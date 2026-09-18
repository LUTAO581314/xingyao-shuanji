import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { SoulStore } from "../src/store"
import { OpenCodeAdapter } from "../src/adapter"
import { startServer } from "../src/server"

const fixtures: Array<{ dir: string; close: () => Promise<void> }> = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "xingyao-draft-http-")), project = join(dir, "project"), db = join(dir, "host", "soul.db")
  mkdirSync(project); writeFileSync(join(project, "a.md"), "磁盘原文")
  let store: SoulStore, app: ReturnType<typeof startServer>
  const open = () => { store = new SoulStore(db); app = startServer({ store, token: "draft-http-fixture", adapter: new OpenCodeAdapter({ baseURL: "http://127.0.0.1:1" }), vaultDir: join(dir, "vault"), workspaceDirectory: project }) }
  open()
  const close = async () => { await app.server.stop(true); store.close() }
  fixtures.push({ dir, close })
  const request = (path: string, input?: unknown, method = input === undefined ? "GET" : "POST") => fetch(`http://127.0.0.1:${app.server.port}/api${path}`, { method, headers: { authorization: "Bearer draft-http-fixture", "content-type": "application/json" }, body: input === undefined ? undefined : JSON.stringify(input) })
  const root = async () => (await (await request("/workspace/roots")).json()).defaultRootId as string
  const file = async (rootId: string) => (await (await request(`/workspace/file?rootId=${rootId}&path=a.md`)).json())
  return { dir, project, request, root, file, restart: async () => { await close(); open() }, get store() { return store }, get app() { return app } }
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.close(); rmSync(f.dir, { recursive: true, force: true }) } })

test("HTTP draft survives server restart with new directory capability and never changes its source file", async () => {
  const f = fixture(), rootId = await f.root(), before = await f.file(rootId)
  expect(before.draftRevision).toBe(0)
  const response = await f.request("/workspace/draft", { rootId, path: "a.md", revision: 0, key: "saved", baseSha256: before.sha256, text: "未写盘的编辑" }, "PUT")
  expect(response.status).toBe(200)
  const saved = await response.json()
  expect(readFileSync(join(f.project, "a.md"), "utf8")).toBe("磁盘原文")
  expect(f.store.experiencesAfter(0)).toEqual([])
  await f.restart()
  const newRoot = await f.root(), after = await f.file(newRoot)
  expect(newRoot).not.toBe(rootId)
  expect(after.draft).toEqual(saved.draft)
  expect(after.text).toBe("磁盘原文")
  expect((await f.request("/workspace/draft", { rootId, path: "a.md", revision: 1, key: "stale-capability", baseSha256: before.sha256, text: "不能覆盖" }, "PUT")).status).toBe(403)
})

test("HTTP draft creation requires an actual file read and stale autosaves cannot revive a deleted draft", async () => {
  const f = fixture(), rootId = await f.root()
  const input = { rootId, path: "a.md", revision: 0, key: "write", baseSha256: "0".repeat(64), text: "草稿" }
  expect((await f.request("/workspace/draft", input, "PUT")).status).toBe(409)
  const file = await f.file(rootId); input.baseSha256 = file.sha256
  expect((await f.request("/workspace/draft", input, "PUT")).status).toBe(200)
  expect((await f.request("/workspace/draft", { rootId, path: "a.md", revision: 1, key: "delete" }, "DELETE")).status).toBe(200)
  expect((await f.request("/workspace/draft", input, "PUT")).status).toBe(409)
  expect((await f.file(rootId)).draft).toBeNull()
})

test("HTTP external change retains the draft and only explicit rebase updates its disk comparison", async () => {
  const f = fixture(), rootId = await f.root(), before = await f.file(rootId)
  await f.request("/workspace/draft", { rootId, path: "a.md", revision: 0, key: "draft", baseSha256: before.sha256, text: "编辑稿" }, "PUT")
  writeFileSync(join(f.project, "a.md"), "外部写入")
  const after = await f.file(rootId)
  expect(after.draft.baseSha256).toBe(before.sha256)
  expect(after.sha256).not.toBe(before.sha256)
  const changed = { rootId, path: "a.md", revision: 1, key: "merge", baseSha256: after.sha256, text: "核对外部写入后合并的稿件" }
  expect((await f.request("/workspace/draft", changed, "PUT")).status).toBe(409)
  expect((await f.request("/workspace/draft", changed, "PATCH")).status).toBe(200)
  expect(readFileSync(join(f.project, "a.md"), "utf8")).toBe("外部写入")
  expect((await f.file(rootId)).draft.text).toBe(changed.text)
})

test("draft transport accepts large and empty text while ordinary APIs keep their lower limit", async () => {
  const f = fixture(), rootId = await f.root(), before = await f.file(rootId)
  const large = { rootId, path: "a.md", revision: 0, key: "large", baseSha256: before.sha256, text: "中文编辑\n".repeat(25000) }
  expect((await f.request("/workspace/draft", large, "PUT")).status).toBe(200)
  expect((await f.request("/workspace/draft", { ...large, revision: 1, key: "empty", text: "" }, "PUT")).status).toBe(200)
  expect((await f.file(rootId)).draft.text).toBe("")
  expect((await f.request("/memories", { kind: "fact", key: "large", text: large.text.repeat(3) })).status).toBe(400)
})

test("authenticated draft text can be recovered by ID even when its entire project is unavailable", async () => {
  const f = fixture(), rootId = await f.root(), before = await f.file(rootId)
  const saved = await (await f.request("/workspace/draft", { rootId, path: "a.md", revision: 0, key: "offline-project", baseSha256: before.sha256, text: "离线项目的草稿正文" }, "PUT")).json()
  renameSync(f.project, join(f.dir, "project-unavailable"))
  await f.restart()
  expect(await f.root()).toBeNull()
  const recovered = await (await f.request(`/workspace/draft?id=${saved.draft.id}`)).json()
  expect(recovered).toEqual(saved)
  expect((await f.request(`/workspace/draft?id=../../outside`)).status).toBe(400)
  expect((await fetch(`http://127.0.0.1:${f.app.server.port}/api/workspace/draft?id=${saved.draft.id}`)).status).toBe(401)
  expect(readFileSync(join(f.dir, "project-unavailable", "a.md"), "utf8")).toBe("磁盘原文")
})

for (const boundary of ["source-archived", "destination-written"] as const) test(`server recovery reconciles imported knowledge after abrupt ${boundary} exit`, async () => {
  const f = fixture(), rootId = await f.root()
  const imported = await (await f.request("/workspace/import", { rootId, path: "a.md", scope: "recovery-project", private: true })).json()
  const code = `import {WorkspaceFiles} from ${JSON.stringify(resolve(import.meta.dir, "../src/workspace-files.ts"))}; const files=new WorkspaceFiles({recoveryStateDirectory:process.env.DRAFT_TEST_STATE,afterBoundary(phase){if(phase===process.env.DRAFT_TEST_PHASE)process.exit(42)}}); const root=files.open(process.env.DRAFT_TEST_PROJECT); const file=files.read(root.id,'a.md'); files.save(root.id,'a.md',{expectedSha256:file.sha256,text:'完整保存的新正文'});`
  const child = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, DRAFT_TEST_STATE: join(f.dir, "host", "workspace-recovery"), DRAFT_TEST_PROJECT: f.project, DRAFT_TEST_PHASE: boundary }, stdout: "pipe", stderr: "pipe", windowsHide: true })
  expect(child.exitCode, child.stderr.toString()).toBe(42)
  await f.restart()
  const currentRoot = await f.root(), recovery = await (await f.request(`/workspace/recovery?rootId=${currentRoot}`)).json()
  expect(recovery.entries[0].status).toBe(boundary === "source-archived" ? "restored" : "committed")
  expect(recovery.warnings).toEqual([])
  const docs = await (await f.request("/knowledge")).json()
  const actual = readFileSync(join(f.project, "a.md"))
  expect(docs[0]).toMatchObject({ id: imported.id, scope: "recovery-project", private: true, contentHash: new Bun.CryptoHasher("sha256").update(actual).digest("hex") })
  writeFileSync(join(f.project, "a.md"), "恢复后另外的软件写入")
  await f.restart()
  expect((await (await f.request("/knowledge")).json())[0].contentHash).toBe(docs[0].contentHash)
  expect(readFileSync(join(f.project, "a.md"), "utf8")).toBe("恢复后另外的软件写入")
})
