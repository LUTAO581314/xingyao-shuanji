import { afterEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SoulStore } from "../src/store"
import { OpenCodeAdapter, type PromptResult } from "../src/adapter"
import { startServer } from "../src/server"
import { MemoryReviewStore } from "../src/memory-review"
import { listCheckpoints } from "../src/checkpoint"
import type { AcceptMemoryCandidate, MemoryCandidate, MemoryReviewView } from "../src/memory-review-contracts"

class ReviewAdapter extends OpenCodeAdapter {
  readonly inputs: Array<{ sessionID: string; text: string; options: unknown }> = []
  readonly sessions: string[] = []
  readonly cleanupCalls: Array<{ sessionID: string; jobID: string }> = []
  readonly aborts: string[] = []
  readonly foreground: string[] = []
  cleanupResult = true
  response: (text: string) => PromptResult = text => {
    const source = JSON.parse(text).sources.find((item: { speaker: string }) => item.speaker === "user")
    return { messageID: "fixture-model-reply", text: JSON.stringify({ candidates: [{ text: "主人希望回答先给结论。", subject: "主人", kind: "preference", attribution: "user_statement", timeNote: "", evidence: [{ sourceId: source.id, quote: source.text }], relatedMemoryIds: [] }] }), parts: [], status: "completed" }
  }
  beforeSession?: () => Promise<void>
  beforePrompt?: () => Promise<void>
  beforeCleanup?: () => Promise<void>
  onAbort?: () => void
  constructor() { super({ baseURL: "http://127.0.0.1:1", timeoutMs: 50 }) }
  override async health() { return { ok: true, version: "local-review-fixture", capabilities: { legacyHTTP: true, promptSystem: true, durableMessages: true, toolResults: true, permissions: true, v2Detected: false, v2Supported: false as const } } }
  override async createSession() { return { id: "foreground-session" } }
  override async prompt(_sessionID: string, text: string) { this.foreground.push(text); return { messageID: "foreground-reply", text: "前台请求已收到。", parts: [], status: "completed" as const } }
  override async createMemoryExtractionSession(_jobID: string) { await this.beforeSession?.(); const id = `review-fixture-${this.sessions.length + 1}`; this.sessions.push(id); return { id } }
  override async promptMemoryExtraction(sessionID: string, text: string, options: Parameters<OpenCodeAdapter["promptMemoryExtraction"]>[2]) {
    this.inputs.push({ sessionID, text, options }); await this.beforePrompt?.()
    if (this.aborts.includes(sessionID)) throw new Error("fixture extraction aborted")
    return this.response(text)
  }
  override async deleteMemoryExtractionSession(sessionID: string, jobID: string) { this.cleanupCalls.push({ sessionID, jobID }); await this.beforeCleanup?.(); return this.cleanupResult }
  override async abort(sessionID: string) { this.aborts.push(sessionID); this.onAbort?.(); return true }
  override async permissions() { return [] }
  override async messages() { return [] }
}

const fixtures: Array<{ dir: string; store: SoulStore; app: ReturnType<typeof startServer> }> = []
function setup(adapter = new ReviewAdapter(), beforeServer?: (store: SoulStore) => void) {
  const dir = mkdtempSync(join(tmpdir(), "xingyao-memory-review-api-"))
  const store = new SoulStore(join(dir, "host", "soul.db"))
  beforeServer?.(store)
  const app = startServer({ store, adapter, vaultDir: join(dir, "vault"), token: "test-memory-review-token" })
  fixtures.push({ dir, store, app })
  const request = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST", headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${app.server.port}${path}`, { method, headers: { authorization: "Bearer test-memory-review-token", "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const view = async (taskId: string) => await (await request(`/api/memory-review?taskId=${encodeURIComponent(taskId)}`)).json() as MemoryReviewView
  const settle = async () => { while (app.reviewJobs.size || app.jobs.size) await Promise.all([...app.reviewJobs.values(), ...app.jobs.values()]) }
  function task(text = "以后请先给我结论，再解释依据。", scope = "project-a") { const task = store.createTask("对话记忆 HTTP 验收", scope); store.addChat(task.id, "user", text); return task }
  return { dir, store, app, adapter, request, view, settle, task }
}
async function idleMaintenance(app: ReturnType<typeof startServer>) {
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000)
  try { await app.maintenance() } finally { clock.mockRestore() }
}
function decision(view: MemoryReviewView, candidate: MemoryCandidate, overrides: Partial<AcceptMemoryCandidate> = {}): AcceptMemoryCandidate {
  return { revision: candidate.revision, reviewRevision: view.revision, text: candidate.text, subject: candidate.subject, kind: candidate.kind, attribution: candidate.attribution,
    validFrom: null, validUntil: null, private: false, pinned: true, resolution: { type: "add" }, ...overrides }
}
afterEach(async () => { for (const item of fixtures.splice(0)) { await item.app.server.stop(true); await Promise.allSettled([...item.app.reviewJobs.values(), ...item.app.jobs.values()]); item.store.close(); rmSync(item.dir, { recursive: true, force: true }) } })

test("memory review HTTP requires authorization and validates requests before admitting work", async () => {
  const f = setup(), task = f.task()
  expect((await f.request(`/api/memory-review?taskId=${task.id}`, undefined, "GET", { authorization: "Bearer invalid" })).status).toBe(401)
  expect((await f.request("/api/memory-review", { taskId: task.id, key: "origin" }, "POST", { origin: "https://example.invalid" })).status).toBe(403)
  expect((await f.request("/api/memory-review", { taskId: task.id })).status).toBe(400)
  expect((await f.request("/api/memory-review", { taskId: task.id, key: "model", model: { providerID: 1 } })).status).toBe(400)
  expect(f.adapter.inputs).toHaveLength(0)
  expect((await f.view(task.id)).batches).toHaveLength(0)
})

test("HTTP extraction creates a durable proposal, not a memory; explicit adoption preserves reviewed metadata", async () => {
  const f = setup(), task = f.task()
  const started = await f.request("/api/memory-review", { taskId: task.id, key: "extract-once" })
  expect(started.status).toBe(202)
  const admitted = await started.json() as { batchId: string }
  await f.settle()
  const reviewed = await f.view(task.id), candidate = reviewed.candidates[0]
  expect(reviewed.batches[0]).toMatchObject({ id: admitted.batchId, status: "completed" })
  expect(candidate).toMatchObject({ status: "pending", scope: "project-a", kind: "preference" })
  expect(f.store.memories()).toHaveLength(0)
  expect(f.adapter.inputs).toHaveLength(1)
  const adopted = await f.request(`/api/memory-review/${candidate.id}/accept`, decision(reviewed, candidate, { subject: "项目 a 的主人", validFrom: 100, validUntil: null }))
  expect(adopted.status).toBe(200)
  const memory = await adopted.json()
  expect(memory).toMatchObject({ scope: "project-a", pinned: true, claim: { subject: "项目 a 的主人", attribution: "user_statement", validFrom: 100, validUntil: null, extractionId: candidate.id } })
  expect(f.store.memories()).toHaveLength(1)
  expect((await f.request(`/api/memory-review/${candidate.id}/accept`, decision(reviewed, candidate))).status).toBe(409)
  const repeated = await f.request("/api/memory-review", { taskId: task.id, key: "extract-once" })
  expect(repeated.status).toBe(202)
  expect((await repeated.json()).batchId).toBe(admitted.batchId)
  await f.settle()
  expect(f.adapter.inputs).toHaveLength(1)
})

test("reject and stale human review are enforced over HTTP without creating memories", async () => {
  const f = setup(), task = f.task()
  await f.request("/api/memory-review", { taskId: task.id, key: "reject" })
  await f.settle()
  const view = await f.view(task.id), candidate = view.candidates[0]
  const oldReview = decision(view, candidate)
  f.store.explicitMemory({ key: "concurrent-memory", scope: "project-a", text: "另一窗口更新了项目事实", kind: "fact" })
  expect((await f.request(`/api/memory-review/${candidate.id}/accept`, oldReview)).status).toBe(409)
  expect((await f.request(`/api/memory-review/${candidate.id}/reject`, { revision: candidate.revision + 1 })).status).toBe(409)
  expect((await f.request(`/api/memory-review/${candidate.id}/reject`, { revision: candidate.revision })).status).toBe(200)
  expect((await f.view(task.id)).candidates[0].status).toBe("rejected")
  expect(f.store.memories()).toHaveLength(1)
})

test("malformed or ungrounded model output fails the review and an explicit new key retries it", async () => {
  const f = setup(), task = f.task()
  f.adapter.response = () => ({ messageID: "bad", status: "completed", parts: [], text: JSON.stringify({ candidates: [{ text: "捏造偏好", subject: "主人", kind: "fact", attribution: "user_statement", timeNote: "", evidence: [{ sourceId: 999999, quote: "输入没有这句话" }], relatedMemoryIds: [] }] }) })
  await f.request("/api/memory-review", { taskId: task.id, key: "bad-output" })
  await f.settle()
  expect((await f.view(task.id)).batches[0].status).toBe("failed")
  expect((await f.view(task.id)).candidates).toHaveLength(0)
  expect(f.store.memories()).toHaveLength(0)
  await f.request("/api/memory-review", { taskId: task.id, key: "bad-output" })
  await f.settle()
  expect(f.adapter.inputs).toHaveLength(1)
  f.adapter.response = () => ({ messageID: "empty-valid", status: "completed", parts: [], text: "{\"candidates\":[]}" })
  expect((await f.request("/api/memory-review", { taskId: task.id, key: "retry-by-user" })).status).toBe(202)
  await f.settle()
  expect(f.adapter.inputs).toHaveLength(2)
  expect((await f.view(task.id)).batches[0].status).toBe("completed")
})

test("sealing before a delayed session opens prevents source delivery to the model", async () => {
  const f = setup(), task = f.task(), blocked = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>()
  f.adapter.beforeSession = async () => { reached.resolve(); await blocked.promise }
  const started = await f.request("/api/memory-review", { taskId: task.id, key: "seal-before-send" })
  expect(started.status).toBe(202)
  try { await reached.promise; f.store.setSealed(true) } finally { blocked.resolve() }
  await f.settle()
  expect(f.adapter.inputs).toHaveLength(0)
  expect((await f.view(task.id)).batches[0].status).toBe("failed")
  expect(f.store.memories()).toHaveLength(0)
})

test("sealing while model output is in flight prevents candidate creation", async () => {
  const f = setup(), task = f.task(), blocked = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>()
  f.adapter.beforePrompt = async () => { reached.resolve(); await blocked.promise }
  expect((await f.request("/api/memory-review", { taskId: task.id, key: "seal-after-send" })).status).toBe(202)
  try { await reached.promise; f.store.setSealed(true) } finally { blocked.resolve() }
  await f.settle()
  expect(f.adapter.inputs).toHaveLength(1)
  expect((await f.view(task.id)).candidates).toHaveLength(0)
  expect((await f.view(task.id)).batches[0].status).toBe("failed")
  expect(f.store.memories()).toHaveLength(0)
})

test("foreground chat preempts background extraction, aborts its session and still runs the user's request", async () => {
  const f = setup(), oldTask = f.task(), current = f.task("请检查当前文件。", "project-b")
  const blocked = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>()
  f.adapter.beforePrompt = async () => { reached.resolve(); await blocked.promise }
  f.adapter.onAbort = () => blocked.resolve()
  expect((await f.request("/api/memory-review", { taskId: oldTask.id, key: "background-before-foreground" })).status).toBe(202)
  await reached.promise
  expect(f.app.jobs.size).toBe(0)
  expect(f.app.reviewJobs.size).toBe(1)
  try {
    expect((await f.request(`/api/tasks/${current.id}/chat`, { key: "foreground-preempt", text: "现在先处理这件事。" })).status).toBe(202)
  } finally { blocked.resolve() }
  await f.settle()
  expect(f.adapter.aborts).toEqual([f.adapter.sessions[0]])
  expect(f.adapter.foreground).toEqual(["现在先处理这件事。"])
  expect(f.adapter.inputs).toHaveLength(1)
  expect((await f.view(oldTask.id)).candidates).toHaveLength(0)
  expect((await f.view(oldTask.id)).batches[0].status).toBe("interrupted")
  expect((await f.view(oldTask.id)).batches[0].cleanup).toBe("deleted")
  expect(f.store.task(current.id)?.status).toBe("verifying")
})

test("HTTP sealing cancels the extraction and later unsealing does not replay its model request", async () => {
  const f = setup(), task = f.task(), blocked = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>()
  f.adapter.beforePrompt = async () => { reached.resolve(); await blocked.promise }
  f.adapter.onAbort = () => blocked.resolve()
  await f.request("/api/memory-review", { taskId: task.id, key: "cancel-on-seal" })
  await reached.promise
  try { expect((await f.request("/api/seal", { sealed: true })).status).toBe(200) } finally { blocked.resolve() }
  await f.settle()
  expect(f.adapter.aborts).toEqual([f.adapter.sessions[0]])
  expect((await f.view(task.id)).batches[0]).toMatchObject({ status: "interrupted", cleanup: "deleted" })
  expect((await f.view(task.id)).candidates).toHaveLength(0)
  expect((await f.request("/api/seal", { sealed: false })).status).toBe(200)
  await idleMaintenance(f.app)
  await f.settle()
  expect(f.adapter.inputs).toHaveLength(1)
  expect(f.store.memories()).toHaveLength(0)
})

test("deleting a source while the model is running prevents late candidate resurrection and cleans its session", async () => {
  const f = setup(), task = f.task("本项目的秘密代号是雨燕。"), source = f.store.experiencesAfter(0)[0]
  const memory = f.store.remember({ scope: task.scope, kind: "fact", text: source.text, sourceIds: [source.id] })
  const blocked = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>()
  f.adapter.beforePrompt = async () => { reached.resolve(); await blocked.promise }
  f.adapter.onAbort = () => blocked.resolve()
  await f.request("/api/memory-review", { taskId: task.id, key: "forget-during-model" })
  await reached.promise
  try { expect((await f.request(`/api/memories/${memory.id}`, { revision: memory.revision }, "DELETE")).status).toBe(200) } finally { blocked.resolve() }
  await f.settle()
  const view = await f.view(task.id)
  expect(view.batches[0]).toMatchObject({ status: "redacted", cleanup: "deleted" })
  expect(view.candidates).toHaveLength(0)
  expect(JSON.stringify(view)).not.toContain("雨燕")
  expect(f.adapter.inputs).toHaveLength(1)
  expect(f.adapter.cleanupCalls).toHaveLength(1)
  expect(f.store.experience(source.id)).toMatchObject({ retracted: true, text: "" })
})

test("cleanup failures remain visible and maintenance retries only cleanup, never extraction", async () => {
  const f = setup(), task = f.task()
  f.adapter.cleanupResult = false
  await f.request("/api/memory-review", { taskId: task.id, key: "cleanup-failed" })
  await f.settle()
  expect((await f.view(task.id)).batches[0]).toMatchObject({ status: "completed", cleanup: "pending" })
  expect(f.adapter.inputs).toHaveLength(1)
  const candidateId = (await f.view(task.id)).candidates[0].id
  f.adapter.cleanupResult = true
  await idleMaintenance(f.app)
  await f.settle()
  expect(f.adapter.cleanupCalls).toHaveLength(2)
  expect(f.adapter.inputs).toHaveLength(1)
  expect(f.adapter.sessions).toHaveLength(1)
  expect((await f.view(task.id)).batches[0]).toMatchObject({ status: "completed", cleanup: "deleted" })
  expect((await f.view(task.id)).candidates[0].id).toBe(candidateId)
})

test("startup recovers an unfinished review by cleaning its owned session without resending inference", async () => {
  let taskId = "", batchId = ""
  const f = setup(new ReviewAdapter(), store => {
    const task = store.createTask("上次中断的对话整理", "a")
    taskId = task.id
    store.addChat(task.id, "user", "请记住我希望先给结论。")
    const review = new MemoryReviewStore(store), { batch } = review.begin(task.id, "previous-process")
    batchId = batch.id
    review.attachSession(batch.id, "previous-owned-session")
  })
  await idleMaintenance(f.app)
  await f.settle()
  expect((await f.view(taskId)).batches[0]).toMatchObject({ id: batchId, status: "interrupted", cleanup: "deleted" })
  expect(f.adapter.cleanupCalls).toEqual([{ sessionID: "previous-owned-session", jobID: batchId }])
  expect(f.adapter.inputs).toHaveLength(0)
  expect(f.adapter.sessions).toHaveLength(0)
  expect(f.store.memories()).toHaveLength(0)
})

test("shutdown waits for background session cleanup before publishing its checkpoint", async () => {
  const f = setup(), task = f.task(), blocked = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>()
  f.adapter.beforeCleanup = async () => { reached.resolve(); await blocked.promise }
  await f.request("/api/memory-review", { taskId: task.id, key: "cleanup-before-shutdown" })
  await reached.promise
  let returned = false
  const shutdown = f.request("/api/shutdown", {}).then(response => { returned = true; return response })
  try {
    expect(await listCheckpoints(join(f.dir, "vault"))).toHaveLength(0)
    expect(returned).toBe(false)
  } finally { blocked.resolve() }
  const response = await shutdown
  expect(response.status).toBe(200)
  const checkpoints = await listCheckpoints(join(f.dir, "vault"))
  expect(checkpoints).toHaveLength(1)
  expect((await response.json()).generation).toBe(checkpoints[0].generation)
  const snapshot = new Database(join(f.dir, "vault", "checkpoints", checkpoints[0].generation, "state.sqlite"), { readonly: true })
  try {
    const batch = snapshot.query<{ body: string }, []>("SELECT body FROM memory_review_batches").get()!
    expect(JSON.parse(batch.body)).toMatchObject({ taskId: task.id, cleanup: "deleted" })
  } finally { snapshot.close() }
})

test("automatic sleep extraction is opt-in and its rolling daily admission limit counts manual work", async () => {
  const f = setup(), first = f.task(), second = f.task("本项目优先解释技术取舍。", "project-b")
  const defaults = await (await f.request("/api/memory-review/settings")).json()
  expect(defaults).toMatchObject({ automatic: false, dailyBatchLimit: 4 })
  await idleMaintenance(f.app)
  await f.settle()
  expect(f.adapter.inputs).toHaveLength(0)
  expect((await f.request("/api/memory-review/settings", { automatic: true, model: null, dailyBatchLimit: 0 })).status).toBe(400)
  expect((await f.request("/api/memory-review/settings", { automatic: true, model: null, dailyBatchLimit: 13 })).status).toBe(400)
  const settings = { automatic: true, model: { providerID: "fixture", modelID: "test-model" }, dailyBatchLimit: 1 }
  expect((await f.request("/api/memory-review/settings", settings)).status).toBe(200)
  await idleMaintenance(f.app)
  await f.settle()
  expect(f.adapter.inputs).toHaveLength(1)
  expect(f.adapter.inputs[0].options).toMatchObject({ model: settings.model })
  expect((await f.view(first.id)).batches[0]).toMatchObject({ status: "completed", cleanup: "deleted" })
  await idleMaintenance(f.app)
  await f.settle()
  expect(f.adapter.inputs).toHaveLength(1)
  expect((await f.view(second.id)).batches).toHaveLength(0)
  // The cap limits unattended admissions. An explicit user request can still
  // proceed, and is included in the next unattended rolling-day count.
  expect((await f.request("/api/memory-review", { taskId: second.id, key: "explicit-over-auto-cap" })).status).toBe(202)
  await f.settle()
  expect(f.adapter.inputs).toHaveLength(2)
  const third = f.task("以后重要修改保留原因。", "project-c")
  await idleMaintenance(f.app)
  await f.settle()
  expect(f.adapter.inputs).toHaveLength(2)
  expect((await f.view(third.id)).batches).toHaveLength(0)
  expect(f.store.memories()).toHaveLength(0)
})

test("a manual batch consumes the later automatic admission allowance", async () => {
  const f = setup(), first = f.task(), second = f.task("今后的报告避免重复。", "b")
  await f.request("/api/memory-review", { taskId: first.id, key: "manual-before-auto" })
  await f.settle()
  expect(f.adapter.inputs).toHaveLength(1)
  expect((await f.request("/api/memory-review/settings", { automatic: true, model: null, dailyBatchLimit: 1 })).status).toBe(200)
  await idleMaintenance(f.app)
  await f.settle()
  expect(f.adapter.inputs).toHaveLength(1)
  expect((await f.view(second.id)).batches).toHaveLength(0)
})

test("failed automatic extraction does not keep charging repeated inference on later idle cycles", async () => {
  const f = setup(), task = f.task()
  f.adapter.response = () => { throw new Error("fixture model refused") }
  await f.request("/api/memory-review/settings", { automatic: true, model: null, dailyBatchLimit: 12 })
  await idleMaintenance(f.app)
  await f.settle()
  expect((await f.view(task.id)).batches[0]).toMatchObject({ status: "failed", cleanup: "deleted" })
  await idleMaintenance(f.app)
  await f.settle()
  expect(f.adapter.inputs).toHaveLength(1)
  expect((await f.view(task.id)).batches).toHaveLength(1)
  expect((await f.request("/api/memory-review", { taskId: task.id, key: "explicit-retry-after-auto-failure" })).status).toBe(202)
  await f.settle()
  expect(f.adapter.inputs).toHaveLength(2)
})

test("actual private chat evidence and sealed-period chat never reach the extraction transport", async () => {
  const f = setup(), task = f.task("公开偏好：回答先给结论。")
  const privateMessage = f.store.addChat(task.id, "user", "私密聊天标记：紫色星尘。")
  const source = f.store.experiencesAfter(0).find(item => item.evidence?.chatMessageId === privateMessage.id)!
  // The current chat API has no privacy toggle; this fixture restores a valid
  // private-source policy directly into its isolated domain database.
  f.store.db.query("UPDATE experiences SET body=? WHERE id=?").run(JSON.stringify({ ...source, private: true }), source.id)
  f.store.setSealed(true)
  f.store.addChat(task.id, "user", "封存聊天标记：蓝色雨燕。")
  f.store.setSealed(false)
  await f.request("/api/memory-review", { taskId: task.id, key: "exclude-private-and-sealed" })
  await f.settle()
  expect(f.adapter.inputs).toHaveLength(1)
  expect(f.adapter.inputs[0].text).toContain("回答先给结论")
  expect(f.adapter.inputs[0].text).not.toContain("紫色星尘")
  expect(f.adapter.inputs[0].text).not.toContain("蓝色雨燕")
  expect(JSON.parse(f.adapter.inputs[0].text).sources).toHaveLength(1)
})
