import { createHash, randomUUID } from "node:crypto"
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, renameSync, unlinkSync, writeSync, type Stats } from "node:fs"
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path"
import { acquireHostLock } from "./checkpoint"

export const MAX_WORKSPACE_FILE_BYTES = 2 * 1024 * 1024
export type WorkspaceRoot = { id: string; path: string; label: string }
export type WorkspaceEntry = { name: string; path: string; kind: "directory" | "file"; size?: number; editable: boolean }
export type WorkspaceListing = { rootId: string; path: string; entries: WorkspaceEntry[]; truncated: boolean }
export type WorkspaceFile = { rootId: string; path: string; absolutePath: string; text: string; sha256: string; bytes: number; bom: boolean; lineEnding: "lf" | "crlf" | "mixed" | "none" }
export type WorkspaceSave = WorkspaceFile & { backupPath: string | null; changed: boolean }
export type WorkspaceSaveBoundary = "recovery-created" | "backup-verified" | "proposed-verified" | "before-archive" | "source-archived" | "destination-created" | "destination-written" | "destination-verified"
export type WorkspaceFilesOptions = {
  /** Additional active runtime directories supplied by the application. */
  protectedDirectories?: string[]
  /** Deterministic fault injection for tests; production callers omit this. */
  afterBoundary?: (boundary: WorkspaceSaveBoundary, context: { absolutePath: string; recoveryDirectory: string; backupPath: string; proposedPath: string }) => void
}
export class WorkspaceFileError extends Error {
  constructor(readonly kind: "invalid" | "denied" | "conflict" | "recovery", message: string, readonly recoveryDirectory?: string, readonly backupPath?: string) {
    super(message); this.name = "WorkspaceFileError"
  }
}

type Identity = { dev: number; ino: number; birthtimeMs: number }
type AuthorizedRoot = WorkspaceRoot & { identity: Identity }
type Snapshot = { bytes: Buffer; sha256: string; identity: Identity; stat: Stats }
type DirectoryProof = { path: string; identity: Identity }
type Baseline = { identity: Identity; sha256: string; directories: DirectoryProof[] }
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
 * Caught save failures restore the original when ownership is still verifiable.
 * Abrupt exit/power loss keeps phase logs and copies for manual recovery; this
 * class does not replay journals automatically. Automatic rollback publication
 * uses hard links, so unsupported filesystems retain the recovery copies instead.
 * Parent/entry checks and cooperative locks do not sandbox a hostile local
 * process racing individual OS calls; runtime-level directory isolation is separate.
 */
export class WorkspaceFiles {
  private readonly selected = new Map<string, AuthorizedRoot>()
  private readonly baselines = new Map<string, Baseline>()
  constructor(private readonly options: WorkspaceFilesOptions = {}) {}

  open(directory: string): WorkspaceRoot {
    absoluteInput(directory)
    this.checkDirectory(resolve(directory))
    const canonical = realpathSync.native(resolve(directory))
    const rootIdentity = this.checkDirectory(canonical)
    const previous = [...this.selected.values()].find(root => key(root.path) === key(canonical))
    if (previous) { if (!same(previous.identity, rootIdentity)) conflict("已授权目录已被替换，请重新启动工作台后选择"); return publicRoot(previous) }
    const root: AuthorizedRoot = { id: randomUUID(), path: canonical, label: basename(canonical) || canonical, identity: rootIdentity }
    this.selected.set(root.id, root)
    return publicRoot(root)
  }

  roots(): WorkspaceRoot[] { return [...this.selected.values()].map(publicRoot) }

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
      let step = 0
      const journal = (phase: string) => {
        verifyRecovery()
        const event = { format: 1, operation: "workspace-edit", phase, at: Date.now(), root: root.path, relativePath: target.path, absolutePath: target.absolutePath, beforeSha256: original!.sha256, proposedSha256: proposedHash, sourceIdentity: original!.identity, beforePath, backupPath, proposedPath }
        writeExclusive(join(recoveryDirectory!, `${String(++step).padStart(4, "0")}-${phase}.json`), Buffer.from(JSON.stringify(event)))
        flushDirectory(recoveryDirectory!)
      }
      const boundary = (phase: WorkspaceSaveBoundary) => { this.options.afterBoundary?.(phase, context); verifyRecovery() }
      journal("prepared"); boundary("recovery-created")
      writeExclusive(beforePath, original.bytes)
      if (readSnapshot(beforePath).sha256 !== original.sha256) conflict("恢复副本验证失败，原文件未替换")
      journal("backed-up"); boundary("backup-verified")
      writeExclusive(proposedPath, proposed)
      if (readSnapshot(proposedPath).sha256 !== proposedHash) conflict("拟写文件验证失败，原文件未替换")
      journal("proposed"); boundary("proposed-verified")
      const verifyOriginal = () => {
        verifyRecovery()
        const current = readSnapshot(target.absolutePath, original!.identity)
        if (current.sha256 !== original!.sha256) conflict("保存期间文件被外部修改，保留修改而不覆盖")
      }
      verifyOriginal(); journal("archiving"); boundary("before-archive"); verifyOriginal()
      // Preserve the actual entry present at this boundary. A final-check race
      // cannot silently discard its contents by replacing it with the proposal.
      renameSync(target.absolutePath, backupPath)
      archived = true
      flushDirectory(dirname(target.absolutePath)); flushDirectory(recoveryDirectory)
      journal("archived"); boundary("source-archived")
      if (readSnapshot(backupPath, original.identity).sha256 !== original.sha256) conflict("归档时原件发生变化，实际原件已保存在恢复目录")
      this.target(rootId, relativePath, false, true)
      plainDirectory(recoveryDirectory, recoveryIdentity)
      journal("publishing")
      const fd = openSync(target.absolutePath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), original.stat.mode & 0o777)
      try {
        installedIdentity = identity(fstatSync(fd))
        boundary("destination-created")
        this.target(rootId, relativePath)
        const named = regularFile(target.absolutePath)
        if (!same(installedIdentity, identity(named))) conflict("新文件路径被替换，停止写入")
        if (named.size !== 0 || fstatSync(fd).size !== 0) conflict("新文件已被外部写入，停止保存")
        writeAll(fd, proposed); fsyncSync(fd)
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
        if (archived && backupPath && original && proposed) {
          try {
            verifyRecovery()
            // If a third party changed/replaced the destination, preserve both
            // entries for review. Only our unchanged proposal (or its partial
            // prefix after an I/O failure) is eligible for automatic recovery.
            const current = present(target.absolutePath)
            if (current) {
              if (!installedIdentity) conflict("目标由外部重新建立，不能自动覆盖")
              const partial = readSnapshot(target.absolutePath, installedIdentity)
              if (partial.bytes.length > proposed.length || !partial.bytes.equals(proposed.subarray(0, partial.bytes.length))) conflict("目标已有外部修改，不能自动覆盖")
              const interruptedPath = join(recoveryDirectory, "interrupted-proposal")
              verifyRecovery()
              renameSync(target.absolutePath, interruptedPath)
              const captured = readSnapshot(interruptedPath, installedIdentity)
              if (!captured.bytes.equals(partial.bytes)) {
                // Restore the entry actually captured by a last-check race when
                // its original name remains free. Never overwrite a new entry.
                linkSync(interruptedPath, target.absolutePath); unlinkSync(interruptedPath)
                conflict("恢复边界出现新的外部修改")
              }
            }
            verifyRecovery()
            // Publication without replacement keeps an externally recreated
            // destination intact. The original entry itself is restored; the
            // independent before/proposed copies remain in the recovery folder.
            const actualOriginal = readSnapshot(backupPath)
            linkSync(backupPath, target.absolutePath)
            unlinkSync(backupPath)
            backupPath = join(recoveryDirectory, "before")
            flushDirectory(dirname(target.absolutePath)); flushDirectory(recoveryDirectory)
            const recovered = readSnapshot(target.absolutePath, actualOriginal.identity)
            if (recovered.sha256 !== actualOriginal.sha256) conflict("恢复后原件再次改变")
            restored = true
          } catch { /* An uncertain entry stays preserved; never force a rollback. */ }
        }
        // Earlier immutable phase logs remain valid even if this last record
        // cannot be written (disk full, removed directory, or interrupted I/O).
        try { verifyRecovery(); writeExclusive(join(recoveryDirectory, `failure-${randomUUID()}.json`), Buffer.from(JSON.stringify({ format: 1, phase: restored ? "original-restored" : "requires-review", at: Date.now() }))); flushDirectory(recoveryDirectory) } catch {}
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
    const directories: DirectoryProof[] = [{ path: root.path, identity: root.identity }]
    let parent = root.path
    for (const part of parts.slice(0, -1)) { parent = join(parent, part); directories.push({ path: parent, identity: plainDirectory(parent) }) }
    return { root, absolutePath, path: canonicalRelative, directories }
  }
}

function publicRoot(root: AuthorizedRoot): WorkspaceRoot { return { id: root.id, path: root.path, label: root.label } }
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
