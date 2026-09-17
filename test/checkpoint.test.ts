import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { acquireHostLock, createCheckpoint, listCheckpoints, restoreCheckpoint } from "../src/checkpoint"

const roots: string[] = []
const databases: Database[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xingyao-checkpoint-test-"))
  roots.push(root)
  const host = join(root, "宿主 space")
  const vault = join(root, "便携 vault")
  mkdirSync(host)
  const db = new Database(join(host, "active.sqlite"))
  databases.push(db)
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=1; CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE evidence(id INTEGER PRIMARY KEY,text TEXT)")
  db.query("INSERT INTO meta VALUES (?,?)").run("identity_id", "test-identity")
  db.query("INSERT INTO meta VALUES (?,?)").run("revision", "1")
  db.query("INSERT INTO meta VALUES (?,?)").run("checkpoint_generation", "")
  db.query("INSERT INTO evidence(text) VALUES (?)").run("committed in WAL / 中文")
  return { root, host, vault, db }
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("host single writer", () => {
  test("rejects a live owner, releases idempotently and preserves a replacement lock", () => {
    const { host } = fixture()
    const release = acquireHostLock(host)
    expect(() => acquireHostLock(host)).toThrow("active")
    release(); release()
    const release2 = acquireHostLock(host)
    const lock = join(host, ".xingyao-writer.lock")
    const replacement = { pid: process.pid, host: hostname(), token: "replacement-token-never-delete" }
    writeFileSync(lock, JSON.stringify(replacement))
    release2()
    expect(JSON.parse(readFileSync(lock, "utf8"))).toEqual(replacement)
  })
  test("reclaims only a demonstrably stopped same-host process", () => {
    const { host } = fixture()
    const lock = join(host, ".xingyao-writer.lock")
    const deadPid = 1073741823
    expect(() => process.kill(deadPid, 0)).toThrow()
    writeFileSync(lock, JSON.stringify({ pid: deadPid, host: hostname(), token: "dead-owner-unique-token" }))
    const release = acquireHostLock(host)
    expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(process.pid)
    release()
    writeFileSync(lock, JSON.stringify({ pid: deadPid, host: "another-host", token: "remote-owner-unique-token" }))
    expect(() => acquireHostLock(host)).toThrow("cannot be verified")
    expect(existsSync(lock)).toBe(true)
  })
  test("never guesses that a partial lock is stale", () => {
    const { host } = fixture()
    const lock = join(host, ".xingyao-writer.lock")
    writeFileSync(lock, "{")
    expect(() => acquireHostLock(host)).toThrow()
    expect(readFileSync(lock, "utf8")).toBe("{")
  })
  test("an OS-live child owns the lock until it exits; a killed child can be recovered", async () => {
    const { host } = fixture()
    const moduleUrl = pathToFileURL(join(import.meta.dir, "../src/checkpoint.ts")).href
    const child = Bun.spawn([process.execPath, "-e", `const {acquireHostLock}=await import(${JSON.stringify(moduleUrl)}); acquireHostLock(process.argv[1]); console.log('locked'); setInterval(()=>{},1000)`, host], { stdout: "pipe", stderr: "pipe" })
    try {
      const reader = child.stdout.getReader()
      const ready = await reader.read()
      reader.releaseLock()
      expect(new TextDecoder().decode(ready.value)).toContain("locked")
      expect(() => acquireHostLock(host)).toThrow("active")
      child.kill()
      await child.exited
      const release = acquireHostLock(host)
      release()
      expect(existsSync(join(host, ".xingyao-writer.lock"))).toBe(false)
    } finally { if (child.exitCode === null) { child.kill(); await child.exited } }
  })
})

describe("portable SQLite checkpoints", () => {
  test("captures committed WAL, restores identity and parent tracking, and preserves old generations", async () => {
    const { root, vault, db } = fixture()
    const first = await createCheckpoint(db, vault, "test-identity", 1, null)
    const snapshot = join(vault, "checkpoints", first.generation, "state.sqlite")
    expect(existsSync(`${snapshot}-wal`)).toBe(false)
    db.query("INSERT INTO evidence(text) VALUES ('later')").run()
    db.query("UPDATE meta SET value='2' WHERE key='revision'").run()
    db.query("UPDATE meta SET value=? WHERE key='checkpoint_generation'").run(first.generation)
    const second = await createCheckpoint(db, vault, "test-identity", 2, first.generation)
    expect(second.parent).toBe(first.generation)
    expect(await listCheckpoints(vault)).toHaveLength(2)
    const target = join(root, "restored host", "active.sqlite")
    const release = acquireHostLock(join(root, "restored host"))
    try { await restoreCheckpoint(vault, first.generation, target) } finally { release() }
    const restored = new Database(target)
    databases.push(restored)
    expect(restored.query("SELECT text FROM evidence").all()).toEqual([{ text: "committed in WAL / 中文" }])
    expect(restored.query("SELECT value FROM meta WHERE key='checkpoint_generation'").get()).toEqual({ value: first.generation })
    expect(restored.query("SELECT value FROM meta WHERE key='revision'").get()).toEqual({ value: "1" })
    expect(await listCheckpoints(vault)).toHaveLength(2)
  })
  test("rejects open transactions and stale revision metadata", async () => {
    const { vault, db } = fixture()
    db.exec("BEGIN; INSERT INTO evidence(text) VALUES ('uncommitted')")
    await expect(createCheckpoint(db, vault, "test-identity", 1, null)).rejects.toThrow("transaction")
    db.exec("ROLLBACK")
    await expect(createCheckpoint(db, vault, "test-identity", 0, null)).rejects.toThrow("revision")
    await expect(createCheckpoint(db, vault, "wrong-identity", 1, null)).rejects.toThrow("revision")
    expect(await listCheckpoints(vault)).toHaveLength(0)
  })
  test("serializes publications and refuses a revision changed before capture", async () => {
    const { vault, db } = fixture()
    const pending = createCheckpoint(db, vault, "test-identity", 1, null)
    const competing = createCheckpoint(db, vault, "test-identity", 1, null)
    await expect(competing).rejects.toThrow("active")
    const first = await pending
    db.query("UPDATE meta SET value=? WHERE key='checkpoint_generation'").run(first.generation)
    const next = createCheckpoint(db, vault, "test-identity", 1, first.generation)
    db.query("UPDATE meta SET value='2' WHERE key='revision'").run()
    await expect(next).rejects.toThrow("changed")
    expect(await listCheckpoints(vault)).toHaveLength(1)
    const second = await createCheckpoint(db, vault, "test-identity", 2, first.generation)
    expect(second.revision).toBe(2)
  })
  test("scans complete generations, ignores half writes, damaged bytes and inconsistent manifests", async () => {
    const { vault, db } = fixture()
    const good = await createCheckpoint(db, vault, "test-identity", 1, null)
    const checkpointRoot = join(vault, "checkpoints")
    mkdirSync(join(checkpointRoot, "incomplete"))
    writeFileSync(join(checkpointRoot, "incomplete", "state.sqlite"), "unfinished")
    const bad = join(checkpointRoot, "bad-hash")
    cpSync(join(checkpointRoot, good.generation), bad, { recursive: true })
    const manifest = JSON.parse(readFileSync(join(bad, "complete.json"), "utf8"))
    manifest.generation = "bad-hash"
    writeFileSync(join(bad, "complete.json"), JSON.stringify(manifest))
    writeFileSync(join(bad, "state.sqlite"), "corruption")
    const lying = join(checkpointRoot, "wrong-revision")
    cpSync(join(checkpointRoot, good.generation), lying, { recursive: true })
    const lyingManifest = { ...manifest, generation: "wrong-revision", revision: 999 }
    writeFileSync(join(lying, "complete.json"), JSON.stringify(lyingManifest))
    expect((await listCheckpoints(vault)).map(x => x.generation)).toEqual([good.generation])
    expect(readdirSync(checkpointRoot)).toHaveLength(4)
  })
  test("valid hash alone cannot turn a corrupt file into a usable checkpoint", async () => {
    const { vault, db } = fixture()
    const good = await createCheckpoint(db, vault, "test-identity", 1, null)
    const directory = join(vault, "checkpoints", good.generation)
    const contents = Buffer.from("not SQLite even though SHA-256 matches")
    writeFileSync(join(directory, "state.sqlite"), contents)
    const manifest = JSON.parse(readFileSync(join(directory, "complete.json"), "utf8"))
    manifest.sha256 = createHash("sha256").update(contents).digest("hex")
    writeFileSync(join(directory, "complete.json"), JSON.stringify(manifest))
    expect(await listCheckpoints(vault)).toHaveLength(0)
  })
  test("a corrupt latest generation falls back to a verified old generation after the vault moves", async () => {
    const { root, vault, db } = fixture()
    const first = await createCheckpoint(db, vault, "test-identity", 1, null)
    db.query("UPDATE meta SET value=? WHERE key='checkpoint_generation'").run(first.generation)
    db.query("UPDATE meta SET value='2' WHERE key='revision'").run()
    const latest = await createCheckpoint(db, vault, "test-identity", 2, first.generation)
    writeFileSync(join(vault, "checkpoints", latest.generation, "complete.json"), '{"partial":')
    const moved = join(root, "new drive location")
    cpSync(vault, moved, { recursive: true })
    const valid = await listCheckpoints(moved)
    expect(valid.map(item => item.generation)).toEqual([first.generation])
    const target = join(root, "moved restore.sqlite")
    await restoreCheckpoint(moved, valid[0]!.generation, target)
    const restored = new Database(target)
    databases.push(restored)
    expect(restored.query("SELECT value FROM meta WHERE key='revision'").get()).toEqual({ value: "1" })
    await expect(createCheckpoint(db, moved, "test-identity", 2, latest.generation)).rejects.toThrow("fork")
  })
  test("refuses stale-parent publication, identity conflicts and divergent complete heads", async () => {
    const { vault, db } = fixture()
    const first = await createCheckpoint(db, vault, "test-identity", 1, null)
    db.query("UPDATE meta SET value=? WHERE key='checkpoint_generation'").run(first.generation)
    const second = await createCheckpoint(db, vault, "test-identity", 1, first.generation)
    await expect(createCheckpoint(db, vault, "test-identity", 1, first.generation)).rejects.toThrow("fork")
    await expect(createCheckpoint(db, vault, "other-identity", 1, second.generation)).rejects.toThrow("identity")
    const branchDir = join(vault, "checkpoints", "offline-branch")
    cpSync(join(vault, "checkpoints", second.generation), branchDir, { recursive: true })
    const manifest = JSON.parse(readFileSync(join(branchDir, "complete.json"), "utf8"))
    manifest.generation = "offline-branch"
    writeFileSync(join(branchDir, "complete.json"), JSON.stringify(manifest))
    expect(await listCheckpoints(vault)).toHaveLength(3)
    await expect(createCheckpoint(db, vault, "test-identity", 1, second.generation)).rejects.toThrow("fork")
  })
  test("explicit restore never overwrites an existing host branch or sidecar", async () => {
    const { root, vault, db } = fixture()
    const first = await createCheckpoint(db, vault, "test-identity", 1, null)
    const target = join(root, "keep.sqlite")
    writeFileSync(target, "existing recovery branch")
    await expect(restoreCheckpoint(vault, first.generation, target)).rejects.toThrow("already exists")
    expect(readFileSync(target, "utf8")).toBe("existing recovery branch")
    const target2 = join(root, "sidecar.sqlite")
    writeFileSync(`${target2}-wal`, "pending WAL")
    await expect(restoreCheckpoint(vault, first.generation, target2)).rejects.toThrow("sidecar")
    expect(existsSync(target2)).toBe(false)
    await expect(restoreCheckpoint(vault, "../escape", target2)).rejects.toThrow("generation")
  })
})
