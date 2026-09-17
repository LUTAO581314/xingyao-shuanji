import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { launch, launcherMain, type LauncherSpawnOptions } from "../src/launcher"
import { activateRelease, inspectRelease, resolveCurrent, rollbackRelease, stageRelease, type ReleaseInfo, type ReleaseValidationReport } from "../src/releases"
import { createCheckpoint, restoreCheckpoint } from "../src/checkpoint"
import { SoulStore } from "../src/store"
import { install, starterScripts } from "../script/install"
import { PRODUCT_VERSION } from "../src/contracts"

const roots: string[] = [], dbs: Database[] = []
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const builtRelease = resolve(import.meta.dir, `../dist/xingyao-${PRODUCT_VERSION}`)
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xingyao-launcher-test-")); roots.push(root)
  const portableRoot = join(root, "便携 spaces & user's data"), systemDir = join(portableRoot, "system")
  mkdirSync(systemDir, { recursive: true })
  return { root, portableRoot, systemDir }
}
function candidate(root: string, version = "0.1.0") {
  const directory = join(root, `candidate-${randomUUID()}`); mkdirSync(directory)
  const files = { "xingyao.exe": `fixture product ${version}`, "opencode.exe": `fixture engine ${version}` }
  for (const [file, body] of Object.entries(files)) writeFileSync(join(directory, file), body)
  writeFileSync(join(directory, "release.json"), JSON.stringify({ product: "xingyao-xuanji", version, protocolVersion: 1, schemaVersion: 1, platform: "windows-x64", adapter: "legacy-http-v1", files: Object.fromEntries(Object.entries(files).map(([file, body]) => [file, hash(body)])), validation: "test-fixture", knownLimitations: ["Fake artifacts; launcher gate fixture only"] }))
  return directory
}
function report(release: ReleaseInfo): ReleaseValidationReport {
  const test = { passed: true, execution: "real" as const, evidence: ["fixture://contract-only; fake artifact is not a real release"], startedAt: Date.now() - 10, finishedAt: Date.now() }
  return { manifestHash: release.manifestHash, outcome: "passed", tests: { backendContract: test, restore: test, soulIntegration: test } }
}
async function selected(root: string, systemDir: string, version = "0.1.0") {
  const staged = await stageRelease(candidate(root, version), systemDir)
  await activateRelease(systemDir, staged.id, report(staged))
  return staged
}
function recorder() {
  const calls: { args: string[]; options: LauncherSpawnOptions }[] = []
  return { calls, spawn(args: string[], options: LauncherSpawnOptions) { calls.push({ args, options }); return { pid: 12345, exited: Promise.resolve(0) } } }
}
async function rollbackFixture(root: string, portableRoot: string, systemDir: string) {
  const old = await selected(root, systemDir)
  await selected(root, systemDir, "0.2.0")
  const store = new SoulStore(join(root, "original host", "soul.db")); dbs.push(store.db)
  const vaultDir = join(portableRoot, "vault")
  const checkpoint = await createCheckpoint(store.db, vaultDir, store.identityId, store.revision, null)
  const restoredHostDb = join(root, "restored host 中文", "soul.db")
  await restoreCheckpoint(vaultDir, checkpoint.generation, restoredHostDb)
  await rollbackRelease(systemDir, old.id, report(old), { vaultDir, generation: checkpoint.generation, identityId: checkpoint.identityId, expectedRevision: checkpoint.revision, restoredHostDb })
  return { checkpoint, restoredHostDb, store }
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe("verified executable launcher", () => {
  test("forwards exact Unicode and space-containing arguments without a shell or output capture", async () => {
    const { root, portableRoot, systemDir } = fixture(), release = await selected(root, systemDir)
    const recorded = recorder(), hostRoot = join(root, "host path 中文")
    const result = await launch({ systemDir, portableRoot, hostRoot, noOpen: true, spawn: recorded.spawn })
    expect(recorded.calls[0]!.args).toEqual([join(release.path, "xingyao.exe"), "--portable-root", portableRoot, "--engine", join(release.path, "opencode.exe"), "--host-root", hostRoot, "--no-open"])
    expect(recorded.calls[0]!.options).toEqual({ cwd: portableRoot, stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true })
    expect(result.selection.releaseId).toBe(release.id)
  })
  test("unselected and hash-corrupt releases never start a process", async () => {
    const { root, portableRoot, systemDir } = fixture(), recorded = recorder()
    await expect(launch({ systemDir, portableRoot, spawn: recorded.spawn })).rejects.toThrow("没有")
    const release = await selected(root, systemDir)
    writeFileSync(join(release.path, "xingyao.exe"), "tampered")
    await expect(launch({ systemDir, portableRoot, spawn: recorded.spawn })).rejects.toThrow("SHA-256")
    expect(recorded.calls).toHaveLength(0)
  })
  test("requires explicit roots and rejects a mismatched portable context", async () => {
    const { root, systemDir } = fixture(), recorded = recorder()
    await expect(launch({ systemDir, portableRoot: root, spawn: recorded.spawn })).rejects.toThrow("直接位于")
    await expect(launch({ systemDir: ".", portableRoot: root, spawn: recorded.spawn })).rejects.toThrow("绝对")
    await expect(launcherMain([])).rejects.toThrow("缺少")
    expect(recorded.calls).toHaveLength(0)
  })
  test("a real harmless child receives the selected argument array intact", async () => {
    const { root, portableRoot, systemDir } = fixture(); await selected(root, systemDir)
    const output = join(root, "received-arguments.json")
    const result = await launch({ systemDir, portableRoot, noOpen: true, spawn(args, settings) {
      return Bun.spawn([process.execPath, "-e", "await Bun.write(process.env.XINGYAO_ARGUMENT_RECORD,JSON.stringify(process.argv.slice(1)))", ...args], { ...settings, env: { ...process.env, XINGYAO_ARGUMENT_RECORD: output } })
    } })
    expect(await result.child.exited).toBe(0)
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(result.args)
  })
  test("rollback launches the verified host copy with an explicit generation guard", async () => {
    const { root, portableRoot, systemDir } = fixture()
    const { checkpoint, restoredHostDb } = await rollbackFixture(root, portableRoot, systemDir)
    const recorded = recorder()
    const result = await launch({ systemDir, portableRoot, spawn: recorded.spawn })
    expect(result.hostRoot).toBe(dirname(restoredHostDb))
    expect(result.args).toContain("--recovery-generation")
    expect(result.args).toContain(checkpoint.generation)
    await expect(launch({ systemDir, portableRoot, hostRoot: join(root, "wrong host"), spawn: recorded.spawn })).rejects.toThrow("不符")
    expect(recorded.calls).toHaveLength(1)
  })
  test("a mismatched actual recovery database stops launch", async () => {
    const { root, portableRoot, systemDir } = fixture()
    const { restoredHostDb } = await rollbackFixture(root, portableRoot, systemDir)
    const db = new Database(restoredHostDb); db.query("UPDATE meta SET value='wrong-identity' WHERE key='identity_id'").run(); db.close()
    const recorded = recorder()
    await expect(launch({ systemDir, portableRoot, spawn: recorded.spawn })).rejects.toThrow("不符")
    expect(recorded.calls).toHaveLength(0)
  })
  test("subsequent committed work on the verified branch remains launchable", async () => {
    const { root, portableRoot, systemDir } = fixture()
    const { restoredHostDb } = await rollbackFixture(root, portableRoot, systemDir)
    const db = new Database(restoredHostDb); db.query("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run(); db.close()
    const recorded = recorder()
    expect((await launch({ systemDir, portableRoot, spawn: recorded.spawn })).child.pid).toBe(12345)
  })
  test.skipIf(process.platform !== "win32")("compiled loader executes its dedicated entrypoint and fails safely without required arguments", async () => {
    const { root } = fixture(), outfile = join(root, "compiled-loader.exe")
    const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../src/launcher-cli.ts")], compile: { target: "bun-windows-x64", outfile }, minify: true, sourcemap: "none" })
    expect(build.success).toBe(true)
    const child = Bun.spawn([outfile], { stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 30_000 })
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(exit).toBe(1)
    expect(stdout).toBe("")
    expect(stderr).toContain("XINGYAO_START_BLOCKED")
    expect(stderr).not.toContain("#token=")
  }, 60_000)
  test.skipIf(process.platform !== "win32")("compiled loader propagates a real child failure without exposing child output", async () => {
    const { root, portableRoot, systemDir } = fixture(), source = candidate(root)
    const fixtureSource = join(root, "failing-product.ts")
    writeFileSync(fixtureSource, 'console.log("PRIVATE_CHILD_STDOUT"); console.error("PRIVATE_CHILD_STDERR"); process.exitCode = 7;\n')
    const product = await Bun.build({ entrypoints: [fixtureSource], compile: { target: "bun-windows-x64", outfile: join(source, "xingyao.exe") }, minify: true, sourcemap: "none" })
    expect(product.success).toBe(true)
    const manifest = JSON.parse(readFileSync(join(source, "release.json"), "utf8"))
    manifest.files["xingyao.exe"] = hash(readFileSync(join(source, "xingyao.exe")))
    writeFileSync(join(source, "release.json"), JSON.stringify(manifest))
    const staged = await stageRelease(source, systemDir)
    await activateRelease(systemDir, staged.id, report(staged))
    const outfile = join(root, "failure-loader.exe")
    const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../src/launcher-cli.ts")], compile: { target: "bun-windows-x64", outfile }, minify: true, sourcemap: "none" })
    expect(build.success).toBe(true)
    const child = Bun.spawn([outfile, "--system-root", systemDir, "--portable-root", portableRoot, "--no-open"], { cwd: portableRoot, stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 30_000 })
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(exit).toBe(7)
    expect(stdout).toBe("")
    expect(stderr).toContain("XINGYAO_PRODUCT_EXITED")
    expect(stderr).toContain("code 7")
    expect(stderr).not.toContain("PRIVATE_CHILD")
  }, 60_000)
  test.skipIf(process.platform !== "win32" || !existsSync(join(builtRelease, "xingyao.exe")) || !existsSync(join(builtRelease, "opencode.exe")))("compiled loader keeps the real product and engine alive, supports reopening, and exits after API shutdown", async () => {
    // Run the actual built product through the installed loader hierarchy, with
    // Unicode and shell-sensitive path characters as well as real engine startup.
    const { root, portableRoot, systemDir } = fixture(), hostRoot = join(root, "isolated host")
    const staged = await stageRelease(builtRelease, systemDir)
    await activateRelease(systemDir, staged.id, report(staged))
    const outfile = join(systemDir, "launcher", "builds", randomUUID(), "xuanji-launcher.exe")
    mkdirSync(dirname(outfile), { recursive: true })
    const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../src/launcher-cli.ts")], compile: { target: "bun-windows-x64", outfile }, minify: true, sourcemap: "none" })
    expect(build.success).toBe(true)
    const args = [outfile, "--system-root", systemDir, "--portable-root", portableRoot, "--host-root", hostRoot, "--no-open"]
    const child = Bun.spawn(args, { cwd: portableRoot, stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 60_000 })
    let running: { url: string; pid: number } | undefined
    let reopened: ReturnType<typeof Bun.spawn> | undefined
    let api: ((path: string, post?: boolean) => Promise<Response>) | undefined
    try {
      const deadline = Date.now() + 35_000
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Compiled launcher exited before product readiness: ${child.exitCode}`)
        if (existsSync(join(hostRoot, "running.json"))) running = JSON.parse(readFileSync(join(hostRoot, "running.json"), "utf8"))
        if (running?.url) break
        await Bun.sleep(40)
      }
      if (!running?.url) throw new Error("Compiled launcher did not bring the product to readiness")
      const url = new URL(running.url)
      api = (path, post = false) => fetch(`${url.origin}${path}`, { method: post ? "POST" : "GET", headers: { authorization: `Bearer ${decodeURIComponent(url.hash.slice(7))}`, "content-type": "application/json" }, body: post ? "{}" : undefined, signal: AbortSignal.timeout(10_000), redirect: "error" })
      expect(child.exitCode).toBeNull()
      expect(running.pid).not.toBe(child.pid)
      expect(existsSync(join(portableRoot, "drive.json"))).toBe(true)
      const state = await (await api("/api/state")).json() as { version: string; identityId: string }
      expect(state.version).toBe(PRODUCT_VERSION)
      expect(state.identityId.length).toBeGreaterThan(0)
      const engine = await (await api("/api/engine")).json() as { ok: boolean; version: string }
      expect(engine.ok).toBe(true)
      expect(engine.version.length).toBeGreaterThan(0)
      process.kill(running.pid, 0)
      reopened = Bun.spawn(args, { cwd: portableRoot, stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 20_000 })
      expect(await reopened.exited).toBe(0)
      expect(child.exitCode).toBeNull()
      expect((await (await api("/api/state")).json() as { identityId: string }).identityId).toBe(state.identityId)
      expect((await api("/api/shutdown", true)).status).toBe(200)
      expect(await child.exited).toBe(0)
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(stdout).toBe("")
      expect(stderr).toBe("")
      expect(JSON.parse(readFileSync(join(hostRoot, "running.json"), "utf8")).stopped).toBe(true)
    } finally {
      if (reopened?.exitCode === null) { reopened.kill(); await reopened.exited }
      if (child.exitCode === null) {
        await api?.("/api/shutdown", true).catch(() => undefined)
        child.kill()
        await child.exited
      }
    }
  }, 90_000)
})

describe("parallel product installer", () => {
  test("stages and gates a new release, preserves existing files and writes portable ASCII startup commands", async () => {
    const { root, portableRoot, systemDir } = fixture(), source = candidate(root)
    const inspected = await inspectRelease(source)
    writeFileSync(join(source, "release-validation.json"), JSON.stringify(report(inspected)))
    const legacy = join(root, "opencode.cmd"); writeFileSync(legacy, "legacy untouched")
    const installed = await install({ candidateDir: source, systemDir, compile: async path => { writeFileSync(path, "fake compiled loader fixture") } })
    expect(installed.portableRoot).toBe(portableRoot)
    expect((await resolveCurrent(systemDir))?.releaseId).toBe(installed.selected.releaseId)
    expect(readFileSync(legacy, "utf8")).toBe("legacy untouched")
    const cmd = readFileSync(installed.commandPath, "utf8")
    expect(/^[\x00-\x7f]*$/.test(cmd)).toBe(true)
    expect(cmd).toContain("%~dp0")
    const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(cmd)![1]!
    const decoded = Buffer.from(encoded, "base64").toString("utf16le")
    expect(decoded).toContain("$env:XINGYAO_BOOT_ROOT")
    expect(decoded).toContain("user''s data")
    const script = readFileSync(installed.starterPath, "utf8")
    expect(script).toContain("-WindowStyle Hidden")
    expect(script).toContain("LocalApplicationData")
    expect(script).not.toContain("#token=")
  })
  test("failed reports, compiler failures and foreign startup files do not activate a candidate", async () => {
    const { root, portableRoot, systemDir } = fixture(), source = candidate(root)
    const inspected = await inspectRelease(source), invalid = report(inspected)
    invalid.tests.soulIntegration.execution = "mock"
    writeFileSync(join(source, "release-validation.json"), JSON.stringify(invalid))
    let compiled = false
    await expect(install({ candidateDir: source, systemDir, compile: async () => { compiled = true } })).rejects.toThrow("真实")
    expect(compiled).toBe(false)
    writeFileSync(join(source, "release-validation.json"), JSON.stringify(report(inspected)))
    await expect(install({ candidateDir: source, systemDir, compile: async () => { throw new Error("fixture compiler failure") } })).rejects.toThrow("compiler")
    expect(await resolveCurrent(systemDir)).toBeNull()
    writeFileSync(join(dirname(portableRoot), "启动星杳.cmd"), "user-owned unrelated starter")
    await expect(install({ candidateDir: source, systemDir, compile: async () => { compiled = true } })).rejects.toThrow("不是本安装器")
    expect(readFileSync(join(dirname(portableRoot), "启动星杳.cmd"), "utf8")).toBe("user-owned unrelated starter")
    expect(await resolveCurrent(systemDir)).toBeNull()
  })
  test("an update creates a different loader and preserves the original loader bytes", async () => {
    const { root, systemDir } = fixture()
    async function installFixture(version: string) {
      const source = candidate(root, version), inspected = await inspectRelease(source)
      writeFileSync(join(source, "release-validation.json"), JSON.stringify(report(inspected)))
      return install({ candidateDir: source, systemDir, compile: async path => { writeFileSync(path, `loader fixture ${version}`) } })
    }
    const first = await installFixture("0.1.0"), second = await installFixture("0.2.0")
    expect(first.loaderPath).not.toBe(second.loaderPath)
    expect(readFileSync(first.loaderPath, "utf8")).toBe("loader fixture 0.1.0")
    expect(existsSync(second.loaderPath)).toBe(true)
  })
  test.skipIf(process.platform !== "win32")("generated PowerShell parses with apostrophes, Chinese and spaces", async () => {
    const { root } = fixture()
    const scripts = starterScripts("builds\\sample id\\xuanji-launcher.exe", "便携 user's data\\system\\launcher\\start.ps1")
    const scriptPath = join(root, "generated.ps1"); writeFileSync(scriptPath, scripts.powershell)
    const code = "$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile($env:XINGYAO_SCRIPT_TEST,[ref]$tokens,[ref]$errors) | Out-Null;if($errors.Count){exit 1}"
    const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", code], { env: { ...process.env, XINGYAO_SCRIPT_TEST: scriptPath }, stdout: "ignore", stderr: "ignore", windowsHide: true, timeout: 10_000 })
    expect(await child.exited).toBe(0)
    expect(resolve(root)).toBe(root)
  })
  test.skipIf(process.platform !== "win32")("PowerShell argument quoting doubles trailing Windows separators", async () => {
    const scripts = starterScripts("builds\\test\\xuanji-launcher.exe", "便携\\system\\launcher\\start.ps1")
    const quoteFunction = /function Quote-Argument[\s\S]+?\n}/.exec(scripts.powershell)![0]
    const input = "C:\\path with spaces\\"
    const command = `${quoteFunction}\nQuote-Argument $env:XINGYAO_QUOTE_TEST | ConvertTo-Json -Compress`
    const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command], { env: { ...process.env, XINGYAO_QUOTE_TEST: input }, stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 10_000 })
    const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
    expect(exit).toBe(0)
    expect(JSON.parse(output)).toBe(`"${input}\\"`)
  })
})
