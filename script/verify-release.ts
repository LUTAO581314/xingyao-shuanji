import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { inspectRelease, type ReleaseValidationReport, type ReleaseTestEvidence } from "../src/releases"
import { PRODUCT_VERSION } from "../src/contracts"
import { sourceHash } from "./source-hash"

const root = resolve(import.meta.dir, "..")
const candidate = resolve(process.argv[2] ?? join(root, "dist", `xingyao-${PRODUCT_VERSION}`))
const inspected = await inspectRelease(candidate)
const buildMetadata = await Bun.file(join(candidate, "release.json")).json() as { sourceHash?: string }
if (buildMetadata.sourceHash !== await sourceHash(root)) throw new Error("当前源码与候选编译来源不一致，请先重新构建")
const reports = join(root, "reports")
await mkdir(reports, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const executable = join(candidate, "opencode.exe")
const startedAt = Date.now()
const typecheck = Bun.spawn([process.execPath, "run", "typecheck"], { cwd: root, stdout: "pipe", stderr: "pipe" })
const types = await Promise.all([new Response(typecheck.stdout).text(), new Response(typecheck.stderr).text(), typecheck.exited])
await Bun.write(join(reports, `${stamp}-typecheck.txt`), types[0] + types[1])
if (types[2] !== 0) throw new Error("类型检查未通过")
const test = Bun.spawn([process.execPath, "test", "test"], { cwd: root, env: { ...process.env, XINGYAO_TEST_OPENCODE: executable }, stdout: "pipe", stderr: "pipe" })
const results = await Promise.all([new Response(test.stdout).text(), new Response(test.stderr).text(), test.exited])
const output = results[0] + results[1]
const logPath = join(reports, `${stamp}-tests.txt`)
await Bun.write(logPath, output)
const clean = output.replace(/\x1b\[[0-9;]*m/g, "")
if (results[2] !== 0 || /[1-9]\d* (?:skip|todo|fail)\b/.test(clean)) throw new Error(`发行测试失败或有未执行项，详见 ${logPath}`)
for (const required of ["real engine and loopback model", "product-integration", "compiled Windows product", "portable", "recovery"]) if (!clean.includes(required)) throw new Error(`缺少发行验收证据：${required}`)
const rechecked = await inspectRelease(candidate)
if (rechecked.manifestHash !== inspected.manifestHash) throw new Error("验收过程中候选制品发生变化")
if (buildMetadata.sourceHash !== await sourceHash(root)) throw new Error("验收过程中产品源码发生变化")
const finishedAt = Date.now()
const evidence = (names: string[]): ReleaseTestEvidence => ({ passed: true, execution: "real", startedAt, finishedAt, evidence: [logPath, ...names] })
const report: ReleaseValidationReport = { manifestHash: inspected.manifestHash, outcome: "passed", tests: {
  backendContract: evidence(["test/adapter.test.ts", "test/engine.test.ts", "test/real-engine.test.ts"]),
  restore: evidence(["test/checkpoint.test.ts", "test/engine-backup.test.ts", "test/recovery.test.ts", "test/compiled.test.ts"]),
  soulIntegration: evidence(["test/product-integration.test.ts", "test/compiled.test.ts"]),
} }
await Bun.write(join(candidate, "release-validation.json"), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ candidate, manifestHash: inspected.manifestHash, tests: clean.match(/\d+ pass\s+\d+ fail/)?.[0] ?? "passed", logPath, report: join(candidate, "release-validation.json") }, null, 2))
