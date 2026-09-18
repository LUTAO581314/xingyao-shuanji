import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { OpenCodeAdapter, type CollaborationView } from "../src/adapter"
import { startServer } from "../src/server"
import { SoulStore } from "../src/store"

class CollaborationAdapter extends OpenCodeAdapter {
  readonly roots: string[] = []
  constructor() { super({ baseURL: "http://127.0.0.1:1", timeoutMs: 50 }) }
  override async collaboration(rootSessionID: string): Promise<CollaborationView> {
    this.roots.push(rootSessionID)
    return {
      rootSessionID, truncated: false, limits: { sessions: 32, depth: 4, transcriptBytes: 2 * 1024 * 1024 },
      sessions: [{
        sessionID: `${rootSessionID}-child`, parentSessionID: rootSessionID, title: `child of ${rootSessionID}`, agent: "review", depth: 1,
        status: { type: "idle" }, createdAt: 1, updatedAt: 2, messageCount: 1, transcriptTruncated: false,
        messages: [{ sourceID: `opencode:legacy:${rootSessionID}-child:msg_1`, messageID: "msg_1", role: "assistant", text: "verified child result", status: "completed", createdAt: 1, completedAt: 2, tools: [] }],
      }],
    }
  }
}

const fixtures: Array<{ root: string; store: SoulStore; app: ReturnType<typeof startServer> }> = []
function setup() {
  const root = mkdtempSync(join(tmpdir(), "xingyao-collaboration-api-"))
  const store = new SoulStore(join(root, "host", "soul.db")), adapter = new CollaborationAdapter()
  const app = startServer({ store, adapter, vaultDir: join(root, "vault"), token: "collaboration-fixture" })
  fixtures.push({ root, store, app })
  const request = (taskId: string, authorization = "Bearer collaboration-fixture") => fetch(`http://127.0.0.1:${app.server.port}/api/tasks/${taskId}/collaboration`, { headers: { authorization } })
  return { store, adapter, request }
}
function durableState(store: SoulStore) {
  return JSON.stringify({ revision: store.revision, tasks: store.tasks(), chats: store.tasks().map(task => store.chats(task.id)), actions: store.tasks().map(task => store.actions(task.id)), memories: store.memories({ private: true, history: true }), experiences: store.experiencesAfter(0, 100) })
}
afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await item.app.server.stop(true)
    item.store.close()
    rmSync(item.root, { recursive: true, force: true })
  }
})

test("collaboration HTTP is authenticated, task-scoped and read-only", async () => {
  const { store, adapter, request } = setup()
  const first = store.createTask("first", "global"), second = store.createTask("second", "private-project")
  store.updateTask(first.id, { sessionId: "ses_first", status: "running" })
  store.updateTask(second.id, { sessionId: "ses_second", status: "verifying" })
  store.addChat(first.id, "user", "delegate the review", "seed-chat")
  const before = durableState(store)

  expect((await request(first.id, "Bearer invalid")).status).toBe(401)
  const firstView = await (await request(first.id)).json() as CollaborationView
  expect(firstView.rootSessionID).toBe("ses_first")
  expect(firstView.sessions[0]).toMatchObject({ sessionID: "ses_first-child", parentSessionID: "ses_first" })
  expect(JSON.stringify(firstView)).not.toContain("ses_second")
  const secondView = await (await request(second.id)).json() as CollaborationView
  expect(secondView.rootSessionID).toBe("ses_second")
  expect(adapter.roots).toEqual(["ses_first", "ses_second"])
  expect(durableState(store)).toBe(before)
})

test("a task without an engine session returns an empty view without querying OpenCode", async () => {
  const { store, adapter, request } = setup()
  const task = store.createTask("not started", "global"), before = durableState(store)
  const response = await request(task.id)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ rootSessionID: null, sessions: [], delegations: [], truncated: false, limits: null })
  expect(adapter.roots).toEqual([])
  expect(durableState(store)).toBe(before)
  expect((await request("missing-task")).status).toBe(404)
})
