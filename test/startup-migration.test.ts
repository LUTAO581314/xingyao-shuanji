import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from "../src/checkpoint"
import { main } from "../src/main"
import { SoulStore } from "../src/store"
import { restoreProduct } from "../src/recovery"
import { SCHEMA_VERSION, type CheckpointInfo, type Memory } from "../src/contracts"

const roots: string[] = []
const runtimes: NonNullable<Awaited<ReturnType<typeof main>>>[] = []
const signals = ["SIGINT", "SIGTERM"] as const
const originalListeners = new Map<string, Set<(...args: any[]) => void>>()
const FIRST = "G1_SOURCE_ONLY: retain the original project preference"
const SECOND = "G2_NEW_SOURCE: this belongs to the newer portable checkpoint"
const DIRTY = "HOST_ONLY_UNSYNCED: keep this local change without migration"

beforeEach(() => {
  for (const signal of signals) originalListeners.set(signal, new Set(process.listeners(signal)))
})

afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.stop()
  for (const signal of signals) {
    for (const listener of process.listeners(signal)) if (!originalListeners.get(signal)?.has(listener)) process.removeListener(signal, listener)
  }
  for (const root of roots.splice(0)) {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.includes("xingyao-startup-migration-")) throw new Error("Unexpected temporary fixture root")
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

/** A prior-release database fixture. The production store is never constructed
 * between downgrading and capturing the schema-1 checkpoint. */
function legacyShape(store: SoulStore) {
  store.db.exec("DROP TABLE action_revisions")
  store.db.query("DELETE FROM meta WHERE key IN ('action_evidence_version','source_revision_version','action_evidence_validation_version','root_learning_policy_version')").run()
  store.db.query("UPDATE memories SET body=json_remove(body,'$.sourceObservedAt')").run()
  store.db.exec("PRAGMA user_version=1")
}

async function publish(store: SoulStore, vault: string, parent: string | null) {
  const checkpoint = await createCheckpoint(store.db, vault, store.identityId, store.revision, parent)
  store.setMeta("checkpoint_generation", checkpoint.generation)
  store.setMeta("checkpoint_revision", String(checkpoint.revision))
  return checkpoint
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xingyao-startup-migration-"))
  roots.push(root)
  const portable = join(root, "portable")
  const vault = join(portable, "vault")
  const source = join(root, "source", "soul.db")
  const host = join(root, "old-host")
  mkdirSync(host, { recursive: true })
  const database = join(host, "soul.db")
  let first!: CheckpointInfo
  let second!: CheckpointInfo
  let firstMemoryId = ""
  let store = new SoulStore(source)
  try {
    const event = store.appendExperience({ sourceKey: "migration:g1", text: FIRST, kind: "preference", scope: "migration", ownership: "told" })
    firstMemoryId = store.remember({ text: FIRST, kind: "preference", scope: "migration", sourceIds: [event.id] }).id
    legacyShape(store)
    first = await publish(store, vault, null)
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  } finally { store.close() }
  // Copy only after the source is closed; the clone is exactly the clean g1 host.
  copyFileSync(source, database)
  store = new SoulStore(source)
  try {
    const event = store.appendExperience({ sourceKey: "migration:g2", text: SECOND, kind: "observation", scope: "migration", ownership: "observed" })
    store.remember({ text: SECOND, kind: "fact", scope: "migration", sourceIds: [event.id] })
    legacyShape(store)
    second = await publish(store, vault, first.generation)
  } finally { store.close() }
  expect(first.schemaVersion).toBe(1)
  expect(second.schemaVersion).toBe(1)
  expect(inspect(database).version).toBe(1)
  return { root, portable, vault, host, database, first, second, firstMemoryId }
}

function inspect(path: string) {
  const db = new Database(path, { readonly: true, strict: true })
  try {
    const meta = (key: string) => db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key=?").get(key)?.value ?? ""
    return {
      version: db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version,
      identity: meta("identity_id"), revision: Number(meta("revision")), checkpoint: meta("checkpoint_generation"),
      marker: meta("action_evidence_version"),
      hasRevisions: !!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='action_revisions'").get(),
      memories: db.query<{ body: string }, []>("SELECT body FROM memories ORDER BY rowid").all().map(row => JSON.parse(row.body) as Memory),
    }
  } finally { db.close(true) }
}

async function start(f: Awaited<ReturnType<typeof fixture>>, host = f.host, extra: string[] = []) {
  const runtime = await main(["--portable-root", f.portable, "--host-root", host, "--engine", join(f.root, "absent-engine.exe"), "--offline", "--no-open", ...extra])
  if (!runtime) throw new Error("The isolated offline runtime did not start")
  runtimes.push(runtime)
  const running = JSON.parse(readFileSync(join(host, "running.json"), "utf8")) as { url: string }
  const url = new URL(running.url)
  const api = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${url.origin}${path}`, { headers: { authorization: `Bearer ${decodeURIComponent(url.hash.slice(7))}` } })
    expect(response.status).toBe(200)
    return await response.json() as T
  }
  return { runtime, api }
}

type State = { identityId: string; unsynced: boolean; revision: number; checkpointGeneration: string; checkpointRevision: number }

test("startup decides the clean old host branch before migration, restores g2 and checkpoints current schema", async () => {
  const f = await fixture()
  const original = inspect(f.database)
  expect(original.revision).toBe(f.first.revision)
  expect(original.checkpoint).toBe(f.first.generation)
  expect(original.memories.map(item => item.text)).toEqual([FIRST])

  const { runtime, api } = await start(f)
  const state = await api<State>("/api/state")
  const migrated = inspect(f.database)
  expect(state.identityId).toBe(f.first.identityId)
  expect(state.identityId).toBe(f.second.identityId)
  expect(state.checkpointGeneration).toBe(f.second.generation)
  expect(state.checkpointRevision).toBe(f.second.revision)
  expect(state.unsynced).toBe(true)
  expect(state.revision).toBeGreaterThan(f.second.revision)
  expect(migrated.version).toBe(SCHEMA_VERSION)
  expect(migrated.marker).toBe("1")
  expect(migrated.hasRevisions).toBe(true)
  expect(migrated.memories.map(item => item.text)).toEqual([FIRST, SECOND])
  expect(migrated.memories.every(item => typeof item.sourceObservedAt === "number")).toBe(true)
  expect((await listCheckpoints(f.vault)).map(item => item.generation).sort()).toEqual([f.first.generation, f.second.generation].sort())

  const saved = await runtime.checkpoint()
  expect(saved.schemaVersion).toBe(SCHEMA_VERSION)
  expect(saved.identityId).toBe(f.first.identityId)
  expect(saved.parent).toBe(f.second.generation)
  const synced = await api<State>("/api/state")
  expect(synced.unsynced).toBe(false)
  expect(synced.checkpointRevision).toBe(synced.revision)
  const restoredPath = join(f.root, "verified-new-checkpoint", "soul.db")
  await restoreCheckpoint(f.vault, saved.generation, restoredPath)
  expect(inspect(restoredPath).version).toBe(SCHEMA_VERSION)
  expect(inspect(restoredPath).memories.map(item => item.text)).toEqual([FIRST, SECOND])
})

test("startup refuses a genuinely dirty schema-1 host before upgrading or replacing its database", async () => {
  const f = await fixture()
  const dirty = new Database(f.database, { strict: true })
  try {
    dirty.transaction(() => {
      dirty.query("UPDATE memories SET body=json_set(body,'$.text',?,'$.revision',json_extract(body,'$.revision')+1) WHERE id=?").run(DIRTY, f.firstMemoryId)
      dirty.query("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run()
    })()
  } finally { dirty.close(true) }
  const before = inspect(f.database)
  const hash = new Bun.CryptoHasher("sha256").update(readFileSync(f.database)).digest("hex")
  await expect(start(f)).rejects.toThrow("宿主未同步分支")
  const after = inspect(f.database)
  expect(after).toEqual(before)
  expect(after.version).toBe(1)
  expect(after.marker).toBe("")
  expect(after.hasRevisions).toBe(false)
  expect(after.memories.map(item => item.text)).toEqual([DIRTY])
  expect(after.memories[0]!.sourceObservedAt).toBeUndefined()
  expect(new Bun.CryptoHasher("sha256").update(readFileSync(f.database)).digest("hex")).toBe(hash)
  expect(existsSync(join(f.host, "running.json"))).toBe(false)
  expect(existsSync(join(f.host, ".xingyao-writer.lock"))).toBe(false)
  expect((await listCheckpoints(f.vault)).map(item => item.generation).sort()).toEqual([f.first.generation, f.second.generation].sort())
})

test("startup validates an explicitly restored old generation before schema migration and retains that selection", async () => {
  const f = await fixture()
  const selectedHost = join(f.root, "selected-old-generation")
  const selectedPath = join(selectedHost, "soul.db")
  await restoreCheckpoint(f.vault, f.first.generation, selectedPath)
  expect(inspect(selectedPath).version).toBe(1)
  const { runtime, api } = await start(f, selectedHost, ["--recovery-generation", f.first.generation])
  const state = await api<State>("/api/state")
  expect(state.identityId).toBe(f.first.identityId)
  expect(state.checkpointGeneration).toBe(f.first.generation)
  expect(state.checkpointRevision).toBe(f.first.revision)
  expect(state.unsynced).toBe(true)
  expect(state.revision).toBeGreaterThan(f.first.revision)
  const selected = inspect(selectedPath)
  expect(selected.version).toBe(SCHEMA_VERSION)
  expect(selected.memories.map(item => item.text)).toEqual([FIRST])
  expect(selected.memories[0]!.sourceObservedAt).toBeNumber()
  // Selection is allowed, but it cannot silently overwrite the newer g2 head.
  await expect(runtime.checkpoint()).rejects.toThrow("fork")
  expect((await listCheckpoints(f.vault)).map(item => item.generation).sort()).toEqual([f.first.generation, f.second.generation].sort())
  const errors: string[] = []
  const originalError = console.error
  console.error = (...values: unknown[]) => { errors.push(values.map(String).join(" ")) }
  try { await runtime.stop(); await runtime.closed }
  finally { console.error = originalError }
  expect(errors).toHaveLength(1)
  expect(errors[0]).toContain("fork")
  expect(errors[0]).toContain("宿主恢复数据已保留")
  expect(existsSync(join(selectedHost, ".xingyao-writer.lock"))).toBe(false)
  expect(JSON.parse(readFileSync(join(selectedHost, "running.json"), "utf8")).stopped).toBe(true)
  expect(inspect(selectedPath).memories.map(item => item.text)).toEqual([FIRST])
})

test("a recovered host restarts after a new checkpoint and a crash without discarding its unsynced work", async () => {
  const f = await fixture()
  const selectedHost = join(f.root, "crashed-recovery-host")
  const selectedPath = join(selectedHost, "soul.db")
  await restoreCheckpoint(f.vault, f.second.generation, selectedPath)
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/main.ts"), "--portable-root", f.portable,
    "--host-root", selectedHost, "--engine", join(f.root, "absent-engine.exe"), "--offline", "--no-open", "--recovery-generation", f.second.generation],
  { stdout: "ignore", stderr: "pipe", windowsHide: true })
  let saved!: CheckpointInfo
  let memory!: Memory
  let unsyncedRevision = 0
  try {
    const running = join(selectedHost, "running.json")
    for (let attempt = 0; attempt < 200 && !existsSync(running) && child.exitCode === null; attempt++) await Bun.sleep(25)
    if (!existsSync(running)) throw new Error(`Isolated child failed to start: ${child.exitCode === null ? "startup timed out" : await new Response(child.stderr).text()}`)
    const url = new URL(JSON.parse(readFileSync(running, "utf8")).url)
    const api = async <T>(path: string, body: unknown, expected: number): Promise<T> => {
      const response = await fetch(`${url.origin}${path}`, { method: "POST", headers: { authorization: `Bearer ${decodeURIComponent(url.hash.slice(7))}`, "content-type": "application/json" }, body: JSON.stringify(body) })
      const result = await response.json()
      expect(response.status, JSON.stringify(result)).toBe(expected)
      return result as T
    }
    saved = await api<CheckpointInfo>("/api/checkpoint", {}, 200)
    expect(saved.schemaVersion).toBe(SCHEMA_VERSION)
    expect(saved.parent).toBe(f.second.generation)
    memory = await api<Memory>("/api/memories", { key: "crash-local", kind: "fact", scope: "migration", text: DIRTY }, 201)
    unsyncedRevision = inspect(selectedPath).revision
    expect(unsyncedRevision).toBeGreaterThan(saved.revision)
    expect(JSON.parse(readFileSync(join(selectedHost, "restore-journal.json"), "utf8")).journal.generation).toBe(f.second.generation)
  } finally {
    // Termination deliberately skips product shutdown/checkpointing, retaining
    // the same committed WAL and paired-restore journal a real crash leaves.
    if (child.exitCode === null) child.kill()
    await child.exited
  }
  const journalBefore = readFileSync(join(selectedHost, "restore-journal.json"), "utf8")
  const { runtime, api } = await start(f, selectedHost, ["--recovery-generation", saved.generation])
  const state = await api<State>("/api/state")
  expect(state.checkpointGeneration).toBe(saved.generation)
  expect(state.checkpointRevision).toBe(saved.revision)
  expect(state.revision).toBe(unsyncedRevision)
  expect(state.unsynced).toBe(true)
  expect(readFileSync(join(selectedHost, "restore-journal.json"), "utf8")).toBe(journalBefore)
  expect(inspect(selectedPath).memories.find(item => item.id === memory.id)?.text).toBe(DIRTY)
  const next = await runtime.checkpoint()
  expect(next.parent).toBe(saved.generation)
  expect((await api<State>("/api/state")).unsynced).toBe(false)
})

test("a paired restore journal for a different lineage cannot authorize retaining an unverified dirty host", async () => {
  const f = await fixture()
  const selectedHost = join(f.root, "mismatched-paired-origin")
  mkdirSync(selectedHost)
  await restoreProduct({ hostDir: selectedHost, vaultDir: f.vault, generation: f.second.generation, engineVersion: "" })
  const selectedPath = join(selectedHost, "soul.db")
  const unrelated = join(f.root, "unpaired-old-domain", "soul.db")
  await restoreCheckpoint(f.vault, f.first.generation, unrelated)
  // Model a domain-only replacement while the completed paired journal still
  // belongs to g2. An ancestor g1 does not descend from that paired origin.
  unlinkSync(selectedPath)
  copyFileSync(unrelated, selectedPath)
  const db = new Database(selectedPath)
  try { db.query("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run() }
  finally { db.close(true) }
  const before = inspect(selectedPath)
  const journal = readFileSync(join(selectedHost, "restore-journal.json"), "utf8")
  await expect(start(f, selectedHost, ["--recovery-generation", f.first.generation])).rejects.toThrow("恢复分支已有新工作")
  expect(inspect(selectedPath)).toEqual(before)
  expect(inspect(selectedPath).version).toBe(1)
  expect(readFileSync(join(selectedHost, "restore-journal.json"), "utf8")).toBe(journal)
  expect(existsSync(join(selectedHost, ".xingyao-writer.lock"))).toBe(false)
})
