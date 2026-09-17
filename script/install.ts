import { createHash, randomUUID } from "node:crypto"
import { closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path"
import { activateRelease, inspectRelease, stageRelease, type ReleaseValidationReport } from "../src/releases"

export type InstallOptions = { candidateDir: string; systemDir: string; compile?: (outfile: string) => Promise<void> }
const MARKER = "XINGYAO_MANAGED_STARTER_V1"
const psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`
function validateReport(report: ReleaseValidationReport, manifestHash: string) {
  if (!report || report.manifestHash !== manifestHash || report.outcome !== "passed") throw new Error("安装需要绑定候选清单哈希的通过报告")
  for (const name of ["backendContract", "restore", "soulIntegration"] as const) {
    const test = report.tests?.[name]
    if (!test || test.passed !== true || test.execution !== "real" || !test.evidence?.length || test.evidence.some(item => typeof item !== "string" || !item.trim()) || !Number.isSafeInteger(test.startedAt) || !Number.isSafeInteger(test.finishedAt) || test.startedAt < 0 || test.finishedAt < test.startedAt || test.finishedAt > Date.now() + 60_000) throw new Error(`缺少真实集成验收：${name}`)
  }
}
function managedDestination(path: string) {
  let stat
  try { stat = lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000 || !readFileSync(path, "utf8").includes(MARKER)) throw new Error(`现有启动入口不是本安装器管理的文件，已保留：${path}`)
}
function writeDurable(path: string, text: string, exclusive = false) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | (exclusive ? constants.O_EXCL : constants.O_TRUNC) | (constants.O_NOFOLLOW ?? 0), 0o600)
  try { writeFileSync(fd, text, "utf8"); fsyncSync(fd) } finally { closeSync(fd) }
}
function safeDirectories(path: string) {
  const full = resolve(path), root = parse(full).root
  let current = root
  for (const part of full.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    let stat
    try { stat = lstatSync(current) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; mkdirSync(current); stat = lstatSync(current) }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("安装路径含链接或非目录，停止写入")
  }
}
export function starterScripts(loaderRelativePath: string, startRelativeToParent: string) {
  const powershell = `# ${MARKER}
$ErrorActionPreference = 'Stop'
$systemRoot = Split-Path -Parent $PSScriptRoot
$portableRoot = Split-Path -Parent $systemRoot
$loader = Join-Path $PSScriptRoot ${psLiteral(loaderRelativePath)}
$localRoot = [Environment]::GetFolderPath('LocalApplicationData')
if ([string]::IsNullOrWhiteSpace($localRoot)) { throw 'Host LocalApplicationData is unavailable' }
$logRoot = Join-Path $localRoot 'Xuanji\\launcher\\logs'
[IO.Directory]::CreateDirectory($logRoot) | Out-Null
$runId = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N')
$stdout = Join-Path $logRoot ($runId + '.out.log')
$stderr = Join-Path $logRoot ($runId + '.error.log')
function Quote-Argument([string]$value) {
  if ($value.Contains('"')) { throw 'Invalid Windows path argument' }
  $extra = ''
  for ($i = $value.Length - 1; $i -ge 0 -and $value[$i] -eq [char]92; $i--) { $extra += [char]92 }
  return '"' + $value + $extra + '"'
}
$launchArguments = @('--system-root', (Quote-Argument $systemRoot), '--portable-root', (Quote-Argument $portableRoot))
try {
  Start-Process -FilePath $loader -ArgumentList $launchArguments -WorkingDirectory $portableRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
} catch {
  [IO.File]::WriteAllText($stderr, 'XINGYAO_BOOT_FAILED: the verified launcher could not be started.')
  exit 1
}
`
  const encoded = Buffer.from(`$script = Join-Path $env:XINGYAO_BOOT_ROOT ${psLiteral(startRelativeToParent)}; & $script; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`, "utf16le").toString("base64")
  const command = `@echo off\r\nrem ${MARKER}\r\nsetlocal\r\nset "XINGYAO_BOOT_ROOT=%~dp0"\r\npowershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}\r\nendlocal\r\n`
  return { powershell, command }
}

/** Installs an independently validated candidate; the caller explicitly decides when to run this. */
export async function install(options: InstallOptions) {
  if (!isAbsolute(options.candidateDir) || !isAbsolute(options.systemDir)) throw new Error("安装目录必须为明确的绝对路径")
  const candidate = await inspectRelease(options.candidateDir), systemDir = resolve(options.systemDir), portableRoot = dirname(systemDir)
  const reportPath = join(candidate.path, "release-validation.json")
  const reportStat = lstatSync(reportPath)
  if (!reportStat.isFile() || reportStat.isSymbolicLink() || reportStat.size > 128_000) throw new Error("安装验收报告不是有效的普通文件")
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseValidationReport
  validateReport(report, candidate.manifestHash)
  const launcherDirectory = join(systemDir, "launcher"), starterPath = join(launcherDirectory, "start.ps1"), commandPath = join(dirname(portableRoot), "启动星杳.cmd")
  safeDirectories(launcherDirectory)
  managedDestination(starterPath); managedDestination(commandPath)
  const staged = await stageRelease(candidate.path, systemDir)
  const projectRoot = resolve(import.meta.dir, "..")
  const sourceHash = createHash("sha256")
  for (const name of ["launcher-cli.ts", "launcher.ts", "releases.ts", "checkpoint.ts", "contracts.ts"]) sourceHash.update(readFileSync(join(projectRoot, "src", name)))
  const loaderBuild = `${sourceHash.digest("hex").slice(0, 16)}-${randomUUID()}`
  const buildDirectory = join(launcherDirectory, "builds", loaderBuild)
  safeDirectories(buildDirectory)
  const loaderPath = join(buildDirectory, "xuanji-launcher.exe")
  if (options.compile) await options.compile(loaderPath)
  else {
    const result = await Bun.build({ entrypoints: [join(projectRoot, "src", "launcher-cli.ts")], compile: { target: "bun-windows-x64", outfile: loaderPath }, minify: true, sourcemap: "none" })
    if (!result.success) throw new Error("独立启动器编译失败，当前发行未切换")
  }
  if (!lstatSync(loaderPath).isFile()) throw new Error("启动器编译未生成可执行文件")
  const loaderHash = new Bun.CryptoHasher("sha256").update(await Bun.file(loaderPath).arrayBuffer()).digest("hex")
  writeDurable(join(buildDirectory, "loader.json"), JSON.stringify({ product: "xingyao-launcher", sha256: loaderHash, filename: basename(loaderPath), builtAt: Date.now() }, null, 2), true)
  const scripts = starterScripts(relative(launcherDirectory, loaderPath), relative(dirname(portableRoot), starterPath))
  // Prepare both scripts before selection. Older loader builds remain usable and untouched.
  const preparedScript = join(buildDirectory, "start.ps1.prepared"), preparedCommand = join(buildDirectory, "start.cmd.prepared")
  writeDurable(preparedScript, scripts.powershell, true); writeDurable(preparedCommand, scripts.command, true)
  const selected = await activateRelease(systemDir, staged.id, report)
  for (const path of [starterPath, commandPath]) {
    managedDestination(path)
    if (existsSync(path)) copyFileSync(path, `${path}.previous-${loaderBuild}`)
  }
  writeDurable(starterPath, scripts.powershell); writeDurable(commandPath, scripts.command)
  return { selected, portableRoot, loaderPath, starterPath, commandPath }
}

if (import.meta.main) {
  const [candidateDir, systemDir, ...extra] = process.argv.slice(2)
  if (!candidateDir || !systemDir || extra.length) { console.error("Usage: bun run script/install.ts <absolute-candidate-directory> <absolute-system-directory>"); process.exitCode = 1 }
  else install({ candidateDir, systemDir }).then(result => console.log(`Installed verified release ${result.selected.releaseId}.`)).catch(() => { console.error("XINGYAO_INSTALL_BLOCKED: candidate validation or installation did not complete; preserved releases remain available."); process.exitCode = 1 })
}
