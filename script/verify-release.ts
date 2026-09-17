import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { inspectRelease, type ReleaseValidationReport, type ReleaseTestEvidence } from "../src/releases"
import { PRODUCT_VERSION } from "../src/contracts"
import { sourceHash } from "./source-hash"
import { verifyUpgradeBaseline } from "./upgrade-baseline"

const root = resolve(import.meta.dir, "..")
const candidate = resolve(process.argv[2] ?? join(root, "dist", `xingyao-${PRODUCT_VERSION}`))
const inspected = await inspectRelease(candidate)
const buildMetadata = await Bun.file(join(candidate, "release.json")).json() as { sourceHash?: string; engineVersion?: string }
if (buildMetadata.sourceHash !== await sourceHash(root)) throw new Error("当前源码与候选编译来源不一致，请先重新构建")
if (buildMetadata.engineVersion !== "0.0.0-product-dev-20260918-engine.6-source") throw new Error("当前升级夹具尚未支持这个目标引擎版本")
const baseline = await verifyUpgradeBaseline(process.env.XINGYAO_UPGRADE_FROM_ENGINE ?? join(root, "dist/xingyao-0.1.0-dev.5/opencode.exe"))
const reports = join(root, "reports")
await mkdir(reports, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const executable = join(candidate, "opencode.exe")
const startedAt = Date.now()
const typecheck = Bun.spawn([process.execPath, "run", "typecheck"], { cwd: root, stdout: "pipe", stderr: "pipe" })
const types = await Promise.all([new Response(typecheck.stdout).text(), new Response(typecheck.stderr).text(), typecheck.exited])
await Bun.write(join(reports, `${stamp}-typecheck.txt`), types[0] + types[1])
if (types[2] !== 0) throw new Error("类型检查未通过")
const test = Bun.spawn([process.execPath, "test", "test"], { cwd: root, env: { ...process.env, XINGYAO_TEST_OPENCODE: executable,
  XINGYAO_UPGRADE_FROM_ENGINE: baseline.executable, XINGYAO_UPGRADE_TO_ENGINE: executable, XINGYAO_UPGRADE_TO_SHA256: inspected.manifest.files["opencode.exe"]! }, stdout: "pipe", stderr: "pipe" })
const results = await Promise.all([new Response(test.stdout).text(), new Response(test.stderr).text(), test.exited])
const output = results[0] + results[1]
const logPath = join(reports, `${stamp}-tests.txt`)
await Bun.write(logPath, output)
const clean = output.replace(/\x1b\[[0-9;]*m/g, "")
if (results[2] !== 0 || /[1-9]\d* (?:skip|todo|fail)\b/.test(clean)) throw new Error(`发行测试失败或有未执行项，详见 ${logPath}`)
for (const required of ["real engine and loopback model", "real shell outcomes", "HTTP evidence", "real engine upgrade", "real memory extraction engine", "startup decides the clean old host branch before migration", "product-integration", "compiled Windows product", "portable", "recovery"]) if (!clean.includes(required)) throw new Error(`缺少发行验收证据：${required}`)
// New workbench releases must exercise the actual compiled graph UI. The
// isolated browser fixture never reads or modifies the installed identity.
const browser = Bun.spawn([process.execPath, "run", "script/graph-browser-check.mjs", join(candidate, "xingyao.exe")], { cwd: root, stdout: "pipe", stderr: "pipe" })
const browserResult = await Promise.all([new Response(browser.stdout).text(), new Response(browser.stderr).text(), browser.exited])
await Bun.write(join(reports, `${stamp}-browser.txt`), browserResult[0] + browserResult[1])
if (browserResult[2] !== 0) throw new Error(`图谱浏览器验收失败，详见 ${join(reports, `${stamp}-browser.txt`)}`)
const browserReportPath = join(reports, `graph-browser-${PRODUCT_VERSION}.json`)
const browserReport = await Bun.file(browserReportPath).json() as { version?: string; executableSha256?: string; result?: string }
if (browserReport.result !== "passed" || browserReport.version !== inspected.manifest.version || browserReport.executableSha256 !== inspected.manifest.files["xingyao.exe"]) throw new Error("图谱浏览器报告未绑定当前编译制品")
const memoryBrowser = Bun.spawn([process.execPath, "run", "script/memory-review-browser-check.mjs", join(candidate, "xingyao.exe"), executable], { cwd: root, stdout: "pipe", stderr: "pipe" })
const memoryResult = await Promise.all([new Response(memoryBrowser.stdout).text(), new Response(memoryBrowser.stderr).text(), memoryBrowser.exited])
await Bun.write(join(reports, `${stamp}-memory-browser.txt`), memoryResult[0] + memoryResult[1])
if (memoryResult[2] !== 0) throw new Error(`对话记忆浏览器验收失败，详见 ${join(reports, `${stamp}-memory-browser.txt`)}`)
const memoryReportPath = join(reports, "memory-review-browser-check.json")
const memoryReport = await Bun.file(memoryReportPath).json() as { productVersion?: string; sha256?: string; result?: string }
if (memoryReport.result !== "passed" || memoryReport.productVersion !== inspected.manifest.version || memoryReport.sha256 !== inspected.manifest.files["xingyao.exe"]) throw new Error("对话记忆浏览器报告未绑定当前编译制品")
const rechecked = await inspectRelease(candidate)
if (rechecked.manifestHash !== inspected.manifestHash) throw new Error("验收过程中候选制品发生变化")
if (buildMetadata.sourceHash !== await sourceHash(root)) throw new Error("验收过程中产品源码发生变化")
await verifyUpgradeBaseline(baseline.executable)
const finishedAt = Date.now()
const evidence = (names: string[]): ReleaseTestEvidence => ({ passed: true, execution: "real", startedAt, finishedAt, evidence: [logPath, ...names] })
const report: ReleaseValidationReport = { manifestHash: inspected.manifestHash, outcome: "passed", tests: {
  backendContract: evidence(["test/adapter.test.ts", "test/engine.test.ts", "test/real-engine.test.ts", "test/memory-extraction-adapter.test.ts"]),
  restore: evidence(["test/checkpoint.test.ts", "test/engine-backup.test.ts", "test/engine-upgrade.test.ts", "test/recovery.test.ts", "test/startup-migration.test.ts", "test/compiled.test.ts"]),
  soulIntegration: evidence(["test/product-integration.test.ts", "test/tool-evidence-api.test.ts", "test/source-revisions.test.ts", "test/memory-review.test.ts", "test/memory-review-api.test.ts", "test/compiled.test.ts", browserReportPath, memoryReportPath, join(reports, `${stamp}-browser.txt`), join(reports, `${stamp}-memory-browser.txt`)]),
}, engineUpgrade: { ...evidence(["test/engine-upgrade.test.ts"]), fromVersion: baseline.version, fromSha256: baseline.sha256,
  toVersion: buildMetadata.engineVersion, toSha256: inspected.manifest.files["opencode.exe"]! } }
await Bun.write(join(candidate, "release-validation.json"), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ candidate, manifestHash: inspected.manifestHash, tests: clean.match(/\d+ pass\s+\d+ fail/)?.[0] ?? "passed", logPath, report: join(candidate, "release-validation.json") }, null, 2))
