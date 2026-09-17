import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, writeSync, type Stats } from "node:fs"
import { basename, extname, isAbsolute, join, parse, resolve } from "node:path"

export type FileCategory = "文档" | "图片" | "音视频" | "压缩包" | "代码" | "其他"
type Phase = "planned" | "copying" | "copied" | "removing" | "moved" | "undo-copying" | "undo-copied" | "undo-removing" | "undone"
type FileIdentity = { dev: number; ino: number; birthtimeMs: number }
export type FilePlanItem = {
  id: string; name: string; source: string; target: string; category: FileCategory; sha256: string; size: number
  status: Phase | "conflict" | "unknown"; phase: Phase; error: string | null
  sourceIdentity: FileIdentity; targetIdentity?: FileIdentity; restoredIdentity?: FileIdentity
}
export type FilePlan = {
  id: string; directory: string; recoveryDirectory: string
  status: "preview" | "applying" | "completed" | "partial" | "undoing" | "undone"
  createdAt: number; updatedAt: number; items: FilePlanItem[]; skipped: { name: string; reason: string }[]; error: string | null
  directoryIdentity: FileIdentity; recoveryIdentity?: FileIdentity; categoryIdentities: Partial<Record<FileCategory, FileIdentity>>
}
export type FileBoundary = "recovery-created" | "target-created" | "copy-verified" | "source-archived" | "restore-created" | "restore-verified" | "target-archived"
export type FileOrganizerOptions = { afterBoundary?: (boundary: FileBoundary, plan: FilePlan, item?: FilePlanItem) => void }
const categories: FileCategory[] = ["文档", "图片", "音视频", "压缩包", "代码", "其他"]
const groups: [FileCategory, Set<string>][] = [
  ["文档", new Set("txt md markdown pdf doc docx xls xlsx ppt pptx csv tsv rtf odt ods epub".split(" "))],
  ["图片", new Set("jpg jpeg png gif webp bmp svg ico tif tiff heic avif".split(" "))],
  ["音视频", new Set("mp3 wav flac ogg aac m4a mp4 mkv mov avi webm wmv mpeg".split(" "))],
  ["压缩包", new Set("zip 7z rar tar gz bz2 xz tgz zst".split(" "))],
  ["代码", new Set("js ts jsx tsx py rs go c h cpp hpp cs java json yaml yml toml html css sh ps1 cmd bat sql ipynb".split(" "))],
]
const running = new WeakMap<Database, Set<string>>()
class FileConflict extends Error {}
class FileUnknown extends Error {}
class Interrupted extends Error {}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
const key = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path)
const identity = (stat: Stats): FileIdentity => ({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs })
const same = (a: FileIdentity, b: FileIdentity) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs
function statIfPresent(path: string) { try { return lstatSync(path) } catch (error) { if (missing(error)) return null; throw error } }
function regular(path: string) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new FileConflict(`不是普通文件或已变成链接：${path}`)
  return stat
}
function safeDirectory(path: string, expected?: FileIdentity) {
  const full = resolve(path)
  const root = parse(full).root
  let current = root
  for (const component of full.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, component)
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new FileConflict(`目录含链接、连接点或非目录：${current}`)
  }
  const stat = lstatSync(full)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (expected && !same(identity(stat), expected))) throw new FileConflict(`目录身份已经改变：${full}`)
  return identity(stat)
}
function fileHash(path: string, expected?: FileIdentity) {
  const before = regular(path)
  if (expected && !same(identity(before), expected)) throw new FileConflict(`文件身份已变化：${path}`)
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd)
    if (!same(identity(before), identity(opened))) throw new FileConflict(`读取时文件已替换：${path}`)
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024)
    for (;;) { const size = readSync(fd, buffer, 0, buffer.length, null); if (!size) break; hash.update(buffer.subarray(0, size)) }
    const after = fstatSync(fd)
    const named = regular(path)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || !same(identity(after), identity(named))) throw new FileConflict(`读取期间文件发生变化：${path}`)
    return { sha256: hash.digest("hex"), size: after.size, identity: identity(after) }
  } finally { closeSync(fd) }
}
function verified(path: string, expected: FileIdentity | undefined, sha256: string) {
  if (!expected) throw new FileUnknown(`没有已提交的文件所有权记录，保留文件等待核实：${path}`)
  const result = fileHash(path, expected)
  if (result.sha256 !== sha256) throw new FileConflict(`文件内容与计划不符，保留原文件：${path}`)
  return result
}
function flushDirectory(path: string) {
  if (process.platform === "win32") return
  const fd = openSync(path, "r")
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
async function protectedFiles(directory: string): Promise<Set<string>> {
  if (process.platform !== "win32") return new Set()
  // The selected path is passed as an environment value, never interpolated as code.
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $names=@(Get-ChildItem -LiteralPath $env:XINGYAO_SCAN_DIRECTORY -Force -File | Where-Object { ($_.Attributes -band ([IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System)) -ne 0 } | ForEach-Object { $_.Name }); ConvertTo-Json -InputObject $names -Compress"
  const child = Bun.spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, XINGYAO_SCAN_DIRECTORY: directory }, stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 10_000 })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new FileConflict(`无法核对 Windows 隐藏/系统属性，停止整理：${stderr.trim().slice(0, 200)}`)
  const value = JSON.parse(stdout.replace(/^\uFEFF/, "")) as unknown
  if (!Array.isArray(value) || value.some(x => typeof x !== "string")) throw new FileConflict("Windows 文件属性结果无效，停止整理")
  return new Set((value as string[]).map(x => x.toLowerCase()))
}

/** File moves are explicit; originals and uncertain copies remain in a private recovery directory. */
export class FileOrganizer {
  constructor(readonly db: Database, private options: FileOrganizerOptions = {}) {
    db.exec("CREATE TABLE IF NOT EXISTS file_plans(id TEXT PRIMARY KEY,body TEXT NOT NULL)")
  }
  get(id: string): FilePlan | null {
    const row = this.db.query<{ body: string }, [string]>("SELECT body FROM file_plans WHERE id=?").get(id)
    return row ? JSON.parse(row.body) : null
  }
  list(): FilePlan[] { return this.db.query<{ body: string }, []>("SELECT body FROM file_plans ORDER BY rowid DESC").all().map(row => JSON.parse(row.body)) }
  private save(plan: FilePlan) {
    this.db.transaction(() => {
      plan.updatedAt = Date.now()
      this.db.query("INSERT INTO file_plans(id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(plan.id, JSON.stringify(plan))
      const row = this.db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='revision'").get()
      if (!row || !/^\d+$/.test(row.value) || !Number.isSafeInteger(Number(row.value) + 1)) throw new Error("领域 revision 无效")
      this.db.query("UPDATE meta SET value=? WHERE key='revision'").run(String(Number(row.value) + 1))
      this.db.query("INSERT INTO outbox(kind,entity_id,created_at) VALUES ('file_plan',?,?)").run(plan.id, plan.updatedAt)
    })()
  }
  private boundary(boundary: FileBoundary, plan: FilePlan, item?: FilePlanItem) {
    try { this.options.afterBoundary?.(boundary, plan, item) } catch (error) { throw new Interrupted(errorText(error)) }
  }
  async plan(directory: string): Promise<FilePlan> {
    if (!directory || !isAbsolute(directory)) throw new FileConflict("请明确指定一个绝对目录路径")
    directory = resolve(directory)
    const directoryIdentity = safeDirectory(directory)
    const blocked = await protectedFiles(directory)
    safeDirectory(directory, directoryIdentity)
    const id = randomUUID(), now = Date.now()
    const plan: FilePlan = { id, directory, directoryIdentity, recoveryDirectory: join(directory, `.xingyao-recovery-${id}`), categoryIdentities: {}, status: "preview", createdAt: now, updatedAt: now, items: [], skipped: [], error: null }
    const activeDatabase = this.db.filename && this.db.filename !== ":memory:" ? key(this.db.filename) : null
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = entry.name, source = join(directory, name)
      let reason: string | undefined
      if (name.startsWith(".") || blocked.has(name.toLowerCase()) || /^(desktop\.ini|thumbs\.db|autorun\.inf)$/i.test(name)) reason = "隐藏或系统文件"
      else if (!entry.isFile() || entry.isSymbolicLink()) reason = "目录、链接或非普通文件；不递归"
      else if (activeDatabase && ["", "-wal", "-shm", "-journal"].some(suffix => key(source) === `${activeDatabase}${suffix}`)) reason = "正在使用的领域数据库"
      if (reason) { plan.skipped.push({ name, reason }); continue }
      try {
        const data = fileHash(source)
        if (data.identity.dev !== directoryIdentity.dev) throw new FileConflict("不处理跨存储卷的源文件")
        const extension = extname(name).slice(1).toLowerCase()
        const category = groups.find(([, extensions]) => extensions.has(extension))?.[0] ?? "其他"
        const targetDirectory = join(directory, category)
        const targetStat = statIfPresent(targetDirectory)
        if (targetStat) {
          const targetIdentity = safeDirectory(targetDirectory)
          if (targetIdentity.dev !== directoryIdentity.dev) throw new FileConflict("分类目录处于不同存储卷")
          plan.categoryIdentities[category] = targetIdentity
        }
        const target = join(targetDirectory, name)
        const conflict = statIfPresent(target) !== null
        plan.items.push({ id: randomUUID(), name, source, target, category, sha256: data.sha256, size: data.size, sourceIdentity: data.identity, phase: "planned", status: conflict ? "conflict" : "planned", error: conflict ? "目标已经存在，不会覆盖" : null })
      } catch (error) { plan.skipped.push({ name, reason: errorText(error) }) }
    }
    this.save(plan)
    return plan
  }
  private paths(plan: FilePlan, item: FilePlanItem) {
    if (!/^[a-f0-9-]{36}$/.test(plan.id) || !/^[a-f0-9-]{36}$/.test(item.id) || basename(item.name) !== item.name || !categories.includes(item.category) ||
      item.source !== join(plan.directory, item.name) || item.target !== join(plan.directory, item.category, item.name) || plan.recoveryDirectory !== join(plan.directory, `.xingyao-recovery-${plan.id}`)) throw new FileConflict("整理计划路径不符合受控目录规则")
    safeDirectory(plan.directory, plan.directoryIdentity)
    return { original: join(plan.recoveryDirectory, `${item.id}.original`), organized: join(plan.recoveryDirectory, `${item.id}.organized`) }
  }
  private ensureRecovery(plan: FilePlan) {
    safeDirectory(plan.directory, plan.directoryIdentity)
    if (plan.recoveryIdentity) { safeDirectory(plan.recoveryDirectory, plan.recoveryIdentity); return }
    if (statIfPresent(plan.recoveryDirectory)) throw new FileUnknown("恢复目录已存在但所有权记录未提交，保留全部文件等待核实")
    mkdirSync(plan.recoveryDirectory, { mode: 0o700 })
    this.boundary("recovery-created", plan)
    plan.recoveryIdentity = safeDirectory(plan.recoveryDirectory)
    this.save(plan)
  }
  private ensureCategory(plan: FilePlan, item: FilePlanItem) {
    safeDirectory(plan.directory, plan.directoryIdentity)
    const directory = join(plan.directory, item.category)
    const expected = plan.categoryIdentities[item.category]
    if (!statIfPresent(directory)) {
      if (expected) throw new FileConflict("预览时的分类目录已经消失")
      mkdirSync(directory)
    }
    const actual = safeDirectory(directory, expected)
    if (actual.dev !== plan.directoryIdentity.dev) throw new FileConflict("不处理跨存储卷的分类目录")
    if (!expected) { plan.categoryIdentities[item.category] = actual; this.save(plan) }
  }
  private setPhase(plan: FilePlan, item: FilePlanItem, phase: Phase) {
    item.phase = phase; item.status = phase; item.error = null; this.save(plan)
  }
  private copy(plan: FilePlan, item: FilePlanItem, undo: boolean) {
    const paths = this.paths(plan, item)
    safeDirectory(plan.recoveryDirectory, plan.recoveryIdentity)
    safeDirectory(join(plan.directory, item.category), plan.categoryIdentities[item.category])
    const from = undo ? paths.original : item.source, to = undo ? item.source : item.target
    const own = undo ? item.restoredIdentity : item.targetIdentity
    if (statIfPresent(to)) {
      if (!own && (item.phase === "planned" || (undo && item.phase === "moved"))) throw new FileConflict(`目标已经存在，不会覆盖：${to}`)
      verified(to, own, item.sha256)
      verified(from, item.sourceIdentity, item.sha256)
      this.setPhase(plan, item, undo ? "undo-copied" : "copied")
      return
    }
    if (own) throw new FileUnknown("本计划已创建的副本消失，不自动冒认或重新创建")
    verified(from, item.sourceIdentity, item.sha256)
    this.setPhase(plan, item, undo ? "undo-copying" : "copying")
    const input = openSync(from, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let output: number | undefined
    try {
      if (!same(identity(fstatSync(input)), item.sourceIdentity)) throw new FileConflict("复制开始时源文件已替换")
      output = openSync(to, "wx", 0o600)
      this.boundary(undo ? "restore-created" : "target-created", plan, item)
      if (undo) item.restoredIdentity = identity(fstatSync(output)); else item.targetIdentity = identity(fstatSync(output))
      this.save(plan)
      const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024)
      for (;;) {
        const size = readSync(input, buffer, 0, buffer.length, null)
        if (!size) break
        hash.update(buffer.subarray(0, size))
        let offset = 0
        while (offset < size) offset += writeSync(output, buffer, offset, size - offset)
      }
      fsyncSync(output)
      if (hash.digest("hex") !== item.sha256) throw new FileConflict("复制中源文件内容改变，保留源文件与未完成副本")
    } finally { if (output !== undefined) closeSync(output); closeSync(input) }
    verified(to, undo ? item.restoredIdentity : item.targetIdentity, item.sha256)
    verified(from, item.sourceIdentity, item.sha256)
    this.boundary(undo ? "restore-verified" : "copy-verified", plan, item)
    this.setPhase(plan, item, undo ? "undo-copied" : "copied")
  }
  private archive(plan: FilePlan, item: FilePlanItem, undo: boolean) {
    const paths = this.paths(plan, item)
    safeDirectory(plan.recoveryDirectory, plan.recoveryIdentity)
    safeDirectory(join(plan.directory, item.category), plan.categoryIdentities[item.category])
    const from = undo ? item.target : item.source, to = undo ? paths.organized : paths.original
    const expected = undo ? item.targetIdentity : item.sourceIdentity
    verified(undo ? item.source : item.target, undo ? item.restoredIdentity : item.targetIdentity, item.sha256)
    if (statIfPresent(to)) {
      verified(to, expected, item.sha256)
      const remaining = statIfPresent(from)
      if (remaining && same(identity(remaining), expected!)) throw new FileUnknown("恢复副本与原路径同时指向同一文件，需要核实")
    } else {
      verified(from, expected, item.sha256)
      this.setPhase(plan, item, undo ? "undo-removing" : "removing")
      // The source is retained, not unlinked. Even an external race between the
      // final check and rename leaves the actual bytes in this recovery directory.
      renameSync(from, to)
      flushDirectory(plan.recoveryDirectory)
      flushDirectory(undo ? join(plan.directory, item.category) : plan.directory)
      this.boundary(undo ? "target-archived" : "source-archived", plan, item)
      verified(to, expected, item.sha256)
      verified(undo ? item.source : item.target, undo ? item.restoredIdentity : item.targetIdentity, item.sha256)
    }
    this.setPhase(plan, item, undo ? "undone" : "moved")
  }
  private applyItem(plan: FilePlan, item: FilePlanItem) {
    this.paths(plan, item)
    this.ensureCategory(plan, item)
    if (item.phase === "planned" || item.phase === "copying") this.copy(plan, item, false)
    if (item.phase === "copied" || item.phase === "removing") this.archive(plan, item, false)
  }
  private undoItem(plan: FilePlan, item: FilePlanItem) {
    this.paths(plan, item)
    if (item.phase === "planned") { this.setPhase(plan, item, "undone"); return }
    this.ensureCategory(plan, item)
    if (item.phase === "copying" || item.phase === "copied") {
      // A source not yet moved is already in its original place. Only an owned,
      // verified extra copy may be moved into recovery; uncertain copies are kept.
      verified(item.source, item.sourceIdentity, item.sha256)
      if (!statIfPresent(item.target) && !item.targetIdentity) { this.setPhase(plan, item, "undone"); return }
      verified(item.target, item.targetIdentity, item.sha256)
      item.restoredIdentity = item.sourceIdentity
      this.setPhase(plan, item, "undo-copied")
    }
    if (item.phase === "removing") this.archive(plan, item, false)
    if (item.phase === "moved" || item.phase === "undo-copying") {
      verified(item.target, item.targetIdentity, item.sha256)
      this.copy(plan, item, true)
    }
    if (item.phase === "undo-copied" || item.phase === "undo-removing") this.archive(plan, item, true)
  }
  private async run(id: string, undo: boolean): Promise<FilePlan> {
    const plan = this.get(id)
    if (!plan) throw new FileConflict("整理计划不存在")
    if ((!undo && plan.status === "completed") || plan.status === "undone") return plan
    if (!undo && plan.items.some(item => item.phase.startsWith("undo-"))) throw new FileConflict("该计划已开始撤销，请继续撤销")
    let locks = running.get(this.db)
    if (!locks) { locks = new Set(); running.set(this.db, locks) }
    const directoryKey = key(plan.directory)
    if (locks.has(directoryKey)) throw new FileConflict("此目录已有整理操作正在进行")
    locks.add(directoryKey)
    try {
      if (!/^[a-f0-9-]{36}$/.test(plan.id) || !isAbsolute(plan.directory) || plan.recoveryDirectory !== join(plan.directory, `.xingyao-recovery-${plan.id}`)) throw new FileConflict("整理计划恢复目录不符合边界规则")
      safeDirectory(plan.directory, plan.directoryIdentity)
      const blocked = await protectedFiles(plan.directory)
      safeDirectory(plan.directory, plan.directoryIdentity)
      plan.status = undo ? "undoing" : "applying"; plan.error = null; this.save(plan)
      if (plan.items.some(item => item.phase !== "undone" && (!undo || item.phase !== "planned"))) this.ensureRecovery(plan)
      for (const item of plan.items) {
        if (item.phase === "undone" || (!undo && item.phase === "moved")) continue
        try {
          if (item.name.startsWith(".") || blocked.has(item.name.toLowerCase())) throw new FileConflict("文件现在具有隐藏或系统属性，停止处理")
          if (undo) this.undoItem(plan, item); else this.applyItem(plan, item)
        } catch (error) {
          if (error instanceof Interrupted) throw error
          item.status = error instanceof FileConflict ? "conflict" : "unknown"; item.error = errorText(error); this.save(plan)
        }
      }
      plan.status = plan.items.every(item => item.phase === (undo ? "undone" : "moved")) ? (undo ? "undone" : "completed") : "partial"
      plan.error = plan.status === "partial" ? "部分文件需要核实；原件和不确定副本均保留，不会覆盖或永久删除" : null
      this.save(plan)
      return plan
    } catch (error) {
      if (error instanceof Interrupted) throw error
      plan.status = "partial"; plan.error = errorText(error); this.save(plan)
      return plan
    } finally { locks.delete(directoryKey) }
  }
  apply(id: string): Promise<FilePlan> { return this.run(id, false) }
  undo(id: string): Promise<FilePlan> { return this.run(id, true) }
}
