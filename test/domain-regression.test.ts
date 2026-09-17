import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SoulStore } from "../src/store"
import { startServer } from "../src/server"
import type { OpenCodeAdapter, NormalizedMessage } from "../src/adapter"

const resources: { store: SoulStore; directory: string }[] = []
const servers: ReturnType<typeof startServer>[] = []
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "xingyao-domain-regression-"))
  const store = new SoulStore(join(directory, "soul.db"), () => 1_000_000)
  resources.push({ store, directory })
  return store
}

afterEach(async () => {
  for (const runtime of servers.splice(0)) await runtime.server.stop(true)
  for (const resource of resources.splice(0)) {
    resource.store.close()
    rmSync(resource.directory, { recursive: true, force: true })
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function serverFixture(store: SoulStore, methods: Record<string, unknown> = {}) {
  const adapter = {
    health: async () => ({ ok: true }),
    createSession: async () => ({ id: "test-session" }),
    prompt: async () => ({ status: "completed", messageID: "reply", text: "done", parts: [] }),
    messages: async () => [],
    abort: async () => true,
    ...methods,
  } as unknown as OpenCodeAdapter
  const runtime = startServer({ store, adapter, vaultDir: join(resources.at(-1)!.directory, "vault"), token: "test-only-session-token" })
  servers.push(runtime)
  const request = (path: string, body: unknown = {}) => fetch(`http://127.0.0.1:${runtime.server.port}${path}`, {
    method: "POST", headers: { authorization: "Bearer test-only-session-token", "content-type": "application/json" }, body: JSON.stringify(body),
  })
  return { runtime, request }
}

describe("domain invariants under correction and deletion", () => {
  test("forgetting unrelated memory does not reopen a previously accepted operation", () => {
    const store = fixture()
    let executions = 0
    const execute = () => { executions++; return { taskId: "test-operation", accepted: true } }
    store.once("chat:accepted-operation", { action: "test operation" }, execute)
    const memory = store.explicitMemory({ key: "unrelated", text: "可删除的普通偏好", scope: "global", kind: "preference" })
    store.forgetMemory(memory.id, memory.revision)
    store.once("chat:accepted-operation", { action: "test operation" }, execute)
    expect(executions).toBe(1)
  })

  test("forgetting a corrected fact also clears its superseded versions", () => {
    const store = fixture()
    const previous = store.explicitMemory({ key: "private-value", text: "PRIVATE-TEST-VALUE old", scope: "project-a", kind: "fact", private: true })
    const current = store.correctMemory(previous.id, previous.revision, "PRIVATE-TEST-VALUE new")
    store.forgetMemory(current.id, current.revision)
    const history = store.memories({ private: true, history: true })
    expect(history.some(memory => memory.text.includes("PRIVATE-TEST-VALUE"))).toBe(false)
    expect(store.experiencesAfter(0).some(event => event.text.includes("PRIVATE-TEST-VALUE"))).toBe(false)
  })

  test("forgetting tool-derived content scrubs the local action copy", () => {
    const store = fixture()
    const task = store.createTask("Test task", "project-a")
    store.recordAction({ id: "test-call", taskId: task.id, tool: "read", status: "succeeded", text: "PRIVATE-ACTION-TEST-VALUE", revision: "v1" })
    const source = store.experiencesAfter(0)[0]!
    const memory = store.remember({ text: source.text, scope: task.scope, kind: "episode", sourceIds: [source.id] })
    store.forgetMemory(memory.id, memory.revision)
    expect(store.actions(task.id).some(action => action.text.includes("PRIVATE-ACTION-TEST-VALUE"))).toBe(false)
  })

  test("a withdrawn sole trigger no longer leaves unexplained negative affect", () => {
    const store = fixture()
    const source = store.appendExperience({ sourceKey: "test/failed", scope: "project-a", ownership: "experienced", kind: "tool_failure", text: "错误归属给本任务的失败结果" })
    const memory = store.remember({ text: source.text, scope: source.scope, kind: "episode", sourceIds: [source.id] })
    expect(store.affect().emotion[0]!).toBeLessThan(0)
    store.correctMemory(memory.id, memory.revision, "先前记录关联错误，该失败不属于本任务")
    expect(store.experience(source.id)?.retracted).toBe(true)
    expect(store.affect().emotion[0]!).toBeCloseTo(0, 12)
    expect(store.affect().lastSourceId).not.toBe(source.id)
  })

  test("an arbitrary supersedes ID cannot bypass a sealed memory store", () => {
    const store = fixture()
    const source = store.appendExperience({ sourceKey: "test/source", scope: "project-a", ownership: "told", kind: "observation", text: "待验证资料" })
    store.setSealed(true)
    expect(() => store.remember({ text: "绕过封存的新学习", scope: source.scope, kind: "fact", sourceIds: [source.id], supersedes: "not-a-real-memory" })).toThrow()
    expect(store.memories()).toHaveLength(0)
  })

  test("deletion clears shared derivatives without erasing independent co-sources", () => {
    const store = fixture()
    const sensitive = store.explicitMemory({ key: "sensitive", text: "PRIVATE-TEST-FACT", scope: "project-a", kind: "fact" })
    const independent = store.explicitMemory({ key: "independent", text: "项目测试命令是 bun test", scope: "project-a", kind: "fact" })
    const combined = store.remember({ text: "PRIVATE-TEST-FACT，项目测试命令是 bun test", scope: "project-a", kind: "inference", sourceIds: [...sensitive.sourceIds, ...independent.sourceIds] })
    store.forgetMemory(sensitive.id, sensitive.revision)
    expect(store.memory(combined.id)?.text).not.toContain("PRIVATE-TEST-FACT")
    expect(store.memory(independent.id)?.status).toBe("active")
    expect(store.experience(independent.sourceIds[0]!)?.retracted).toBe(false)
    expect(store.projection("project-a", "测试命令")).toContain("bun test")
  })

  test("correction replay does not activate experiences recorded during seal", () => {
    const store = fixture()
    const memory = store.explicitMemory({ key: "before-seal", text: "可纠正的资料", scope: "project-a", kind: "fact" })
    store.setSealed(true)
    store.appendExperience({ sourceKey: "sealed/tool/success", scope: "project-a", kind: "tool_success", ownership: "experienced", text: "封存期间记录的审计结果" })
    expect(store.affect().emotion[0]).toBe(0)
    store.correctMemory(memory.id, memory.revision, "管理员纠正资料")
    expect(store.affect().emotion[0]).toBe(0)
    expect(store.sealed).toBe(true)
    store.setSealed(false)
    expect(store.sleep().created).toBe(0)
  })

  test("correcting an inference preserves its independent underlying facts", () => {
    const store = fixture()
    const fact = store.explicitMemory({ key: "observed", text: "本次测试耗时两秒", scope: "project-a", kind: "fact" })
    const conclusion = store.remember({ text: "所以所有运行都会耗时两秒", scope: fact.scope, kind: "inference", sourceIds: fact.sourceIds })
    store.correctMemory(conclusion.id, conclusion.revision, "一次测试不能代表所有运行")
    expect(store.memory(fact.id)?.status).toBe("active")
    expect(store.experience(fact.sourceIds[0]!)?.retracted).toBe(false)
    expect(store.memory(conclusion.id)?.status).toBe("superseded")
  })

  test("derived correction versions are scrubbed while their independent co-source survives", () => {
    const store = fixture()
    const a = store.explicitMemory({ key: "a", text: "PRIVATE-DERIVED-CONTENT", scope: "project-a", kind: "fact" })
    const b = store.explicitMemory({ key: "b", text: "独立测试事实", scope: "project-a", kind: "fact" })
    const combined = store.remember({ text: "PRIVATE-DERIVED-CONTENT 的推论", scope: a.scope, kind: "inference", sourceIds: [...a.sourceIds, ...b.sourceIds] })
    const corrected = store.correctMemory(combined.id, combined.revision, "PRIVATE-DERIVED-CONTENT 的修订推论")
    store.forgetMemory(a.id, a.revision)
    expect(store.memory(corrected.id)?.text).toBe("")
    expect(store.experience(corrected.sourceIds[0]!)?.text).toBe("")
    expect(store.memory(b.id)?.status).toBe("active")
    expect(store.experience(b.sourceIds[0]!)?.retracted).toBe(false)
  })

  test("tool-source tombstones survive restart and suppress changed upstream snapshots", () => {
    let store = fixture()
    const task = store.createTask("Test task", "project-a")
    const action = { id: "stable-tool-call", taskId: task.id, tool: "read", status: "succeeded" as const, text: "PRIVATE-REPLAY-CONTENT", revision: "snapshot-1" }
    store.recordAction(action)
    const first = store.experiencesAfter(0)[0]!
    const memory = store.remember({ text: first.text, scope: task.scope, kind: "episode", sourceIds: [first.id] })
    store.recordAction({ ...action, text: "PRIVATE-REPLAY-CONTENT with metadata", revision: "snapshot-2" })
    expect(store.memory(memory.id)?.status).toBe("invalidated")
    store.forgetMemory(memory.id, store.memory(memory.id)!.revision)
    const resource = resources.at(-1)!
    store.close()
    store = new SoulStore(join(resource.directory, "soul.db"), () => 1_000_000)
    resource.store = store
    store.recordAction({ ...action, text: "PRIVATE-REPLAY-CONTENT after reconnect", revision: "snapshot-3" })
    expect(store.actions(task.id)[0]!.text).toBe("[已按要求删除]")
    expect(store.experiencesAfter(0).every(event => event.retracted && !event.text.includes("PRIVATE-REPLAY-CONTENT"))).toBe(true)
    expect(store.sleep().created).toBe(0)
    expect(store.affect().emotion[0]).toBe(0)
  })

  test("message-source tombstones suppress a second ingestion path for the same message", () => {
    const store = fixture()
    const task = store.createTask("Test task", "project-a")
    const chat = store.addChat(task.id, "assistant", "PRIVATE-MESSAGE-CONTENT", "engine:canonical-message")
    const source = store.experiencesAfter(0)[0]!
    const memory = store.remember({ text: source.text, scope: task.scope, kind: "episode", sourceIds: [source.id] })
    store.forgetMemory(memory.id, memory.revision)
    store.addChat(task.id, "assistant", "PRIVATE-MESSAGE-CONTENT", chat.id)
    const repeated = store.appendExperience({ sourceKey: "alternate-ingestion/revision-2", scope: task.scope, kind: "assistant_message", ownership: "experienced", text: "PRIVATE-MESSAGE-CONTENT", evidence: { chatMessageId: chat.id } })
    expect(repeated.retracted).toBe(true)
    expect(repeated.text).toBe("")
    expect(store.chats(task.id)[0]!.text).toBe("[已按要求删除]")
  })

  test("ordinary source correction does not create a privacy tombstone for a later real outcome", () => {
    const store = fixture()
    const task = store.createTask("Test task", "project-a")
    store.recordAction({ id: "updated-call", taskId: task.id, tool: "test", status: "failed", text: "错误的旧结果", revision: "old" })
    const source = store.experiencesAfter(0)[0]!
    const memory = store.remember({ text: source.text, scope: task.scope, kind: "episode", sourceIds: [source.id] })
    store.correctMemory(memory.id, memory.revision, "旧结果归属错误")
    store.recordAction({ id: "updated-call", taskId: task.id, tool: "test", status: "succeeded", text: "新核实结果", revision: "new" })
    expect(store.actions(task.id)[0]!.text).toBe("新核实结果")
    expect(store.experiencesAfter(0).at(-1)?.retracted).toBe(false)
    expect(store.experiencesAfter(0).at(-1)?.text).toBe("新核实结果")
  })
})

describe("asynchronous task recovery", () => {
  test("abort before session creation prevents a later prompt dispatch", async () => {
    const store = fixture()
    const task = store.createTask("Test task", "project-a")
    const healthStarted = deferred<void>()
    const healthRelease = deferred<void>()
    let prompts = 0
    const { runtime, request } = serverFixture(store, {
      health: async () => { healthStarted.resolve(); await healthRelease.promise; return { ok: true } },
      prompt: async () => { prompts++; return { status: "completed", messageID: "reply", text: "done", parts: [] } },
    })
    try {
      const accepted = await request(`/api/tasks/${task.id}/chat`, { key: "abort-before-dispatch", text: "execute a test operation" })
      expect(accepted.status).toBe(202)
      await healthStarted.promise
      const aborted = await request(`/api/tasks/${task.id}/abort`)
      expect(aborted.status).toBe(200)
    } finally { healthRelease.resolve() }
    await Promise.all([...runtime.jobs.values()])
    expect(prompts).toBe(0)
  })

  test("an old completed assistant message cannot settle a new uncertain attempt", async () => {
    const store = fixture()
    const task = store.createTask("Test task", "project-a")
    store.updateTask(task.id, { sessionId: "test-session", status: "verifying" })
    const oldMessage: NormalizedMessage = {
      sourceID: "opencode:legacy:test-session:previous-reply", sessionID: "test-session", messageID: "previous-reply",
      role: "assistant", text: "previous request completed", parts: [], status: "completed", time: { created: 1, completed: 2 },
    }
    const { runtime, request } = serverFixture(store, {
      prompt: async () => ({ status: "unknown", messageID: null, text: "", parts: [], error: "lost response" }),
      messages: async () => [oldMessage],
    })
    expect((await request(`/api/tasks/${task.id}/chat`, { key: "new-attempt", text: "execute a new test operation" })).status).toBe(202)
    await Promise.all([...runtime.jobs.values()])
    expect(store.task(task.id)?.status).toBe("waiting")
    const response = await request(`/api/tasks/${task.id}/reconcile`)
    expect(response.status).toBe(200)
    expect((await response.json()).settled).toBe(false)
    expect(store.task(task.id)?.status).toBe("waiting")
  })
})
