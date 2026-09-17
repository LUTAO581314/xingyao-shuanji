import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCodeAdapter } from "../src/adapter"
import { startServer } from "../src/server"
import { SoulStore } from "../src/store"
import { LearningStore, type SkillCandidate, type SkillObservation } from "../src/learning"
import type { Action, ChatMessage, Experience, Memory, SleepReport, Task } from "../src/contracts"

// These are protocol fixtures, not executed commands or simulated normalized
// adapter results. Every assertion crosses the actual HTTP adapter and API.
const NOW = Date.UTC(2026, 8, 17, 12)
const SESSION = "ses_evidence"
const MESSAGE = "msg_evidence"
const CALL = "call_evidence"
const CLAIM = "我已经成功完成全部任务，所有检查通过。"
const OUTPUT = "Raw fixture output: this text does not determine the process outcome."
type TaskDetail = Task & { messages: ChatMessage[]; actions: Action[] }
type ToolFixture = { name: string; state: Record<string, unknown> }
type Fixture = ReturnType<typeof setup>
const fixtures: { dir: string; store: SoulStore; app: ReturnType<typeof startServer>; upstream: { stop(closeActiveConnections?: boolean): Promise<void> | void } }[] = []

function completed(exit: number | null | "missing", name = "bash"): ToolFixture {
  return { name, state: { status: "completed", input: { command: "fixture-only; never executed" }, output: OUTPUT,
    metadata: exit === "missing" ? {} : { exit }, time: { start: NOW - 1000, end: NOW } } }
}

function message(tool: ToolFixture | null) {
  const source = { sessionID: SESSION, messageID: MESSAGE }
  return {
    info: { id: MESSAGE, sessionID: SESSION, role: "assistant", time: { created: NOW - 1000, completed: NOW }, finish: "stop" },
    parts: [
      ...(tool ? [{ ...source, id: "part_tool", type: "tool", callID: CALL, tool: tool.name, state: tool.state }] : []),
      { ...source, id: "part_text", type: "text", text: CLAIM },
    ],
  }
}

function setup(initialTool: ToolFixture | null, prepareLegacy?: (store: SoulStore) => void) {
  const dir = mkdtempSync(join(tmpdir(), "xingyao-tool-evidence-"))
  const database = join(dir, "host", "soul.db")
  let store = new SoulStore(database, () => NOW)
  if (prepareLegacy) {
    try { prepareLegacy(store) } finally { store.close() }
    store = new SoulStore(database, () => NOW)
  }
  let tool = initialTool
  let delivered = !!prepareLegacy
  let promptCount = 0
  const unexpectedRoutes: string[] = []
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname
    if (request.method === "GET" && path === "/global/health") return Response.json({ healthy: true, version: "local-evidence-fixture" })
    if (request.method === "GET" && path === "/doc") return Response.json({
      openapi: "3.1.0",
      paths: {
        "/session": { post: {} },
        "/session/{sessionID}/message": { get: {}, post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Prompt" } } } } } },
        "/permission/{requestID}/reply": { post: {} },
      },
      components: { schemas: { Prompt: { type: "object", properties: { system: { type: "string" } } } } },
    })
    if (request.method === "POST" && path === "/session") return Response.json({ id: SESSION })
    if (request.method === "POST" && path === `/session/${SESSION}/message`) {
      delivered = true
      promptCount++
      return Response.json(message(tool))
    }
    if (request.method === "GET" && path === `/session/${SESSION}/message`) return Response.json(delivered ? [message(tool)] : [])
    unexpectedRoutes.push(`${request.method} ${path}`)
    return Response.json({ error: "Unexpected fixture route" }, { status: 404 })
  } })
  const adapter = new OpenCodeAdapter({ baseURL: upstream.url.origin, timeoutMs: 1000 })
  const app = startServer({ store, adapter, token: "test-only-token", vaultDir: join(dir, "vault") })
  const api = async <T>(method: string, path: string, body?: unknown, expected = 200): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${app.server.port}${path}`, { method,
      headers: { authorization: "Bearer test-only-token", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const value = await response.json()
    expect(response.status, JSON.stringify(value)).toBe(expected)
    return value as T
  }
  const fixture = { dir, store, app, upstream, api, unexpectedRoutes,
    setTool(value: ToolFixture | null) { tool = value },
    get promptCount() { return promptCount },
  }
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.app.server.stop(true)
    await Promise.allSettled([...fixture.app.jobs.values()])
    await fixture.upstream.stop(true)
    fixture.store.close()
    rmSync(fixture.dir, { recursive: true, force: true })
  }
})

async function run(fixture: Fixture): Promise<TaskDetail> {
  const task = await fixture.api<Task>("POST", "/api/tasks", { key: "task", title: "真实结果证据校验", scope: "evidence" }, 201)
  await fixture.api("POST", `/api/tasks/${task.id}/chat`, { key: "prompt", text: "读取实际工具结果，等待人工验收。" }, 202)
  await Promise.allSettled([...fixture.app.jobs.values()])
  const detail = await fixture.api<TaskDetail>("GET", `/api/tasks/${task.id}`)
  expect(detail.status).toBe("verifying")
  expect(detail.messages.filter(item => item.role === "assistant").map(item => item.text)).toEqual([CLAIM])
  expect(fixture.promptCount).toBe(1)
  expect(fixture.unexpectedRoutes).toEqual([])
  return detail
}

function proposal(sourceIds: number[]) {
  return { title: "工具结果校验候选", scope: "evidence", when: "核对进程返回结果时", steps: ["检查结构化退出证据"], avoid: [], sourceIds }
}

function apiProposal(sourceIds: number[]) {
  const value = proposal(sourceIds)
  return { ...value, steps: value.steps.join("\n"), avoid: value.avoid.join("\n") }
}

function liveToolEvents(store: SoulStore): Experience[] {
  return store.experiencesAfter(0).filter(event => !event.retracted && event.kind.startsWith("tool_"))
}

const cases: { label: string; tool: ToolFixture; outcome: "succeeded" | "failed" | "unknown"; lifecycle: "completed" | "failed"; exit?: number | null }[] = [
  { label: "shell exit 0", tool: completed(0), outcome: "succeeded", lifecycle: "completed", exit: 0 },
  { label: "shell exit 1", tool: completed(1), outcome: "failed", lifecycle: "completed", exit: 1 },
  { label: "shell exit 2", tool: completed(2), outcome: "failed", lifecycle: "completed", exit: 2 },
  { label: "shell null exit", tool: completed(null), outcome: "unknown", lifecycle: "completed", exit: null },
  { label: "shell missing exit", tool: completed("missing"), outcome: "unknown", lifecycle: "completed" },
  { label: "shell state.error", tool: { name: "bash", state: { status: "error", input: { command: "fixture-only" }, error: "OS fixture failed to start", time: { start: NOW - 1000, end: NOW } } }, outcome: "failed", lifecycle: "failed" },
  { label: "unrecognized MCP tool", tool: completed(0, "mcp_unrecognized_tool"), outcome: "unknown", lifecycle: "completed" },
]

for (const item of cases) test(`HTTP evidence: ${item.label} governs actions, affect, sleep and learning despite assistant success prose`, async () => {
  const fixture = setup(item.tool)
  const detail = await run(fixture)
  expect(detail.actions).toHaveLength(1)
  const action = detail.actions[0]!
  expect(action.status).toBe(item.outcome)
  expect(action.execution).toMatchObject({ version: 1, lifecycle: item.lifecycle, outcome: item.outcome, startedAt: NOW - 1000, finishedAt: NOW })
  expect(action.execution?.basis).toBeTruthy()
  if ("exit" in item) expect(action.execution?.exitCode).toBe(item.exit)
  else expect(action.execution).not.toHaveProperty("exitCode")
  expect(action.text).toContain(String(item.tool.state.output ?? item.tool.state.error))
  expect(action.text).not.toContain(CLAIM)

  const events = liveToolEvents(fixture.store)
  expect(events).toHaveLength(1) // Prompt result and persisted history are one observation.
  const event = events[0]!
  expect(event.kind).toBe(item.outcome === "succeeded" ? "tool_success" : item.outcome === "failed" ? "tool_failure" : "tool_unknown")
  expect(event.evidence?.execution).toEqual(action.execution)
  expect(event.evidence?.status).toBe(item.outcome)
  const valence = fixture.store.affect().emotion[0]!
  if (item.outcome === "succeeded") expect(valence).toBeGreaterThan(0)
  else if (item.outcome === "failed") expect(valence).toBeLessThan(0)
  else expect(valence).toBe(0)

  const observations = await fixture.api<SkillObservation[]>("GET", "/api/skills/sources?scope=evidence")
  expect(observations).toHaveLength(1)
  expect(observations[0]!.sourceId).toBe(event.id)
  expect(observations[0]!.outcome).toBe(item.outcome === "succeeded" ? "success" : item.outcome === "failed" ? "failure" : "unknown")
  const skill = await fixture.api<SkillCandidate>("POST", "/api/skills", apiProposal([event.id]), 201)
  expect(skill.evaluation.successes).toBe(item.outcome === "succeeded" ? 1 : 0)
  expect(skill.evaluation.failures).toBe(item.outcome === "failed" ? 1 : 0)
  expect(skill.evaluation.unknownSources).toBe(item.outcome === "unknown" ? 1 : 0)
  expect(skill.status).toBe("draft")

  const sleep = await fixture.api<SleepReport>("POST", "/api/sleep", {})
  const memories = await fixture.api<Memory[]>("GET", "/api/memories?scope=evidence")
  expect(sleep.created).toBe(item.outcome === "unknown" ? 0 : 1)
  expect(memories).toHaveLength(item.outcome === "unknown" ? 0 : 1)
  for (const memory of memories) {
    expect(memory.kind).toBe("episode")
    expect(memory.sourceIds).toEqual([event.id])
    expect(memory.text).toBe(action.text)
    expect(memory.text).not.toContain(CLAIM)
  }
  expect((await fixture.api<SleepReport>("POST", "/api/sleep", {})).created).toBe(0)
  await fixture.api("POST", `/api/tasks/${detail.id}/reconcile`, {})
  expect((await fixture.api<TaskDetail>("GET", `/api/tasks/${detail.id}`)).status).toBe("verifying")
  expect(liveToolEvents(fixture.store)).toHaveLength(1)
  expect(fixture.promptCount).toBe(1)
})

test("HTTP evidence: assistant success prose alone cannot create action, affect, memory or skill evidence", async () => {
  const fixture = setup(null)
  const detail = await run(fixture)
  expect(detail.actions).toHaveLength(0)
  expect(liveToolEvents(fixture.store)).toHaveLength(0)
  expect(fixture.store.affect().emotion.every(value => value === 0)).toBe(true)
  expect(await fixture.api<SkillObservation[]>("GET", "/api/skills/sources?scope=evidence")).toEqual([])
  expect((await fixture.api<SleepReport>("POST", "/api/sleep", {})).created).toBe(0)
  expect(await fixture.api<Memory[]>("GET", "/api/memories?scope=evidence")).toEqual([])
  const selfReport = fixture.store.experiencesAfter(0).find(event => event.kind === "assistant_message")!
  expect(selfReport.text).toBe(CLAIM)
  await fixture.api("POST", "/api/skills", apiProposal([selfReport.id]), 400)
  expect((await fixture.api<TaskDetail>("GET", `/api/tasks/${detail.id}`)).status).toBe("verifying")
})

test("HTTP evidence: changed exit with identical output retires success derivatives and replay cannot restore them", async () => {
  const fixture = setup(completed(0))
  const detail = await run(fixture)
  const oldAction = detail.actions[0]!
  const oldSource = liveToolEvents(fixture.store)[0]!
  await fixture.api("POST", "/api/sleep", {})
  const oldMemory = (await fixture.api<Memory[]>("GET", "/api/memories?scope=evidence"))[0]!
  const oldSkill = await fixture.api<SkillCandidate>("POST", "/api/skills", apiProposal([oldSource.id]), 201)

  fixture.setTool(completed(2))
  await fixture.api("POST", `/api/tasks/${detail.id}/reconcile`, {})
  const corrected = await fixture.api<TaskDetail>("GET", `/api/tasks/${detail.id}`)
  expect(corrected.status).toBe("verifying")
  expect(corrected.actions).toHaveLength(1)
  expect(corrected.actions[0]!.status).toBe("failed")
  expect(corrected.actions[0]!.execution?.exitCode).toBe(2)
  expect(corrected.actions[0]!.revision).not.toBe(oldAction.revision)
  expect(fixture.store.experience(oldSource.id)?.retracted).toBe(true)
  expect(fixture.store.memory(oldMemory.id)?.status).toBe("invalidated")
  expect(fixture.store.affect().emotion[0]!).toBeLessThan(0)
  const newSource = liveToolEvents(fixture.store)[0]!
  expect(liveToolEvents(fixture.store)).toHaveLength(1)
  expect(newSource.kind).toBe("tool_failure")
  expect(newSource.observedAt).toBe(oldSource.observedAt)
  const skills = await fixture.api<SkillCandidate[]>("GET", "/api/skills?scope=evidence")
  const revisedSkill = skills.find(item => item.id === oldSkill.id)!
  expect(revisedSkill.status).toBe("needs_review")
  expect(revisedSkill.evaluation.successes).toBe(0)
  expect(revisedSkill.evaluation.failures).toBe(1)
  expect((await fixture.api<SleepReport>("POST", "/api/sleep", {})).created).toBe(1)
  const memories = await fixture.api<Memory[]>("GET", "/api/memories?scope=evidence")
  expect(memories).toHaveLength(1)
  expect(memories[0]!.sourceIds).toEqual([newSource.id])

  // A stale GET snapshot already seen before must not roll the call back.
  fixture.setTool(completed(0))
  await fixture.api("POST", `/api/tasks/${detail.id}/reconcile`, {})
  expect(fixture.store.actions(detail.id)[0]!.status).toBe("failed")
  expect(liveToolEvents(fixture.store).map(event => event.id)).toEqual([newSource.id])
  expect(fixture.store.affect().emotion[0]!).toBeLessThan(0)
  expect((await fixture.api<SleepReport>("POST", "/api/sleep", {})).created).toBe(0)
  expect(fixture.promptCount).toBe(1)
})

test("HTTP evidence: legacy success is withdrawn on upgrade and real reconciliation replaces it with nonzero exit evidence", async () => {
  let taskId = ""
  let oldSourceId = 0
  let oldMemoryId = ""
  let oldSkillId = ""
  const fixture = setup(completed(1), store => {
    // Explicit prior-release database fixture: legacy actions had status/text
    // only. Removing the version marker simulates opening that old database.
    const task = store.createTask("旧版本成功误判", "evidence")
    taskId = task.id
    store.updateTask(task.id, { sessionId: SESSION, status: "verifying" })
    store.setMeta(`attempt:${task.id}`, JSON.stringify({ baseline: [], delivered: true }))
    store.recordAction({ id: `${SESSION}:${MESSAGE}:${CALL}`, taskId: task.id, tool: "bash", status: "succeeded", text: "bash：已完成\n" + OUTPUT, revision: "historical-lifecycle-only" })
    oldSourceId = liveToolEvents(store)[0]!.id
    expect(store.affect().emotion[0]!).toBeGreaterThan(0)
    expect(store.sleep().created).toBe(1)
    oldMemoryId = store.memories()[0]!.id
    oldSkillId = new LearningStore(store.db).propose(proposal([oldSourceId])).id
    store.db.query("DELETE FROM meta WHERE key='action_evidence_version'").run()
  })

  expect(fixture.store.actions(taskId)[0]!.status).toBe("unknown")
  expect(fixture.store.experience(oldSourceId)?.retracted).toBe(true)
  expect(fixture.store.memory(oldMemoryId)?.status).toBe("invalidated")
  expect(fixture.store.affect().emotion[0]!).toBe(0)
  expect(await fixture.api<SkillObservation[]>("GET", "/api/skills/sources?scope=evidence")).toEqual([])
  const before = (await fixture.api<SkillCandidate[]>("GET", "/api/skills?scope=evidence")).find(item => item.id === oldSkillId)!
  expect(before.status).toBe("needs_review")
  expect(before.evaluation.successes).toBe(0)

  await fixture.api("POST", `/api/tasks/${taskId}/reconcile`, {})
  const corrected = await fixture.api<TaskDetail>("GET", `/api/tasks/${taskId}`)
  expect(corrected.status).toBe("verifying")
  expect(corrected.actions).toHaveLength(1)
  expect(corrected.actions[0]!.status).toBe("failed")
  expect(corrected.actions[0]!.execution).toMatchObject({ version: 1, lifecycle: "completed", outcome: "failed", exitCode: 1 })
  expect(corrected.actions[0]!.text).toContain(OUTPUT)
  expect(corrected.messages.map(item => item.text)).toContain(CLAIM)
  expect(fixture.store.affect().emotion[0]!).toBeLessThan(0)
  const actual = liveToolEvents(fixture.store)
  expect(actual).toHaveLength(1)
  expect(actual[0]!.kind).toBe("tool_failure")
  expect(actual[0]!.observedAt).toBe(fixture.store.experience(oldSourceId)!.observedAt)
  const after = (await fixture.api<SkillCandidate[]>("GET", "/api/skills?scope=evidence")).find(item => item.id === oldSkillId)!
  expect(after.status).toBe("needs_review")
  expect(after.evaluation.successes).toBe(0)
  expect(after.evaluation.failures).toBe(1)
  expect((await fixture.api<SleepReport>("POST", "/api/sleep", {})).created).toBe(1)
  expect(fixture.store.memories().map(item => item.sourceIds)).toEqual([[actual[0]!.id]])
  await fixture.api("POST", `/api/tasks/${taskId}/reconcile`, {})
  expect(liveToolEvents(fixture.store)).toHaveLength(1)
  expect((await fixture.api<SleepReport>("POST", "/api/sleep", {})).created).toBe(0)
  expect(fixture.promptCount).toBe(0) // Reconciliation must not execute again.
  expect(fixture.unexpectedRoutes).toEqual([])
})
