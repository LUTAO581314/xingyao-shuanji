import { resolve } from "node:path"

// Historical binary: its original model snapshot is unavailable. Never rebuild
// an approximation and label it as this baseline; acquire these exact bytes.
export const upgradeBaseline = {
  version: "0.0.0-product-dev-20260917-engine.5",
  sha256: "528277b2ea4178093a192da0fe33ef4768e7ae5514a7b21de006d07212c6df83",
}
export async function verifyUpgradeBaseline(executable: string) {
  const bytes = Bun.file(executable)
  if (!await bytes.exists()) throw new Error("缺少 engine.5 升级基准；请提供经固定 SHA-256 核对的旧制品，不能跳过迁移测试")
  if (new Bun.CryptoHasher("sha256").update(await bytes.arrayBuffer()).digest("hex") !== upgradeBaseline.sha256) throw new Error("engine.5 升级基准 SHA-256 不匹配")
  return { ...upgradeBaseline, executable: resolve(executable) }
}
if (import.meta.main) {
  const executable = process.argv[2]
  if (!executable || process.argv.length !== 3) throw new Error("Usage: bun run script/upgrade-baseline.ts <engine.5-executable>")
  await verifyUpgradeBaseline(executable)
  console.log(`Verified upgrade baseline ${upgradeBaseline.version} / ${upgradeBaseline.sha256}`)
}
