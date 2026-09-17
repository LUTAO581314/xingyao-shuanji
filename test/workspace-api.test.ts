import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SoulStore } from "../src/store"
import { OpenCodeAdapter } from "../src/adapter"
import { startServer } from "../src/server"

const fixtures: { root: string; store: SoulStore; app: ReturnType<typeof startServer> }[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xingyao-workspace-api-")), project = join(root, "project"), host = join(root, "host")
  mkdirSync(project); mkdirSync(host)
  const store = new SoulStore(join(host, "soul.db"))
  const app = startServer({ store, token: "workspace-fixture", adapter: new OpenCodeAdapter({ baseURL: "http://127.0.0.1:1" }), vaultDir: join(root, "vault"), workspaceDirectory: project })
  fixtures.push({ root, store, app })
  const request = (path: string, input?: unknown, method = input === undefined ? "GET" : "POST", headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${app.server.port}/api${path}`, { method, headers: { authorization: "Bearer workspace-fixture", "content-type": "application/json", ...headers }, body: input === undefined ? undefined : JSON.stringify(input) })
  return { root, project, host, store, request }
}
afterEach(async () => {
  for (const item of fixtures.splice(0)) { await item.app.server.stop(true); item.store.close(); rmSync(item.root, { recursive: true, force: true }) }
})
test("workspace HTTP edits preserve BOM and CRLF, refresh source graph, and retain privacy and scope", async () => {
  const { project, request } = fixture(), path = join(project, "说明.md")
  writeFileSync(path, Buffer.from("\uFEFF第一行\r\n最初资料\r\n"))
  const roots = await (await request("/workspace/roots")).json()
  expect(roots.error).toBeNull()
  expect(roots.roots[0].id).toBe(roots.defaultRootId)
  const rootId = roots.defaultRootId
  const listing = await (await request(`/workspace/list?rootId=${rootId}`)).json()
  expect(listing.entries).toHaveLength(1)
  expect(listing.entries[0].editable).toBe(true)
  const imported = await (await request("/workspace/import", { rootId, path: "说明.md", scope: "project-a", private: true })).json()
  expect(imported.private).toBe(true)
  const old = await (await request(`/workspace/file?${new URLSearchParams({ rootId, path: "说明.md" })}`)).json()
  expect(old.bom).toBe(true)
  expect(old.lineEnding).toBe("crlf")
  const response = await request("/workspace/file", { rootId, path: "说明.md", expectedSha256: old.sha256, text: "第一行\n修改后的资料\n" }, "PUT")
  expect(response.status).toBe(200)
  const saved = await response.json()
  expect(readFileSync(path, "utf8")).toBe("\uFEFF第一行\r\n修改后的资料\r\n")
  expect(readFileSync(saved.backupPath, "utf8")).toBe("\uFEFF第一行\r\n最初资料\r\n")
  expect(saved.knowledge).toEqual({ refreshed: 1, warnings: [] })
  const docs = await (await request("/knowledge")).json()
  expect(docs[0].id).toBe(imported.id)
  expect(docs[0].scope).toBe("project-a")
  expect(docs[0].private).toBe(true)
  expect(docs[0].contentHash).toBe(saved.sha256)
  expect(docs[0].revision).toBe(imported.revision + 1)
  expect((await (await request("/graph?scope=project-a")).json()).nodes).toHaveLength(0)
  const graph = await (await request("/graph?scope=project-a&private=true")).json()
  expect(graph.nodes.some((node: { id: string }) => node.id === `document:${imported.id}`)).toBe(true)
})
test("workspace HTTP rejects stale saves, protected roots, traversal and unauthenticated requests", async () => {
  const { project, host, request } = fixture()
  writeFileSync(join(project, "a.md"), "first")
  const { defaultRootId: rootId } = await (await request("/workspace/roots")).json()
  const old = await (await request(`/workspace/file?rootId=${rootId}&path=a.md`)).json()
  writeFileSync(join(project, "a.md"), "external-change")
  expect((await request("/workspace/file", { rootId, path: "a.md", expectedSha256: old.sha256, text: "editor" }, "PUT")).status).toBe(409)
  expect(readFileSync(join(project, "a.md"), "utf8")).toBe("external-change")
  expect((await request("/workspace/roots", { directory: host })).status).toBe(403)
  expect((await request(`/workspace/file?rootId=${rootId}&path=../host/soul.db`)).status).toBe(403)
  expect((await request("/workspace/roots", undefined, "GET", { authorization: "Bearer wrong" })).status).toBe(401)
  expect((await request("/workspace/roots", undefined, "GET", { origin: "https://external.invalid" })).status).toBe(403)
  expect((await request("/workspace/import", { rootId, path: "a.md", scope: "project" })).status).toBe(400)
})
test("workspace HTTP accepts large text and empty edits without relaxing normal API limits", async () => {
  const { project, request } = fixture()
  writeFileSync(join(project, "large.md"), "initial")
  const { defaultRootId: rootId } = await (await request("/workspace/roots")).json()
  const file = await (await request(`/workspace/file?rootId=${rootId}&path=large.md`)).json()
  const content = "中文正文\n".repeat(25000)
  const response = await request("/workspace/file", { rootId, path: "large.md", expectedSha256: file.sha256, text: content }, "PUT")
  expect(response.status).toBe(200)
  const saved = await response.json()
  expect(readFileSync(join(project, "large.md"), "utf8")).toBe(content)
  const empty = await request("/workspace/file", { rootId, path: "large.md", expectedSha256: saved.sha256, text: "" }, "PUT")
  expect(empty.status).toBe(200)
  expect(readFileSync(join(project, "large.md"))).toHaveLength(0)
  expect((await request("/memories", { key: "huge", kind: "fact", text: "x".repeat(210000) })).status).toBe(400)
})
