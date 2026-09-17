import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SoulStore } from "../src/store"
import { OpenCodeAdapter } from "../src/adapter"
import { startServer } from "../src/server"
import { listCheckpoints, restoreCheckpoint } from "../src/checkpoint"

const fixtures: { dir: string; store: SoulStore; app: ReturnType<typeof startServer> }[] = []
function setup(adapter = new OpenCodeAdapter({ baseURL: "http://127.0.0.1:1", timeoutMs: 50 })) {
  const dir = mkdtempSync(join(tmpdir(), "xingyao-server-"))
  const store = new SoulStore(join(dir, "host", "soul.db"))
  const app = startServer({ store, adapter, token: "test-only-token", vaultDir: join(dir, "vault") })
  fixtures.push({ dir, store, app })
  const request = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST", headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${app.server.port}${path}`, { method, headers: { authorization: "Bearer test-only-token", "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { dir, store, app, request }
}
afterEach(async () => { for (const item of fixtures.splice(0)) { await item.app.server.stop(true); await Promise.allSettled([...item.app.jobs.values()]); item.store.close(); rmSync(item.dir, { recursive: true, force: true }) } })

test("browser assets load and APIs require both token and valid origin", async () => {
  const { request } = setup()
  const page = await request("/")
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
  expect(page.headers.get("content-security-policy")).toContain("style-src 'self' 'sha256-pgvDUBa4IjFA2yuSJ2cqcyxmNYJMborsd0ORcRv9vw8='")
  expect(page.headers.get("content-security-policy")).not.toContain("unsafe-inline")
  expect(await page.text()).toContain("星杳")
  expect((await request("/app.js")).headers.get("content-type")).toContain("javascript")
  expect((await request("/api/state", undefined, "GET", { authorization: "Bearer invalid" })).status).toBe(401)
  expect((await request("/api/state", undefined, "GET", { origin: "https://example.com" })).status).toBe(403)
  expect((await request("/api/state", undefined, "GET", { host: "evil.invalid" })).status).toBe(403)
  expect((await request("/api/state")).status).toBe(200)
})

test("memory revisions, input validation and snapshot restore survive HTTP lifecycle", async () => {
  const { dir, request, store } = setup()
  const created = await (await request("/api/memories", { key: "one", text: "回答先给结论", kind: "preference", scope: "global", pinned: true })).json()
  expect(created.sourceIds).toHaveLength(1)
  expect((await request(`/api/memories/${created.id}`, { revision: 90, text: "stale" }, "PATCH")).status).toBe(409)
  const revised = await (await request(`/api/memories/${created.id}`, { revision: 1, text: "回答完整且清楚" }, "PATCH")).json()
  expect(revised.supersedes).toBe(created.id)
  expect((await request("/api/memories", { key: "bad", text: "bad", kind: "nonexistent" })).status).toBe(400)
  const snapshot = await (await request("/api/checkpoint", {})).json()
  expect(snapshot.identityId).toBe(store.identityId)
  expect((await listCheckpoints(join(dir, "vault")))).toHaveLength(1)
  await restoreCheckpoint(join(dir, "vault"), snapshot.generation, join(dir, "other-host", "soul.db"))
  const restored = new SoulStore(join(dir, "other-host", "soul.db"))
  try { expect(restored.identityId).toBe(store.identityId); expect(restored.memories()[0].text).toBe("回答完整且清楚") } finally { restored.close() }
  expect((await (await request("/api/state")).json()).unsynced).toBe(false)
})

test("unavailable engine keeps an admitted task durable and does not fabricate response", async () => {
  const { request, app, store } = setup()
  const task = await (await request("/api/tasks", { key: "task", title: "隔离测试", scope: "a" })).json()
  const response = await request(`/api/tasks/${task.id}/chat`, { key: "prompt", text: "check project" })
  expect(response.status).toBe(202)
  await Promise.allSettled([...app.jobs.values()])
  expect(store.task(task.id)?.status).toBe("waiting")
  expect(store.chats(task.id).filter(message => message.role === "assistant")).toHaveLength(0)
  expect(store.chats(task.id)[0].text).toBe("check project")
  expect((await request(`/api/tasks/${task.id}/reconcile`, {})).status).toBe(200)
  expect(store.task(task.id)?.status).toBe("ready")
  await request(`/api/tasks/${task.id}/chat`, { key: "prompt", text: "check project" })
  expect(app.jobs.size).toBe(0)
  expect(store.chats(task.id)).toHaveLength(1)
})

test("a provider reusing a tool call ID in different messages cannot overwrite earlier evidence", async () => {
  class ReusedCallAdapter extends OpenCodeAdapter {
    delivered = false
    override async health() { return { ok: true, version: "local-fixture", capabilities: { legacyHTTP: true, promptSystem: true, durableMessages: true, toolResults: true, permissions: true, v2Detected: false, v2Supported: false as const } } }
    override async createSession() { return { id: "session-fixture" } }
    override async prompt() { this.delivered = true; return { messageID: "message-2", text: "", parts: [], status: "completed" as const } }
    override async messages() {
      if (!this.delivered) return []
      return [1, 2].map(n => ({ sourceID: `message-${n}`, sessionID: "session-fixture", messageID: `message-${n}`, role: "assistant" as const, text: "", status: "completed" as const, time: { created: n }, parts: [{ type: "tool" as const, sourceID: `part-${n}`, sessionID: "session-fixture", messageID: `message-${n}`, id: `part-${n}`, callID: "provider-reused-id", tool: "read", status: "completed" as const, upstreamStatus: "completed", input: {}, output: `distinct evidence ${n}` }] }))
    }
  }
  const { request, app, store } = setup(new ReusedCallAdapter({ baseURL: "http://127.0.0.1:1" }))
  const task = store.createTask("evidence", "global")
  await request(`/api/tasks/${task.id}/chat`, { key: "distinct-calls", text: "read both" })
  await Promise.allSettled([...app.jobs.values()])
  expect(store.actions(task.id)).toHaveLength(2)
  expect(store.actions(task.id).map(action => action.text)).toEqual(["read：执行成功\ndistinct evidence 1", "read：执行成功\ndistinct evidence 2"])
})
