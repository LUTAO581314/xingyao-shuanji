import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCheckpoint } from "../src/checkpoint"
import { backupEngine } from "../src/engine-backup"
import { restoreProduct, resumeProductRestore, type RestoreBoundary } from "../src/recovery"
import { SoulStore } from "../src/store"

const roots: string[] = [], dbs: Database[] = []
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const engineVersion = "recovery-fixture.1"
function engineData(host: string) { return join(host, "opencode", "data", "opencode") }
function makeEngine(host: string, text: string) {
  mkdirSync(engineData(host), { recursive: true })
  const db = new Database(join(engineData(host), "opencode-product-dev.db"))
  db.exec("CREATE TABLE fixture (value TEXT)")
  db.query("INSERT INTO fixture VALUES (?)").run(text)
  db.close(true)
}
async function fixture(options: { engine?: "full" | "empty" | "none"; session?: boolean; existing?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "xingyao-product-restore-")); roots.push(root)
  const sourceHost = join(root, "source"), hostDir = join(root, "目标 host"), vaultDir = join(root, "portable vault")
  mkdirSync(hostDir)
  const source = new SoulStore(join(sourceHost, "soul.db")); dbs.push(source.db)
  const task = source.createTask("isolated restore fixture", "fixture")
  if (options.session ?? true) source.updateTask(task.id, { sessionId: "session-only-in-test" })
  const mode = options.engine ?? "full"
  if (mode === "full") makeEngine(sourceHost, "snapshot-engine-state")
  const checkpoint = await createCheckpoint(source.db, vaultDir, source.identityId, source.revision, null, mode === "none" ? undefined : async directory => {
    const manifest = await backupEngine(sourceHost, directory, engineVersion)
    const extensions: Record<string, string> = { "engine/complete.json": hash(readFileSync(join(directory, "engine", "complete.json"))) }
    for (const file of manifest.files) extensions[`engine/${file.path}`] = file.sha256
    return extensions
  })
  let oldIdentity: string | undefined
  if (options.existing) {
    const old = new SoulStore(join(hostDir, "soul.db")); oldIdentity = old.identityId; old.close()
    makeEngine(hostDir, "old-engine-state")
    writeFileSync(join(engineData(hostDir), "keep.bin"), "opaque previous host file")
  }
  return { root, source, sourceHost, hostDir, vaultDir, checkpoint, oldIdentity, options: { hostDir, vaultDir, generation: checkpoint.generation, engineVersion } }
}
function metadata(path: string, key: string) {
  const db = new Database(path, { readonly: true })
  try { return (db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string }).value } finally { db.close(true) }
}
function engineText(host: string) {
  const db = new Database(join(engineData(host), "opencode-product-dev.db"), { readonly: true })
  try { return db.query("SELECT value FROM fixture").get() } finally { db.close(true) }
}
function interruptAt(boundary: RestoreBoundary) { return (step: RestoreBoundary) => { if (step === boundary) throw new Error(`simulated crash at ${boundary}`) } }
function journal(host: string) { return JSON.parse(readFileSync(join(host, "restore-journal.json"), "utf8")) }
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe("coherent domain and engine restore", () => {
  test("validates an exact engine version before touching either existing host database", async () => {
    const f = await fixture({ existing: true })
    const before = hash(readFileSync(join(f.hostDir, "soul.db")))
    await expect(restoreProduct({ ...f.options, engineVersion: "wrong-version" })).rejects.toThrow("version mismatch")
    expect(hash(readFileSync(join(f.hostDir, "soul.db")))).toBe(before)
    expect(engineText(f.hostDir)).toEqual({ value: "old-engine-state" })
    expect(existsSync(join(f.hostDir, "restore-journal.json"))).toBe(false)
  })
  test("publishes both prepared states while preserving existing domain, sidecars and engine directory", async () => {
    const f = await fixture({ existing: true })
    writeFileSync(join(f.hostDir, "soul.db-wal"), "opaque-old-sidecar")
    const result = await restoreProduct(f.options)
    expect(result).toEqual({ restored: true, generation: f.checkpoint.generation })
    expect(metadata(join(f.hostDir, "soul.db"), "identity_id")).toBe(f.source.identityId)
    expect(engineText(f.hostDir)).toEqual({ value: "snapshot-engine-state" })
    const record = journal(f.hostDir).journal
    expect(record.phase).toBe("complete")
    const backup = join(f.hostDir, "recovery", record.backup)
    expect(readFileSync(join(backup, "soul.db-wal"), "utf8")).toBe("opaque-old-sidecar")
    expect(readFileSync(join(backup, "opencode-data", "keep.bin"), "utf8")).toBe("opaque previous host file")
    expect(existsSync(join(f.hostDir, "soul.db-wal"))).toBe(false)
    expect(existsSync(join(engineData(f.hostDir), "keep.bin"))).toBe(false)
    const previous = new Database(join(backup, "opencode-data", "opencode-product-dev.db"), { readonly: true })
    try { expect(previous.query("SELECT value FROM fixture").get()).toEqual({ value: "old-engine-state" }) } finally { previous.close(true) }
  })
  test("publishing the domain before a crash does not let startup skip engine restoration", async () => {
    const f = await fixture({ existing: true })
    await expect(restoreProduct({ ...f.options, afterBoundary: interruptAt("domain-published") })).rejects.toThrow("simulated crash")
    expect(existsSync(join(f.hostDir, "soul.db"))).toBe(true)
    expect(existsSync(engineData(f.hostDir))).toBe(false)
    expect(journal(f.hostDir).journal.phase).toBe("preserved")
    expect(await resumeProductRestore(f.options)).toEqual({ restored: true, generation: f.checkpoint.generation })
    expect(engineText(f.hostDir)).toEqual({ value: "snapshot-engine-state" })
  })
  test("completion is idempotent and does not undo later committed host work", async () => {
    const f = await fixture()
    await restoreProduct(f.options)
    const db = new Database(join(f.hostDir, "soul.db"))
    db.query("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run(); db.close(true)
    const originalReceipt = readFileSync(join(f.hostDir, "restore-journal.json"), "utf8")
    expect(await restoreProduct(f.options)).toEqual({ restored: false, generation: f.checkpoint.generation })
    expect(await resumeProductRestore(f.options)).toEqual({ restored: false, generation: f.checkpoint.generation })
    expect(Number(metadata(join(f.hostDir, "soul.db"), "revision"))).toBe(f.checkpoint.revision + 1)
    expect(readFileSync(join(f.hostDir, "restore-journal.json"), "utf8")).toBe(originalReceipt)
  })
  test("memory-only checkpoints require no task session bindings, including explicitly empty engine snapshots", async () => {
    for (const engine of ["none", "empty"] as const) {
      const bad = await fixture({ engine, session: true, existing: true })
      await expect(restoreProduct(bad.options)).rejects.toThrow("会话绑定")
      expect(metadata(join(bad.hostDir, "soul.db"), "identity_id")).toBe(bad.oldIdentity!)
      expect(engineText(bad.hostDir)).toEqual({ value: "old-engine-state" })
      const good = await fixture({ engine, session: false })
      expect((await restoreProduct(good.options)).restored).toBe(true)
      expect(existsSync(engineData(good.hostDir))).toBe(true)
    }
  })
})

describe("durable restore boundaries", () => {
  test.each(["prepared", "old-domain-preserved", "old-engine-preserved", "preserved", "engine-published"] as RestoreBoundary[])("resumes a crash at %s without losing either original state", async boundary => {
    const f = await fixture({ existing: true })
    await expect(restoreProduct({ ...f.options, afterBoundary: interruptAt(boundary) })).rejects.toThrow("simulated crash")
    expect((await resumeProductRestore(f.options)).restored).toBe(true)
    expect(metadata(join(f.hostDir, "soul.db"), "identity_id")).toBe(f.checkpoint.identityId)
    expect(engineText(f.hostDir)).toEqual({ value: "snapshot-engine-state" })
    const backup = join(f.hostDir, "recovery", journal(f.hostDir).journal.backup)
    expect(metadata(join(backup, "soul.db"), "identity_id")).toBe(f.oldIdentity!)
    expect(readFileSync(join(backup, "opencode-data", "keep.bin"), "utf8")).toBe("opaque previous host file")
  })
  test.each(["domain-staged", "engine-staged"] as RestoreBoundary[])("a crash before the journal at %s leaves existing host state untouched", async boundary => {
    const f = await fixture({ existing: true })
    await expect(restoreProduct({ ...f.options, afterBoundary: interruptAt(boundary) })).rejects.toThrow("simulated crash")
    expect(await resumeProductRestore(f.options)).toEqual({ restored: false })
    expect(metadata(join(f.hostDir, "soul.db"), "identity_id")).toBe(f.oldIdentity!)
    expect(engineText(f.hostDir)).toEqual({ value: "old-engine-state" })
    expect((await restoreProduct(f.options)).restored).toBe(true)
  })
  test("an incomplete journal cannot be rebound to another generation or engine version", async () => {
    const f = await fixture()
    await expect(restoreProduct({ ...f.options, afterBoundary: interruptAt("domain-published") })).rejects.toThrow()
    await expect(restoreProduct({ ...f.options, generation: "another-valid-generation" })).rejects.toThrow("同一代次")
    await expect(resumeProductRestore({ ...f.options, engineVersion: "different-version" })).rejects.toThrow("version mismatch")
    expect(existsSync(engineData(f.hostDir))).toBe(false)
    expect((await resumeProductRestore(f.options)).restored).toBe(true)
  })
  test("a crash after the completed receipt returns an idempotent completion", async () => {
    const f = await fixture()
    await expect(restoreProduct({ ...f.options, afterBoundary: interruptAt("completed") })).rejects.toThrow("simulated crash")
    expect((await resumeProductRestore(f.options)).restored).toBe(false)
    expect(engineText(f.hostDir)).toEqual({ value: "snapshot-engine-state" })
  })
})

describe("restore journal and staging integrity", () => {
  test("changes before the prepared journal cannot become a new trusted staging baseline", async () => {
    for (const boundary of ["domain-staged", "engine-staged"] as const) {
      const f = await fixture({ existing: true })
      await expect(restoreProduct({ ...f.options, afterBoundary(step, details) {
        if (step !== boundary) return
        if (boundary === "domain-staged") {
          const changed = new Database(join(details.stageDir, "soul.db"))
          changed.query("UPDATE tasks SET body=?").run(JSON.stringify({ id: "modified", sessionId: "session-only-in-test", title: "altered after domain verification" }))
          changed.close(true)
        } else writeFileSync(join(engineData(details.stageDir), "opencode-product-dev.db"), "changed after engine staging")
      } })).rejects.toThrow()
      expect(existsSync(join(f.hostDir, "restore-journal.json"))).toBe(false)
      expect(metadata(join(f.hostDir, "soul.db"), "identity_id")).toBe(f.oldIdentity!)
      expect(engineText(f.hostDir)).toEqual({ value: "old-engine-state" })
    }
  })
  test("a changed staging database fails before any existing host state is moved", async () => {
    const f = await fixture({ existing: true })
    await expect(restoreProduct({ ...f.options, afterBoundary: interruptAt("prepared") })).rejects.toThrow()
    const record = journal(f.hostDir).journal
    writeFileSync(join(f.hostDir, record.stage, "soul.db"), "tampered staging")
    await expect(resumeProductRestore(f.options)).rejects.toThrow("SHA-256")
    expect(metadata(join(f.hostDir, "soul.db"), "identity_id")).toBe(f.oldIdentity!)
    expect(engineText(f.hostDir)).toEqual({ value: "old-engine-state" })
  })
  test("a changed staged engine fails before replacing the domain database", async () => {
    const f = await fixture({ existing: true })
    await expect(restoreProduct({ ...f.options, afterBoundary: interruptAt("prepared") })).rejects.toThrow()
    const record = journal(f.hostDir).journal
    writeFileSync(join(engineData(join(f.hostDir, record.stage)), "opencode-product-dev.db"), "tampered engine staging")
    await expect(resumeProductRestore(f.options)).rejects.toThrow("SHA-256")
    expect(metadata(join(f.hostDir, "soul.db"), "identity_id")).toBe(f.oldIdentity!)
  })
  test("journal tampering and recomputed checksums on escaping paths are rejected", async () => {
    const f = await fixture({ existing: true })
    await expect(restoreProduct({ ...f.options, afterBoundary: interruptAt("prepared") })).rejects.toThrow()
    const path = join(f.hostDir, "restore-journal.json"), envelope = journal(f.hostDir)
    envelope.journal.stage = "../outside"
    writeFileSync(path, JSON.stringify(envelope))
    await expect(resumeProductRestore(f.options)).rejects.toThrow("校验失败")
    envelope.sha256 = hash(JSON.stringify(envelope.journal))
    writeFileSync(path, JSON.stringify(envelope))
    await expect(resumeProductRestore(f.options)).rejects.toThrow("目录边界")
    expect(metadata(join(f.hostDir, "soul.db"), "identity_id")).toBe(f.oldIdentity!)
  })
  test("directory junctions cannot redirect a restore outside the selected host", async () => {
    const f = await fixture()
    const outside = join(f.root, "outside"); mkdirSync(outside)
    symlinkSync(outside, join(f.hostDir, "opencode"), process.platform === "win32" ? "junction" : "dir")
    await expect(restoreProduct(f.options)).rejects.toThrow("连接点")
    expect(existsSync(join(f.hostDir, "soul.db"))).toBe(false)
    expect(existsSync(join(outside, "data"))).toBe(false)
  })
})
