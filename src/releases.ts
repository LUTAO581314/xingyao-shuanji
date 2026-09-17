import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { constants, closeSync, copyFileSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path"
import { acquireHostLock, listCheckpoints } from "./checkpoint"
import { PROTOCOL_VERSION, isSupportedSchema, type CheckpointInfo } from "./contracts"

export type ReleaseManifest = {
  product: "xingyao-xuanji"; version: string; protocolVersion: number; schemaVersion: number
  platform: "windows-x64"; adapter: "legacy-http-v1"; files: Record<string, string>
  validation: string; knownLimitations: string[]; createdAt?: string
}
export type ReleaseInfo = { id: string; path: string; manifestHash: string; manifest: ReleaseManifest; status: "candidate" | "staged" }
export type ReleaseTestEvidence = { passed: boolean; execution: "real" | "mock"; evidence: string[]; startedAt: number; finishedAt: number }
export type ReleaseValidationReport = {
  manifestHash: string; outcome: "passed" | "failed"
  tests: { backendContract: ReleaseTestEvidence; restore: ReleaseTestEvidence; soulIntegration: ReleaseTestEvidence }
}
export type ReleaseRecovery = { generation: string; identityId: string; revision: number; schemaVersion: number; checkpointSha256: string; hostDatabase: string }
export type ReleaseSelection = {
  format: 1; id: string; sequence: number; releaseId: string; releasePath: string; manifestHash: string
  previousSelection: string | null; previousReleaseId: string | null; mode: "activate" | "rollback"; createdAt: number
  validation: ReleaseValidationReport; recovery: ReleaseRecovery | null; warnings?: string[]
}
export type RollbackRecoveryInput = { vaultDir: string; generation: string; identityId: string; expectedRevision: number; restoredHostDb: string }

/** Older binaries can ignore unsupported generations and append a second head.
 * Inspect the entire verified vault, not only the snapshot selected for recovery.
 */
export function assertVaultSchemaCompatible(schemaVersion: number, checkpoints: readonly Pick<CheckpointInfo, "schemaVersion">[]): void {
  if (checkpoints.some(checkpoint => checkpoint.schemaVersion > schemaVersion))
    throw new Error("所选旧发行与当前便携库不匹配：库中已有更高 schema 的完整检查点。请使用隔离的便携库和宿主恢复副本，不能让旧程序继续写入这个库。")
}
const STAGED = ".staged.json"
const RELEASE_ID = /^r-[a-z0-9]+-[a-f0-9-]{36}$/
const SELECTION_ID = /^\d{12}-[a-f0-9-]{36}$/
const HEX = /^[a-f0-9]{64}$/
const MAX_MANIFEST = 1024 * 1024
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"

function plainFile(path: string) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`发行文件必须是普通文件：${path}`)
  return stat
}
function safeDirectory(path: string) {
  const full = resolve(path), root = parse(full).root
  let current = root
  for (const part of full.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`发行路径不允许符号链接或连接点：${current}`)
  }
}
function digest(bytes: Uint8Array | string) { return createHash("sha256").update(bytes).digest("hex") }
function hashFile(path: string) {
  plainFile(path)
  const fd = openSync(path, "r")
  try {
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024)
    for (;;) { const size = readSync(fd, buffer, 0, buffer.length, null); if (!size) return hash.digest("hex"); hash.update(buffer.subarray(0, size)) }
  } finally { closeSync(fd) }
}
function readJson(path: string, max = MAX_MANIFEST): { value: unknown; hash: string; bytes: Buffer } {
  if (plainFile(path).size > max) throw new Error("发行元数据过大")
  const bytes = readFileSync(path)
  return { value: JSON.parse(bytes.toString("utf8")), hash: digest(bytes), bytes }
}
function writeNew(path: string, contents: string | Uint8Array) {
  const fd = openSync(path, "wx", 0o600)
  try { writeFileSync(fd, contents); fsyncSync(fd) } finally { closeSync(fd) }
}
function flushDirectory(path: string) {
  if (process.platform === "win32") return
  const fd = openSync(path, "r")
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function safeMember(name: string) {
  if (!name || name.length > 512 || isAbsolute(name) || name.includes("\\") || /[:\x00-\x1f]/.test(name)) throw new Error(`非法发行文件路径：${name}`)
  const parts = name.split("/")
  if (parts.some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))) throw new Error(`非法发行文件路径：${name}`)
  if (["release.json", STAGED].includes(name.toLowerCase()) || parts[0]!.startsWith(".")) throw new Error(`保留的发行文件路径：${name}`)
  return parts
}
function manifestOf(value: unknown): ReleaseManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("发行清单不是对象")
  const m = value as ReleaseManifest
  if (m.product !== "xingyao-xuanji" || typeof m.version !== "string" || m.version.length > 128 || !VERSION.test(m.version)) throw new Error("发行产品或版本不受支持")
  if (m.protocolVersion !== PROTOCOL_VERSION || !isSupportedSchema(m.schemaVersion)) throw new Error("发行协议或数据库 schema 不受支持，不能覆盖稳定版本")
  if (m.platform !== "windows-x64" || m.adapter !== "legacy-http-v1") throw new Error("发行平台或 OpenCode 适配器不受支持")
  if (typeof m.validation !== "string" || !Array.isArray(m.knownLimitations) || m.knownLimitations.some(item => typeof item !== "string")) throw new Error("发行验收说明缺失")
  if (!m.files || typeof m.files !== "object" || Array.isArray(m.files) || Object.keys(m.files).length > 256) throw new Error("发行文件清单无效")
  if (!Object.hasOwn(m.files, "xingyao.exe") || !Object.hasOwn(m.files, "opencode.exe")) throw new Error("完整发行必须包含 xingyao.exe 和 opencode.exe")
  const seen = new Set<string>()
  for (const [name, hash] of Object.entries(m.files)) {
    safeMember(name)
    if (seen.has(name.toLowerCase())) throw new Error("发行文件名称存在 Windows 大小写冲突")
    seen.add(name.toLowerCase())
    if (typeof hash !== "string" || !HEX.test(hash)) throw new Error(`发行文件哈希无效：${name}`)
  }
  return m
}

/** Checks only declared artifacts; staging copies that exact allowlist. No executable is run. */
export async function inspectRelease(path: string): Promise<ReleaseInfo> {
  path = resolve(path)
  safeDirectory(path)
  const raw = readJson(join(path, "release.json"))
  const manifest = manifestOf(raw.value)
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = join(path, ...safeMember(name))
    safeDirectory(dirname(file))
    if (hashFile(file) !== expected) throw new Error(`发行文件 SHA-256 不匹配：${name}`)
  }
  if (hashFile(join(path, "release.json")) !== raw.hash) throw new Error("校验期间发行清单发生变化")
  let status: ReleaseInfo["status"] = "candidate"
  try {
    const marker = readJson(join(path, STAGED), 16_384).value as { format?: number; releaseId?: string; manifestHash?: string; complete?: boolean }
    if (marker.format !== 1 || marker.complete !== true || marker.releaseId !== basename(path) || marker.manifestHash !== raw.hash) throw new Error("候选暂存完成记录不匹配")
    status = "staged"
  } catch (error) { if (!isMissing(error)) throw error }
  return { id: basename(path), path, manifestHash: raw.hash, manifest, status }
}

/** Creates a new immutable candidate directory. Never modifies a selected/running release. */
export async function stageRelease(candidateDir: string, systemDir: string): Promise<ReleaseInfo> {
  const source = await inspectRelease(candidateDir)
  systemDir = resolve(systemDir)
  mkdirSync(systemDir, { recursive: true })
  safeDirectory(systemDir)
  const unlock = acquireHostLock(join(systemDir, ".release-writer"))
  try {
    const root = join(systemDir, "releases")
    mkdirSync(root, { recursive: true }); safeDirectory(root)
    const id = `r-${Date.now().toString(36)}-${randomUUID()}`, destination = join(root, id)
    mkdirSync(destination)
    for (const name of Object.keys(source.manifest.files)) {
      const target = join(destination, ...safeMember(name))
      mkdirSync(dirname(target), { recursive: true })
      const from = join(source.path, ...safeMember(name))
      safeDirectory(dirname(from)); plainFile(from)
      copyFileSync(from, target, constants.COPYFILE_EXCL)
      const fd = openSync(target, "r+")
      try { fsyncSync(fd) } finally { closeSync(fd) }
    }
    const manifestBytes = readFileSync(join(source.path, "release.json"))
    if (digest(manifestBytes) !== source.manifestHash) throw new Error("复制期间候选清单发生变化")
    writeNew(join(destination, "release.json"), manifestBytes)
    const copied = await inspectRelease(destination)
    if (copied.manifestHash !== source.manifestHash) throw new Error("复制后的发行清单哈希不一致")
    writeNew(join(destination, STAGED), JSON.stringify({ format: 1, complete: true, releaseId: id, manifestHash: copied.manifestHash, stagedAt: Date.now() }))
    flushDirectory(destination); flushDirectory(root)
    return { ...copied, status: "staged" }
  } finally { unlock() }
}

function validateReport(report: ReleaseValidationReport, manifestHash: string) {
  if (!report || report.manifestHash !== manifestHash || report.outcome !== "passed") throw new Error("验收报告未通过或未绑定当前发行清单哈希")
  for (const name of ["backendContract", "restore", "soulIntegration"] as const) {
    const test = report.tests?.[name]
    if (!test || test.passed !== true || test.execution !== "real" || !Array.isArray(test.evidence) || !test.evidence.length || test.evidence.some(value => typeof value !== "string" || !value.trim()) ||
      !Number.isSafeInteger(test.startedAt) || !Number.isSafeInteger(test.finishedAt) || test.startedAt < 0 || test.finishedAt < test.startedAt || test.finishedAt > Date.now() + 60_000)
      throw new Error(`缺少通过的真实集成验收及证据：${name}`)
  }
  if (JSON.stringify(report).length > 128_000) throw new Error("验收报告过大")
}
function selectionOf(value: unknown, id: string): ReleaseSelection {
  if (!value || typeof value !== "object") throw new Error("切换记录无效")
  const s = value as ReleaseSelection
  if (s.format !== 1 || s.id !== id || !SELECTION_ID.test(id) || !RELEASE_ID.test(s.releaseId) || !HEX.test(s.manifestHash) ||
    !Number.isSafeInteger(s.sequence) || s.sequence < 1 || !id.startsWith(`${s.sequence}`.padStart(12, "0") + "-") ||
    !(s.previousSelection === null || (typeof s.previousSelection === "string" && SELECTION_ID.test(s.previousSelection))) ||
    !(s.previousReleaseId === null || (typeof s.previousReleaseId === "string" && RELEASE_ID.test(s.previousReleaseId))) ||
    !["activate", "rollback"].includes(s.mode) || !Number.isSafeInteger(s.createdAt) || s.createdAt < 0 ||
    (s.mode === "rollback" && !s.recovery)) throw new Error("切换记录字段不完整")
  validateReport(s.validation, s.manifestHash)
  if (s.recovery !== null) {
    const recovery = s.recovery
    if (!recovery || typeof recovery.generation !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(recovery.generation) ||
      typeof recovery.identityId !== "string" || !recovery.identityId || !Number.isSafeInteger(recovery.revision) || recovery.revision < 0 ||
      !isSupportedSchema(recovery.schemaVersion) || typeof recovery.checkpointSha256 !== "string" || !HEX.test(recovery.checkpointSha256) ||
      typeof recovery.hostDatabase !== "string" || !isAbsolute(recovery.hostDatabase)) throw new Error("切换记录缺少有效的配套恢复信息")
  }
  return s
}
function readSelections(systemDir: string): ReleaseSelection[] {
  const root = join(systemDir, "selections")
  let entries: string[]
  try { safeDirectory(root); entries = readdirSync(root) } catch (error) { if (isMissing(error)) return []; throw error }
  const selections: ReleaseSelection[] = []
  for (const id of entries) {
    if (!SELECTION_ID.test(id)) continue
    try {
      const directory = join(root, id); safeDirectory(directory)
      const complete = readJson(join(directory, "complete.json"), 16_384).value as { format: number; complete: boolean; sha256: string }
      const record = readJson(join(directory, "selection.json"))
      if (complete.format !== 1 || complete.complete !== true || complete.sha256 !== record.hash) continue
      selections.push(selectionOf(record.value, id))
    } catch { /* Torn or incomplete journals never replace an earlier complete selection. */ }
  }
  return selections
}
function latestSelection(selections: ReleaseSelection[]) {
  if (!selections.length) return null
  const byId = new Map(selections.map(selection => [selection.id, selection]))
  for (const selection of selections) {
    const parent = selection.previousSelection && byId.get(selection.previousSelection)
    if (selection.previousSelection === null) {
      if (selection.sequence !== 1 || selection.previousReleaseId !== null) throw new Error("发行切换历史起点无效")
    } else if (!parent || parent.sequence + 1 !== selection.sequence || parent.releaseId !== selection.previousReleaseId) throw new Error("发行切换历史缺失或分叉，不能猜测当前版本")
  }
  const parents = new Set(selections.map(selection => selection.previousSelection))
  const heads = selections.filter(selection => !parents.has(selection.id))
  if (heads.length !== 1) throw new Error("发行切换历史存在多个分支，需要明确选择")
  return heads[0]!
}

/** The append-only, checksummed journal is authoritative; pointer JSON files are only mirrors. */
export async function resolveCurrent(systemDir: string): Promise<ReleaseSelection | null> {
  systemDir = resolve(systemDir)
  const selected = latestSelection(readSelections(systemDir))
  if (!selected) return null
  const release = await inspectRelease(join(systemDir, "releases", selected.releaseId))
  if (release.status !== "staged" || release.manifestHash !== selected.manifestHash) throw new Error("已选定发行损坏；停止启动，不自动降级到可能不匹配的数据版本")
  // Derive the installed path again so moving the USB drive does not retain its old drive letter.
  return { ...selected, releasePath: release.path }
}
function writeMirror(path: string, selection: ReleaseSelection) {
  // Truncation can tear on exFAT. No reader should treat this mirror as authoritative.
  try { plainFile(path) } catch (error) { if (!isMissing(error)) throw error }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600)
  try { writeFileSync(fd, JSON.stringify(selection, null, 2)); fsyncSync(fd) } finally { closeSync(fd) }
}
function compareVersions(left: string, right: string) {
  const a = VERSION.exec(left)!, b = VERSION.exec(right)!
  for (let i = 1; i <= 3; i++) { const x = BigInt(a[i]!), y = BigInt(b[i]!); if (x !== y) return x > y ? 1 : -1 }
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : !a[4] ? 1 : -1
  const ap = a[4].split("."), bp = b[4].split(".")
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i], y = bp[i]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn && yn) { if (BigInt(x) !== BigInt(y)) return BigInt(x) > BigInt(y) ? 1 : -1; continue }
    if (xn !== yn) return xn ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}
async function selectRelease(systemDir: string, releaseId: string, report: ReleaseValidationReport, mode: "activate" | "rollback", recovery: ReleaseRecovery | null): Promise<ReleaseSelection> {
  if (!RELEASE_ID.test(releaseId)) throw new Error("非法发行标识")
  report = structuredClone(report)
  systemDir = resolve(systemDir); safeDirectory(systemDir)
  const unlock = acquireHostLock(join(systemDir, ".release-writer"))
  try {
    const release = await inspectRelease(join(systemDir, "releases", releaseId))
    if (release.status !== "staged") throw new Error("发行尚未完整暂存")
    validateReport(report, release.manifestHash)
    const previous = mode === "rollback" ? latestSelection(readSelections(systemDir)) : await resolveCurrent(systemDir)
    if (mode === "activate" && previous) {
      if (previous.releaseId === releaseId) return previous
      const old = await inspectRelease(previous.releasePath)
      if (release.manifest.schemaVersion < old.manifest.schemaVersion)
        throw new Error("较旧的数据库 schema 必须走配套检查点回滚流程，不能通过新版号激活旧数据结构")
      if (compareVersions(release.manifest.version, old.manifest.version) <= 0 || readSelections(systemDir).some(selection => selection.manifestHash === release.manifestHash))
        throw new Error("相同或更早的发行必须走配套检查点回滚流程，不能通过普通激活绕过数据检查")
      // An upgrade from a recovered branch must keep using that explicitly selected data.
      recovery = previous.recovery
    }
    if (previous?.releaseId === releaseId && previous.mode === mode && JSON.stringify(previous.recovery) === JSON.stringify(recovery)) return previous
    const sequence = (previous?.sequence ?? 0) + 1
    if (sequence >= 1_000_000_000_000) throw new Error("发行代次超出范围")
    const id = `${String(sequence).padStart(12, "0")}-${randomUUID()}`
    const selection: ReleaseSelection = { format: 1, id, sequence, releaseId, releasePath: release.path, manifestHash: release.manifestHash, previousSelection: previous?.id ?? null, previousReleaseId: previous?.releaseId ?? null, mode, createdAt: Date.now(), validation: report, recovery }
    const root = join(systemDir, "selections"); mkdirSync(root, { recursive: true }); safeDirectory(root)
    const directory = join(root, id); mkdirSync(directory)
    const body = JSON.stringify(selection, null, 2)
    writeNew(join(directory, "selection.json"), body)
    writeNew(join(directory, "complete.json"), JSON.stringify({ format: 1, complete: true, sha256: digest(body) }))
    flushDirectory(directory); flushDirectory(root)
    const warnings: string[] = []
    if (previous) { try { writeMirror(join(systemDir, "previous.json"), previous) } catch { warnings.push("previous.json 镜像未更新；完整切换日志仍保留上一版本") } }
    try { writeMirror(join(systemDir, "current.json"), selection) } catch { warnings.push("current.json 镜像未更新；启动器必须通过 resolveCurrent 读取完整切换日志") }
    return warnings.length ? { ...selection, warnings } : selection
  } finally { unlock() }
}

/** Changes the selection for the next launch; does not stop or overwrite an existing process. */
export function activateRelease(systemDir: string, releaseId: string, validationReport: ReleaseValidationReport): Promise<ReleaseSelection> {
  return selectRelease(systemDir, releaseId, validationReport, "activate", null)
}

/** Requires an already restored, closed host copy. Never replaces the active user's database. */
export async function rollbackRelease(systemDir: string, releaseId: string, validationReport: ReleaseValidationReport, recovery: RollbackRecoveryInput): Promise<ReleaseSelection> {
  recovery = structuredClone(recovery)
  validationReport = structuredClone(validationReport)
  if (!recovery || !isAbsolute(recovery.restoredHostDb) || !recovery.generation || !recovery.identityId || !Number.isSafeInteger(recovery.expectedRevision)) throw new Error("回滚必须提供已恢复的配套检查点和宿主副本")
  if (!RELEASE_ID.test(releaseId)) throw new Error("非法发行标识")
  const release = await inspectRelease(join(resolve(systemDir), "releases", releaseId))
  validateReport(validationReport, release.manifestHash)
  const snapshots = await listCheckpoints(recovery.vaultDir)
  assertVaultSchemaCompatible(release.manifest.schemaVersion, snapshots)
  const snapshot = snapshots.find(value => value.generation === recovery.generation)
  if (!snapshot || snapshot.identityId !== recovery.identityId || snapshot.revision !== recovery.expectedRevision || snapshot.schemaVersion !== release.manifest.schemaVersion) throw new Error("回滚检查点不可用，或身份、revision、schema 与所选代码不匹配")
  const path = resolve(recovery.restoredHostDb)
  safeDirectory(dirname(path)); plainFile(path)
  const unlock = acquireHostLock(dirname(path))
  try {
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try { lstatSync(`${path}${suffix}`); throw new Error("回滚宿主副本尚未闭合；先关闭数据库后再切换发行") }
      catch (error) { if (!isMissing(error)) throw error }
    }
    const db = new Database(path, { readonly: true, strict: true })
    try {
      db.exec("PRAGMA trusted_schema=OFF")
      const checks = db.query("PRAGMA integrity_check").all() as Record<string, unknown>[]
      const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
      const read = (key: string) => (db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null)?.value
      if (checks.length !== 1 || Object.values(checks[0]!)[0] !== "ok" || version !== snapshot.schemaVersion || read("identity_id") !== snapshot.identityId || read("revision") !== String(snapshot.revision) || read("checkpoint_generation") !== snapshot.generation)
        throw new Error("宿主副本未实际恢复到指定检查点，不能只切换程序声称数据回滚")
    } finally { db.close(true) }
    return await selectRelease(systemDir, releaseId, validationReport, "rollback", { generation: snapshot.generation, identityId: snapshot.identityId, revision: snapshot.revision, schemaVersion: snapshot.schemaVersion, checkpointSha256: snapshot.sha256, hostDatabase: path })
  } finally { unlock() }
}
