import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { constants, closeSync, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { isSupportedSchema, type CheckpointInfo } from "./contracts"

const DATABASE_FILE = "state.sqlite"
const MANIFEST_FILE = "complete.json"
const LOCK_FILE = ".xingyao-writer.lock"
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/
type LockOwner = { pid: number; host: string; token: string; createdAt: number }
type Manifest = CheckpointInfo & { format: 1; complete: true; database: typeof DATABASE_FILE; extensions?: Record<string, string> }

export class UnsupportedCheckpointError extends Error {}

function isMissing(error: unknown) { return (error as NodeJS.ErrnoException).code === "ENOENT" }
function isExisting(error: unknown) { return (error as NodeJS.ErrnoException).code === "EEXIST" }
function plainFile(path: string) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${path}`)
  return stat
}
function flushDirectory(path: string) {
  // Windows does not expose directory fsync through node:fs. File contents are flushed;
  // recovery still treats a missing/torn completion marker as an incomplete generation.
  if (process.platform === "win32") return
  const fd = openSync(path, "r")
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function writeExclusive(path: string, text: string) {
  const fd = openSync(path, "wx", 0o600)
  try { writeFileSync(fd, text, "utf8"); fsyncSync(fd) } finally { closeSync(fd) }
}
function readOwner(path: string): LockOwner {
  if (plainFile(path).size > 4096) throw new Error("Invalid writer lock; explicit recovery is required")
  const value = JSON.parse(readFileSync(path, "utf8")) as LockOwner
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.host !== "string" || typeof value.token !== "string" || value.token.length < 16)
    throw new Error("Invalid writer lock; explicit recovery is required")
  return value
}
function definitelyDead(owner: LockOwner) {
  // A lock copied from another host is not proof that the remote writer has stopped.
  if (owner.host !== hostname()) return false
  try { process.kill(owner.pid, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" }
}

/** Single cooperating writer per directory on this host. Unknown locks fail closed. */
export function acquireHostLock(hostDir: string): () => void {
  mkdirSync(hostDir, { recursive: true, mode: 0o700 })
  const path = join(resolve(hostDir), LOCK_FILE)
  const owner: LockOwner = { pid: process.pid, host: hostname(), token: randomUUID(), createdAt: Date.now() }
  const install = () => writeExclusive(path, JSON.stringify(owner))
  try { install() }
  catch (error) {
    if (!isExisting(error)) throw error
    // Only stale-lock recovery takes this guard. All contenders re-read the current
    // owner while holding it, so a second reaper cannot remove a newly acquired lock.
    const recovery = `${path}.recovery`
    try { writeExclusive(recovery, JSON.stringify(owner)) }
    catch (guardError) {
      if (isExisting(guardError)) throw new Error("Writer lock recovery is already in progress; retry or inspect the stale recovery guard")
      throw guardError
    }
    try {
      let previous: LockOwner | undefined
      try { previous = readOwner(path) } catch (readError) { if (!isMissing(readError)) throw readError }
      if (previous && !definitelyDead(previous)) throw new Error(`Writer already active or cannot be verified stopped (PID ${previous.pid}, host ${previous.host})`)
      if (previous) unlinkSync(path)
      try { install() }
      catch (installError) {
        if (isExisting(installError)) throw new Error("Another writer acquired the directory during recovery")
        throw installError
      }
    } finally { unlinkSync(recovery) }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    try {
      const current = readOwner(path)
      if (current.token === owner.token && current.pid === owner.pid && current.host === owner.host) unlinkSync(path)
    } catch (error) { if (!isMissing(error)) throw error }
  }
}

function hashFile(path: string): string {
  plainFile(path)
  const fd = openSync(path, "r")
  try {
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const length = readSync(fd, buffer, 0, buffer.length, null)
      if (!length) return hash.digest("hex")
      hash.update(buffer.subarray(0, length))
    }
  } finally { closeSync(fd) }
}
function inspectDatabase(path: string) {
  plainFile(path)
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (existsSync(`${path}${suffix}`)) throw new Error("Checkpoint is not a closed standalone SQLite database")
  }
  const db = new Database(path, { readonly: true, strict: true })
  try {
    db.exec("PRAGMA trusted_schema=OFF")
    const checks = db.query("PRAGMA integrity_check").all() as Record<string, unknown>[]
    if (checks.length !== 1 || Object.values(checks[0]!)[0] !== "ok") throw new Error("SQLite integrity_check failed")
    const schemaVersion = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
    if (!isSupportedSchema(schemaVersion)) throw new UnsupportedCheckpointError(`Unsupported checkpoint schema: ${schemaVersion}; use a compatible release or an isolated recovery vault`)
    const identityId = (db.query("SELECT value FROM meta WHERE key='identity_id'").get() as { value: string } | null)?.value
    const rawRevision = (db.query("SELECT value FROM meta WHERE key='revision'").get() as { value: string } | null)?.value
    const revision = Number(rawRevision)
    if (!identityId || rawRevision === undefined || !/^\d+$/.test(rawRevision) || !Number.isSafeInteger(revision)) throw new Error("Checkpoint domain metadata is missing or invalid")
    return { identityId, revision, schemaVersion }
  } finally { db.close(true) }
}
function parseManifest(directory: string, generation: string): Manifest {
  if (!GENERATION.test(generation)) throw new Error("Invalid checkpoint generation")
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Checkpoint directory must not be a symbolic link")
  const path = join(directory, MANIFEST_FILE)
  if (plainFile(path).size > 16_384) throw new Error("Oversized checkpoint manifest")
  const m = JSON.parse(readFileSync(path, "utf8")) as Manifest
  if (m.complete === true && m.generation === generation && Number.isSafeInteger(m.format) && m.format > 1)
    throw new UnsupportedCheckpointError("Unsupported checkpoint completion format; do not append to this vault with an older release")
  if (m.format !== 1 || m.complete !== true || m.database !== DATABASE_FILE || m.generation !== generation ||
      typeof m.identityId !== "string" || !m.identityId || !Number.isSafeInteger(m.createdAt) || m.createdAt < 0 ||
      !Number.isSafeInteger(m.revision) || m.revision < 0 || !Number.isSafeInteger(m.schemaVersion) || m.schemaVersion < 0 ||
      typeof m.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(m.sha256) ||
      !(m.parent === null || (typeof m.parent === "string" && GENERATION.test(m.parent) && m.parent !== generation)))
    throw new Error("Invalid or unsupported checkpoint completion manifest")
  if (!isSupportedSchema(m.schemaVersion)) throw new UnsupportedCheckpointError(`Unsupported checkpoint schema: ${m.schemaVersion}; use a compatible release or an isolated recovery vault`)
  return m
}
function info(m: Manifest): CheckpointInfo {
  return { generation: m.generation, identityId: m.identityId, createdAt: m.createdAt, schemaVersion: m.schemaVersion, sha256: m.sha256, revision: m.revision, parent: m.parent }
}
function validateSnapshot(path: string, manifest: Manifest) {
  const hash = hashFile(path)
  if (hash !== manifest.sha256) throw new Error("Checkpoint SHA-256 mismatch")
  const contents = inspectDatabase(path)
  if (contents.identityId !== manifest.identityId || contents.revision !== manifest.revision || contents.schemaVersion !== manifest.schemaVersion)
    throw new Error("Checkpoint manifest does not match its database")
  // Recheck after opening SQLite to detect replacement or mutation during validation.
  if (hashFile(path) !== hash) throw new Error("Checkpoint changed during validation")
}

function validateExtensions(directory: string, manifest: Manifest) {
  if (manifest.extensions === undefined) return
  if (!manifest.extensions || typeof manifest.extensions !== "object" || Array.isArray(manifest.extensions)) throw new Error("Invalid snapshot extensions")
  for (const [name, hash] of Object.entries(manifest.extensions)) {
    if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(name) || name.includes("..") || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid snapshot extension member")
    const parent = lstatSync(join(directory, name.split("/")[0]!))
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Snapshot extension directory must be ordinary")
    if (hashFile(join(directory, name)) !== hash) throw new Error("Snapshot extension hash mismatch")
  }
}

/** Enumerates independently verified generations, including divergent heads.
 * Recognizable unsupported completions block use of the vault: silently hiding
 * them would let an older writer manufacture a second history branch. */
export async function listCheckpoints(vaultDir: string): Promise<CheckpointInfo[]> {
  const root = join(vaultDir, "checkpoints")
  let entries: string[]
  try { entries = readdirSync(root) } catch (error) { if (isMissing(error)) return []; throw error }
  const result: CheckpointInfo[] = []
  for (const generation of entries) {
    if (typeof generation !== "string" || !GENERATION.test(generation)) continue
    try {
      const directory = join(root, generation)
      const manifest = parseManifest(directory, generation)
      validateSnapshot(join(directory, DATABASE_FILE), manifest)
      validateExtensions(directory, manifest)
      result.push(info(manifest))
    } catch (error) {
      if (error instanceof UnsupportedCheckpointError) throw error
      // Incomplete or damaged generations are not recovery candidates.
    }
  }
  return result.sort((a, b) => b.createdAt - a.createdAt || b.generation.localeCompare(a.generation))
}

function assertCanAppend(checkpoints: CheckpointInfo[], identityId: string, revision: number, parent: string | null) {
  if (checkpoints.some(x => x.identityId !== identityId)) throw new Error("Checkpoint identity conflict: use a separate vault")
  if (!checkpoints.length) {
    if (parent !== null) throw new Error("Checkpoint parent is unavailable or invalid; preserve the host recovery branch")
    return
  }
  const parents = new Set(checkpoints.map(x => x.parent).filter(x => x !== null))
  const heads = checkpoints.filter(x => !parents.has(x.generation))
  if (heads.length !== 1) throw new Error(`Checkpoint fork detected; review branches: ${heads.map(x => x.generation).join(", ")}`)
  if (heads[0]!.generation !== parent) throw new Error(`Checkpoint fork detected: expected parent ${heads[0]!.generation}, received ${parent}; preserve the host recovery branch`)
  if (revision < heads[0]!.revision) throw new Error("Checkpoint revision cannot move backwards")
}

/** Captures committed SQLite state (including WAL) without copying the active .db.
 * Supported historical schemas remain unchanged; migration belongs to SoulStore.
 */
export async function createCheckpoint(db: Database, vaultDir: string, identityId: string, revision: number, parent: string | null, beforeComplete?: (directory: string) => Promise<Record<string, string>>): Promise<CheckpointInfo> {
  if (!identityId || !Number.isSafeInteger(revision) || revision < 0 || (parent !== null && !GENERATION.test(parent))) throw new Error("Invalid checkpoint metadata")
  if (db.inTransaction) throw new Error("Commit the active transaction before creating a checkpoint")
  const release = acquireHostLock(join(vaultDir, ".checkpoint-writer"))
  let staging: string | undefined
  try {
    const checkpoints = await listCheckpoints(vaultDir)
    assertCanAppend(checkpoints, identityId, revision, parent)
    const currentIdentity = (db.query("SELECT value FROM meta WHERE key='identity_id'").get() as { value: string } | null)?.value
    const currentRevision = (db.query("SELECT value FROM meta WHERE key='revision'").get() as { value: string } | null)?.value
    const currentGeneration = (db.query("SELECT value FROM meta WHERE key='checkpoint_generation'").get() as { value: string } | null)?.value || null
    if (currentIdentity !== identityId || currentRevision !== String(revision)) throw new Error("Activity changed before checkpoint capture; retry with the current revision")
    if (currentGeneration !== parent) throw new Error("Checkpoint fork detected: host parent differs from the requested parent")
    const base = db.filename && db.filename !== ":memory:" ? dirname(resolve(db.filename)) : tmpdir()
    staging = mkdtempSync(join(base, ".xingyao-snapshot-"))
    const snapshot = join(staging, DATABASE_FILE)
    // VACUUM INTO is a consistent SQLite read of committed pages, including WAL.
    // No await occurs between metadata verification and this snapshot operation.
    db.query("VACUUM INTO ?").run(snapshot)
    const snapshotDb = new Database(snapshot, { strict: true })
    try { snapshotDb.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL") } finally { snapshotDb.close(true) }
    const captured = inspectDatabase(snapshot)
    if (captured.identityId !== identityId || captured.revision !== revision) throw new Error("Snapshot revision changed during capture")
    const previous = checkpoints.find(checkpoint => checkpoint.generation === parent)
    if (previous && captured.schemaVersion < previous.schemaVersion) throw new Error("Checkpoint schema cannot move backwards; preserve a separate recovery branch")
    const generation = `${Date.now().toString(36)}-${randomUUID()}`
    const manifest: Manifest = { format: 1, complete: true, database: DATABASE_FILE, generation, identityId, revision, parent, schemaVersion: captured.schemaVersion, createdAt: Date.now(), sha256: hashFile(snapshot) }
    const root = join(vaultDir, "checkpoints")
    mkdirSync(root, { recursive: true })
    const directory = join(root, generation)
    mkdirSync(directory)
    const portable = join(directory, DATABASE_FILE)
    copyFileSync(snapshot, portable, constants.COPYFILE_EXCL)
    const fd = openSync(portable, "r+")
    try { fsyncSync(fd) } finally { closeSync(fd) }
    validateSnapshot(portable, manifest)
    if (beforeComplete) { manifest.extensions = await beforeComplete(directory); validateExtensions(directory, manifest) }
    // The completion marker is the final write. A crash earlier leaves an ignored generation.
    writeExclusive(join(directory, MANIFEST_FILE), JSON.stringify(manifest, null, 2))
    flushDirectory(directory)
    flushDirectory(root)
    return info(manifest)
  } finally {
    try { if (staging) rmSync(staging, { recursive: true, force: true }) } finally { release() }
  }
}

function assertDestinationAbsent(destination: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try { lstatSync(`${destination}${suffix}`); throw new Error("Restore destination or SQLite sidecar already exists; preserve it as a recovery branch") }
    catch (error) { if (!isMissing(error)) throw error }
  }
}

/** Caller holds the destination host lock. Explicit generation selection can resolve a fork. */
export async function restoreCheckpoint(vaultDir: string, generation: string, destination: string): Promise<CheckpointInfo> {
  if (!GENERATION.test(generation)) throw new Error("Invalid checkpoint generation")
  destination = resolve(destination)
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  assertDestinationAbsent(destination)
  const directory = join(vaultDir, "checkpoints", generation)
  const manifest = parseManifest(directory, generation)
  validateExtensions(directory, manifest)
  const staging = mkdtempSync(join(dirname(destination), ".xingyao-restore-"))
  try {
    const snapshot = join(staging, DATABASE_FILE)
    plainFile(join(directory, DATABASE_FILE))
    copyFileSync(join(directory, DATABASE_FILE), snapshot, constants.COPYFILE_EXCL)
    // Validate the copied bytes, not merely the source checked before the copy.
    validateSnapshot(snapshot, manifest)
    const db = new Database(snapshot, { strict: true })
    try {
      db.exec("PRAGMA synchronous=FULL")
      db.query("INSERT INTO meta(key,value) VALUES ('checkpoint_generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(generation)
    } finally { db.close(true) }
    inspectDatabase(snapshot)
    assertDestinationAbsent(destination)
    const fd = openSync(snapshot, "r+")
    try { fsyncSync(fd) } finally { closeSync(fd) }
    // NTFS supports an atomic, no-replace hard link. Unlike rename on POSIX this
    // cannot overwrite a host branch created between the existence check and publish.
    // The staging name is removed only after the complete file has its final name.
    try { linkSync(snapshot, destination) }
    catch (error) {
      if (isExisting(error)) throw new Error("Restore destination was created concurrently; preserve the existing recovery branch")
      throw new Error("Atomic restore publication failed; use a writable NTFS host directory with hard-link support", { cause: error })
    }
    flushDirectory(dirname(destination))
    return info(manifest)
  } finally { rmSync(staging, { recursive: true, force: true }) }
}
