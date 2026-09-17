import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { backupEngine, restoreEngine, verifyEngineCheckpoint } from "../src/engine-backup"

const roots: string[] = []
const databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close(true)
  for (const root of roots.splice(0)) {
    if (resolve(dirname(root)) !== resolve(tmpdir())) throw new Error("Unexpected test root")
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xingyao-engine-backup-"))
  roots.push(root)
  const host = join(root, "host")
  const target = join(root, "target")
  const generation = join(root, "generation")
  const data = join(host, "opencode", "data", "opencode")
  mkdirSync(data, { recursive: true })
  mkdirSync(target)
  mkdirSync(generation)
  return { root, host, target, generation, data }
}
function source(data: string) {
  const db = new Database(join(data, "opencode-product-dev.db"))
  databases.push(db)
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=7; CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO fixture VALUES (1, 'committed');")
  return db
}

test("engine snapshot includes committed WAL and excludes credentials and uncommitted rows", async () => {
  const f = fixture()
  const db = source(f.data)
  db.exec("INSERT INTO fixture VALUES (2, 'in WAL'); BEGIN; INSERT INTO fixture VALUES (3, 'uncommitted')")
  writeFileSync(join(f.data, "auth.json"), '{"secret":"synthetic-never-copy"}')
  writeFileSync(join(f.data, "unrelated.txt"), "not engine state")
  const manifest = await backupEngine(f.host, f.generation, "engine-fixture.1")
  expect(manifest.files).toHaveLength(1)
  expect(manifest.files[0]!.userVersion).toBe(7)
  expect(readdirSync(join(f.generation, "engine")).sort()).toEqual(["complete.json", "opencode-product-dev.db"])
  expect(await verifyEngineCheckpoint(f.generation)).toEqual(manifest)
  db.exec("COMMIT")
  await restoreEngine(f.target, f.generation, "engine-fixture.1")
  const restoredData = join(f.target, "opencode", "data", "opencode")
  const restored = new Database(join(restoredData, "opencode-product-dev.db"), { readonly: true })
  try { expect(restored.query("SELECT count(*) AS n FROM fixture").get()).toEqual({ n: 2 }) }
  finally { restored.close(true) }
  expect(existsSync(join(restoredData, "auth.json"))).toBe(false)
  expect(readFileSync(join(f.data, "auth.json"), "utf8")).toContain("synthetic-never-copy")
  await expect(restoreEngine(f.target, f.generation, "engine-fixture.1")).rejects.toThrow("already contains")
})

test("requires exact engine version and does not install into existing database or sidecars", async () => {
  const f = fixture()
  source(f.data)
  await backupEngine(f.host, f.generation, "engine-fixture.1")
  await expect(restoreEngine(f.target, f.generation, "engine-fixture.2")).rejects.toThrow("version mismatch")
  const dest = join(f.target, "opencode", "data", "opencode")
  expect(existsSync(dest)).toBe(false)
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, "opencode-product-dev.db-wal"), "preserve-existing")
  await expect(restoreEngine(f.target, f.generation, "engine-fixture.1")).rejects.toThrow("already contains")
  expect(readFileSync(join(dest, "opencode-product-dev.db-wal"), "utf8")).toBe("preserve-existing")
})

test("checks integrity even if a corrupt snapshot has a matching recalculated hash", async () => {
  const f = fixture()
  source(f.data)
  const manifest = await backupEngine(f.host, f.generation, "engine-fixture.1")
  const snapshot = join(f.generation, "engine", manifest.files[0]!.path)
  const bytes = readFileSync(snapshot)
  bytes[0] = 0
  writeFileSync(snapshot, bytes)
  await expect(verifyEngineCheckpoint(f.generation)).rejects.toThrow("SHA-256")
  manifest.files[0]!.sha256 = createHash("sha256").update(bytes).digest("hex")
  writeFileSync(join(f.generation, "engine", "complete.json"), JSON.stringify(manifest))
  await expect(verifyEngineCheckpoint(f.generation)).rejects.toThrow()
  await expect(restoreEngine(f.target, f.generation, "engine-fixture.1")).rejects.toThrow()
  expect(existsSync(join(f.target, "opencode"))).toBe(false)
})

test("rejects incomplete, duplicate or escaping manifests and unexpected files", async () => {
  const f = fixture()
  source(f.data)
  const manifest = await backupEngine(f.host, f.generation, "engine-fixture.1")
  const marker = join(f.generation, "engine", "complete.json")
  rmSync(marker)
  await expect(verifyEngineCheckpoint(f.generation)).rejects.toThrow()
  writeFileSync(marker, JSON.stringify({ ...manifest, files: [{ ...manifest.files[0], path: "../auth.json" }] }))
  await expect(verifyEngineCheckpoint(f.generation)).rejects.toThrow("Invalid engine checkpoint")
  writeFileSync(marker, JSON.stringify({ ...manifest, files: [manifest.files[0], manifest.files[0]] }))
  await expect(verifyEngineCheckpoint(f.generation)).rejects.toThrow("Duplicate")
  writeFileSync(marker, JSON.stringify(manifest))
  writeFileSync(join(f.generation, "engine", "auth.json"), "synthetic")
  await expect(verifyEngineCheckpoint(f.generation)).rejects.toThrow("Unexpected")
})

test("unknown engine database names fail instead of silently losing sessions", async () => {
  const f = fixture()
  writeFileSync(join(f.data, "opencode-future.db"), "unrecognized")
  await expect(backupEngine(f.host, f.generation, "engine-fixture.1")).rejects.toThrow("Unrecognized engine database")
  expect(existsSync(join(f.generation, "engine"))).toBe(false)
})

test("does not publish an empty snapshot when an orphaned WAL remains", async () => {
  const f = fixture()
  writeFileSync(join(f.data, "opencode-product-dev.db-wal"), "orphaned")
  await expect(backupEngine(f.host, f.generation, "engine-fixture.1")).rejects.toThrow("Orphaned")
  expect(existsSync(join(f.generation, "engine"))).toBe(false)
})

test("rejects redirected database directories", async () => {
  const f = fixture()
  source(f.data)
  await backupEngine(f.host, f.generation, "engine-fixture.1")
  symlinkSync(join(f.host, "opencode"), join(f.target, "opencode"), process.platform === "win32" ? "junction" : "dir")
  await expect(restoreEngine(f.target, f.generation, "engine-fixture.1")).rejects.toThrow("symbolic links")
})

test("captures an explicit empty engine state without importing unrelated files", async () => {
  const f = fixture()
  writeFileSync(join(f.data, "auth.json"), "excluded")
  expect((await backupEngine(f.host, f.generation, "engine-fixture.1")).files).toEqual([])
  await restoreEngine(f.target, f.generation, "engine-fixture.1")
  expect(readdirSync(join(f.target, "opencode", "data", "opencode"))).toEqual([])
  await expect(backupEngine(f.host, f.generation, "engine-fixture.1")).rejects.toThrow("already exists")
})
