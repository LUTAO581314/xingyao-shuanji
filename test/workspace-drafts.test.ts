import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SoulStore } from "../src/store"
import { WorkspaceDraftStore, MAX_DRAFT_BYTES } from "../src/workspace-drafts"
import { createCheckpoint, restoreCheckpoint } from "../src/checkpoint"
import { SCHEMA_VERSION } from "../src/contracts"

const fixtures: Array<{ dir: string; store: SoulStore }> = []
const sha = "1".repeat(64), nextSha = "2".repeat(64)
function fixture() { const dir = mkdtempSync(join(tmpdir(), "xingyao-drafts-")), store = new SoulStore(join(dir, "host", "soul.db")); fixtures.push({ dir, store }); return { dir, store, drafts: new WorkspaceDraftStore(store), root: join(dir, "project") } }
afterEach(() => { for (const f of fixtures.splice(0)) { f.store.close(); rmSync(f.dir, { recursive: true, force: true }) } })

test("draft acknowledgements survive reopen and snapshots without entering memory, knowledge or experiences", async () => {
  const f = fixture(), identity = f.store.identityId, revision = f.store.revision
  const saved = f.drafts.save(f.root, "草稿.md", { revision: 0, key: "first", text: "未写入磁盘的想法", baseSha256: sha }, "edit", sha)
  expect(saved.draft!.revision).toBe(1)
  expect(f.store.revision).toBe(revision + 1)
  expect(f.store.experiencesAfter(0)).toHaveLength(0)
  expect(f.store.memories()).toHaveLength(0)
  const snapshot = await createCheckpoint(f.store.db, join(f.dir, "vault"), identity, f.store.revision, null)
  const restoredPath = join(f.dir, "restored", "soul.db")
  await restoreCheckpoint(join(f.dir, "vault"), snapshot.generation, restoredPath)
  const restored = new SoulStore(restoredPath)
  try { expect(restored.identityId).toBe(identity); expect(new WorkspaceDraftStore(restored).get(f.root, "草稿.md")).toEqual(saved) } finally { restored.close() }
})

test("concurrent edits and delayed retries cannot replace a newer draft or recreate a discarded one", () => {
  const f = fixture(), first = { revision: 0, key: "first", text: "第一窗口", baseSha256: sha }
  const a = f.drafts.save(f.root, "a.md", first, "edit", sha)
  expect(f.drafts.save(f.root, "a.md", first, "edit", sha)).toEqual(a)
  expect(() => f.drafts.save(f.root, "a.md", { ...first, text: "同标识不同正文" }, "edit", sha)).toThrow()
  expect(() => f.drafts.save(f.root, "a.md", { ...first, key: "other" }, "edit", sha)).toThrow()
  const discarded = f.drafts.discard(f.root, "a.md", a.draftRevision, "discard")
  expect(discarded).toEqual({ draft: null, draftRevision: 2 })
  expect(() => f.drafts.save(f.root, "a.md", first, "edit", sha)).toThrow()
  expect(() => f.drafts.discard(f.root, "a.md", 1, "late-delete")).toThrow()
  const next = f.drafts.save(f.root, "a.md", { ...first, revision: 2, key: "new", text: "再次编辑" }, "edit", sha)
  expect(next.draftRevision).toBe(3)
})

test("a changed disk baseline requires an explicit reviewed rebase; ordinary autosave preserves the original base", () => {
  const f = fixture(), saved = f.drafts.save(f.root, "a.md", { revision: 0, key: "original", text: "稿件", baseSha256: sha }, "edit", sha)
  expect(() => f.drafts.save(f.root, "a.md", { revision: saved.draftRevision, key: "silent", text: "覆盖", baseSha256: nextSha }, "edit", nextSha)).toThrow()
  expect(() => f.drafts.save(f.root, "a.md", { revision: saved.draftRevision, key: "unread", text: "合并", baseSha256: nextSha }, "rebase", sha)).toThrow()
  const merged = f.drafts.save(f.root, "a.md", { revision: saved.draftRevision, key: "reviewed", text: "明确合并后的稿件", baseSha256: nextSha }, "rebase", nextSha)
  expect(merged.draft).toMatchObject({ text: "明确合并后的稿件", baseSha256: nextSha, revision: 2 })
})

test("draft quota and text validation never silently evict an existing draft", () => {
  const f = fixture(), block = "x".repeat(2 * 1024 * 1024)
  for (let i = 0; i < 8; i++) f.drafts.save(f.root, `${i}.md`, { revision: 0, key: `large-${i}`, text: block, baseSha256: sha }, "edit", sha)
  expect(f.drafts.list().totalBytes).toBe(MAX_DRAFT_BYTES)
  expect(() => f.drafts.save(f.root, "overflow.md", { revision: 0, key: "overflow", text: "x", baseSha256: sha }, "edit", sha)).toThrow("容量")
  expect(f.drafts.list().drafts).toHaveLength(8)
  for (const value of ["../escape.md", "a/../b.md", "C:/absolute.md", "a\\..\\b.md"]) expect(() => f.drafts.get(f.root, value)).toThrow()
  for (const value of ["bad\0text", "bad\ud800", "-----BEGIN PRIVATE KEY-----"]) expect(() => f.drafts.save(f.root, "0.md", { revision: 1, key: crypto.randomUUID(), text: value, baseSha256: sha })).toThrow()
  expect(f.drafts.get(f.root, "0.md").draft!.text).toBe(block)
})

test("schema 3 restores to current schema with old memory and historical bytes preserved", async () => {
  const f = fixture(), memory = f.store.explicitMemory({ key: "old", text: "保留旧偏好", kind: "preference", scope: "global" })
  f.store.db.exec("DROP TABLE workspace_drafts; PRAGMA user_version=3")
  const snapshot = await createCheckpoint(f.store.db, join(f.dir, "vault"), f.store.identityId, f.store.revision, null)
  const bytesPath = join(f.dir, "vault", "checkpoints", snapshot.generation, "state.sqlite"), before = readFileSync(bytesPath)
  const target = join(f.dir, "migrated", "soul.db")
  await restoreCheckpoint(join(f.dir, "vault"), snapshot.generation, target)
  const migrated = new SoulStore(target)
  try { expect(migrated.db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION }); expect(migrated.memory(memory.id)).toEqual(memory); expect(new WorkspaceDraftStore(migrated).list().drafts).toEqual([]) } finally { migrated.close() }
  expect(readFileSync(bytesPath)).toEqual(before)
})
