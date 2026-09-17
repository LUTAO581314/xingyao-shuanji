import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { activateRelease, inspectRelease, resolveCurrent, rollbackRelease, stageRelease, type ReleaseInfo, type ReleaseValidationReport } from "../src/releases"
import { acquireHostLock, createCheckpoint, restoreCheckpoint } from "../src/checkpoint"
import { SoulStore } from "../src/store"
import { SCHEMA_VERSION } from "../src/contracts"

const roots: string[] = []
const dbs: Database[] = []
const hash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex")
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xingyao-releases-test-")); roots.push(root)
  return { root, system: join(root, "便携 system") }
}
function candidate(root: string, version = "0.1.0-dev.1", schemaVersion = SCHEMA_VERSION) {
  const directory = join(root, `candidate-${randomUUID()}`); mkdirSync(directory)
  const files = { "xingyao.exe": `fake product fixture ${version}`, "opencode.exe": `fake engine fixture ${version}` }
  for (const [name, body] of Object.entries(files)) writeFileSync(join(directory, name), body)
  writeFileSync(join(directory, "release.json"), JSON.stringify({ product: "xingyao-xuanji", version, protocolVersion: 1, schemaVersion, platform: "windows-x64", adapter: "legacy-http-v1", files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, hash(body)])), validation: "development-candidate", knownLimitations: ["Fake artifacts in isolated release-gate tests; never execute"] }, null, 2))
  return directory
}
function report(release: ReleaseInfo): ReleaseValidationReport {
  const now = Date.now()
  const evidence = { passed: true, execution: "real" as const, evidence: ["fixture://controlled-test-report; verifies the gate contract only"], startedAt: now - 10, finishedAt: now }
  return { manifestHash: release.manifestHash, outcome: "passed", tests: { backendContract: structuredClone(evidence), restore: structuredClone(evidence), soulIntegration: structuredClone(evidence) } }
}
function editManifest(path: string, edit: (value: any) => void) {
  const manifest = JSON.parse(readFileSync(join(path, "release.json"), "utf8"))
  edit(manifest)
  writeFileSync(join(path, "release.json"), JSON.stringify(manifest))
}
async function recoveryFixture(root: string, schemaVersion = SCHEMA_VERSION) {
  const store = new SoulStore(join(root, "original host", "soul.db")); dbs.push(store.db)
  const vaultDir = join(root, "vault")
  store.explicitMemory({ key: "release-test", text: "仅用于隔离回滚测试", scope: "global", kind: "fact" })
  // Deliberately model historical bytes; never open this fixture through a newer
  // SoulStore before testing restore/rollback's exact schema correspondence.
  store.db.exec(`PRAGMA user_version=${schemaVersion}`)
  const checkpoint = await createCheckpoint(store.db, vaultDir, store.identityId, store.revision, null)
  const restoredHostDb = join(root, "restored host", "soul.db")
  await restoreCheckpoint(vaultDir, checkpoint.generation, restoredHostDb)
  return { vaultDir, generation: checkpoint.generation, identityId: checkpoint.identityId, expectedRevision: checkpoint.revision, restoredHostDb }
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("release inspection and staging", () => {
  test("stages only declared files into a unique directory without activating or modifying the source", async () => {
    const { root, system } = fixture(), source = candidate(root)
    writeFileSync(join(source, "undeclared-extra.exe"), "never copy")
    const inspected = await inspectRelease(source)
    expect(inspected.status).toBe("candidate")
    const staged = await stageRelease(source, system)
    expect(staged.status).toBe("staged")
    expect(staged.manifestHash).toBe(inspected.manifestHash)
    expect(staged.path).not.toBe(source)
    expect(existsSync(join(staged.path, "undeclared-extra.exe"))).toBe(false)
    expect(await resolveCurrent(system)).toBeNull()
    expect(existsSync(join(system, "current.json"))).toBe(false)
    const second = await stageRelease(source, system)
    expect(second.id).not.toBe(staged.id)
    expect((await inspectRelease(source)).status).toBe("candidate")
  })
  test("checks every declared hash, both executables and supported schema/protocol/platform", async () => {
    const { root } = fixture()
    const corrupt = candidate(root)
    writeFileSync(join(corrupt, "opencode.exe"), "changed")
    await expect(inspectRelease(corrupt)).rejects.toThrow("SHA-256")
    for (const change of [(m: any) => delete m.files["opencode.exe"], (m: any) => m.schemaVersion = SCHEMA_VERSION + 1, (m: any) => m.protocolVersion = 2, (m: any) => m.platform = "linux-x64", (m: any) => m.adapter = "v2-unknown"]) {
      const source = candidate(root); editManifest(source, change)
      await expect(inspectRelease(source)).rejects.toThrow()
    }
  })
  test("rejects traversal, ADS paths, ambiguous Windows names and case aliases", async () => {
    const { root } = fixture()
    for (const name of ["../outside.exe", "/root.exe", "C:/outside.exe", "sub\\outside.exe", "sub/file:stream", "sub/../file", "sub/file.", "sub/CON.txt", "release.json", "XINGYAO.EXE"]) {
      const source = candidate(root)
      editManifest(source, value => value.files[name] = hash("not read"))
      await expect(inspectRelease(source)).rejects.toThrow()
    }
  })
  test("rejects artifact paths through directory junctions", async () => {
    const { root } = fixture(), source = candidate(root)
    const outside = join(root, "outside"); mkdirSync(outside)
    writeFileSync(join(outside, "asset.txt"), "outside")
    symlinkSync(outside, join(source, "linked"), process.platform === "win32" ? "junction" : "dir")
    editManifest(source, value => value.files["linked/asset.txt"] = hash("outside"))
    await expect(inspectRelease(source)).rejects.toThrow("连接点")
  })
})

describe("activation gate and recoverable selection", () => {
  test("requires real passed report evidence bound to this exact manifest", async () => {
    const { root, system } = fixture(), staged = await stageRelease(candidate(root), system)
    for (const alter of [(r: ReleaseValidationReport) => r.manifestHash = "0".repeat(64), (r: ReleaseValidationReport) => r.outcome = "failed", (r: ReleaseValidationReport) => r.tests.backendContract.execution = "mock", (r: ReleaseValidationReport) => r.tests.restore.passed = false, (r: ReleaseValidationReport) => r.tests.soulIntegration.evidence = []]) {
      const invalid = report(staged); alter(invalid)
      await expect(activateRelease(system, staged.id, invalid)).rejects.toThrow()
      expect(await resolveCurrent(system)).toBeNull()
    }
    const selected = await activateRelease(system, staged.id, report(staged))
    expect(selected.releaseId).toBe(staged.id)
    expect((await resolveCurrent(system))?.id).toBe(selected.id)
    expect((await activateRelease(system, staged.id, report(staged))).id).toBe(selected.id)
  })
  test("a failed or tampered candidate cannot change the selected release", async () => {
    const { root, system } = fixture(), stable = await stageRelease(candidate(root), system)
    await activateRelease(system, stable.id, report(stable))
    const broken = candidate(root, "0.2.0")
    writeFileSync(join(broken, "xingyao.exe"), "broken")
    await expect(stageRelease(broken, system)).rejects.toThrow()
    const next = await stageRelease(candidate(root, "0.2.0"), system)
    writeFileSync(join(next.path, "opencode.exe"), "changed after staging")
    await expect(activateRelease(system, next.id, report(next))).rejects.toThrow("SHA-256")
    expect((await resolveCurrent(system))?.releaseId).toBe(stable.id)
    expect(readFileSync(join(stable.path, "xingyao.exe"), "utf8")).toContain("0.1.0-dev.1")
  })
  test("pointer corruption and incomplete newest journals preserve the complete current selection and previous release", async () => {
    const { root, system } = fixture(), one = await stageRelease(candidate(root), system), two = await stageRelease(candidate(root, "0.2.0"), system)
    const first = await activateRelease(system, one.id, report(one))
    const second = await activateRelease(system, two.id, report(two))
    expect(JSON.parse(readFileSync(join(system, "previous.json"), "utf8")).releaseId).toBe(one.id)
    writeFileSync(join(system, "current.json"), "{torn")
    writeFileSync(join(system, "previous.json"), "{also torn")
    const incomplete = join(system, "selections", `000000000003-${randomUUID()}`)
    mkdirSync(incomplete); writeFileSync(join(incomplete, "selection.json"), '{"partial":')
    const recovered = await resolveCurrent(system)
    expect(recovered?.id).toBe(second.id)
    expect(recovered?.previousSelection).toBe(first.id)
    expect(existsSync(join(one.path, "xingyao.exe"))).toBe(true)
  })
  test("detects independently complete selection forks instead of choosing a timestamp winner", async () => {
    const { root, system } = fixture(), one = await stageRelease(candidate(root), system), two = await stageRelease(candidate(root, "0.2.0"), system)
    await activateRelease(system, one.id, report(one))
    const selected = await activateRelease(system, two.id, report(two))
    const forkId = `000000000002-${randomUUID()}`, fork = { ...selected, id: forkId, createdAt: selected.createdAt + 1 }
    const directory = join(system, "selections", forkId); mkdirSync(directory)
    const bytes = JSON.stringify(fork)
    writeFileSync(join(directory, "selection.json"), bytes)
    writeFileSync(join(directory, "complete.json"), JSON.stringify({ format: 1, complete: true, sha256: hash(bytes) }))
    await expect(resolveCurrent(system)).rejects.toThrow("多个分支")
  })
  test("a damaged committed release fails closed instead of silently selecting older code", async () => {
    const { root, system } = fixture(), one = await stageRelease(candidate(root), system), two = await stageRelease(candidate(root, "0.2.0"), system)
    await activateRelease(system, one.id, report(one)); await activateRelease(system, two.id, report(two))
    writeFileSync(join(two.path, "xingyao.exe"), "damaged after activation")
    await expect(resolveCurrent(system)).rejects.toThrow("SHA-256")
  })
  test("moving the portable system derives its new release path from the verified journal", async () => {
    const { root, system } = fixture(), release = await stageRelease(candidate(root), system)
    await activateRelease(system, release.id, report(release))
    const relocated = join(root, "new drive", "system")
    cpSync(system, relocated, { recursive: true })
    const selected = await resolveCurrent(relocated)
    expect(selected?.releasePath).toBe(join(relocated, "releases", release.id))
    expect(selected?.manifestHash).toBe(release.manifestHash)
  })
})

describe("code and data rollback", () => {
  test("matching schema 1 recovery bytes cannot select old code when the same vault contains schema 2", async () => {
    const { root, system } = fixture()
    const old = await stageRelease(candidate(root, "0.1.0", 1), system)
    const next = await stageRelease(candidate(root, "0.2.0", SCHEMA_VERSION), system)
    await activateRelease(system, old.id, report(old))
    const current = await activateRelease(system, next.id, report(next))
    const recovery = await recoveryFixture(root, 1)
    const source = dbs.at(-1)!
    source.exec(`PRAGMA user_version=${SCHEMA_VERSION}`)
    source.query("UPDATE meta SET value=? WHERE key='checkpoint_generation'").run(recovery.generation)
    source.query("UPDATE meta SET value=? WHERE key='revision'").run(String(recovery.expectedRevision + 1))
    await createCheckpoint(source, recovery.vaultDir, recovery.identityId, recovery.expectedRevision + 1, recovery.generation)
    const beforeHost = readFileSync(recovery.restoredHostDb)
    const beforeManifest = readFileSync(join(recovery.vaultDir, "checkpoints", recovery.generation, "complete.json"))
    await expect(rollbackRelease(system, old.id, report(old), recovery)).rejects.toThrow("隔离的便携库")
    expect((await resolveCurrent(system))?.id).toBe(current.id)
    expect(readFileSync(recovery.restoredHostDb)).toEqual(beforeHost)
    expect(readFileSync(join(recovery.vaultDir, "checkpoints", recovery.generation, "complete.json"))).toEqual(beforeManifest)
    // This guard does not alter restoreCheckpoint: new code still restores the
    // historical generation to another destination, preserving its schema.
    const another = join(root, "another-old-copy", "soul.db")
    const restored = await restoreCheckpoint(recovery.vaultDir, recovery.generation, another)
    expect(restored.schemaVersion).toBe(1)
    const copy = new Database(another, { readonly: true }); dbs.push(copy)
    expect(copy.query("PRAGMA user_version").get()).toEqual({ user_version: 1 })
  })
  test("reads schema 1 selection history, upgrades to schema 2, and requires matching schema for rollback", async () => {
    const { root, system } = fixture()
    const old = await stageRelease(candidate(root, "0.1.0", 1), system)
    const first = await activateRelease(system, old.id, report(old))
    expect((await resolveCurrent(system))?.id).toBe(first.id)
    const next = await stageRelease(candidate(root, "0.2.0", SCHEMA_VERSION), system)
    const selected = await activateRelease(system, next.id, report(next))
    expect(selected.previousSelection).toBe(first.id)
    expect((await resolveCurrent(system))?.id).toBe(selected.id)
    const modern = await recoveryFixture(join(root, "new-recovery"), SCHEMA_VERSION)
    await expect(rollbackRelease(system, old.id, report(old), modern)).rejects.toThrow("不匹配")
    expect((await resolveCurrent(system))?.releaseId).toBe(next.id)
    const historical = await recoveryFixture(join(root, "old-recovery"), 1)
    const rolled = await rollbackRelease(system, old.id, report(old), historical)
    expect(rolled.recovery?.schemaVersion).toBe(1)
    expect((await resolveCurrent(system))?.id).toBe(rolled.id)
    const wrongActual = new Database(historical.restoredHostDb)
    wrongActual.exec(`PRAGMA user_version=${SCHEMA_VERSION}`); wrongActual.close()
    await expect(rollbackRelease(system, old.id, report(old), historical)).rejects.toThrow("未实际恢复")
  })
  test("a greater product version cannot activate an older data schema without a paired rollback", async () => {
    const { root, system } = fixture()
    const current = await stageRelease(candidate(root, "0.2.0", SCHEMA_VERSION), system)
    await activateRelease(system, current.id, report(current))
    const olderSchema = await stageRelease(candidate(root, "0.3.0", 1), system)
    await expect(activateRelease(system, olderSchema.id, report(olderSchema))).rejects.toThrow("schema")
    expect((await resolveCurrent(system))?.releaseId).toBe(current.id)
  })
  test("ordinary activation cannot bypass rollback data requirements", async () => {
    const { root, system } = fixture(), old = await stageRelease(candidate(root), system), next = await stageRelease(candidate(root, "0.2.0"), system)
    await activateRelease(system, old.id, report(old)); await activateRelease(system, next.id, report(next))
    await expect(activateRelease(system, old.id, report(old))).rejects.toThrow("检查点回滚")
    const duplicateOld = await stageRelease(candidate(root), system)
    await expect(activateRelease(system, duplicateOld.id, report(duplicateOld))).rejects.toThrow("检查点回滚")
    expect((await resolveCurrent(system))?.releaseId).toBe(next.id)
  })
  test("requires a verified matching checkpoint and an actually restored closed host database", async () => {
    const { root, system } = fixture(), old = await stageRelease(candidate(root), system), next = await stageRelease(candidate(root, "0.2.0"), system)
    await activateRelease(system, old.id, report(old)); await activateRelease(system, next.id, report(next))
    const recovery = await recoveryFixture(root)
    await expect(rollbackRelease(system, old.id, report(old), { ...recovery, expectedRevision: recovery.expectedRevision + 1 })).rejects.toThrow("不匹配")
    expect((await resolveCurrent(system))?.releaseId).toBe(next.id)
    const db = new Database(recovery.restoredHostDb)
    db.query("UPDATE meta SET value='wrong-generation' WHERE key='checkpoint_generation'").run(); db.close()
    await expect(rollbackRelease(system, old.id, report(old), recovery)).rejects.toThrow("未实际恢复")
    const correct = new Database(recovery.restoredHostDb)
    correct.query("UPDATE meta SET value=? WHERE key='checkpoint_generation'").run(recovery.generation); correct.close()
    const rolled = await rollbackRelease(system, old.id, report(old), recovery)
    expect(rolled.mode).toBe("rollback")
    expect(rolled.recovery?.generation).toBe(recovery.generation)
    expect(rolled.recovery?.hostDatabase).toBe(recovery.restoredHostDb)
    expect(rolled.previousReleaseId).toBe(next.id)
    expect((await resolveCurrent(system))?.releaseId).toBe(old.id)
    expect(existsSync(join(next.path, "xingyao.exe"))).toBe(true)
    expect((await activateRelease(system, old.id, report(old))).recovery?.generation).toBe(recovery.generation)
  })
  test("rollback refuses a running host lock or leftover WAL and leaves current unchanged", async () => {
    const { root, system } = fixture(), old = await stageRelease(candidate(root), system), next = await stageRelease(candidate(root, "0.2.0"), system)
    await activateRelease(system, old.id, report(old)); await activateRelease(system, next.id, report(next))
    const recovery = await recoveryFixture(root)
    const unlock = acquireHostLock(join(root, "restored host"))
    try { await expect(rollbackRelease(system, old.id, report(old), recovery)).rejects.toThrow("active") } finally { unlock() }
    writeFileSync(`${recovery.restoredHostDb}-wal`, "unclosed data")
    await expect(rollbackRelease(system, old.id, report(old), recovery)).rejects.toThrow("尚未闭合")
    expect((await resolveCurrent(system))?.releaseId).toBe(next.id)
  })
  test("an explicit validated rollback can recover from a damaged current executable", async () => {
    const { root, system } = fixture(), old = await stageRelease(candidate(root), system), next = await stageRelease(candidate(root, "0.2.0"), system)
    await activateRelease(system, old.id, report(old)); await activateRelease(system, next.id, report(next))
    const recovery = await recoveryFixture(root)
    writeFileSync(join(next.path, "xingyao.exe"), "damaged committed executable")
    await expect(resolveCurrent(system)).rejects.toThrow()
    const selected = await rollbackRelease(system, old.id, report(old), recovery)
    expect(selected.releaseId).toBe(old.id)
    expect((await resolveCurrent(system))?.recovery?.generation).toBe(recovery.generation)
  })
})
