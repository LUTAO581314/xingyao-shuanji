import { createHash, randomUUID } from "node:crypto"
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, renameSync, writeSync, type Stats } from "node:fs"
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path"
import { acquireHostLock } from "./checkpoint"

export const MAX_WORKSPACE_FILE_BYTES = 2 * 1024 * 1024
export type WorkspaceRoot = { id: string; path: string; label: string }
export type WorkspaceEntry = { name: string; path: string; kind: "directory" | "file"; size?: number; editable: boolean }
export type WorkspaceListing = { rootId: string; path: string; entries: WorkspaceEntry[]; truncated: boolean }
export type WorkspaceFile = { rootId: string; path: string; absolutePath: string; text: string; sha256: string; bytes: number; bom: boolean; lineEnding: "lf" | "crlf" | "mixed" | "none" }
export type WorkspaceSave = WorkspaceFile & { backupPath: string | null; changed: boolean }
export type WorkspaceIdentity = { dev: number; ino: number; birthtimeMs: number }
export type WorkspaceRootProof = { format: 1; path: string; identity: WorkspaceIdentity; directories: { path: string; identity: WorkspaceIdentity }[] }
export type WorkspaceFileProof = { format: 1; root: WorkspaceRootProof; path: string; absolutePath: string; identity: WorkspaceIdentity; sha256: string; directories: { path: string; identity: WorkspaceIdentity }[] }
export type WorkspaceRecovery = {
  id: string; rootId: string; path: string | null; recoveryDirectory: string
  status: "pending" | "restored" | "committed" | "unchanged" | "conflict" | "busy" | "manual"
  message: string; beforePath: string | null; backupPath: string | null; proposedPath: string | null
}
export type WorkspaceRecoveryListing = { rootId: string; entries: WorkspaceRecovery[]; truncated: boolean }
export type WorkspaceSaveBoundary = "recovery-created" | "backup-verified" | "proposed-verified" | "before-archive" | "source-archived" | "destination-created" | "destination-written" | "destination-verified"
export type WorkspaceRecoveryBoundary = "recovery-ready" | "recovery-destination-created" | "recovery-copy-progress" | "recovery-destination-written" | "recovery-restored"
export type WorkspaceFilesOptions = {
  /** Additional active runtime directories supplied by the application. */
  protectedDirectories?: string[]
  /** Private host state outside project roots; required for recovery across processes. */
  recoveryStateDirectory?: string
  /** Deterministic fault injection for tests; production callers omit this. */
  afterBoundary?: (boundary: WorkspaceSaveBoundary, context: { absolutePath: string; recoveryDirectory: string; backupPath: string; proposedPath: string }) => void
  afterRecoveryBoundary?: (boundary: WorkspaceRecoveryBoundary, context: { absolutePath: string; recoveryDirectory: string; backupPath: string; proposedPath: string }) => void
}
export class WorkspaceFileError extends Error {
  constructor(readonly kind: "invalid" | "denied" | "conflict" | "recovery", message: string, readonly recoveryDirectory?: string, readonly backupPath?: string) {
    super(message); this.name = "WorkspaceFileError"
  }
}

type Identity = WorkspaceIdentity
type AuthorizedRoot = WorkspaceRoot & { identity: Identity; directories: DirectoryProof[] }
type Snapshot = { bytes: Buffer; sha256: string; identity: Identity; stat: Stats }
type DirectoryProof = { path: string; identity: Identity }
type Baseline = { identity: Identity; sha256: string; directories: DirectoryProof[] }
type FileStamp = { identity: Identity; sha256: string; size: number; mtimeMs: number; ctimeMs: number }
type RecoveryRecord = {
  format: 2; operation: "workspace-edit"; id: string; sequence: number; phase: string; at: number
  root: string; rootIdentity: Identity; relativePath: string; absolutePath: string
  recoveryDirectory: string; recoveryIdentity: Identity; directories: DirectoryProof[]
  beforeSha256: string; proposedSha256: string; sourceIdentity: Identity; sourceMode: number
  beforeIdentity?: Identity; proposedIdentity?: Identity; archivedIdentity?: Identity; installed?: FileStamp; restored?: FileStamp
}
type TrustedRecord = { record: RecoveryRecord; bytes: Buffer; name: string }
const processRecoveryRecords = new Map<string, TrustedRecord>()
const RECOVERY_NAME = /^\.xingyao-edit-([a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12})$/
const RECORD_NAME = /^\d{4}-[a-z-]+\.json$/
const EXTENSIONS = new Set(".txt .md .markdown .mdx .json .jsonc .csv .tsv .ts .tsx .js .jsx .mjs .cjs .py .rs .go .java .c .h .cpp .hpp .cs .css .scss .html .xml .sql .sh .ps1 .bat .cmd .yaml .yml .toml .ini .rb .php .swift .kt .lua .vue .svelte .svg".split(" "))
const PLAIN_NAMES = new Set(["readme", "license", "dockerfile", "makefile", ".gitignore", ".gitattributes", ".editorconfig"])
const BLOCKED_DIRECTORIES = new Set([".git", ".codex", ".agents", ".ssh", ".aws", ".gnupg", ".opencode", ".config", ".cache", ".local", "node_modules", "bower_components", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".turbo", ".parcel-cache", "dist", "build", "target", "coverage", "$recycle.bin", "system volume information", "windows", "program files", "program files (x86)"])
const BLOCKED_FILES = new Set(["auth.json", "engine-config.json", "opencode.json", "opencode.jsonc", "running.json", "drive.json", ".npmrc", ".pypirc", ".netrc", "id_rsa", "id_ed25519", "id_ecdsa", "desktop.ini", "thumbs.db", "autorun.inf"])
const key = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value)
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const identity = (stat: Stats): Identity => ({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs })
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
const inProgress = new Set<string>()
function conflict(message: string): never { throw new WorkspaceFileError("conflict", message) }
function denied(message: string): never { throw new WorkspaceFileError("denied", message) }

/** Explicit, process-local directory capabilities. No domain database writes.
 * Recovery is opt-in for a selected root, verifies a private host ledger, and
 * keeps all source/proposed/conflicting bytes. Copy publication uses O_EXCL so
 * it also works on exFAT. Unprovable interruptions remain available for review.
 * Parent/entry checks and cooperative locks do not sandbox a hostile local
 * process racing individual OS calls; runtime-level directory isolation is separate.
 */
export class WorkspaceFiles {
  private readonly selected = new Map<string, AuthorizedRoot>()
  private readonly baselines = new Map<string, Baseline>()
  private readonly recoveryState?: { path: string; directories: DirectoryProof[] }
  constructor(private readonly options: WorkspaceFilesOptions = {}) {
    if (options.recoveryStateDirectory) {
      absoluteInput(options.recoveryStateDirectory)
      const path = resolve(options.recoveryStateDirectory)
      // Existing ancestors are verified before recursive creation as well as after it.
      verifyPlainAncestors(path, true)
      mkdirSync(path, { recursive: true, mode: 0o700 })
      this.recoveryState = { path, directories: verifyPlainAncestors(path) }
    }
  }

  open(directory: string): WorkspaceRoot {
    absoluteInput(directory)
    if (this.recoveryState && (within(directory, this.recoveryState.path) || within(this.recoveryState.path, directory))) denied("恢复凭据目录必须位于所选项目目录之外")
    this.checkDirectory(resolve(directory))
    const canonical = realpathSync.native(resolve(directory))
    const rootIdentity = this.checkDirectory(canonical)
    const previous = [...this.selected.values()].find(root => key(root.path) === key(canonical))
    if (previous) { if (!same(previous.identity, rootIdentity)) conflict("已授权目录已被替换，请重新启动工作台后选择"); return publicRoot(previous) }
    const root: AuthorizedRoot = { id: randomUUID(), path: canonical, label: basename(canonical) || canonical, identity: rootIdentity, directories: verifyPlainAncestors(canonical) }
    this.selected.set(root.id, root)
    return publicRoot(root)
  }

  roots(): WorkspaceRoot[] { return [...this.selected.values()].map(publicRoot) }

  /** Serializable evidence only: these proofs do not authorize a directory. */
  rootProof(rootId: string): WorkspaceRootProof {
    const root = this.root(rootId)
    return { format: 1, path: root.path, identity: { ...root.identity }, directories: structuredClone(root.directories) }
  }

  fileProof(rootId: string, relativePath: string): WorkspaceFileProof {
    const target = this.target(rootId, relativePath), snapshot = readSnapshot(target.absolutePath)
    describeFile(rootId, target.path, target.absolutePath, snapshot)
    verifyDirectories(target.directories); this.root(rootId)
    return { format: 1, root: this.rootProof(rootId), path: target.path, absolutePath: target.absolutePath, identity: { ...snapshot.identity }, sha256: snapshot.sha256, directories: target.directories.map(entry => ({ path: entry.path, identity: { ...entry.identity } })) }
  }

  verifyRootProof(rootId: string, proof: WorkspaceRootProof): void {
    const actual = this.rootProof(rootId)
    if (!proof || proof.format !== 1 || typeof proof.path !== "string" || key(actual.path) !== key(proof.path) || !validIdentity(proof.identity) || !same(actual.identity, proof.identity) || JSON.stringify(actual.directories) !== JSON.stringify(proof.directories)) conflict("项目目录身份已改变，请核对保留的草稿")
  }

  /** Validate a stored baseline without changing the current session's save baseline. */
  verifyFileProof(rootId: string, relativePath: string, proof: WorkspaceFileProof): WorkspaceFile {
    if (!proof || proof.format !== 1 || !Array.isArray(proof.directories)) conflict("文件基线证明无效")
    this.verifyRootProof(rootId, proof.root)
    const target = this.target(rootId, relativePath)
    if (target.path !== proof.path || typeof proof.absolutePath !== "string" || key(target.absolutePath) !== key(proof.absolutePath) || !validIdentity(proof.identity) || JSON.stringify(target.directories) !== JSON.stringify(proof.directories)) conflict("文件或父目录身份已改变，请核对保留的草稿")
    const snapshot = readSnapshot(target.absolutePath, proof.identity)
    if (snapshot.sha256 !== proof.sha256) conflict("文件基线内容已改变，请合并保留的草稿")
    verifyDirectories(target.directories); this.root(rootId)
    return describeFile(rootId, target.path, target.absolutePath, snapshot)
  }

  recoveryList(rootId: string): WorkspaceRecoveryListing {
    const root = this.root(rootId), entries: WorkspaceRecovery[] = []
    const directory = opendirSync(root.path)
    let scanned = 0, truncated = false
    try {
      for (;;) {
        const entry = directory.readSync()
        if (!entry) break
        if (++scanned > 5000 || entries.length >= 200) { truncated = true; break }
        if (!RECOVERY_NAME.test(entry.name)) continue
        entries.push(this.inspectRecovery(rootId, entry.name))
      }
    } finally { directory.closeSync() }
    this.root(rootId)
    return { rootId, entries, truncated }
  }

  /** Only reconcile knowledge from bytes still proven to be the completed edit.
   * Historical committed records do not authorize importing later external edits. */
  recoveredFile(rootId: string, id: string): WorkspaceFile | null {
    const { record } = this.readRecoveryRecord(rootId, id)
    this.verifyRecord(rootId, record)
    const expected = record.phase === "committed" ? record.installed : record.phase === "restored" ? record.restored : undefined
    if (!expected) return null
    const snapshot = readSnapshot(record.absolutePath)
    if (!stampMatches(snapshot, expected)) return null
    this.verifyRecord(rootId, record)
    return describeFile(rootId, record.relativePath, record.absolutePath, snapshot)
  }

  /** Explicit recovery of incomplete edits in one currently authorized root. */
  recover(rootId: string): WorkspaceRecoveryListing {
    const listing = this.recoveryList(rootId)
    listing.entries = listing.entries.map(entry => {
      if (entry.status !== "pending") return entry
      let release: (() => void) | undefined, lockDirectory: string | undefined, lockIdentity: Identity | undefined
      let record: RecoveryRecord | undefined, lock: string | undefined, entered = false
      try {
        const trusted = this.readRecoveryRecord(rootId, entry.id)
        record = trusted.record; lock = key(record.absolutePath)
        if (inProgress.has(lock)) return { ...entry, status: "busy" as const, message: "文件正在保存或恢复，请稍后重试" }
        inProgress.add(lock); entered = true
        this.verifyRecord(rootId, record)
        lockDirectory = join(dirname(record.absolutePath), `.xingyao-edit-lock-${hash(Buffer.from(lock)).slice(0, 32)}`)
        try { mkdirSync(lockDirectory, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
        lockIdentity = plainDirectory(lockDirectory)
        try { release = acquireHostLock(lockDirectory) } catch { return { ...entry, status: "busy" as const, message: "保存进程仍在运行，或保存锁需要人工核对" } }
        plainDirectory(lockDirectory, lockIdentity)
        // The writer may have progressed between the listing and the shared lock.
        record = this.readRecoveryRecord(rootId, entry.id).record
        const current = this.classifyRecovery(rootId, record)
        if (current.status !== "pending") return current
        const result = this.restoreRecord(rootId, record)
        return result
      } catch (error) {
        return { ...entry, status: "conflict" as const, message: error instanceof Error ? error.message : "恢复未完成，所有版本已保留" }
      } finally {
        if (release) { try { if (record) this.verifyRecord(rootId, record); plainDirectory(lockDirectory!, lockIdentity); release() } catch {} }
        if (lock && entered) inProgress.delete(lock)
      }
    })
    return listing
  }

  private inspectRecovery(rootId: string, name: string): WorkspaceRecovery {
    const directory = join(this.root(rootId).path, name), id = name.slice(".xingyao-edit-".length)
    try { return this.classifyRecovery(rootId, this.readRecoveryRecord(rootId, id).record) }
    catch { return { id, rootId, path: null, recoveryDirectory: directory, status: "manual", message: "旧版、缺失或不可信的恢复记录；请人工核对保留文件", beforePath: null, backupPath: null, proposedPath: null } }
  }

  private recoveryEntry(rootId: string, record: RecoveryRecord, status: WorkspaceRecovery["status"], message: string): WorkspaceRecovery {
    return { id: record.id, rootId, path: record.relativePath, recoveryDirectory: record.recoveryDirectory, status, message, beforePath: join(record.recoveryDirectory, "before"), backupPath: join(record.recoveryDirectory, "original"), proposedPath: join(record.recoveryDirectory, "proposed") }
  }

  private classifyRecovery(rootId: string, record: RecoveryRecord): WorkspaceRecovery {
    this.verifyRecord(rootId, record)
    const entry = (status: WorkspaceRecovery["status"], message: string) => this.recoveryEntry(rootId, record, status, message)
    if (record.phase === "committed") return entry("committed", "已确认保存完成；原件与拟写副本保留")
    if (record.phase === "restored") return entry("restored", "已恢复原件；原件、拟写和中断版本保留")
    if (record.phase === "unchanged") return entry("unchanged", "中断发生在替换前，原文件未改动")
    if (record.phase === "requires-review") return entry("conflict", "保存或回滚期间存在外部变化，请人工核对保留版本")
    const current = present(record.absolutePath)
    if (current) {
      const snapshot = readSnapshot(record.absolutePath)
      if (!record.installed && !record.restored && same(snapshot.identity, record.sourceIdentity) && snapshot.sha256 === record.beforeSha256) return entry("unchanged", "原文件仍保持读取时的身份和内容")
      if (record.restored && stampMatches(snapshot, record.restored) && snapshot.sha256 === record.beforeSha256) return entry("pending", "原件复制完成，等待确认恢复记录")
      if (record.installed && stampMatches(snapshot, record.installed)) {
        if (snapshot.sha256 === record.proposedSha256) return entry("pending", "拟写内容已经完整落盘，等待确认保存记录")
        if (snapshot.bytes.length === 0) { this.verifyRecoveryCopies(record); return entry("pending", "保存中断留下本次创建的空文件，可恢复原件") }
      }
      return entry("conflict", "当前文件存在外部修改、身份变化或无法证明归属的中断内容；全部版本保留")
    }
    if (record.installed || record.restored) return entry("conflict", "已创建的目标文件现已消失，不能推断删除意图；保留恢复副本")
    this.verifyRecoveryCopies(record)
    return entry("pending", "原件已归档而目标尚未发布，可安全复制恢复原件")
  }

  private verifyRecoveryCopies(record: RecoveryRecord): Snapshot {
    if (!record.archivedIdentity) conflict("归档身份尚未确认，请人工核对")
    const original = readSnapshot(join(record.recoveryDirectory, "original"), record.archivedIdentity)
    if (original.sha256 !== record.beforeSha256 || !record.beforeIdentity || !record.proposedIdentity) conflict("恢复副本证据不完整")
    if (readSnapshot(join(record.recoveryDirectory, "before"), record.beforeIdentity).sha256 !== record.beforeSha256 || readSnapshot(join(record.recoveryDirectory, "proposed"), record.proposedIdentity).sha256 !== record.proposedSha256) conflict("恢复副本已改变，停止自动恢复")
    return original
  }

  private verifyRecord(rootId: string, record: RecoveryRecord): void {
    const root = this.root(rootId)
    if (record.format !== 2 || record.operation !== "workspace-edit" || key(root.path) !== key(record.root) || !same(root.identity, record.rootIdentity)) conflict("恢复记录的项目目录身份不匹配")
    if (key(record.recoveryDirectory) !== key(join(root.path, `.xingyao-edit-${record.id}`))) conflict("恢复目录路径不匹配")
    plainDirectory(record.recoveryDirectory, record.recoveryIdentity)
    const target = this.target(rootId, record.relativePath, false, true)
    if (key(target.absolutePath) !== key(record.absolutePath) || JSON.stringify(target.directories) !== JSON.stringify(record.directories)) conflict("恢复目标的父目录身份已改变")
    verifyDirectories(record.directories)
  }

  private writeRecoveryRecord(record: RecoveryRecord): void {
    plainDirectory(record.recoveryDirectory, record.recoveryIdentity)
    const name = `${String(record.sequence).padStart(4, "0")}-${record.phase}.json`, bytes = Buffer.from(JSON.stringify(record))
    if (bytes.length > 65536 || record.sequence > 9999) conflict("恢复凭据超过大小限制，请选择更浅的项目根目录")
    writeExclusive(join(record.recoveryDirectory, name), bytes); flushDirectory(record.recoveryDirectory)
    if (this.recoveryState) {
      verifyDirectories(this.recoveryState.directories)
      const directory = join(this.recoveryState.path, record.id)
      try { mkdirSync(directory, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
      const proof = plainDirectory(directory)
      writeExclusive(join(directory, name), bytes)
      plainDirectory(directory, proof); verifyDirectories(this.recoveryState.directories); flushDirectory(directory)
    }
    if (!this.recoveryState) {
      processRecoveryRecords.set(record.id, { record: structuredClone(record), name, bytes })
      while (processRecoveryRecords.size > 1024) processRecoveryRecords.delete(processRecoveryRecords.keys().next().value!)
    }
  }

  private readRecoveryRecord(rootId: string, id: string): TrustedRecord {
    if (!RECOVERY_NAME.test(`.xingyao-edit-${id}`)) conflict("恢复标识无效")
    const directory = join(this.root(rootId).path, `.xingyao-edit-${id}`)
    const recoveryIdentity = plainDirectory(directory)
    let trusted: TrustedRecord | undefined
    if (this.recoveryState) {
      verifyDirectories(this.recoveryState.directories)
      const ledger = join(this.recoveryState.path, id), proof = plainDirectory(ledger)
      const names = boundedNames(ledger, 256).filter(name => RECORD_NAME.test(name)).sort()
      const name = names.at(-1)
      if (!name) conflict("恢复记录没有本机可信凭据")
      const bytes = readSmallFile(join(ledger, name), 65536)
      trusted = { name, bytes, record: JSON.parse(bytes.toString("utf8")) as RecoveryRecord }
      plainDirectory(ledger, proof); verifyDirectories(this.recoveryState.directories)
    } else trusted = processRecoveryRecords.get(id)
    if (!trusted) conflict("恢复记录没有本机可信凭据")
    const { record, name, bytes } = trusted
    const names = boundedNames(directory, 256).filter(value => RECORD_NAME.test(value)).sort()
    if (names.at(-1) !== name || record.id !== id || !same(recoveryIdentity, record.recoveryIdentity) || !readSmallFile(join(directory, name), 65536).equals(bytes)) conflict("恢复记录与本机凭据不匹配")
    this.verifyRecord(rootId, record)
    return trusted
  }

  private restoreRecord(rootId: string, previous: RecoveryRecord, rollback = false): WorkspaceRecovery {
    let record = structuredClone(previous)
    const journal = (phase: string) => { this.verifyRecord(rootId, record); record = { ...record, sequence: record.sequence + 1, phase, at: Date.now() }; this.writeRecoveryRecord(record) }
    const context = { absolutePath: record.absolutePath, recoveryDirectory: record.recoveryDirectory, backupPath: join(record.recoveryDirectory, "original"), proposedPath: join(record.recoveryDirectory, "proposed") }
    const boundary = (phase: WorkspaceRecoveryBoundary) => { this.options.afterRecoveryBoundary?.(phase, context); this.verifyRecord(rootId, record) }
    const named = present(record.absolutePath)
    if (named) {
      const snapshot = readSnapshot(record.absolutePath)
      if (record.restored && stampMatches(snapshot, record.restored) && snapshot.sha256 === record.beforeSha256) { journal("restored"); return this.recoveryEntry(rootId, record, "restored", "原件复制已验证，恢复完成") }
      if (!rollback && record.installed && stampMatches(snapshot, record.installed) && snapshot.sha256 === record.proposedSha256) { journal("committed"); return this.recoveryEntry(rootId, record, "committed", "拟写内容已完整落盘，保存记录已确认") }
      if (!record.installed || !stampMatches(snapshot, record.installed) || snapshot.bytes.length !== 0 && (!rollback || snapshot.sha256 !== record.proposedSha256)) conflict("目标版本变化，停止自动恢复")
      this.verifyRecoveryCopies(record)
      // Keep the interrupted entry as an independent version. No overwrite call
      // is used when publishing the restored file, including on exFAT.
      const capturedPath = join(record.recoveryDirectory, `interrupted-${randomUUID()}`)
      journal("recovering-capture")
      this.verifyRecord(rootId, record)
      if (!stampMatches(readSnapshot(record.absolutePath), record.installed)) conflict("恢复前目标已改变")
      const captureFd = openSync(record.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        if (!same(identity(fstatSync(captureFd)), snapshot.identity)) conflict("恢复前目标身份变化")
        renameSync(record.absolutePath, capturedPath)
        // exFAT file IDs change on rename. The held handle proves continuity.
        const captured = readSnapshot(capturedPath, identity(fstatSync(captureFd)))
        if (captured.sha256 !== snapshot.sha256) conflict("恢复边界出现外部变化，实际版本保留在恢复目录")
      } finally { closeSync(captureFd) }
      delete record.installed
      journal("recovering")
    }
    const original = this.verifyRecoveryCopies(record)
    boundary("recovery-ready")
    this.verifyRecord(rootId, record)
    const fd = openSync(record.absolutePath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), record.sourceMode)
    try {
      record.restored = stampFd(fd, Buffer.alloc(0))
      journal("restore-created"); boundary("recovery-destination-created")
      if (!stampMatches(readSnapshot(record.absolutePath), record.restored)) conflict("恢复目标已被外部修改")
      // Bounded chunks make an interruption observable in tests. A crash before
      // the verified full-copy record leaves a conflict, never an inferred write.
      let offset = 0
      while (offset < original.bytes.length) {
        this.verifyRecord(rootId, record)
        if (!same(identity(fstatSync(fd)), record.restored.identity) || !same(identity(regularFile(record.absolutePath)), record.restored.identity)) conflict("恢复文件被替换")
        const count = Math.min(65536, original.bytes.length - offset)
        writeAll(fd, original.bytes.subarray(offset, offset + count)); offset += count
        fsyncSync(fd)
        const partial = stampFd(fd, original.bytes.subarray(0, offset))
        boundary("recovery-copy-progress")
        if (!stampMatches(readSnapshot(record.absolutePath), partial)) conflict("恢复复制期间存在外部写入，中断版本和原件均已保留")
      }
      fsyncSync(fd)
      const actual = readSnapshot(record.absolutePath, record.restored.identity)
      if (actual.sha256 !== record.beforeSha256) conflict("恢复内容在复制期间改变")
      record.restored = stamp(actual)
      journal("restore-written"); boundary("recovery-destination-written")
    } finally { closeSync(fd) }
    this.verifyRecord(rootId, record)
    if (!stampMatches(readSnapshot(record.absolutePath), record.restored!)) conflict("恢复提交前文件已被外部修改")
    journal("restored"); boundary("recovery-restored")
    return this.recoveryEntry(rootId, record, "restored", "原件已恢复；原件、拟写和中断版本全部保留")
  }

  list(rootId: string, relativePath = ""): WorkspaceListing {
    const target = this.target(rootId, relativePath, true)
    this.checkDirectory(target.absolutePath)
    const entries: WorkspaceEntry[] = []
    const directory = opendirSync(target.absolutePath)
    let scanned = 0, truncated = false
    try {
      for (;;) {
        const entry = directory.readSync()
        if (!entry) break
        if (++scanned > 5000 || entries.length >= 500) { truncated = true; break }
        const relativeName = [target.path, entry.name].filter(Boolean).join("/")
        try {
          component(entry.name)
          const file = this.target(rootId, relativeName, true), stat = lstatSync(file.absolutePath)
          if (stat.isSymbolicLink()) continue
          if (stat.isDirectory()) {
            this.checkDirectory(file.absolutePath)
            entries.push({ name: entry.name, path: relativeName, kind: "directory", editable: false })
          } else if (stat.isFile()) {
            if (blockedFile(entry.name)) continue
            entries.push({ name: entry.name, path: relativeName, kind: "file", size: stat.size, editable: editableName(entry.name) && stat.size <= MAX_WORKSPACE_FILE_BYTES && stat.nlink === 1 })
          }
        } catch (error) { if (!(error instanceof WorkspaceFileError) && !missing(error)) throw error }
      }
    } finally { directory.closeSync() }
    this.target(rootId, relativePath, true)
    entries.sort((a, b) => Number(a.kind === "file") - Number(b.kind === "file") || a.name.localeCompare(b.name, "en"))
    return { rootId, path: target.path, entries, truncated }
  }

  read(rootId: string, relativePath: string): WorkspaceFile {
    const target = this.target(rootId, relativePath), snapshot = readSnapshot(target.absolutePath)
    this.target(rootId, relativePath)
    verifyDirectories(target.directories)
    const result = describeFile(rootId, target.path, target.absolutePath, snapshot)
    this.baselines.set(`${rootId}:${target.path}`, { identity: snapshot.identity, sha256: snapshot.sha256, directories: target.directories })
    return result
  }

  save(rootId: string, relativePath: string, input: { expectedSha256: string; text: string }): WorkspaceSave {
    if (!input || typeof input.expectedSha256 !== "string" || !/^[a-f\d]{64}$/i.test(input.expectedSha256) || typeof input.text !== "string") throw new WorkspaceFileError("invalid", "保存需要读取时的 SHA-256 和文本")
    if (input.text.length > MAX_WORKSPACE_FILE_BYTES) throw new WorkspaceFileError("invalid", "文本超过 2 MiB 限额")
    const target = this.target(rootId, relativePath), baselineKey = `${rootId}:${target.path}`, baseline = this.baselines.get(baselineKey)
    if (!baseline || baseline.sha256 !== input.expectedSha256.toLowerCase()) conflict("请先读取文件；保存版本必须对应当前会话读取的原件")
    const lock = key(target.absolutePath)
    if (inProgress.has(lock)) conflict("文件正在保存，请稍后重试")
    inProgress.add(lock)
    let recoveryDirectory: string | undefined, backupPath: string | undefined
    let release: (() => void) | undefined, lockDirectory: string | undefined, lockIdentity: Identity | undefined
    let recoveryIdentity: Identity | undefined, original: Snapshot | undefined, proposed: Buffer | undefined
    let record: RecoveryRecord | undefined
    let archived = false, installedIdentity: Identity | undefined
    const verifyParents = () => { this.target(rootId, relativePath, false, true); verifyDirectories(baseline.directories) }
    const verifyRecovery = () => { verifyParents(); if (!recoveryDirectory || !recoveryIdentity) conflict("恢复目录尚未建立"); plainDirectory(recoveryDirectory, recoveryIdentity) }
    try {
      verifyParents()
      // The lock lives beside the file, so overlapping authorized roots and
      // independent processes use the same gate. The shared lock helper reclaims
      // only verifiably dead writers; it never guesses about a live owner.
      lockDirectory = join(dirname(target.absolutePath), `.xingyao-edit-lock-${hash(Buffer.from(lock)).slice(0, 32)}`)
      try { mkdirSync(lockDirectory, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
      lockIdentity = plainDirectory(lockDirectory)
      try { release = acquireHostLock(lockDirectory) } catch { conflict("文件正在由另一个工作台保存，或保存锁需要核实") }
      verifyParents(); plainDirectory(lockDirectory, lockIdentity)
      original = readSnapshot(target.absolutePath, baseline.identity)
      if (original.sha256 !== baseline.sha256) conflict("文件已被外部修改，请重新读取后合并")
      const before = describeFile(rootId, target.path, target.absolutePath, original)
      const text = before.lineEnding === "crlf" ? input.text.replace(/\r\n|\r|\n/g, "\r\n") : before.lineEnding === "lf" ? input.text.replace(/\r\n|\r|\n/g, "\n") : input.text
      validateText(text)
      proposed = Buffer.concat([before.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, "utf8")])
      if (proposed.length > MAX_WORKSPACE_FILE_BYTES) throw new WorkspaceFileError("invalid", "UTF-8 文件超过 2 MiB 限额")
      const proposedHash = hash(proposed)
      if (proposedHash === original.sha256) return { ...before, backupPath: null, changed: false }
      const root = this.root(rootId)
      recoveryDirectory = join(root.path, `.xingyao-edit-${randomUUID()}`)
      this.target(rootId, relativePath)
      mkdirSync(recoveryDirectory, { mode: 0o700 })
      recoveryIdentity = plainDirectory(recoveryDirectory)
      backupPath = join(recoveryDirectory, "original")
      const beforePath = join(recoveryDirectory, "before"), proposedPath = join(recoveryDirectory, "proposed")
      const context = { absolutePath: target.absolutePath, recoveryDirectory, backupPath, proposedPath }
      record = { format: 2, operation: "workspace-edit", id: basename(recoveryDirectory).slice(".xingyao-edit-".length), sequence: 0, phase: "prepared", at: Date.now(), root: root.path, rootIdentity: root.identity, relativePath: target.path, absolutePath: target.absolutePath, recoveryDirectory, recoveryIdentity, directories: baseline.directories, beforeSha256: original.sha256, proposedSha256: proposedHash, sourceIdentity: original.identity, sourceMode: original.stat.mode & 0o777 }
      const journal = (phase: string) => {
        verifyRecovery()
        record = { ...record!, sequence: record!.sequence + 1, phase, at: Date.now() }
        this.writeRecoveryRecord(record)
      }
      const boundary = (phase: WorkspaceSaveBoundary) => { this.options.afterBoundary?.(phase, context); verifyRecovery() }
      journal("prepared"); boundary("recovery-created")
      writeExclusive(beforePath, original.bytes)
      const beforeCopy = readSnapshot(beforePath)
      if (beforeCopy.sha256 !== original.sha256) conflict("恢复副本验证失败，原文件未替换")
      record.beforeIdentity = beforeCopy.identity
      journal("backed-up"); boundary("backup-verified")
      writeExclusive(proposedPath, proposed)
      const proposedCopy = readSnapshot(proposedPath)
      if (proposedCopy.sha256 !== proposedHash) conflict("拟写文件验证失败，原文件未替换")
      record.proposedIdentity = proposedCopy.identity
      journal("proposed"); boundary("proposed-verified")
      const verifyOriginal = () => {
        verifyRecovery()
        const current = readSnapshot(target.absolutePath, original!.identity)
        if (current.sha256 !== original!.sha256) conflict("保存期间文件被外部修改，保留修改而不覆盖")
      }
      verifyOriginal(); journal("archiving"); boundary("before-archive"); verifyOriginal()
      // Preserve the actual entry present at this boundary. A final-check race
      // cannot silently discard its contents by replacing it with the proposal.
      const archiveFd = openSync(target.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        if (!same(identity(fstatSync(archiveFd)), original.identity)) conflict("归档前原件身份改变")
        renameSync(target.absolutePath, backupPath)
        archived = true
        record.archivedIdentity = identity(fstatSync(archiveFd))
        if (readSnapshot(backupPath, record.archivedIdentity).sha256 !== original.sha256) conflict("归档时原件发生变化，实际原件已保存在恢复目录")
      } finally { closeSync(archiveFd) }
      flushDirectory(dirname(target.absolutePath)); flushDirectory(recoveryDirectory)
      journal("archived"); boundary("source-archived")
      if (readSnapshot(backupPath, record.archivedIdentity).sha256 !== original.sha256) conflict("归档时原件发生变化，实际原件已保存在恢复目录")
      this.target(rootId, relativePath, false, true)
      plainDirectory(recoveryDirectory, recoveryIdentity)
      journal("publishing")
      const fd = openSync(target.absolutePath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), original.stat.mode & 0o777)
      try {
        installedIdentity = identity(fstatSync(fd))
        record.installed = stampFd(fd, Buffer.alloc(0))
        journal("destination-created")
        boundary("destination-created")
        this.target(rootId, relativePath)
        const named = regularFile(target.absolutePath)
        if (!same(installedIdentity, identity(named))) conflict("新文件路径被替换，停止写入")
        if (named.size !== 0 || fstatSync(fd).size !== 0) conflict("新文件已被外部写入，停止保存")
        writeAll(fd, proposed); fsyncSync(fd)
        record.installed = stampFd(fd, proposed)
        journal("destination-written")
        boundary("destination-written")
        if (!same(installedIdentity, identity(fstatSync(fd)))) conflict("写入文件身份变化")
      } finally { closeSync(fd) }
      flushDirectory(dirname(target.absolutePath))
      this.target(rootId, relativePath)
      if (readSnapshot(target.absolutePath, installedIdentity).sha256 !== proposedHash) conflict("保存后文件内容不符，保留原件和拟写版本等待恢复")
      boundary("destination-verified")
      // Verify again after the final observable boundary and before success.
      const actual = readSnapshot(target.absolutePath, installedIdentity)
      this.target(rootId, relativePath)
      if (actual.sha256 !== proposedHash) conflict("提交前发生外部修改，不能报告保存成功")
      journal("committed")
      this.baselines.set(baselineKey, { identity: actual.identity, sha256: actual.sha256, directories: baseline.directories })
      return { ...describeFile(rootId, target.path, target.absolutePath, actual), backupPath, changed: true }
    } catch (error) {
      if (recoveryDirectory) {
        let restored = false
        if (!archived) {
          try { verifyRecovery(); if (present(join(recoveryDirectory, "before"))) backupPath = join(recoveryDirectory, "before"); else backupPath = undefined } catch { backupPath = undefined }
        }
        if (archived && backupPath && original && proposed && record) {
          try {
            verifyRecovery()
            const trusted = this.readRecoveryRecord(rootId, record.id)
            restored = this.restoreRecord(rootId, trusted.record, true).status === "restored"
            if (restored) backupPath = join(recoveryDirectory, "before")
          } catch { /* An uncertain entry stays preserved; never force a rollback. */ }
        }
        // Never replay a caught, failed rollback later as if it had never run.
        // If the ledger itself tore, its mismatch already requires manual review.
        if (!restored && record) try {
          verifyRecovery()
          const current = this.readRecoveryRecord(rootId, record.id).record
          const unchanged = !archived && original && readSnapshot(target.absolutePath, original.identity).sha256 === original.sha256
          this.writeRecoveryRecord({ ...current, sequence: current.sequence + 1, phase: unchanged ? "unchanged" : "requires-review", at: Date.now() })
        } catch {}
        throw new WorkspaceFileError(error instanceof WorkspaceFileError && error.kind === "conflict" ? "conflict" : "recovery", restored ? "保存失败，原件已恢复；拟写内容保留在恢复目录" : "保存未确认完成；请核对原文件与恢复目录，已有版本保留供恢复", recoveryDirectory, backupPath)
      }
      throw error
    } finally {
      if (release) { try { verifyDirectories(baseline.directories); plainDirectory(lockDirectory!, lockIdentity); release() } catch { /* Leave an uncertain lock for explicit recovery. */ } }
      inProgress.delete(lock)
    }
  }

  private root(id: string): AuthorizedRoot {
    const root = this.selected.get(id)
    if (!root) denied("目录未在当前会话中授权")
    verifyDirectories(root.directories)
    this.checkDirectory(root.path, root.identity)
    return root
  }
  private checkDirectory(directory: string, expected?: Identity): Identity {
    const full = resolve(directory), drive = parse(full).root
    if ((this.options.protectedDirectories ?? []).some(protectedPath => within(resolve(protectedPath), full))) denied("活动运行目录不能通过文件编辑器修改")
    let current = drive
    for (const part of full.slice(drive.length).split(/[\\/]/).filter(Boolean)) {
      component(part)
      if (blockedDirectory(part)) denied("该运行、凭据或生成目录不参与文件编辑")
      current = join(current, part)
      plainDirectory(current)
      if ((this.options.protectedDirectories ?? []).some(protectedPath => within(resolve(protectedPath), current))) denied("活动运行目录不能通过文件编辑器修改")
      if (present(join(current, "soul.db")) || present(join(current, "release.json")) && present(join(current, "xingyao.exe"))) denied("检测到活动数据或发行目录，不能授权编辑")
    }
    return plainDirectory(full, expected)
  }
  private target(rootId: string, relativePath: string, allowDirectory = false, allowMissing = false) {
    const root = this.root(rootId)
    if (typeof relativePath !== "string" || relativePath.length > 2048 || /[\u0000-\u001f]/.test(relativePath) || isAbsolute(relativePath) || /^[A-Za-z]:|^[/\\]/.test(relativePath)) denied("文件路径必须是授权根内的相对路径")
    const parts = relativePath === "" ? [] : relativePath.split(/[\\/]/)
    for (const part of parts) component(part)
    if (!parts.length && !allowDirectory) denied("请选择已有的文本文件")
    const absolutePath = join(root.path, ...parts), canonicalRelative = parts.join("/")
    if (!within(root.path, absolutePath)) denied("文件路径超出已授权根目录")
    this.checkDirectory(parts.length ? dirname(absolutePath) : absolutePath)
    const name = parts.at(-1)
    if (name && (blockedDirectory(name) || blockedFile(name))) denied("受保护文件或目录不能访问")
    if (!allowDirectory && name && !editableName(name)) denied("只允许编辑受支持的 UTF-8 文本文件")
    const stat = present(absolutePath)
    if (!stat && !allowMissing) throw new WorkspaceFileError("conflict", "文件或目录已经不存在")
    if (stat?.isSymbolicLink()) denied("不允许符号链接或目录连接点")
    if (stat && !allowDirectory && (!stat.isFile() || stat.nlink !== 1)) denied("只能编辑单一身份的普通文件，不能编辑链接")
    const directories: DirectoryProof[] = structuredClone(root.directories)
    let parent = root.path
    for (const part of parts.slice(0, -1)) { parent = join(parent, part); directories.push({ path: parent, identity: plainDirectory(parent) }) }
    return { root, absolutePath, path: canonicalRelative, directories }
  }
}

function publicRoot(root: AuthorizedRoot): WorkspaceRoot { return { id: root.id, path: root.path, label: root.label } }
function validIdentity(value: unknown): value is Identity { return !!value && typeof value === "object" && ["dev", "ino", "birthtimeMs"].every(name => typeof (value as Record<string, unknown>)[name] === "number" && Number.isFinite((value as Record<string, number>)[name])) }
function stamp(snapshot: Snapshot): FileStamp { return { identity: snapshot.identity, sha256: snapshot.sha256, size: snapshot.bytes.length, mtimeMs: snapshot.stat.mtimeMs, ctimeMs: snapshot.stat.ctimeMs } }
function stampFd(fd: number, bytes: Buffer): FileStamp { const stat = fstatSync(fd); return { identity: identity(stat), sha256: hash(bytes), size: bytes.length, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } }
function stampMatches(snapshot: Snapshot, expected: FileStamp) { return same(snapshot.identity, expected.identity) && snapshot.sha256 === expected.sha256 && snapshot.bytes.length === expected.size && snapshot.stat.mtimeMs === expected.mtimeMs && snapshot.stat.ctimeMs === expected.ctimeMs }
function verifyPlainAncestors(path: string, allowMissing = false): DirectoryProof[] {
  const full = resolve(path), drive = parse(full).root, result: DirectoryProof[] = [{ path: drive, identity: plainDirectory(drive) }]
  let current = drive
  for (const part of full.slice(drive.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    if (allowMissing && !present(current)) break
    result.push({ path: current, identity: plainDirectory(current) })
  }
  return result
}
function boundedNames(path: string, limit: number): string[] {
  const names: string[] = [], directory = opendirSync(path)
  try { for (;;) { const entry = directory.readSync(); if (!entry) break; if (names.length >= limit) conflict("恢复目录条目过多，请人工核对"); names.push(entry.name) } }
  finally { directory.closeSync() }
  return names
}
function readSmallFile(path: string, limit: number): Buffer {
  if (regularFile(path).size > limit) conflict("恢复记录超过大小限制")
  const snapshot = readSnapshot(path)
  if (snapshot.bytes.length > limit) conflict("恢复记录超过大小限制")
  return snapshot.bytes
}
function within(root: string, candidate: string) { const part = relative(key(root), key(candidate)); return part === "" || part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part) }
function absoluteInput(value: string) {
  if (typeof value !== "string" || !value || !isAbsolute(value) || /^[/\\]{2}/.test(value) || /[\u0000-\u001f]/.test(value) || value.slice(process.platform === "win32" ? 2 : 0).includes(":")) denied("请选择本机绝对目录，不支持 UNC、设备路径或数据流")
  for (const part of value.slice(parse(value).root.length).split(/[\\/]/).filter(Boolean)) component(part)
}
function component(value: string) {
  if (!value || value === "." || value === ".." || /[<>:"|?*\u0000-\u001f]/.test(value) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(value)) denied("路径包含穿越、设备名称或不支持的组件")
}
function blockedDirectory(name: string) { const lower = name.toLowerCase(); return BLOCKED_DIRECTORIES.has(lower) || lower.startsWith(".xingyao-") || lower.startsWith(".product-restore-") || lower === ".release-writer" }
function blockedFile(name: string) {
  const lower = name.toLowerCase()
  return BLOCKED_FILES.has(lower) || lower === ".env" || lower.startsWith(".env.") || /^engine-config[-.]/.test(lower) || /(?:^|[._-])(?:credentials?|secrets?|tokens?)(?:[._-]|$)/.test(lower) || /\.(?:pem|key|pfx|p12|keystore|db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/.test(lower)
}
function editableName(name: string) { return !blockedFile(name) && (EXTENSIONS.has(extname(name).toLowerCase()) || PLAIN_NAMES.has(name.toLowerCase())) }
function present(file: string): Stats | null { try { return lstatSync(file) } catch (error) { if (missing(error)) return null; throw error } }
function plainDirectory(directory: string, expected?: Identity): Identity {
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) denied("目录含符号链接、连接点或非目录")
  const actual = identity(stat)
  if (expected && !same(expected, actual)) conflict("已授权目录身份改变")
  return actual
}
function verifyDirectories(directories: DirectoryProof[]) { for (const directory of directories) plainDirectory(directory.path, directory.identity) }
function regularFile(file: string): Stats { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) denied("不是单一身份的普通文件"); return stat }
function readSnapshot(file: string, expected?: Identity): Snapshot {
  const before = regularFile(file)
  if (before.size > MAX_WORKSPACE_FILE_BYTES) throw new WorkspaceFileError("invalid", "文件超过 2 MiB 限额")
  if (expected && !same(expected, identity(before))) conflict("文件身份已被外部替换")
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (!same(identity(before), identity(fstatSync(fd)))) conflict("打开文件时身份改变")
    const bytes = Buffer.alloc(MAX_WORKSPACE_FILE_BYTES + 1)
    let length = 0
    for (;;) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; if (length === bytes.length) throw new WorkspaceFileError("invalid", "文件超过 2 MiB 限额") }
    const after = fstatSync(fd), named = regularFile(file)
    if (!same(identity(before), identity(after)) || !same(identity(after), identity(named)) || before.size !== length || after.size !== length || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) conflict("读取期间文件发生变化")
    const content = bytes.subarray(0, length)
    return { bytes: content, sha256: hash(content), identity: identity(after), stat: after }
  } finally { closeSync(fd) }
}
function describeFile(rootId: string, relativePath: string, absolutePath: string, snapshot: Snapshot): WorkspaceFile {
  const bom = snapshot.bytes.length >= 3 && snapshot.bytes[0] === 0xef && snapshot.bytes[1] === 0xbb && snapshot.bytes[2] === 0xbf
  let text: string
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bom ? snapshot.bytes.subarray(3) : snapshot.bytes) } catch { throw new WorkspaceFileError("invalid", "文件不是有效的 UTF-8 文本") }
  validateText(text)
  const crlf = /\r\n/.test(text), lf = /(?<!\r)\n/.test(text), loneCR = /\r(?!\n)/.test(text)
  const lineEnding = loneCR || crlf && lf ? "mixed" : crlf ? "crlf" : lf ? "lf" : "none"
  return { rootId, path: relativePath, absolutePath, text, sha256: snapshot.sha256, bytes: snapshot.bytes.length, bom, lineEnding }
}
function validateText(text: string) {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text) || Buffer.from(text, "utf8").toString("utf8") !== text) throw new WorkspaceFileError("invalid", "内容不是有效的普通 UTF-8 文本")
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) denied("检测到私钥内容，不能在编辑器读取或保存")
}
function writeAll(fd: number, bytes: Uint8Array) { let offset = 0; while (offset < bytes.length) { const written = writeSync(fd, bytes, offset, bytes.length - offset); if (written <= 0) throw new Error("Write did not advance"); offset += written } }
function writeExclusive(file: string, bytes: Uint8Array) { const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); try { writeAll(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) } }
function flushDirectory(directory: string) { if (process.platform === "win32") return; const fd = openSync(directory, "r"); try { fsyncSync(fd) } finally { closeSync(fd) } }
