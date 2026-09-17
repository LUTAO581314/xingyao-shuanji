import { mkdir, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, parse, relative, resolve } from "node:path"
import { OpenCodeAdapter } from "./adapter"

export type EngineOptions = {
  executable: string
  hostDir: string
  projectDir: string
  /** An explicitly selected product JSON config under hostDir; never a legacy user config. */
  configPath?: string
  startupTimeoutMs?: number
  requestTimeoutMs?: number
}

export type Engine = {
  adapter: OpenCodeAdapter
  version: string
  pid: number
  /** Stops only this owned child. Callers must finish or abort sessions first. */
  stop(): Promise<void>
}

export class EngineStartError extends Error {
  constructor(readonly kind: "configuration" | "launch" | "timeout" | "exited" | "compatibility", message: string, readonly pid?: number) {
    super(message)
    this.name = "EngineStartError"
  }
}

/** Owns one authenticated loopback OpenCode process, with product-specific data roots.
 * No parent model credentials or proxy environment are inherited. Provider configuration
 * must be explicitly supplied through a new product config file. Existing OpenCode state
 * is neither read nor copied. No logs or child error bodies are emitted by this module.
 */
export async function startEngine(options: EngineOptions): Promise<Engine> {
  const startupTimeoutMs = duration(options.startupTimeoutMs ?? 25_000)
  const requestTimeoutMs = duration(options.requestTimeoutMs ?? 120_000)
  if (![options.executable, options.hostDir, options.projectDir].every(isAbsolute)) {
    throw new EngineStartError("configuration", "Engine paths must be absolute")
  }
  const executable = await realpath(options.executable).catch(() => undefined)
  const physicalProject = await realpath(options.projectDir).catch(() => undefined)
  if (!executable || !(await stat(executable)).isFile()) throw new EngineStartError("configuration", "OpenCode executable is unavailable")
  if (!physicalProject || !(await stat(physicalProject)).isDirectory()) throw new EngineStartError("configuration", "Project directory is unavailable")
  // Preserve an explicitly chosen stable mount/drive path in the engine's session identity.
  // Resolving it to its physical host path here would defeat portable session recovery.
  const project = resolve(options.projectDir)
  await mkdir(options.hostDir, { recursive: true, mode: 0o700 })
  const host = await realpath(options.hostDir)
  const config = await productConfig(host, options.configPath)
  const root = join(host, "opencode")
  const directories = ["data", "cache", "state", "config", "tmp", "home", "appdata", "localappdata"]
  await Promise.all(directories.map((name) => mkdir(join(root, name), { recursive: true, mode: 0o700 })))
  const password = crypto.randomUUID() + crypto.randomUUID()
  const env = isolatedEnvironment(root)
  // The patched engine retains this alias only after realpath canonicalization;
  // symlinks that leave the mapped drive still resolve to their outside target.
  const driveRoot = parse(project).root
  if (process.platform === "win32" && /^[D-Z]:\\$/i.test(driveRoot) && (await realpath(driveRoot)).toLowerCase() !== driveRoot.toLowerCase()) {
    env.OPENCODE_PORTABLE_ROOT = driveRoot
  }
  Object.assign(env, {
    XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"),
    OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_TEST_HOME: join(root, "home"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_PURE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
  })
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn([executable, "serve", "--hostname", "127.0.0.1", "--port", "0", "--mdns=false", "--pure"], {
      cwd: project, env, stdin: "ignore", stdout: "pipe", stderr: "ignore",
    })
  } catch {
    throw new EngineStartError("launch", "OpenCode could not be launched")
  }
  const owned = child
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => stopping ??= stopOwned(owned)
  const ready = Promise.withResolvers<string>()
  const reading = consumeListeningAddress(owned.stdout as ReadableStream<Uint8Array>, ready.resolve)
  // Drain continuously to prevent blocked child stdout, but never publish its contents.
  void reading.catch(() => ready.reject(new EngineStartError("exited", "OpenCode startup output closed", owned.pid)))
  void owned.exited.then(() => ready.reject(new EngineStartError("exited", "OpenCode exited before readiness", owned.pid)))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const startup = async (): Promise<Engine> => {
      const baseURL = await ready.promise
      const probe = new OpenCodeAdapter({ baseURL, directory: project, password, timeoutMs: Math.min(startupTimeoutMs, 3000) })
      const health = await probe.health()
      if (!health.ok || !health.version) {
        throw new EngineStartError("compatibility", `OpenCode capability handshake failed: ${health.reason ?? "required capability unavailable"}`, owned.pid)
      }
      if (owned.exitCode !== null) throw new EngineStartError("exited", "OpenCode exited during readiness", owned.pid)
      return { adapter: new OpenCodeAdapter({ baseURL, directory: project, password, timeoutMs: requestTimeoutMs }), version: health.version, pid: owned.pid, stop }
    }
    return await Promise.race([
      startup(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new EngineStartError("timeout", "OpenCode startup timed out", owned.pid)), startupTimeoutMs) }),
    ])
  } catch (error) {
    await stop()
    if (error instanceof EngineStartError) throw error
    throw new EngineStartError("launch", "OpenCode startup failed", owned.pid)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function stopOwned(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (child.exitCode !== null) return
  child.kill("SIGTERM")
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([child.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 3000) })])
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited }
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

async function consumeListeningAddress(stream: ReadableStream<Uint8Array>, ready: (url: string) => void): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) return
      buffer = (buffer + decoder.decode(item.value, { stream: true })).slice(-16_384)
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        const match = /^opencode server listening on (http:\/\/127\.0\.0\.1:(\d+))\s*$/.exec(line)
        if (match && Number(match[2]) > 0 && Number(match[2]) <= 65535) ready(match[1]!)
      }
    }
  } finally { reader.releaseLock() }
}

async function productConfig(host: string, configPath?: string): Promise<Record<string, unknown>> {
  const config: Record<string, unknown> = {}
  if (configPath !== undefined) {
    const file = await realpath(configPath).catch(() => undefined)
    if (!file || !within(host, file) || !file.toLowerCase().endsWith(".json")) {
      throw new EngineStartError("configuration", "Product config must be a JSON file within hostDir")
    }
    const blob = Bun.file(file)
    if (blob.size > 2 * 1024 * 1024) throw new EngineStartError("configuration", "Product config exceeds 2 MiB")
    let value: unknown
    try { value = await blob.json() }
    catch { throw new EngineStartError("configuration", "Product config is not valid JSON") }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new EngineStartError("configuration", "Product config must be an object")
    const supported = new Set(["$schema", "model", "small_model", "provider", "enabled_providers", "disabled_providers"])
    for (const [key, item] of Object.entries(value)) {
      if (!supported.has(key)) throw new EngineStartError("configuration", "Product config contains unsupported settings; only model/provider configuration is accepted")
      config[key] = item
    }
    // Do not let a new portable config indirectly import the old profile or its secrets.
    if (/\{(?:file|env):/.test(JSON.stringify(config))) throw new EngineStartError("configuration", "External file and environment substitutions are not supported in product config")
  }
  return { ...config, plugin: [], soul: { enabled: false }, permission: "ask", autoupdate: false, share: "disabled" }
}

function isolatedEnvironment(root: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE", "LANG", "LC_ALL", "TZ"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]!
  }
  return { ...env, TEMP: join(root, "tmp"), TMP: join(root, "tmp"), TMPDIR: join(root, "tmp"), APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata") }
}
function within(root: string, file: string): boolean { const rel = relative(resolve(root), resolve(file)); return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel) }
function duration(ms: number): number { if (!Number.isFinite(ms) || ms <= 0 || ms > 2_147_483_647) throw new EngineStartError("configuration", "Engine timeout must be a positive finite timer duration"); return ms }
