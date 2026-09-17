import { Database } from "bun:sqlite"
import { closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { isAbsolute, join, parse, relative, resolve } from "node:path"
import { acquireHostLock, createCheckpoint, listCheckpoints, restoreCheckpoint } from "./checkpoint"
import { backupEngine, restoreEngine, verifyEngineCheckpoint } from "./engine-backup"
import { startEngine, type Engine } from "./engine"
import { SoulStore } from "./store"
import type { CheckpointInfo } from "./contracts"

export type MigrationEngine = { executable: string; version: string; sha256: string }
export type EngineMigrationBoundary = "source-restored" | "baseline-verified" | "candidate-started" | "history-verified" | "checkpoint-created"
export type EngineMigrationOptions = {
  hostDir: string; vaultDir: string; generation: string; projectDir: string
  from: MigrationEngine; to: MigrationEngine
  /** Fault injection only; production callers omit. */
  afterBoundary?: (boundary: EngineMigrationBoundary, stageDir: string) => void
}
export type EngineMigrationEvidence = {
  format: 1; sourceGeneration: string; sourceCheckpointSha256: string; identityId: string
  sourceEngineVersion: string; sourceEngineSha256: string; targetEngineVersion: string; targetEngineSha256: string
  contract: "legacy-public-session-archive-v1"; scope: "all-product-task-session-bindings"
  sessions: Array<{ sessionID: string; messageCount: number; sha256: string }>
  verifiedAt: number; outcome: "passed"
}
const sha = (bytes: Uint8Array | ArrayBuffer | string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
const generationPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/
function directory(path: string) {
  if (!isAbsolute(path)) throw new Error("迁移目录必须为绝对路径")
  const full = resolve(path), root = parse(full).root
  let current = root
  for (const part of full.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("迁移路径不能包含链接或非目录")
  }
  return full
}
async function binary(input: MigrationEngine) {
  if (!isAbsolute(input.executable) || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(input.version) || !/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error("迁移需要明确的引擎路径、版本与 SHA-256")
  const executable = resolve(input.executable), stat = lstatSync(executable)
  if (!stat.isFile() || stat.isSymbolicLink() || resolve(realpathSync(executable)).toLowerCase() !== executable.toLowerCase()) throw new Error("迁移引擎必须为未重定向的普通文件")
  if (sha(await Bun.file(executable).arrayBuffer()) !== input.sha256) throw new Error("迁移引擎 SHA-256 不匹配")
  const probe = Bun.spawnSync([executable, "--version"], { stdout: "pipe", stderr: "ignore", windowsHide: true, timeout: 10_000 })
  if (probe.exitCode !== 0 || probe.stdout.toString().trim() !== input.version) throw new Error("迁移引擎版本与清单不符")
  return { ...input, executable }
}
function durable(path: string, body: string) {
  const fd = openSync(path, "wx", 0o600)
  try { writeFileSync(fd, body); fsyncSync(fd) } finally { closeSync(fd) }
}
function assertCleanHost(hostDir: string, checkpoint: CheckpointInfo, stageDir: string) {
  const file = join(hostDir, "soul.db")
  if (!existsSync(file)) {
    if (["opencode.db", "opencode-product-dev.db"].some(name => existsSync(join(hostDir, "opencode/data/opencode", name)))) throw new Error("宿主有未配套的引擎数据，不能忽略后迁移")
    return
  }
  // SQLite readonly can still create -shm/-wal beside a WAL-mode database.
  // Inspect a stopped-writer copy INCLUDING any committed WAL; immutable=1
  // on the original would silently ignore those committed records.
  const inspection = join(stageDir, "host-inspection")
  mkdirSync(inspection)
  const names = ["soul.db", "soul.db-wal", "soul.db-shm", "soul.db-journal"]
  const fingerprint = () => names.map(name => {
    const source = join(hostDir, name)
    if (!existsSync(source)) return null
    const stat = lstatSync(source)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("迁移宿主库及辅助文件必须为普通文件")
    return { name, hash: sha(readFileSync(source)), inode: stat.ino, device: stat.dev, birthtime: stat.birthtimeMs }
  })
  const before = fingerprint()
  for (const member of before) if (member) {
    const target = join(inspection, member.name)
    copyFileSync(join(hostDir, member.name), target, constants.COPYFILE_EXCL)
    if (sha(readFileSync(target)) !== member.hash) throw new Error("宿主检查副本内容变化，请先保存并退出")
  }
  if (JSON.stringify(fingerprint()) !== JSON.stringify(before)) throw new Error("宿主在迁移检查时仍被改写")
  const db = new Database(join(inspection, "soul.db"), { readonly: true, strict: true })
  try {
    db.exec("PRAGMA trusted_schema=OFF")
    const read = (key: string) => db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key=?").get(key)?.value
    const schema = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
    if (schema !== checkpoint.schemaVersion || read("identity_id") !== checkpoint.identityId || read("revision") !== String(checkpoint.revision) || read("checkpoint_generation") !== checkpoint.generation) throw new Error("宿主存在未同步变化或不属于迁移检查点，请先保存并退出")
  } finally { db.close(true) }
}

/** Explicit offline migration: originals remain untouched. Both binaries only
 * open a restored copy. A new paired checkpoint is published last, with the
 * existing checkpoint as parent. Restore itself still requires exact versions.
 * No provider config, credentials or model prompt enters this operation. */
export async function migrateEngineCheckpoint(input: EngineMigrationOptions): Promise<{ checkpoint: CheckpointInfo; stageDir: string; evidence: EngineMigrationEvidence }> {
  const options = { ...input, hostDir: directory(input.hostDir), vaultDir: directory(input.vaultDir) }
  const contains = (root: string, target: string) => { const part = relative(root, target); return !part || (part !== ".." && !part.startsWith("..\\") && !part.startsWith("../") && !isAbsolute(part)) }
  if (contains(options.hostDir, options.vaultDir) || contains(options.vaultDir, options.hostDir)) throw new Error("迁移宿主和便携库目录不能相同或互相包含")
  if (!isAbsolute(options.projectDir) || !lstatSync(options.projectDir).isDirectory() || !generationPattern.test(options.generation)) throw new Error("迁移需要现有项目路径和明确检查点")
  const unlock = acquireHostLock(options.hostDir)
  let engine: Engine | undefined, store: SoulStore | undefined
  let stageDir: string | undefined
  try {
    const checkpoints = await listCheckpoints(options.vaultDir)
    const heads = checkpoints.filter(c => !checkpoints.some(other => other.parent === c.generation))
    const source = heads.length === 1 && heads[0]!.generation === options.generation ? heads[0]! : null
    if (!source) throw new Error("只能迁移唯一完整分支的最新检查点；不会覆盖或制造分叉")
    stageDir = mkdtempSync(join(options.hostDir, ".engine-migration-"))
    const stage = stageDir
    assertCleanHost(options.hostDir, source, stageDir)
    const from = await binary(options.from), to = await binary(options.to)
    if (from.sha256 === to.sha256) throw new Error("目标引擎与原引擎相同，无需迁移")
    const generationDir = join(options.vaultDir, "checkpoints", source.generation)
    const savedEngine = await verifyEngineCheckpoint(generationDir)
    if (savedEngine.engineVersion !== from.version) throw new Error("来源引擎与配套检查点版本不符")
    // Keep failure evidence in an isolated NTFS host subdirectory. Never erase a
    // failed attempt automatically or write into the active OpenCode directory.
    await restoreCheckpoint(options.vaultDir, source.generation, join(stageDir, "soul.db"))
    await restoreEngine(stageDir, generationDir, from.version)
    options.afterBoundary?.("source-restored", stageDir)
    store = new SoulStore(join(stageDir, "soul.db"))
    if (store.identityId !== source.identityId || (store.meta("engine_version") && store.meta("engine_version") !== from.version)) throw new Error("领域身份或配套引擎记录不符")
    if (store.meta("engine_sha256") && store.meta("engine_sha256") !== from.sha256) throw new Error("领域记录的来源引擎哈希不符")
    const tasks = store.tasks()
    if (tasks.some(task => ["running", "waiting"].includes(task.status))) throw new Error("仍有运行中或待核实任务，先核实结果后迁移")
    const sessionIDs = [...new Set(tasks.flatMap(task => task.sessionId ? [task.sessionId] : []))].sort()
    if (sessionIDs.length && !savedEngine.files.length) throw new Error("任务含会话绑定却没有配套引擎数据库")
    engine = await startEngine({ executable: from.executable, hostDir: stageDir, projectDir: options.projectDir, requestTimeoutMs: 30_000 })
    if (engine.version !== from.version) throw new Error("旧引擎实际服务版本不符")
    const sessions: EngineMigrationEvidence["sessions"] = []
    for (const sessionID of sessionIDs) sessions.push(await engine.adapter.migrationDigest(sessionID))
    if ((await engine.adapter.permissions()).length) throw new Error("旧引擎仍有未处理的权限请求")
    await engine.stop(); engine = undefined
    options.afterBoundary?.("baseline-verified", stageDir)
    engine = await startEngine({ executable: to.executable, hostDir: stageDir, projectDir: options.projectDir, requestTimeoutMs: 30_000 })
    if (engine.version !== to.version) throw new Error("新引擎实际服务版本不符")
    options.afterBoundary?.("candidate-started", stageDir)
    for (const expected of sessions) {
      const actual = await engine.adapter.migrationDigest(expected.sessionID)
      if (actual.sha256 !== expected.sha256 || actual.messageCount !== expected.messageCount) throw new Error("新引擎会话历史与迁移前不一致；原检查点保留")
    }
    if ((await engine.adapter.permissions()).length) throw new Error("新引擎产生了待处理权限请求")
    await engine.stop(); engine = undefined
    options.afterBoundary?.("history-verified", stageDir)
    await binary(from); await binary(to)
    const evidence: EngineMigrationEvidence = { format: 1, sourceGeneration: source.generation, sourceCheckpointSha256: source.sha256, identityId: source.identityId,
      sourceEngineVersion: from.version, sourceEngineSha256: from.sha256, targetEngineVersion: to.version, targetEngineSha256: to.sha256,
      contract: "legacy-public-session-archive-v1", scope: "all-product-task-session-bindings", sessions, verifiedAt: Date.now(), outcome: "passed" }
    store.db.transaction(() => {
      store!.setMeta("engine_version", to.version); store!.setMeta("engine_sha256", to.sha256)
      store!.setMeta("engine_migration", JSON.stringify(evidence))
      store!.setMeta("revision", String(store!.revision + 1))
    })()
    // createCheckpoint owns the portable writer lock and rechecks the parent.
    // A competing new head during the rehearsal therefore rejects publication.
    const checkpoint = await createCheckpoint(store.db, options.vaultDir, store.identityId, store.revision, source.generation, async directory => {
      const engineCheckpoint = await backupEngine(stage, directory, to.version)
      const hashes: Record<string, string> = {}
      for (const file of engineCheckpoint.files) hashes[`engine/${file.path}`] = file.sha256
      hashes["engine/complete.json"] = sha(readFileSync(join(directory, "engine/complete.json")))
      mkdirSync(join(directory, "upgrade"))
      const body = JSON.stringify(evidence, null, 2)
      durable(join(directory, "upgrade/engine-migration.json"), body)
      hashes["upgrade/engine-migration.json"] = sha(body)
      return hashes
    })
    options.afterBoundary?.("checkpoint-created", stageDir)
    return { checkpoint, stageDir, evidence }
  } catch (error) {
    if (stageDir) throw new Error(`${error instanceof Error ? error.message : "迁移未完成"}；隔离副本保留在 ${stageDir}。如已写入新完整检查点，请核对其迁移凭据后继续，不要重复覆盖。`, { cause: error })
    throw error
  } finally {
    try { await engine?.stop() } finally { try { store?.close() } finally { unlock() } }
  }
}
