import { Database } from "bun:sqlite"
import { lstatSync } from "node:fs"
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path"
import { parseArgs } from "node:util"
import { acquireHostLock, listCheckpoints } from "./checkpoint"
import { assertVaultSchemaCompatible, inspectRelease, resolveCurrent, type ReleaseSelection } from "./releases"
import { isSupportedSchema, type CheckpointInfo } from "./contracts"

export type LauncherChild = { pid: number; exited: Promise<number> }
export type LauncherSpawnOptions = { cwd: string; stdin: "ignore"; stdout: "ignore"; stderr: "ignore"; windowsHide: true }
export type LauncherOptions = {
  systemDir: string; portableRoot: string; hostRoot?: string; noOpen?: boolean
  spawn?: (command: string[], options: LauncherSpawnOptions) => LauncherChild
}
export type LauncherResult = { selection: ReleaseSelection; child: LauncherChild; args: string[]; hostRoot?: string }
const pathKey = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path)
function noDirectoryLinks(path: string) {
  const full = resolve(path), root = parse(full).root
  let current = root
  for (const part of full.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("恢复目录含链接或非目录")
  }
}

async function recoveryHost(selection: ReleaseSelection, options: LauncherOptions, targetSchema: number, snapshots: CheckpointInfo[]) {
  const expected = selection.recovery
  if (!expected) return { hostRoot: options.hostRoot && resolve(options.hostRoot), generation: undefined }
  if (!isSupportedSchema(expected.schemaVersion) || expected.schemaVersion > targetSchema) throw new Error("恢复基点的数据 schema 比选定发行更新，不能用旧程序启动")
  const path = resolve(expected.hostDatabase)
  if (basename(path).toLowerCase() !== "soul.db") throw new Error("配套恢复库必须名为 soul.db，不能交给主程序打开另一个文件")
  const hostRoot = dirname(path)
  noDirectoryLinks(hostRoot)
  if (options.hostRoot && pathKey(options.hostRoot) !== pathKey(hostRoot)) throw new Error("启动宿主目录与已验证的恢复分支不符")
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("恢复库不是普通文件")
  const unlock = acquireHostLock(hostRoot)
  try {
    const base = snapshots.find(snapshot => snapshot.generation === expected.generation)
    if (!base || base.identityId !== expected.identityId || base.revision !== expected.revision || base.schemaVersion !== expected.schemaVersion || base.sha256 !== expected.checkpointSha256)
      throw new Error("便携恢复检查点缺失或已变化，停止启动")
    const db = new Database(path, { readonly: true, strict: true })
    try {
      db.exec("PRAGMA trusted_schema=OFF")
      const checks = db.query("PRAGMA integrity_check").all() as Record<string, unknown>[]
      const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
      const meta = (key: string) => (db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null)?.value
      const revision = meta("revision"), generation = meta("checkpoint_generation")
      if (checks.length !== 1 || Object.values(checks[0]!)[0] !== "ok" || !isSupportedSchema(version)
        || (version !== expected.schemaVersion && version !== targetSchema) || version > targetSchema
        || meta("identity_id") !== expected.identityId || !revision || !/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision)) || Number(revision) < expected.revision || !generation)
        throw new Error("实际宿主数据与所选恢复分支不符，停止启动")
      let checkpoint = snapshots.find(snapshot => snapshot.generation === generation)
      if (!checkpoint || checkpoint.revision > Number(revision) || checkpoint.schemaVersion > version) throw new Error("宿主数据的检查点起点无法核实")
      const visited = new Set<string>()
      let descendantSchema = version, descendantRevision = Number(revision)
      while (checkpoint.generation !== expected.generation) {
        // Walk backwards through a forward-only schema migration. Old checkpoints
        // stay byte-for-byte unchanged, while descendants may use the target schema.
        if (visited.has(checkpoint.generation) || checkpoint.identityId !== expected.identityId
          || !isSupportedSchema(checkpoint.schemaVersion) || checkpoint.schemaVersion < expected.schemaVersion
          || checkpoint.schemaVersion > descendantSchema || checkpoint.revision > descendantRevision
          || !checkpoint.parent) throw new Error("宿主数据不属于所选恢复分支，或 schema/版本链发生倒退")
        visited.add(checkpoint.generation)
        descendantSchema = checkpoint.schemaVersion
        descendantRevision = checkpoint.revision
        const parent = snapshots.find(snapshot => snapshot.generation === checkpoint!.parent)
        if (!parent) throw new Error("恢复分支的检查点链不完整")
        checkpoint = parent
      }
      if (checkpoint.schemaVersion > descendantSchema || checkpoint.revision > descendantRevision)
        throw new Error("恢复基点到宿主数据的 schema/版本链发生倒退")
      return { hostRoot, generation }
    } finally { db.close(true) }
  } finally { unlock() }
}

/** Verifies the installed selection before spawning with an argument array and no shell. */
export async function launch(options: LauncherOptions): Promise<LauncherResult> {
  if (!options.systemDir || !isAbsolute(options.systemDir) || !options.portableRoot || !isAbsolute(options.portableRoot) || (options.hostRoot && !isAbsolute(options.hostRoot))) throw new Error("启动器需要明确的绝对系统、便携和宿主目录")
  options = { ...options, systemDir: resolve(options.systemDir), portableRoot: resolve(options.portableRoot) }
  if (pathKey(dirname(options.systemDir)) !== pathKey(options.portableRoot)) throw new Error("系统目录必须直接位于指定便携根目录下")
  const selection = await resolveCurrent(options.systemDir)
  if (!selection) throw new Error("没有通过验收并激活的发行版本")
  const release = await inspectRelease(selection.releasePath)
  if (release.manifestHash !== selection.manifestHash) throw new Error("验证期间选定发行清单发生变化，停止启动")
  // Every path, including a selection with no recovery record, must protect a
  // newer vault from an older executable. Reuse this scan for branch validation.
  const snapshots = await listCheckpoints(join(options.portableRoot, "vault"))
  assertVaultSchemaCompatible(release.manifest.schemaVersion, snapshots)
  const { hostRoot, generation } = await recoveryHost(selection, options, release.manifest.schemaVersion, snapshots)
  const command = [join(selection.releasePath, "xingyao.exe"), "--portable-root", options.portableRoot, "--engine", join(selection.releasePath, "opencode.exe")]
  if (hostRoot) command.push("--host-root", hostRoot)
  if (generation) command.push("--recovery-generation", generation)
  if (options.noOpen) command.push("--no-open")
  const spawn = options.spawn ?? ((args, settings) => Bun.spawn(args, settings))
  const child = spawn(command, { cwd: options.portableRoot, stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true })
  return { selection, child, args: command, hostRoot }
}

export async function launcherMain(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { "system-root": { type: "string" }, "portable-root": { type: "string" }, "host-root": { type: "string" }, "no-open": { type: "boolean" } } })
  if (!values["system-root"] || !values["portable-root"]) throw new Error("缺少 --system-root 或 --portable-root")
  const result = await launch({ systemDir: values["system-root"], portableRoot: values["portable-root"], hostRoot: values["host-root"], noOpen: values["no-open"] })
  // Bun's Windows process ownership can terminate children when an unref'ed
  // launcher exits. Keep this hidden supervisor alive for the product lifetime.
  const code = await result.child.exited
  process.exitCode = code
  if (code !== 0) console.error(`XINGYAO_PRODUCT_EXITED: selected product exited unsuccessfully (code ${code}).`)
  return result
}
