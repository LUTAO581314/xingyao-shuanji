import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCodeAdapter, OpenCodeAdapterError, type CollaborationView, type DelegationSessionInput, type NormalizedMessage, type PromptResult } from "../src/adapter"
import { startServer } from "../src/server"
import { SoulStore } from "../src/store"

function normalized(sessionID: string, messageID: string, role: "user" | "assistant", text: string): NormalizedMessage {
  const part = { sourceID: `opencode:legacy:${sessionID}:${messageID}:text`, sessionID, messageID, id: "text", type: "text" as const, text, synthetic: false, ignored: false }
  return { sourceID: `opencode:legacy:${sessionID}:${messageID}`, sessionID, messageID, role, text, parts: [part], status: "completed", time: { created: Date.now(), ...(role === "assistant" ? { completed: Date.now() + 1 } : {}) } }
}

class DelegationAdapter extends OpenCodeAdapter {
  childMessages: NormalizedMessage[] = []
  rootMessages: NormalizedMessage[] = []
  creates = 0
  prompts = 0
  aborts = 0
  lostCreate = false
  lostPrompt = false
  hold: Promise<void> | null = null
  constructor() { super({ baseURL: "http://127.0.0.1:1", timeoutMs: 50 }) }
  override async health() { return { ok: true, version: "fixture", capabilities: { legacyHTTP: true, promptSystem: true, durableMessages: true, toolResults: true, permissions: true, collaboration: true, v2Detected: false, v2Supported: false as const } } }
  override async subagents() { return [{ name: "explore", description: "research" }, { name: "general", description: "general work" }] }
  override async createDelegationSession(_input: DelegationSessionInput) { this.creates++; if (this.lostCreate) throw new OpenCodeAdapterError("network", "OpenCode connection failed"); return { id: "ses_child" } }
  override async findDelegationSession(_input: DelegationSessionInput) { return this.creates ? { id: "ses_child" } : null }
  override async assertDelegationSession(sessionID: string, input: DelegationSessionInput) { if (sessionID !== "ses_child" || input.rootSessionID !== "ses_root") throw new Error("ownership mismatch") }
  override async delegationMessages(sessionID: string, input: DelegationSessionInput) { await this.assertDelegationSession(sessionID, input); return this.childMessages }
  override async delegationStatus(sessionID: string, input: DelegationSessionInput) { await this.assertDelegationSession(sessionID, input); return { type: "idle" as const } }
  override async promptDelegation(sessionID: string, text: string, input: DelegationSessionInput): Promise<PromptResult> {
    await this.assertDelegationSession(sessionID, input); this.prompts++
    await this.hold
    const user = normalized(sessionID, `child_user_${this.prompts}`, "user", text)
    const assistant = normalized(sessionID, `child_answer_${this.prompts}`, "assistant", `child result ${this.prompts}: ${text}`)
    this.childMessages.push(user, assistant)
    if (this.lostPrompt) return { messageID: null, text: "", parts: [], status: "unknown", error: "OpenCode connection failed" }
    return { messageID: assistant.messageID, text: assistant.text, parts: assistant.parts, status: "completed" }
  }
  override async abortDelegation(sessionID: string, input: DelegationSessionInput) { await this.assertDelegationSession(sessionID, input); this.aborts++; return true }
  override async messages(sessionID: string) { return sessionID === "ses_root" ? this.rootMessages : this.childMessages }
  override async prompt(sessionID: string, text: string): Promise<PromptResult> {
    if (sessionID !== "ses_root") throw new Error("unexpected session")
    const index = this.rootMessages.length + 1
    const user = normalized(sessionID, `root_user_${index}`, "user", text)
    const assistant = normalized(sessionID, `root_answer_${index}`, "assistant", "main verified summary")
    this.rootMessages.push(user, assistant)
    return { messageID: assistant.messageID, text: assistant.text, parts: assistant.parts, status: "completed" }
  }
  override async collaboration(rootSessionID: string): Promise<CollaborationView> {
    return { rootSessionID, truncated: false, limits: { sessions: 32, depth: 4, transcriptBytes: 2 * 1024 * 1024 }, sessions: this.creates ? [{
      sessionID: "ses_child", parentSessionID: rootSessionID, title: "Inspect", agent: "explore", depth: 1, status: { type: "idle" }, createdAt: 1, updatedAt: 2,
      messageCount: this.childMessages.length, transcriptTruncated: false, messages: this.childMessages.map(message => ({ sourceID: message.sourceID, messageID: message.messageID, role: message.role, text: message.text, status: message.status, createdAt: message.time.created, ...(message.time.completed ? { completedAt: message.time.completed } : {}), tools: [] })),
    }] : [] }
  }
}

const fixtures: Array<{ root: string; store: SoulStore; app: ReturnType<typeof startServer> }> = []
afterEach(() => { for (const fixture of fixtures.splice(0)) { fixture.app.server.stop(true); fixture.store.close(); rmSync(fixture.root, { recursive: true, force: true }) } })

test("schema 4 upgrades by adding an empty delegation ledger without changing history", () => {
  const root = mkdtempSync(join(tmpdir(), "xingyao-delegation-upgrade-")), path = join(root, "soul.db")
  const original = new SoulStore(path), task = original.createTask("Historical", "global")
  original.addChat(task.id, "user", "keep this history", "historical-chat")
  const before = JSON.stringify({ tasks: original.tasks(), chats: original.chats(task.id), memories: original.memories({ history: true, private: true }) })
  original.close()
  const old = new Database(path); old.exec("DROP TABLE delegations; PRAGMA user_version=4"); old.close()
  const upgraded = new SoulStore(path)
  try {
    expect(upgraded.db.query("PRAGMA user_version").get()).toEqual({ user_version: 5 })
    expect(JSON.stringify({ tasks: upgraded.tasks(), chats: upgraded.chats(task.id), memories: upgraded.memories({ history: true, private: true }) })).toBe(before)
    expect(upgraded.delegations(task.id)).toEqual([])
  } finally { upgraded.close(); rmSync(root, { recursive: true, force: true }) }
})

test("restart marks an interrupted delegation uncertain without resending it", () => {
  const root = mkdtempSync(join(tmpdir(), "xingyao-delegation-restart-")), path = join(root, "soul.db")
  const first = new SoulStore(path), task = first.createTask("Main", "global")
  first.updateTask(task.id, { sessionId: "ses_root" })
  const delegation = first.createDelegation({ taskId: task.id, requestKey: "create", rootSessionId: "ses_root", title: "Inspect", instruction: "work", agent: "explore" })
  first.updateDelegation(delegation.id, task.id, { sessionId: "ses_child", state: "running", attempt: { ...delegation.attempt, baselineMessageIds: [], delivered: true } })
  first.close()
  const recovered = new SoulStore(path)
  try {
    recovered.recoverInterrupted()
    expect(recovered.delegation(delegation.id)).toMatchObject({ sessionId: "ses_child", state: "waiting", error: "上次委派运行中断，需要核对子会话；不会自动重发操作", attempt: { delivered: true } })
  } finally { recovered.close(); rmSync(root, { recursive: true, force: true }) }
})

test("an in-flight delegation blocks checkpoints, model changes, sleep and normal shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "xingyao-delegation-lifecycle-")), store = new SoulStore(join(root, "host", "soul.db")), adapter = new DelegationAdapter()
  const gate = Promise.withResolvers<void>(); adapter.hold = gate.promise
  const app = startServer({ store, adapter, vaultDir: join(root, "vault"), token: "fixture" }); fixtures.push({ root, store, app })
  const task = store.createTask("Main", "global"); store.updateTask(task.id, { sessionId: "ses_root" })
  const call = (path: string, data: unknown) => fetch(`http://127.0.0.1:${app.server.port}/api${path}`, { method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" }, body: JSON.stringify(data) })
  expect((await call(`/tasks/${task.id}/delegations`, { key: "create", title: "Inspect", instruction: "wait", agent: "explore" })).status).toBe(202)
  const until = Date.now() + 2000; while (!adapter.prompts && Date.now() < until) await Bun.sleep(5)
  expect(adapter.prompts).toBe(1)
  expect((await call("/checkpoint", {})).status).toBe(409)
  expect((await call("/settings/model", {})).status).toBe(409)
  expect((await call("/sleep", {})).status).toBe(409)
  expect((await call("/shutdown", {})).status).toBe(409)
  gate.resolve(); adapter.hold = null
  const delegation = store.delegations(task.id)[0]!
  const settled = Date.now() + 2000; while (store.delegation(delegation.id)?.state !== "waiting" && Date.now() < settled) await Bun.sleep(5)
  expect(store.delegation(delegation.id)?.state).toBe("waiting")
})

test("owned delegation creates, pauses, continues in place and explicitly merges without importing child prose", async () => {
  const root = mkdtempSync(join(tmpdir(), "xingyao-delegation-api-")), store = new SoulStore(join(root, "host", "soul.db")), adapter = new DelegationAdapter()
  const app = startServer({ store, adapter, vaultDir: join(root, "vault"), token: "fixture" }); fixtures.push({ root, store, app })
  adapter.lostCreate = true
  const task = store.createTask("Main", "global"); store.updateTask(task.id, { sessionId: "ses_root" })
  const call = async (path: string, data?: unknown, token = "fixture") => fetch(`http://127.0.0.1:${app.server.port}/api${path}`, { method: data === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, ...(data === undefined ? {} : { "content-type": "application/json" }) }, body: data === undefined ? undefined : JSON.stringify(data) })
  const waitFor = async (check: () => boolean) => { const until = Date.now() + 2000; while (!check() && Date.now() < until) await Bun.sleep(5); expect(check()).toBe(true) }

  expect((await call("/collaboration/agents")).status).toBe(200)
  const created = await call(`/tasks/${task.id}/delegations`, { key: "create-1", title: "Inspect", instruction: "find issue", agent: "explore" })
  expect(created.status).toBe(202)
  const delegation = await created.json() as { id: string }
  await waitFor(() => store.delegation(delegation.id)?.state === "waiting")
  expect(adapter.creates).toBe(1); expect(adapter.prompts).toBe(1)
  expect(store.chats(task.id)).toEqual([])
  expect(store.experiencesAfter(0).map(item => item.text).join("\n")).not.toContain("child result")

  const view = await (await call(`/tasks/${task.id}/collaboration`)).json() as { delegations: Array<{ id: string; sessionId: string }> }
  expect(view.delegations).toMatchObject([{ id: delegation.id, sessionId: "ses_child" }])
  expect((await call(`/tasks/${task.id}/delegations/${delegation.id}/stop`, { key: "stop-1" })).status).toBe(200)
  expect(store.delegation(delegation.id)?.state).toBe("paused"); expect(adapter.aborts).toBe(1)
  expect((await call(`/tasks/${task.id}/delegations/${delegation.id}/continue`, { key: "continue-1", instruction: "check again" })).status).toBe(202)
  await waitFor(() => store.delegation(delegation.id)?.state === "waiting" && adapter.prompts === 2)
  expect(store.delegation(delegation.id)?.sessionId).toBe("ses_child")
  adapter.lostPrompt = true
  const lost = { key: "continue-lost", instruction: "verify persisted result" }
  expect((await call(`/tasks/${task.id}/delegations/${delegation.id}/continue`, lost)).status).toBe(202)
  await waitFor(() => store.delegation(delegation.id)?.state === "waiting" && adapter.prompts === 3)
  expect((await call(`/tasks/${task.id}/delegations/${delegation.id}/continue`, lost)).status).toBe(202)
  await Bun.sleep(10); expect(adapter.prompts).toBe(3)

  const foreign = store.createTask("Foreign", "global")
  expect((await call(`/tasks/${foreign.id}/delegations/${delegation.id}/stop`, { key: "foreign-stop" })).status).toBe(404)
  const merge = await call(`/tasks/${task.id}/delegations/${delegation.id}/merge`, { key: "merge-1", messageId: "child_answer_3" })
  expect(merge.status).toBe(202)
  await waitFor(() => store.task(task.id)?.status === "verifying")
  expect(store.delegation(delegation.id)?.state).toBe("merged")
  expect(store.chats(task.id).map(item => [item.role, item.text])).toEqual([
    ["system", "已将子智能体「Inspect」的来源消息 child_answer_3 交给星杳核对汇总。"],
    ["assistant", "main verified summary"],
  ])
  expect(store.experiencesAfter(0).map(item => item.text).join("\n")).not.toContain("child result 2")
  expect((await call(`/tasks/${task.id}/delegations/${delegation.id}/stop`, { key: "unauthorized" }, "wrong")).status).toBe(401)
})
