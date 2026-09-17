import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, writeFileSync, type Stats } from "node:fs"
import { isAbsolute, join, parse, resolve } from "node:path"
import { listCheckpoints, restoreCheckpoint } from "./checkpoint"
import { restoreEngine, verifyEngineCheckpoint, type EngineCheckpoint } from "./engine-backup"
import type { CheckpointInfo } from "./contracts"

export type RestoreBoundary = "domain-staged" | "engine-staged" | "prepared" | "old-domain-preserved" | "old-engine-preserved" | "preserved" | "domain-published" | "engine-published" | "completed"
export type RestoreResult = { restored: boolean; generation?: string }
export type ResumeProductRestoreOptions = {
  hostDir: string; vaultDir: string; engineVersion: string
  afterBoundary?: (boundary: RestoreBoundary, details: { generation: string; stageDir: string; backupDir: string }) => void
}
export type RestoreProductOptions = ResumeProductRestoreOptions & { generation: string }
type Identity = { dev: number; ino: number; birthtimeMs: number }
type OwnedFile = { name: string; identity: Identity; sha256: string; size: number }
type Phase = "prepared" | "preserving" | "preserved" | "domain-published" | "engine-published" | "complete"
type Journal = {
  format: 1; attempt: string; generation: string; checkpoint: CheckpointInfo; engineVersion: string | null; engineManifestHash: string | null
  stage: string; backup: string; phase: Phase; createdAt: number; updatedAt: number
  hostIdentity: Identity; stageIdentity: Identity; backupIdentity: Identity; engineIdentity: Identity
  domain: OwnedFile; engineFiles: OwnedFile[]; oldDomain: OwnedFile[]; oldEngineIdentity: Identity | null
}
const JOURNAL = "restore-journal.json"
const DOMAIN_NAMES = ["soul.db", "soul.db-wal", "soul.db-shm", "soul.db-journal"]
const ENGINE_NAMES = ["opencode.db", "opencode-product-dev.db"]
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const HEX = /^[a-f0-9]{64}$/
const active = new Set<string>()
const identity = (stat: Stats): Identity => ({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs })
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
function statOptional(path: string) { try { return lstatSync(path) } catch (error) { if (missing(error)) return null; throw error } }
function plainFile(path: string) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("恢复文件不是普通文件，停止操作")
  return stat
}
function directory(path: string, expected?: Identity): Identity {
  const full = resolve(path), root = parse(full).root
  let current = root
  for (const part of full.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("恢复路径含符号链接、连接点或非目录")
  }
  const actual = identity(lstatSync(full))
  if (expected && !same(actual, expected)) throw new Error("恢复目录身份改变，停止操作")
  return actual
}
function ensureDirectories(root: string, segments: string[]) {
  let current = root
  const rootIdentity = directory(root)
  for (const segment of segments) {
    current = join(current, segment)
    if (!statOptional(current)) mkdirSync(current, { mode: 0o700 })
    if (directory(current).dev !== rootIdentity.dev) throw new Error("恢复路径跨存储卷，停止操作")
  }
  return current
}
function hashFile(path: string): string {
  plainFile(path)
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024)
    for (;;) { const size = readSync(fd, buffer, 0, buffer.length, null); if (!size) return hash.digest("hex"); hash.update(buffer.subarray(0, size)) }
  } finally { closeSync(fd) }
}
function captureFile(path: string, name: string): OwnedFile {
  const before = plainFile(path), hash = hashFile(path), after = plainFile(path)
  if (!same(identity(before), identity(after)) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("恢复准备期间文件发生变化")
  return { name, identity: identity(after), sha256: hash, size: after.size }
}
function verifyFile(path: string, expected: OwnedFile) {
  const stat = plainFile(path)
  if (!same(identity(stat), expected.identity) || stat.size !== expected.size || hashFile(path) !== expected.sha256) throw new Error("恢复文件身份或 SHA-256 不匹配；保留当前状态")
}
function flushDirectory(path: string) {
  if (process.platform === "win32") return
  const fd = openSync(path, "r")
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function writeExclusive(path: string, bytes: string) {
  const fd = openSync(path, "wx", 0o600)
  try { writeFileSync(fd, bytes, "utf8"); fsyncSync(fd) } finally { closeSync(fd) }
}
function writeJournal(hostDir: string, journal: Journal) {
  directory(hostDir, journal.hostIdentity)
  journal.updatedAt = Date.now()
  const payload = JSON.stringify(journal)
  const content = JSON.stringify({ format: 1, journal, sha256: digest(payload) }, null, 2)
  const target = join(hostDir, JOURNAL), previous = statOptional(target)
  if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw new Error("恢复日志路径不是普通文件")
  const temporary = join(hostDir, `.restore-journal-${randomUUID()}.tmp`)
  writeExclusive(temporary, content)
  // The host directory is NTFS. A flushed temporary file replaces this one journal;
  // source/backup identities still reconcile operations interrupted around the rename.
  renameSync(temporary, target)
  flushDirectory(hostDir)
}
function validIdentity(value: Identity) { return value && [value.dev, value.ino, value.birthtimeMs].every(x => typeof x === "number" && Number.isFinite(x) && x >= 0) }
function validFile(value: OwnedFile, names: string[]) { return value && names.includes(value.name) && validIdentity(value.identity) && typeof value.sha256 === "string" && HEX.test(value.sha256) && Number.isSafeInteger(value.size) && value.size >= 0 }
function readJournal(hostDir: string): Journal | null {
  const path = join(hostDir, JOURNAL), stat = statOptional(path)
  if (!stat) return null
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000) throw new Error("恢复日志文件无效，不能跳过恢复事务")
  const envelope = JSON.parse(readFileSync(path, "utf8")) as { format: number; sha256: string; journal: Journal }
  const j = envelope.journal
  if (envelope.format !== 1 || !j || envelope.sha256 !== digest(JSON.stringify(j))) throw new Error("恢复日志校验失败，停止启动")
  if (j.format !== 1 || !UUID.test(j.attempt) || !GENERATION.test(j.generation) || j.stage !== `.product-restore-${j.attempt}` || j.backup !== `restore-${j.attempt}` ||
    !["prepared", "preserving", "preserved", "domain-published", "engine-published", "complete"].includes(j.phase) ||
    !Number.isSafeInteger(j.createdAt) || !Number.isSafeInteger(j.updatedAt) || !validIdentity(j.hostIdentity) || !validIdentity(j.stageIdentity) || !validIdentity(j.backupIdentity) || !validIdentity(j.engineIdentity) ||
    !validFile(j.domain, ["soul.db"]) || !Array.isArray(j.engineFiles) || j.engineFiles.length > 2 || j.engineFiles.some(x => !validFile(x, ENGINE_NAMES)) || new Set(j.engineFiles.map(x => x.name)).size !== j.engineFiles.length ||
    !Array.isArray(j.oldDomain) || j.oldDomain.length > 4 || j.oldDomain.some(x => !validFile(x, DOMAIN_NAMES)) || new Set(j.oldDomain.map(x => x.name)).size !== j.oldDomain.length ||
    !(j.oldEngineIdentity === null || validIdentity(j.oldEngineIdentity)) || !j.checkpoint || j.checkpoint.generation !== j.generation || typeof j.checkpoint.sha256 !== "string" || !HEX.test(j.checkpoint.sha256) ||
    !(j.engineVersion === null || (typeof j.engineVersion === "string" && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(j.engineVersion))) || !(j.engineManifestHash === null || (typeof j.engineManifestHash === "string" && HEX.test(j.engineManifestHash))))
    throw new Error("恢复日志字段或目录边界无效")
  if ((j.engineVersion === null) !== (j.engineManifestHash === null) || (j.engineFiles.length > 0 && !j.engineVersion)) throw new Error("恢复日志缺少引擎版本依据")
  directory(hostDir, j.hostIdentity)
  return j
}
function paths(hostDir: string, j: Journal) {
  return { stage: join(hostDir, j.stage), backup: join(hostDir, "recovery", j.backup), domain: join(hostDir, "soul.db"), engine: join(hostDir, "opencode", "data", "opencode"), stageEngine: join(hostDir, j.stage, "opencode", "data", "opencode"), backupEngine: join(hostDir, "recovery", j.backup, "opencode-data") }
}
function boundary(options: ResumeProductRestoreOptions, j: Journal, step: RestoreBoundary) {
  const p = paths(options.hostDir, j)
  options.afterBoundary?.(step, { generation: j.generation, stageDir: p.stage, backupDir: p.backup })
}
function domainMetadata(path: string, checkpoint: CheckpointInfo) {
  const db = new Database(path, { readonly: true, strict: true })
  try {
    db.exec("PRAGMA trusted_schema=OFF")
    const checks = db.query("PRAGMA integrity_check").all() as Record<string, unknown>[]
    const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
    const meta = (key: string) => (db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null)?.value
    if (checks.length !== 1 || Object.values(checks[0]!)[0] !== "ok" || version !== checkpoint.schemaVersion || meta("identity_id") !== checkpoint.identityId || meta("revision") !== String(checkpoint.revision) || meta("checkpoint_generation") !== checkpoint.generation) throw new Error("恢复领域库与指定检查点不一致")
    let hasSessions = false
    for (const row of db.query<{ body: string }, []>("SELECT body FROM tasks").all()) {
      const task = JSON.parse(row.body) as { sessionId?: unknown }
      if (task.sessionId !== undefined && task.sessionId !== null && task.sessionId !== "") hasSessions = true
    }
    return hasSessions
  } finally { db.close(true) }
}
function verifyEngineDirectory(path: string, j: Journal) {
  directory(path, j.engineIdentity)
  const names = readdirSync(path)
  if (names.length !== j.engineFiles.length || names.some(name => !j.engineFiles.some(file => file.name === name))) throw new Error("恢复引擎目录含意外文件，停止发布")
  for (const file of j.engineFiles) verifyFile(join(path, file.name), file)
}
async function source(options: ResumeProductRestoreOptions, generation: string) {
  const checkpoint = (await listCheckpoints(options.vaultDir)).find(item => item.generation === generation)
  if (!checkpoint) throw new Error("找不到完整且校验通过的恢复检查点")
  const generationDir = join(options.vaultDir, "checkpoints", generation)
  let engine: EngineCheckpoint | null = null, engineManifestHash: string | null = null
  if (statOptional(join(generationDir, "engine"))) {
    engine = await verifyEngineCheckpoint(generationDir)
    if (engine.engineVersion !== options.engineVersion) throw new Error("Engine version mismatch: 配套引擎验证失败，宿主数据未替换")
    engineManifestHash = hashFile(join(generationDir, "engine", "complete.json"))
  }
  return { checkpoint, generationDir, engine, engineManifestHash }
}
async function prepare(options: RestoreProductOptions): Promise<Journal> {
  const from = await source(options, options.generation)
  const attempt = randomUUID(), stageName = `.product-restore-${attempt}`, stage = join(options.hostDir, stageName)
  mkdirSync(stage, { mode: 0o700 })
  await restoreCheckpoint(options.vaultDir, options.generation, join(stage, "soul.db"))
  const hasSessions = domainMetadata(join(stage, "soul.db"), from.checkpoint)
  const domain = captureFile(join(stage, "soul.db"), "soul.db")
  if (!from.engine?.files.length && hasSessions) throw new Error("检查点包含会话绑定却没有配套引擎数据库，不能假装会话可续")
  const details = { generation: options.generation, stageDir: stage, backupDir: join(options.hostDir, "recovery", `restore-${attempt}`) }
  options.afterBoundary?.("domain-staged", details)
  if (from.engine) await restoreEngine(stage, from.generationDir, options.engineVersion)
  else ensureDirectories(stage, ["opencode", "data", "opencode"])
  options.afterBoundary?.("engine-staged", details)
  const enginePath = join(stage, "opencode", "data", "opencode")
  const engineFiles = (from.engine?.files ?? []).map(file => {
    const captured = captureFile(join(enginePath, file.path), file.path)
    if (captured.sha256 !== file.sha256 || captured.size !== file.size) throw new Error("暂存引擎文件与源检查点不一致，停止发布")
    return captured
  })
  verifyFile(join(stage, "soul.db"), domain)
  const backupRoot = ensureDirectories(options.hostDir, ["recovery"])
  const backupName = `restore-${attempt}`, backup = join(backupRoot, backupName); mkdirSync(backup, { mode: 0o700 })
  const oldDomain = DOMAIN_NAMES.flatMap(name => statOptional(join(options.hostDir, name)) ? [captureFile(join(options.hostDir, name), name)] : [])
  const hostIdentity = directory(options.hostDir)
  if (oldDomain.some(file => file.identity.dev !== hostIdentity.dev)) throw new Error("原宿主数据库跨存储卷，停止恢复")
  let oldEngineIdentity: Identity | null = null
  // Validate each existing ancestor even when the final data directory is missing.
  let current = options.hostDir
  for (const segment of ["opencode", "data", "opencode"]) { current = join(current, segment); if (!statOptional(current)) break; if (directory(current).dev !== hostIdentity.dev) throw new Error("原宿主引擎目录跨存储卷，停止恢复"); if (current === join(options.hostDir, "opencode", "data", "opencode")) oldEngineIdentity = directory(current) }
  const journal: Journal = { format: 1, attempt, generation: options.generation, checkpoint: from.checkpoint, engineVersion: from.engine?.engineVersion ?? null, engineManifestHash: from.engineManifestHash, stage: stageName, backup: backupName, phase: "prepared", createdAt: Date.now(), updatedAt: Date.now(), hostIdentity: directory(options.hostDir), stageIdentity: directory(stage), backupIdentity: directory(backup), engineIdentity: directory(enginePath), domain, engineFiles, oldDomain, oldEngineIdentity }
  verifyEngineDirectory(enginePath, journal)
  writeJournal(options.hostDir, journal)
  boundary(options, journal, "prepared")
  return journal
}
function preserveDomain(options: ResumeProductRestoreOptions, j: Journal) {
  const p = paths(options.hostDir, j)
  for (const file of j.oldDomain) {
    const old = join(options.hostDir, file.name), backup = join(p.backup, file.name)
    if (statOptional(backup)) {
      verifyFile(backup, file)
      const present = statOptional(old)
      if (present && (file.name !== "soul.db" || !same(identity(present), j.domain.identity))) throw new Error("原宿主文件与备份同时存在且归属不明，停止恢复")
      continue
    }
    verifyFile(old, file)
    renameSync(old, backup)
    flushDirectory(options.hostDir); flushDirectory(p.backup)
    boundary(options, j, "old-domain-preserved")
    verifyFile(backup, file)
  }
  for (const name of DOMAIN_NAMES.slice(1)) if (statOptional(join(options.hostDir, name))) throw new Error("宿主存在未纳入恢复事务的 SQLite sidecar")
}
function preserveEngine(options: ResumeProductRestoreOptions, j: Journal) {
  if (!j.oldEngineIdentity) return
  const p = paths(options.hostDir, j)
  if (statOptional(p.backupEngine)) {
    directory(p.backupEngine, j.oldEngineIdentity)
    const present = statOptional(p.engine)
    if (present) directory(p.engine, j.engineIdentity)
    return
  }
  directory(p.engine, j.oldEngineIdentity)
  renameSync(p.engine, p.backupEngine)
  flushDirectory(join(options.hostDir, "opencode", "data")); flushDirectory(p.backup)
  boundary(options, j, "old-engine-preserved")
  directory(p.backupEngine, j.oldEngineIdentity)
}
async function resume(options: ResumeProductRestoreOptions, j: Journal): Promise<RestoreResult> {
  if (j.phase === "complete") return { restored: false, generation: j.generation }
  const from = await source(options, j.generation)
  if (JSON.stringify(from.checkpoint) !== JSON.stringify(j.checkpoint) || from.engineManifestHash !== j.engineManifestHash || (from.engine?.engineVersion ?? null) !== j.engineVersion) throw new Error("恢复来源与持久日志不一致，停止恢复")
  if ((from.engine?.files.length ?? 0) !== j.engineFiles.length || j.engineFiles.some(file => !from.engine?.files.some(source => source.path === file.name && source.sha256 === file.sha256 && source.size === file.size))) throw new Error("恢复日志中的引擎文件与源检查点不一致")
  const p = paths(options.hostDir, j)
  directory(p.stage, j.stageIdentity); directory(p.backup, j.backupIdentity)
  // The domain stage remains as a hard link after publishing, allowing ownership
  // verification across a crash before the phase update without re-copying any DB.
  verifyFile(join(p.stage, "soul.db"), j.domain)
  const hasSessions = domainMetadata(join(p.stage, "soul.db"), j.checkpoint)
  if (!j.engineFiles.length && hasSessions) throw new Error("恢复领域库需要缺失的引擎会话")
  if (statOptional(p.stageEngine)) verifyEngineDirectory(p.stageEngine, j)
  else verifyEngineDirectory(p.engine, j)
  j.phase = "preserving"; writeJournal(options.hostDir, j)
  preserveDomain(options, j); preserveEngine(options, j)
  j.phase = "preserved"; writeJournal(options.hostDir, j); boundary(options, j, "preserved")
  if (statOptional(p.domain)) verifyFile(p.domain, j.domain)
  else {
    linkSync(join(p.stage, "soul.db"), p.domain)
    flushDirectory(options.hostDir)
    boundary(options, j, "domain-published")
    verifyFile(p.domain, j.domain)
  }
  j.phase = "domain-published"; writeJournal(options.hostDir, j)
  ensureDirectories(options.hostDir, ["opencode", "data"])
  if (statOptional(p.engine)) verifyEngineDirectory(p.engine, j)
  else {
    verifyEngineDirectory(p.stageEngine, j)
    renameSync(p.stageEngine, p.engine)
    flushDirectory(join(options.hostDir, "opencode", "data"))
    boundary(options, j, "engine-published")
    verifyEngineDirectory(p.engine, j)
  }
  j.phase = "engine-published"; writeJournal(options.hostDir, j)
  verifyFile(p.domain, j.domain); domainMetadata(p.domain, j.checkpoint); verifyEngineDirectory(p.engine, j)
  j.phase = "complete"; writeJournal(options.hostDir, j); boundary(options, j, "completed")
  return { restored: true, generation: j.generation }
}
function normalized<T extends ResumeProductRestoreOptions>(options: T): T {
  if (!isAbsolute(options.hostDir) || !isAbsolute(options.vaultDir) || typeof options.engineVersion !== "string") throw new Error("恢复需要绝对宿主/便携路径与明确引擎版本")
  const result = { ...options, hostDir: resolve(options.hostDir), vaultDir: resolve(options.vaultDir) }
  directory(result.hostDir)
  return result
}
async function serialized(options: ResumeProductRestoreOptions, action: () => Promise<RestoreResult>) {
  const key = process.platform === "win32" ? options.hostDir.toLowerCase() : options.hostDir
  if (active.has(key)) throw new Error("该宿主已有恢复事务运行")
  active.add(key)
  try { return await action() } finally { active.delete(key) }
}

/** Caller holds the host writer lock and has closed both the domain DB and engine. */
export async function restoreProduct(options: RestoreProductOptions): Promise<RestoreResult> {
  options = normalized(options)
  if (!GENERATION.test(options.generation)) throw new Error("恢复代次无效")
  return serialized(options, async () => {
    const old = readJournal(options.hostDir)
    if (old && old.phase !== "complete" && old.generation !== options.generation) throw new Error("已有未完成恢复事务，必须先完成同一代次")
    if (old && old.generation === options.generation) return resume(options, old)
    if (old) {
      const archive = join(options.hostDir, "recovery", old.backup, "restore-journal.completed.json")
      directory(join(options.hostDir, "recovery", old.backup), old.backupIdentity)
      if (!statOptional(archive)) writeExclusive(archive, readFileSync(join(options.hostDir, JOURNAL), "utf8"))
    }
    return resume(options, await prepare(options))
  })
}

/** Call before checking soul.db existence: an installed domain DB is not proof that engine recovery finished. */
export async function resumeProductRestore(options: ResumeProductRestoreOptions): Promise<RestoreResult> {
  options = normalized(options)
  return serialized(options, async () => {
    const journal = readJournal(options.hostDir)
    return journal ? resume(options, journal) : { restored: false }
  })
}
