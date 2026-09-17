import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SoulStore } from "../src/store"
import { OpenCodeAdapter } from "../src/adapter"
import { startServer } from "../src/server"

const fixtures: { dir: string; store: SoulStore; app: ReturnType<typeof startServer> }[] = []
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "xingyao-graph-api-"))
  const store = new SoulStore(join(dir, "host", "soul.db"))
  const app = startServer({ store, adapter: new OpenCodeAdapter({ baseURL: "http://127.0.0.1:1", timeoutMs: 50 }), vaultDir: join(dir, "vault"), token: "graph-test-only" })
  fixtures.push({ dir, store, app })
  const request = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST", headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${app.server.port}${path}`, { method, headers: { authorization: "Bearer graph-test-only", "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const document = async (name: string, content: string, scope = "global", privateValue = false) => {
    const path = join(dir, name)
    writeFileSync(path, content)
    const response = await request("/api/knowledge", { path, scope, private: privateValue })
    expect(response.status).toBe(201)
    return response.json()
  }
  const source = (id: string, params = "") => request(`/api/graph/source?id=${encodeURIComponent(id)}${params}`)
  return { dir, store, request, document, source }
}
afterEach(async () => {
  for (const { dir, store, app } of fixtures.splice(0)) { await app.server.stop(true); store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
})

test("graph and source endpoints enforce authentication, origin and explicit parameter validation", async () => {
  const { request } = setup()
  for (const path of ["/api/graph", "/api/graph/source?id=memory:any"]) {
    expect((await request(path, undefined, "GET", { authorization: "" })).status).toBe(401)
    expect((await request(path, undefined, "GET", { origin: "https://external.example" })).status).toBe(403)
    expect((await request(path, undefined, "GET", { host: "external.example" })).status).toBe(403)
  }
  for (const query of ["private=yes", "scope=", "maxNodes=0", "maxNodes=2001", "maxEdges=-1", "maxNodes=1e2", "maxNodes=", "maxEdges=1.5"]) expect((await request(`/api/graph?${query}`)).status).toBe(400)
  for (const query of ["", "id=memory:any&startLine=0", "id=document:any&lineLimit=201", "id=memory:any&lineLimit=-1"]) expect((await request(`/api/graph/source?${query}`)).status).toBe(400)
  const empty = await request("/api/graph")
  expect(empty.headers.get("cache-control")).toBe("no-store")
  expect((await empty.json()).nodes).toEqual([])
})

test("graph source access stays within project and private scope, including direct IDs", async () => {
  const { request, document, source, store } = setup()
  const shared = await document("shared.md", "shared")
  const hidden = await document("private.md", "PRIVATE_FIXTURE_BODY", "a", true)
  const foreign = await document("foreign.md", "FOREIGN_FIXTURE_BODY", "b")
  const memory = store.explicitMemory({ key: "private-memory", text: "PRIVATE_MEMORY", kind: "preference", scope: "a", private: true })
  const eventId = memory.sourceIds[0]!
  const graph = await (await request("/api/graph?scope=a")).json()
  expect(graph.nodes.map((node: { id: string }) => node.id)).toEqual([`document:${shared.id}`])
  for (const id of [`document:${hidden.id}`, `document:${foreign.id}`, `memory:${memory.id}`, `experience:${eventId}`]) expect((await source(id, "&scope=a")).status).toBe(404)
  expect((await source(`document:${hidden.id}`, "&scope=a&private=true")).status).toBe(200)
  expect((await source(`memory:${memory.id}`, "&scope=a&private=true")).status).toBe(200)
  expect((await source(`experience:${eventId}`, "&scope=a&private=true")).status).toBe(200)
  expect((await source(`document:${foreign.id}`, "&scope=a&private=true")).status).toBe(404)
  expect((await source(`document:${shared.id}`, "&scope=a")).status).toBe(200)
})

test("linked document evidence opens the imported revision and follows explicit refresh or removal", async () => {
  const { request, document, source } = setup()
  const target = await document("target.md", "# target")
  const origin = await document("source.md", "first\n[[target]]\n<script>globalThis.untrusted = true</script>\nlast")
  const graph = await (await request("/api/graph")).json()
  expect(graph.edges).toHaveLength(1)
  const edge = graph.edges[0]
  expect(edge.to).toBe(`document:${target.id}`)
  const opened = await (await source(edge.from, `&startLine=${edge.evidence.line}&lineLimit=2`)).json()
  expect(opened.contentHash).toBe(edge.evidence.contentHash)
  expect(opened.lines).toEqual([{ number: 2, text: "[[target]]" }, { number: 3, text: "<script>globalThis.untrusted = true</script>" }])
  writeFileSync(origin.path, "changed outside\n[[missing]]")
  expect((await (await source(edge.from)).json()).contentHash).toBe(origin.contentHash)
  await request(`/api/knowledge/${origin.id}`, {})
  const changed = await (await source(edge.from)).json()
  expect(changed.contentHash).not.toBe(origin.contentHash)
  expect(changed.lines[0].text).toBe("changed outside")
  expect((await (await request("/api/graph")).json()).edges).toHaveLength(0)
  await request(`/api/knowledge/${origin.id}`, {}, "DELETE")
  expect((await source(edge.from)).status).toBe(404)
})

test("a memory correction invalidates old graph selections and deletion removes new sources", async () => {
  const { request, source, store } = setup()
  const first = store.explicitMemory({ key: "correctable", text: "old preference", kind: "preference", scope: "global" })
  const next = await (await request(`/api/memories/${first.id}`, { revision: first.revision, text: "new preference" }, "PATCH")).json()
  expect((await source(`memory:${first.id}`)).status).toBe(404)
  expect((await (await source(`memory:${next.id}`)).json()).memory.text).toBe("new preference")
  const graph = await (await request("/api/graph")).json()
  expect(graph.nodes.some((node: { id: string }) => node.id === `memory:${first.id}`)).toBe(false)
  expect(graph.nodes.some((node: { id: string }) => node.id === `memory:${next.id}`)).toBe(true)
  await request(`/api/memories/${next.id}`, { revision: next.revision }, "DELETE")
  expect((await source(`memory:${next.id}`)).status).toBe(404)
  expect((await (await request("/api/graph")).json()).nodes).toEqual([])
})
