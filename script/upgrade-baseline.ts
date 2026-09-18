import { resolve } from "node:path"

// Installed engine.6 binary: migrations must start from these exact bytes.
export const upgradeBaseline = {
  version: "0.0.0-product-dev-20260918-engine.6-source",
  sha256: "f02b6bbba598d4f2e9e1c1f75794104b9581129ae199d3130b4bc2e552ee748b",
}
export async function verifyUpgradeBaseline(executable: string) {
  const bytes = Bun.file(executable)
  if (!await bytes.exists()) throw new Error("缺少 engine.6 升级基准；请提供经固定 SHA-256 核对的旧制品，不能跳过迁移测试")
  if (new Bun.CryptoHasher("sha256").update(await bytes.arrayBuffer()).digest("hex") !== upgradeBaseline.sha256) throw new Error("engine.6 升级基准 SHA-256 不匹配")
  return { ...upgradeBaseline, executable: resolve(executable) }
}
if (import.meta.main) {
  const executable = process.argv[2]
  if (!executable || process.argv.length !== 3) throw new Error("Usage: bun run script/upgrade-baseline.ts <engine.6-executable>")
  await verifyUpgradeBaseline(executable)
  console.log(`Verified upgrade baseline ${upgradeBaseline.version} / ${upgradeBaseline.sha256}`)
}
