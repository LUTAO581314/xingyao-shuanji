import { lstatSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { parseArgs } from "node:util"
import { migrateEngineCheckpoint, type EngineMigrationOptions } from "../src/engine-migration"
import { inspectRelease, validateReport, type ReleaseValidationReport } from "../src/releases"

export type ReleaseMigrationOptions = Omit<EngineMigrationOptions, "from" | "to" | "afterBoundary"> & { fromRelease: string; toRelease: string }

/** Resolve reviewed release metadata without running either executable or
 * modifying an identity. Qualification is for the exact source/target pair. */
export async function qualifiedMigration(options: ReleaseMigrationOptions): Promise<EngineMigrationOptions> {
  if (![options.fromRelease, options.toRelease, options.hostDir, options.vaultDir, options.projectDir].every(isAbsolute)) throw new Error("迁移必须使用明确的绝对路径")
  const from = await inspectRelease(options.fromRelease), to = await inspectRelease(options.toRelease)
  const readReport = async (path: string, manifestHash: string) => {
    const file = join(path, "release-validation.json"), stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128_000) throw new Error("迁移发行缺少有效的验收报告")
    const report = await Bun.file(file).json() as ReleaseValidationReport
    validateReport(report, manifestHash)
    return report
  }
  await readReport(from.path, from.manifestHash)
  const targetReport = await readReport(to.path, to.manifestHash)
  const before = await Bun.file(join(from.path, "release.json")).json() as { engineVersion?: unknown }
  const after = await Bun.file(join(to.path, "release.json")).json() as { engineVersion?: unknown }
  const upgrade = targetReport.engineUpgrade
  if (!upgrade || upgrade.fromVersion !== before.engineVersion || upgrade.toVersion !== after.engineVersion ||
      upgrade.fromSha256 !== from.manifest.files["opencode.exe"] || upgrade.toSha256 !== to.manifest.files["opencode.exe"]) throw new Error("目标发行没有通过这两个准确引擎制品的升级测试；不能借用另一版本的报告")
  return { hostDir: options.hostDir, vaultDir: options.vaultDir, generation: options.generation, projectDir: options.projectDir,
    from: { executable: join(from.path, "opencode.exe"), version: upgrade.fromVersion, sha256: upgrade.fromSha256 },
    to: { executable: join(to.path, "opencode.exe"), version: upgrade.toVersion, sha256: upgrade.toSha256 } }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    "from-release": { type: "string" }, "to-release": { type: "string" }, "host-root": { type: "string" },
    "vault-root": { type: "string" }, generation: { type: "string" }, project: { type: "string" }, help: { type: "boolean" },
  } })
  if (values.help) console.log("bun run script/migrate-engine.ts --from-release <absolute-directory> --to-release <absolute-directory> --host-root <absolute-directory> --vault-root <absolute-directory> --generation <source-generation> --project <existing-stable-project-path>")
  else {
    for (const name of ["from-release", "to-release", "host-root", "vault-root", "generation", "project"] as const) if (!values[name]) throw new Error(`Missing --${name}`)
    const options = await qualifiedMigration({ fromRelease: values["from-release"]!, toRelease: values["to-release"]!,
      hostDir: values["host-root"]!, vaultDir: values["vault-root"]!, generation: values.generation!, projectDir: values.project! })
    const result = await migrateEngineCheckpoint(options)
    console.log(JSON.stringify({ generation: result.checkpoint.generation, parent: result.checkpoint.parent, identityId: result.checkpoint.identityId,
      stageDir: result.stageDir, evidence: result.evidence,
      next: "新检查点已完成。请安装同一目标发行后启动；宿主将通过配套恢复接续。原发行与原检查点仍保留。" }, null, 2))
  }
}
