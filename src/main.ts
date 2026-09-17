import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { SoulStore } from "./store"
import { acquireHostLock, listCheckpoints } from "./checkpoint"
import { startEngine } from "./engine"
import { OpenCodeAdapter } from "./adapter"
import { startServer, ModelConfigurationError } from "./server"
import { PRODUCT_VERSION } from "./contracts"
import { mountPortable } from "./portable"
import { backupEngine } from "./engine-backup"
import { resumeProductRestore, restoreProduct } from "./recovery"

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    "portable-root": { type: "string" }, "host-root": { type: "string" }, engine: { type: "string" }, project: { type: "string" }, port: { type: "string" },
    "recovery-generation": { type: "string" },
    "no-open": { type: "boolean" }, "offline": { type: "boolean" }, version: { type: "boolean" }, help: { type: "boolean" },
  } })
  if (values.version) { console.log(`星杳 · 璇玑 ${PRODUCT_VERSION}`); return }
  if (values.help) { console.log("xingyao --portable-root <directory> [--engine <opencode.exe>] [--project <directory>] [--no-open] [--offline]"); return }
  const portable = resolve(values["portable-root"] ?? process.env.XUANJI_ROOT ?? join(process.cwd(), "Xuanji"))
  mkdirSync(portable, { recursive: true })
  const marker = join(portable, "drive.json")
  if (!existsSync(marker)) writeFileSync(marker, JSON.stringify({ driveId: crypto.randomUUID(), product: "xingyao-xuanji", version: 1 }), { flag: "wx" })
  const drive: unknown = JSON.parse(readFileSync(marker, "utf8"))
  if (!drive || typeof drive !== "object" || !("driveId" in drive) || typeof drive.driveId !== "string" || !/^[0-9a-f-]{36}$/.test(drive.driveId)) throw new Error("便携身份标识无效，停止启动以保护数据")
  const host = resolve(values["host-root"] ?? join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? process.cwd(), "AppData", "Local"), "Xuanji", drive.driveId))
  mkdirSync(host, { recursive: true })
  if (await reopenExisting(host, drive.driveId, values["no-open"] === true)) return
  const unlock = acquireHostLock(host)
  const vault = join(portable, "vault")
  const dbPath = join(host, "soul.db")
  let store: SoulStore | undefined
  let engine: Awaited<ReturnType<typeof startEngine>> | undefined
  let app: ReturnType<typeof startServer> | undefined
  let stopping = false
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined
  let mount: ReturnType<typeof mountPortable> | undefined
  try {
    const executable = resolve(values.engine ?? join(portable, "system", "engine", "opencode.exe"))
    const executableVersion = existsSync(executable) ? Bun.spawnSync([executable, "--version"], { stdout: "pipe", stderr: "ignore", windowsHide: true }).stdout.toString().trim() : ""
    const recoveryOptions = { hostDir: host, vaultDir: vault, engineVersion: executableVersion }
    const resumed = await resumeProductRestore(recoveryOptions)
    const snapshots = await listCheckpoints(vault)
    const heads = snapshots.filter(snapshot => !snapshots.some(other => other.parent === snapshot.generation))
    if (heads.length > 1) throw new Error("U 盘存在多个恢复分支，请先选择要恢复的检查点；未覆盖任何数据")
    if (!existsSync(dbPath) && heads[0]) await restoreProduct({ ...recoveryOptions, generation: heads[0].generation })
    store = new SoulStore(dbPath)
    const latest = heads[0]
    if (latest && store.identityId !== latest.identityId) throw new Error("宿主和 U 盘身份不同，停止自动同步")
    const recoveryGeneration = values["recovery-generation"]
    if (recoveryGeneration && store.meta("checkpoint_generation") !== recoveryGeneration) throw new Error("恢复分支和选定代次不一致，停止自动启动")
    if (recoveryGeneration && resumed.generation !== recoveryGeneration) {
      const selected = snapshots.find(snapshot => snapshot.generation === recoveryGeneration)
      if (!selected || selected.revision !== store.revision) throw new Error("恢复分支已有新工作，需先核实配套引擎状态，不能重新覆盖")
      store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); store.close(); store = undefined
      await restoreProduct({ ...recoveryOptions, generation: recoveryGeneration })
      store = new SoulStore(dbPath)
    }
    if (latest && !recoveryGeneration && store.meta("checkpoint_generation") !== latest.generation) {
      const parent = snapshots.find(snapshot => snapshot.generation === store!.meta("checkpoint_generation"))
      const clean = parent && store.revision === parent.revision
      if (!clean) throw new Error(`检测到宿主未同步分支。活动库保留在 ${dbPath}；U 盘检查点未覆盖。请通过恢复流程选择分支。`)
      store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      store.close(); store = undefined
      await restoreProduct({ ...recoveryOptions, generation: latest.generation })
      store = new SoulStore(dbPath)
    }
    if (latest && store.revision === latest.revision) store.setMeta("checkpoint_revision", String(latest.revision))
    store.recoverInterrupted()
    if (!values.project && !values.offline) mount = mountPortable(portable)
    const project = resolve(values.project ?? join(mount?.root ?? portable, "projects", "default"))
    mkdirSync(project, { recursive: true })
    const configPath = join(host, "engine-config.json")
    if (!existsSync(configPath)) writeFileSync(configPath, JSON.stringify({ "$schema": "https://opencode.ai/config.json" }, null, 2), { flag: "wx" })
    let adapter = new OpenCodeAdapter({ baseURL: "http://127.0.0.1:1", timeoutMs: 300 })
    if (!values.offline) {
      try { engine = await startEngine({ executable, hostDir: host, projectDir: project, configPath }); adapter = engine.adapter; store.setMeta("engine_version", engine.version) }
      catch (error) { console.error(`执行引擎不可用，记忆与资料管理仍可使用：${error instanceof Error ? error.message : "启动失败"}`) }
    }
    const token = crypto.randomUUID() + crypto.randomUUID()
    const close = async () => {
      if (stopping) return
      stopping = true
      if (maintenanceTimer) clearInterval(maintenanceTimer)
      await engine?.stop()
      await Promise.allSettled([...app?.jobs.values() ?? []])
      store?.close()
      mount?.release()
      unlock()
      if (existsSync(join(host, "running.json"))) writeFileSync(join(host, "running.json"), JSON.stringify({ stopped: true, at: Date.now() }))
    }
    app = startServer({ store, adapter, vaultDir: vault, token, port: values.port ? Number(values.port) : 0, configPath, onShutdown: close, stopExecution: async () => { await engine?.stop() },
      checkpointExtensions: async directory => {
        const version = engine?.version ?? store!.meta("engine_version")
        if (!version) return {}
        const saved = await backupEngine(host, directory, version)
        const hashes: Record<string, string> = {}
        for (const file of saved.files) hashes[`engine/${file.path}`] = file.sha256
        hashes["engine/complete.json"] = new Bun.CryptoHasher("sha256").update(await Bun.file(join(directory, "engine", "complete.json")).arrayBuffer()).digest("hex")
        return hashes
      },
      configureModel: async config => {
        const previous = readFileSync(configPath, "utf8")
        const next = { model: `xingyao/${config.model}`, provider: { xingyao: { npm: "@ai-sdk/openai-compatible", name: "我的模型", options: { baseURL: config.baseURL, apiKey: config.apiKey }, models: { [config.model]: { name: config.model, limit: { context: 128000, output: 8192 } } } } } }
        const temporary = join(host, `engine-config-${crypto.randomUUID()}.json`)
        writeFileSync(temporary, JSON.stringify(next, null, 2), { flag: "wx", mode: 0o600 })
        let candidate: Awaited<ReturnType<typeof startEngine>> | undefined
        try {
          await engine?.stop()
          candidate = await startEngine({ executable, hostDir: host, projectDir: project, configPath: temporary })
          renameSync(temporary, configPath)
          engine = candidate
          store!.setMeta("engine_version", engine.version)
          return engine.adapter
        } catch (error) {
          await candidate?.stop()
          writeFileSync(configPath, previous, { mode: 0o600 })
          engine = await startEngine({ executable, hostDir: host, projectDir: project, configPath }).catch(() => undefined)
          throw new ModelConfigurationError(error instanceof Error ? error.message : "模型配置未完成，已恢复原设置", engine?.adapter ?? new OpenCodeAdapter({ baseURL: "http://127.0.0.1:1", timeoutMs: 300 }))
        } finally { if (existsSync(temporary)) unlinkSync(temporary) }
      },
    })
    maintenanceTimer = setInterval(() => { void app!.maintenance().catch(() => { /* The workbench exposes the failed sync status. */ }) }, 60_000)
    const url = `http://127.0.0.1:${app.server.port}/#token=${encodeURIComponent(token)}`
    writeFileSync(join(host, "running.json"), JSON.stringify({ pid: process.pid, url, host, portable, identityId: store.identityId, driveId: drive.driveId, version: PRODUCT_VERSION, createdAt: Date.now() }), { mode: 0o600 })
    console.log(`星杳 · 璇玑 ${PRODUCT_VERSION} 已启动：127.0.0.1:${app.server.port}`)
    console.log(`运行目录：${host}`)
    if (!values["no-open"]) {
      if (process.platform === "win32") Bun.spawn(["rundll32.exe", "url.dll,FileProtocolHandler", url], { stdout: "ignore", stderr: "ignore" })
      else console.log("请从运行目录的 running.json 打开本机工作台。")
    }
    const shutdown = async () => {
      if (stopping) return
      await app!.shutdown(true).catch(error => console.error(`退出时未完成同步，宿主恢复数据已保留：${error instanceof Error ? error.message : "未知错误"}`))
      await app!.closed
    }
    process.on("SIGINT", () => void shutdown())
    process.on("SIGTERM", () => void shutdown())
    return { ...app, host, portable, stop: shutdown }
  } catch (error) {
    await engine?.stop(); store?.close(); mount?.release(); unlock(); throw error
  }
}

async function reopenExisting(host: string, driveId: string, noOpen: boolean): Promise<boolean> {
  try {
    const path = join(host, "running.json")
    if (!existsSync(path)) return false
    const running = JSON.parse(readFileSync(path, "utf8")) as { pid: number; url: string; driveId: string; identityId: string }
    if (!Number.isSafeInteger(running.pid) || running.pid < 1 || running.driveId !== driveId || !running.identityId) return false
    process.kill(running.pid, 0)
    const url = new URL(running.url)
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || !url.hash.startsWith("#token=")) return false
    const response = await fetch(`${url.origin}/api/state`, { headers: { authorization: `Bearer ${decodeURIComponent(url.hash.slice(7))}` }, signal: AbortSignal.timeout(1500), redirect: "error" })
    if (!response.ok || (await response.json() as { identityId?: string }).identityId !== running.identityId) return false
    if (!noOpen && process.platform === "win32") Bun.spawn(["rundll32.exe", "url.dll,FileProtocolHandler", running.url], { stdout: "ignore", stderr: "ignore", windowsHide: true })
    console.log("星杳已经在运行，已接续现有工作台。")
    return true
  } catch { return false }
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : "启动失败"); process.exitCode = 1 })
