import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { qualifiedMigration } from "../script/migrate-engine"
import { inspectRelease, type ReleaseValidationReport } from "../src/releases"
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "../src/contracts"

test("migration qualification requires passed release reports for the exact engine pair before touching identity data", async () => {
  const root = mkdtempSync(join(tmpdir(), "xingyao-upgrade-qualification-"))
  const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")
  const evidence = { passed: true, execution: "real" as const, startedAt: Date.now() - 1, finishedAt: Date.now(), evidence: ["test fixture: gate validation only; fake executables never run"] }
  async function fixture(name: string) {
    const path = join(root, name); mkdirSync(path)
    const files = { "xingyao.exe": "fixture product", "opencode.exe": `fixture engine ${name}` }
    for (const [name, text] of Object.entries(files)) writeFileSync(join(path, name), text)
    writeFileSync(join(path, "release.json"), JSON.stringify({ product: "xingyao-xuanji", version: "0.1.0-dev.1", protocolVersion: PROTOCOL_VERSION,
      schemaVersion: SCHEMA_VERSION, platform: "windows-x64", adapter: "legacy-http-v1", validation: "fixture", knownLimitations: ["never execute"],
      engineVersion: name, files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha(text)])) }))
    const inspected = await inspectRelease(path)
    const report: ReleaseValidationReport = { manifestHash: inspected.manifestHash, outcome: "passed", tests: { backendContract: evidence, restore: evidence, soulIntegration: evidence } }
    writeFileSync(join(path, "release-validation.json"), JSON.stringify(report))
    return { path, report, engineSha: sha(files["opencode.exe"]) }
  }
  try {
    const old = await fixture("engine-old"), target = await fixture("engine-new")
    const options = { fromRelease: old.path, toRelease: target.path, hostDir: join(root, "untouched-host"), vaultDir: join(root, "untouched-vault"), projectDir: join(root, "project"), generation: "source-generation" }
    await expect(qualifiedMigration(options)).rejects.toThrow("没有通过")
    target.report.engineUpgrade = { ...evidence, fromVersion: "engine-old", fromSha256: old.engineSha, toVersion: "engine-new", toSha256: target.engineSha }
    const save = () => writeFileSync(join(target.path, "release-validation.json"), JSON.stringify(target.report))
    save()
    const qualified = await qualifiedMigration(options)
    expect(qualified.from.sha256).toBe(old.engineSha)
    expect(qualified.to.sha256).toBe(target.engineSha)
    expect(qualified.from.executable).toBe(join(old.path, "opencode.exe"))
    target.report.engineUpgrade.toSha256 = "0".repeat(64); save()
    await expect(qualifiedMigration(options)).rejects.toThrow("没有通过")
    target.report.engineUpgrade.toSha256 = target.engineSha
    target.report.engineUpgrade.execution = "mock"; save()
    await expect(qualifiedMigration(options)).rejects.toThrow("真实证据")
    target.report.engineUpgrade.execution = "real"
    target.report.manifestHash = "0".repeat(64); save()
    await expect(qualifiedMigration(options)).rejects.toThrow("未绑定")
    old.report.outcome = "failed"
    writeFileSync(join(old.path, "release-validation.json"), JSON.stringify(old.report))
    await expect(qualifiedMigration(options)).rejects.toThrow("未通过")
    expect(() => readFileSync(join(options.hostDir, "soul.db"))).toThrow()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
