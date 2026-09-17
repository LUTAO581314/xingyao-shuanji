import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { constants, closeSync, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const DATABASES = ["opencode.db", "opencode-product-dev.db"] as const
const SIDECARS = ["-wal", "-shm", "-journal"]
type DatabaseName = typeof DATABASES[number]
export type EngineDatabaseSnapshot = {
  path: DatabaseName
  sha256: string
  size: number
  /** SQLite metadata only; this is not OpenCode's private migration table. */
  userVersion: number
  schemaVersion: number
}
export type EngineCheckpoint = {
  format: 1
  complete: true
  engineVersion: string
  createdAt: number
  files: EngineDatabaseSnapshot[]
}

/** Caller must quiesce its engine and domain writer for a coherent combined generation.
 * VACUUM INTO independently captures committed SQLite pages, including an active WAL.
 * This module never queries or modifies OpenCode's private tables, nor copies auth.json.
 */
export async function backupEngine(hostDir: string, generationDir: string, engineVersion: string): Promise<EngineCheckpoint> {
  validVersion(engineVersion)
  directory(hostDir)
  directory(generationDir)
  const target = join(resolve(generationDir), "engine")
  if (existsSync(target)) throw new Error("Engine checkpoint already exists; use a new generation")
  const source = dataDirectory(hostDir, false)
  const names = source ? knownDatabases(source) : []
  const staging = mkdtempSync(join(resolve(hostDir), ".engine-snapshot-"))
  try {
    const files = names.map((name): EngineDatabaseSnapshot => {
      const original = join(source!, name)
      regularFile(original)
      const snapshot = join(staging, name)
      const db = new Database(original, { readonly: true, strict: true })
      try {
        db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000")
        db.query("VACUUM INTO ?").run(snapshot)
      } finally { db.close(true) }
      const closed = new Database(snapshot, { strict: true })
      try { closed.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL") }
      finally { closed.close(true) }
      const meta = inspectDatabase(snapshot)
      return { path: name, sha256: hashFile(snapshot), size: regularFile(snapshot).size, ...meta }
    })
    const manifest: EngineCheckpoint = { format: 1, complete: true, engineVersion, createdAt: Date.now(), files }
    mkdirSync(target, { mode: 0o700 })
    for (const file of files) {
      const destination = join(target, file.path)
      copyFileSync(join(staging, file.path), destination, constants.COPYFILE_EXCL)
      flushFile(destination)
      verifyFile(destination, file)
    }
    writeExclusive(join(target, "complete.json"), JSON.stringify(manifest, null, 2))
    flushDirectory(target)
    flushDirectory(resolve(generationDir))
    return manifest
  } finally { rmSync(staging, { recursive: true, force: true }) }
}

/** Accepts the generation directory, not its engine subdirectory. */
export async function verifyEngineCheckpoint(generationDir: string): Promise<EngineCheckpoint> {
  directory(generationDir)
  const root = join(resolve(generationDir), "engine")
  directory(root)
  const file = join(root, "complete.json")
  if (regularFile(file).size > 16_384) throw new Error("Oversized engine checkpoint manifest")
  const raw = readFileSync(file, "utf8")
  const manifest = parseManifest(JSON.parse(raw) as unknown)
  const allowed = new Set(["complete.json", ...manifest.files.map((item) => item.path)])
  for (const name of readdirSync(root)) {
    if (!allowed.has(name)) throw new Error("Unexpected engine checkpoint file")
  }
  for (const item of manifest.files) verifyFile(join(root, item.path), item)
  if (readFileSync(file, "utf8") !== raw) throw new Error("Engine checkpoint manifest changed during validation")
  return manifest
}

/** Restore only before engine startup. Exact engine versions are required until a
 * separately tested compatibility plan exists. Existing databases/sidecars are never
 * overwritten. NTFS/local filesystems with hard links provide exclusive final install.
 */
export async function restoreEngine(hostDir: string, generationDir: string, expectedVersion: string): Promise<void> {
  validVersion(expectedVersion)
  const manifest = await verifyEngineCheckpoint(generationDir)
  if (manifest.engineVersion !== expectedVersion) throw new Error("Engine version mismatch; an explicitly tested migration plan is required")
  directory(hostDir)
  const target = dataDirectory(hostDir, true)!
  for (const name of DATABASES) {
    for (const suffix of ["", ...SIDECARS]) {
      if (existsSync(join(target, name + suffix))) throw new Error("Engine restore target already contains database state")
    }
  }
  knownDatabases(target)
  const staging = mkdtempSync(join(resolve(hostDir), ".engine-restore-"))
  const installed: string[] = []
  try {
    for (const item of manifest.files) {
      const snapshot = join(staging, item.path)
      copyFileSync(join(resolve(generationDir), "engine", item.path), snapshot, constants.COPYFILE_EXCL)
      flushFile(snapshot)
      verifyFile(snapshot, item)
    }
    // No awaits occur during installation. A second cooperating writer is excluded
    // by the caller's host lock; linkSync still refuses existing names atomically.
    for (const item of manifest.files) {
      const destination = join(target, item.path)
      linkSync(join(staging, item.path), destination)
      installed.push(item.path)
      verifyFile(destination, item)
    }
    flushDirectory(target)
  } catch (error) {
    for (const name of installed) {
      const destination = join(target, name)
      const original = lstatSync(join(staging, name))
      const current = lstatSync(destination)
      if (original.dev === current.dev && original.ino === current.ino) unlinkSync(destination)
    }
    throw error
  } finally { rmSync(staging, { recursive: true, force: true }) }
}

function dataDirectory(hostDir: string, create: boolean): string | undefined {
  let path = resolve(hostDir)
  directory(path)
  for (const segment of ["opencode", "data", "opencode"]) {
    path = join(path, segment)
    if (!existsSync(path)) {
      if (!create) return undefined
      mkdirSync(path, { mode: 0o700 })
    }
    directory(path)
  }
  return path
}
function knownDatabases(root: string): DatabaseName[] {
  const names = readdirSync(root)
  for (const name of names) {
    if (!/\.(?:db|sqlite|sqlite3)(?:-wal|-shm|-journal)?$/i.test(name)) continue
    if (!DATABASES.some((allowed) => name === allowed || SIDECARS.some((suffix) => name === allowed + suffix))) {
      throw new Error("Unrecognized engine database; backup adapter must be updated before migration")
    }
    const owner = DATABASES.find((allowed) => SIDECARS.some((suffix) => name === allowed + suffix))
    if (owner && !names.includes(owner)) throw new Error("Orphaned engine SQLite sidecar requires recovery before backup")
  }
  return DATABASES.filter((name) => names.includes(name))
}
function inspectDatabase(path: string): { userVersion: number; schemaVersion: number } {
  regularFile(path)
  for (const suffix of SIDECARS) if (existsSync(path + suffix)) throw new Error("Engine snapshot must be a closed standalone database")
  const db = new Database(path, { readonly: true, strict: true })
  try {
    db.exec("PRAGMA trusted_schema=OFF")
    const result = db.query("PRAGMA integrity_check").all() as Record<string, unknown>[]
    if (result.length !== 1 || Object.values(result[0]!)[0] !== "ok") throw new Error("Engine SQLite integrity_check failed")
    const userVersion = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
    const schemaVersion = (db.query("PRAGMA schema_version").get() as { schema_version: number }).schema_version
    if (!Number.isSafeInteger(userVersion) || !Number.isSafeInteger(schemaVersion)) throw new Error("Invalid SQLite metadata")
    return { userVersion, schemaVersion }
  } finally { db.close(true) }
}
function verifyFile(path: string, expected: EngineDatabaseSnapshot): void {
  if (regularFile(path).size !== expected.size || hashFile(path) !== expected.sha256) throw new Error("Engine checkpoint SHA-256 or size mismatch")
  const actual = inspectDatabase(path)
  if (actual.userVersion !== expected.userVersion || actual.schemaVersion !== expected.schemaVersion) throw new Error("Engine checkpoint SQLite metadata mismatch")
  if (hashFile(path) !== expected.sha256) throw new Error("Engine checkpoint changed during validation")
}
function parseManifest(value: unknown): EngineCheckpoint {
  if (!isRecord(value) || value.format !== 1 || value.complete !== true || typeof value.engineVersion !== "string"
    || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0 || !Array.isArray(value.files)
    || value.files.length > DATABASES.length) throw new Error("Invalid engine checkpoint manifest")
  validVersion(value.engineVersion)
  const files = value.files.map((item): EngineDatabaseSnapshot => {
    if (!isRecord(item) || !DATABASES.includes(item.path as DatabaseName) || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)
      || !Number.isSafeInteger(item.size) || Number(item.size) < 512 || !Number.isSafeInteger(item.userVersion) || !Number.isSafeInteger(item.schemaVersion)) {
      throw new Error("Invalid engine checkpoint database entry")
    }
    return { path: item.path as DatabaseName, sha256: item.sha256, size: Number(item.size), userVersion: Number(item.userVersion), schemaVersion: Number(item.schemaVersion) }
  })
  if (new Set(files.map((item) => item.path)).size !== files.length) throw new Error("Duplicate engine database entry")
  return { format: 1, complete: true, engineVersion: value.engineVersion, createdAt: Number(value.createdAt), files }
}
function validVersion(version: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(version)) throw new Error("A valid exact engine version is required") }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) }
function directory(path: string): void { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Engine data directories must not be symbolic links") }
function regularFile(path: string) { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Engine snapshot must be a regular file"); return stat }
function hashFile(path: string): string {
  regularFile(path)
  const fd = openSync(path, "r")
  try {
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    for (;;) { const n = readSync(fd, buffer, 0, buffer.length, null); if (!n) return hash.digest("hex"); hash.update(buffer.subarray(0, n)) }
  } finally { closeSync(fd) }
}
function flushFile(path: string) { const fd = openSync(path, "r+"); try { fsyncSync(fd) } finally { closeSync(fd) } }
function writeExclusive(path: string, text: string) { const fd = openSync(path, "wx", 0o600); try { writeFileSync(fd, text, "utf8"); fsyncSync(fd) } finally { closeSync(fd) } }
function flushDirectory(path: string) {
  // Windows directory fsync is unavailable here; complete+hash validation still guards recovery.
  if (process.platform === "win32") return
  const fd = openSync(path, "r"); try { fsyncSync(fd) } finally { closeSync(fd) }
}
