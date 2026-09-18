import { lstat, mkdir, readFile, realpath, copyFile, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"

const product = resolve(import.meta.dir, "..")
const [requested, ...extra] = process.argv.slice(2)
if (!requested || !isAbsolute(requested) || extra.length) throw new Error("Usage: bun run script/build-engine.ts <prepared-absolute-engine-source>")
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("The engine candidate must be built on Windows x64")
const checkout = resolve(requested)
const source = await Bun.file(join(product, "patches/opencode/manifest.json")).json()
const recipe = source.candidateBuild
if (recipe.bun !== Bun.version || recipe.channel !== "product-dev" || !/^\d+\.\d+\.\d+$/.test(recipe.version)) throw new Error("Unexpected engine build recipe or Bun version")
const snapshotPath = join(product, "build-inputs/models.dev.json")
const snapshot = await Bun.file(join(product, "build-inputs/models.dev.manifest.json")).json()
const sha = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
const snapshotBytes = await readFile(snapshotPath)
if (snapshot.format !== 1 || snapshot.bytes !== snapshotBytes.length || snapshot.sha256 !== sha(snapshotBytes)) throw new Error("Pinned model catalog does not match its manifest")
JSON.parse(snapshotBytes.toString("utf8"))
const reports = join(product, "reports")
await mkdir(reports, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const inputDirectory = join(reports, `${stamp}-engine-inputs`)
await mkdir(inputDirectory)
const frozenSnapshot = join(inputDirectory, "models.dev.json")
await writeFile(frozenSnapshot, snapshotBytes, { flag: "wx" })
await writeFile(join(inputDirectory, "empty.npmrc"), "", { flag: "wx" })
const allowedEnvironment = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "SYSTEMDRIVE", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PYTHON", "HOMEDRIVE", "HOMEPATH"])
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnvironment.has(key.toUpperCase()))),
  OPENCODE_CHANNEL: recipe.channel, OPENCODE_VERSION: recipe.version, OPENCODE_RELEASE: "",
  MODELS_DEV_API_JSON: frozenSnapshot, HUSKY: "0", CI: "true",
  NPM_CONFIG_USERCONFIG: join(inputDirectory, "empty.npmrc"),
}
async function toolVersion(args: string[]) {
  const child = Bun.spawn(args, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`Required build tool unavailable: ${args[0]}`)
  return (stdout + stderr).trim()
}
const vswhere = join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Microsoft Visual Studio/Installer/vswhere.exe")
const visualStudio = JSON.parse(await toolVersion([vswhere, "-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-format", "json"]))[0]
if (!visualStudio?.installationPath) throw new Error("Visual Studio C++ build tools are required")
const toolchain = {
  bun: Bun.version,
  node: await toolVersion(["node", "--version"]),
  python: await toolVersion([process.env.PYTHON ?? "python", "--version"]),
  visualStudio: visualStudio.installationVersion,
  msvc: (await readFile(join(visualStudio.installationPath, "VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt"), "utf8")).trim(),
}
async function run(args: string[], cwd: string, label: string) {
  console.log(label)
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const log = join(reports, `${stamp}-engine-${label}.txt`)
  await writeFile(log, stdout + stderr)
  if (code !== 0) throw new Error(`${label} failed (${code}); see ${log}`)
  return { log, stdout }
}
await run([process.execPath, "run", join(product, "script/engine-source.ts"), "verify", checkout], product, "source-before")
// Bun may consider a previously interrupted install complete. Start with a
// pristine dependency tree; failures keep the checkout and logs for diagnosis.
try { await lstat(join(checkout, "node_modules")); throw new Error("Dependencies already exist; prepare a new isolated source directory") }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
const engineRoot = join(checkout, "packages/opencode")
const upstreamPackage = JSON.parse(await readFile(join(engineRoot, "package.json"), "utf8")) as { version?: unknown }
if (upstreamPackage.version !== recipe.version) throw new Error("Engine version must match the pinned upstream source version")
const dist = join(engineRoot, "dist")
// The upstream builder recreates dist. Require a fresh prepared checkout so it
// cannot erase an earlier candidate or anything in the original working tree.
try { await lstat(dist); throw new Error("Engine dist already exists; prepare a new isolated source directory") }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
if ((await realpath(engineRoot)).toLowerCase() !== engineRoot.toLowerCase()) throw new Error("Engine build directory is redirected")
const installed = await run([process.execPath, "install", "--frozen-lockfile"], checkout, "dependencies")
await run([process.execPath, "run", join(product, "script/engine-source.ts"), "verify", checkout], product, "source-after-install")
const coreTypes = await run([process.execPath, "run", "typecheck"], join(checkout, "packages/core"), "core-types")
const engineTypes = await run([process.execPath, "run", "typecheck"], engineRoot, "engine-types")
const coreTests = await run([process.execPath, "test", "test/filesystem-search-import.test.ts", "test/portable-path.test.ts", "test/project.test.ts"], join(checkout, "packages/core"), "core-tests")
const built = await run([process.execPath, "run", "script/build.ts", "--single", "--skip-install", "--skip-embed-web-ui"], engineRoot, "build")
if (sha(await readFile(frozenSnapshot)) !== snapshot.sha256) throw new Error("Build input model catalog changed during compilation")
await run([process.execPath, "run", join(product, "script/engine-source.ts"), "verify", checkout], product, "source-after-build")
const executable = join(dist, "opencode-windows-x64/bin/opencode.exe")
const version = await run([executable, "--version"], engineRoot, "version")
if (version.stdout.trim() !== recipe.version) throw new Error("Compiled engine version did not match the build recipe")
const output = join(product, "dist/engines", recipe.version)
await mkdir(join(product, "dist/engines"), { recursive: true })
await mkdir(output)
await copyFile(executable, join(output, "opencode.exe"))
await copyFile(join(checkout, "LICENSE"), join(output, "OPENCODE-LICENSE.txt"))
await writeFile(join(output, "models.dev.json"), snapshotBytes, { flag: "wx" })
if (sha(await readFile(join(output, "models.dev.json"))) !== snapshot.sha256) throw new Error("Archived model catalog does not match build input")
const record = {
  format: 1, version: recipe.version, channel: recipe.channel, platform: "windows-x64", bun: Bun.version, toolchain,
  upstreamCommit: source.upstream.commit, sourceTree: source.patchedTree,
  sourceManifestSha256: sha(await readFile(join(product, "patches/opencode/manifest.json"))),
  lockfileSha256: sha(await readFile(join(checkout, "bun.lock"))),
  modelCatalog: snapshot,
  executableSha256: sha(await readFile(join(output, "opencode.exe"))),
  licenseSha256: sha(await readFile(join(output, "OPENCODE-LICENSE.txt"))),
  createdAt: new Date().toISOString(), sourceCheckout: checkout,
  logs: [installed.log, coreTypes.log, engineTypes.log, coreTests.log, built.log],
  validation: "source-build-only; product execution and migration gates are still required",
  byteIdenticalRebuildClaimed: false,
}
await writeFile(join(output, "engine-build.json"), JSON.stringify(record, null, 2) + "\n")
console.log(JSON.stringify({ output, version: record.version, executableSha256: record.executableSha256, sourceTree: record.sourceTree }, null, 2))
