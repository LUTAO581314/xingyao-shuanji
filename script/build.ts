import { mkdir, copyFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { PRODUCT_VERSION, PROTOCOL_VERSION, SCHEMA_VERSION } from "../src/contracts"
import { sourceHash } from "./source-hash"

const root = resolve(import.meta.dir, "..")
const output = join(root, "dist", `xingyao-${PRODUCT_VERSION}`)
const enginePath = process.env.XINGYAO_BUILD_ENGINE
let engineVersion: string | null = null
if (enginePath) {
  const checked = Bun.spawnSync([enginePath, "--version"], { stdout: "pipe", stderr: "ignore", windowsHide: true })
  engineVersion = checked.stdout.toString().trim()
  if (checked.exitCode !== 0 || !engineVersion || engineVersion.length > 200) throw new Error("Bundled engine version probe failed")
}
const upstreamLicense = process.env.XINGYAO_UPSTREAM_LICENSE ?? (enginePath ? join(dirname(enginePath), "OPENCODE-LICENSE.txt") : undefined)
if (enginePath && (!upstreamLicense || !await Bun.file(upstreamLicense).exists())) throw new Error("Bundled engine requires XINGYAO_UPSTREAM_LICENSE or its adjacent OPENCODE-LICENSE.txt")
const source = await Bun.file(join(root, "patches/opencode/manifest.json")).json() as { patches: { file: string; sha256: string }[] }
const hashFile = async (path: string) => new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex")
for (const patch of source.patches) {
  if (!/^[0-9]{3}-[a-z0-9-]+\.patch$/.test(patch.file) || await hashFile(join(root, "patches/opencode", patch.file)) !== patch.sha256) throw new Error("Engine patch inventory failed integrity validation")
}
const provenancePath = process.env.XINGYAO_ENGINE_BUILD_RECORD
if (provenancePath) {
  const record = await Bun.file(provenancePath).json()
  if (!enginePath || !upstreamLicense || record.format !== 1 || record.version !== engineVersion || record.executableSha256 !== await hashFile(enginePath) ||
      record.licenseSha256 !== await hashFile(upstreamLicense) || record.sourceManifestSha256 !== await hashFile(join(root, "patches/opencode/manifest.json"))) throw new Error("Engine build record does not match bundled inputs")
}
await mkdir(join(root, "dist"), { recursive: true })
await mkdir(output) // Never overwrite an earlier candidate or its validation evidence.
const result = await Bun.build({ entrypoints: [join(root, "src", "cli.ts")], compile: { target: "bun-windows-x64", outfile: join(output, "xingyao.exe") }, minify: true, sourcemap: "none" })
if (!result.success) throw new AggregateError(result.logs, "构建失败")
if (enginePath) await copyFile(enginePath, join(output, "opencode.exe"))
if (enginePath) await copyFile(upstreamLicense!, join(output, "OPENCODE-LICENSE.txt"))
if (provenancePath) await copyFile(provenancePath, join(output, "engine-build.json"))
await Bun.write(join(output, "THIRD-PARTY-NOTICES.txt"), "星杳 · 璇玑 bundles the Bun JavaScript runtime (MIT), OpenCode (MIT), and Cytoscape.js 3.34.3 (MIT).\nOpenCode and its bundled dependencies retain their respective licenses.\nOpenCode source: https://github.com/anomalyco/opencode\nCytoscape.js source: https://github.com/cytoscape/cytoscape.js/tree/v3.34.3\nCytoscape.js copyright and license: CYTOSCAPE-LICENSE.txt\nBun license and third-party notices: https://github.com/oven-sh/bun/blob/main/LICENSE.md\nProduct source and minimal engine patches are included in the local development repository.\n")
await copyFile(join(root, "src/web/vendor/CYTOSCAPE-LICENSE.txt"), join(output, "CYTOSCAPE-LICENSE.txt"))
await copyFile(join(root, "README.md"), join(output, "README.md"))
const maintenanceFiles = [...source.patches.map(patch => `patches/opencode/${patch.file}`), "patches/opencode/manifest.json", "patches/opencode/README.md", "build-inputs/models.dev.manifest.json", "docs/engine-source.md", "docs/engine-upgrade.md", "docs/github-product-workflow.md", "docs/opencode-patches.md", "docs/system-design.md", "docs/conversation-memory.md", "docs/workspace-recovery.md", "docs/collaboration.md", "docs/implementation-status.md", "docs/workbench-modules.md", "docs/architecture-review-2026-09-17.md", "docs/evidence-fixes-2026-09-17.md"]
for (const name of maintenanceFiles) { await mkdir(join(output, name, ".."), { recursive: true }); await copyFile(join(root, name), join(output, name)) }
const files: Record<string, string> = {}
for (const name of ["xingyao.exe", "README.md", "THIRD-PARTY-NOTICES.txt", "CYTOSCAPE-LICENSE.txt", ...maintenanceFiles, ...(enginePath ? ["opencode.exe", "OPENCODE-LICENSE.txt"] : []), ...(provenancePath ? ["engine-build.json"] : [])]) files[name] = await hashFile(join(output, name))
await Bun.write(join(output, "release.json"), JSON.stringify({ product: "xingyao-xuanji", version: PRODUCT_VERSION, protocolVersion: PROTOCOL_VERSION, schemaVersion: SCHEMA_VERSION, platform: "windows-x64", adapter: "legacy-http-v1", engineVersion, sourceHash: await sourceHash(root), createdAt: new Date().toISOString(), files, validation: "development-candidate", knownLimitations: ["V2 API is not supported", "Host NTFS working database; portable snapshots require safe exit", "Model credentials are host-local", "Conversation memory candidates require review; real model quality and long-term personality learning are not validated", "Delegation abort does not roll back prior side effects", "GitHub conversation archive does not yet export product OpenCode sessions"] }, null, 2))
console.log(output)
