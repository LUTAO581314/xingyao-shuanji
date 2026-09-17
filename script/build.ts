import { mkdir, copyFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { PRODUCT_VERSION, PROTOCOL_VERSION, SCHEMA_VERSION } from "../src/contracts"
import { sourceHash } from "./source-hash"

const root = resolve(import.meta.dir, "..")
const output = join(root, "dist", `xingyao-${PRODUCT_VERSION}`)
await mkdir(output, { recursive: true })
const result = await Bun.build({ entrypoints: [join(root, "src", "cli.ts")], compile: { target: "bun-windows-x64", outfile: join(output, "xingyao.exe") }, minify: true, sourcemap: "none" })
if (!result.success) throw new AggregateError(result.logs, "构建失败")
const enginePath = process.env.XINGYAO_BUILD_ENGINE
if (enginePath) await copyFile(enginePath, join(output, "opencode.exe"))
const upstreamLicense = process.env.XINGYAO_UPSTREAM_LICENSE ?? "C:/Users/LT/Documents/trae/LICENSE"
if (enginePath && await Bun.file(upstreamLicense).exists()) await copyFile(upstreamLicense, join(output, "OPENCODE-LICENSE.txt"))
await Bun.write(join(output, "THIRD-PARTY-NOTICES.txt"), "星杳 · 璇玑 bundles the Bun JavaScript runtime (MIT) and OpenCode (MIT).\nOpenCode and its bundled dependencies retain their respective licenses.\nOpenCode source: https://github.com/anomalyco/opencode\nBun license and third-party notices: https://github.com/oven-sh/bun/blob/main/LICENSE.md\nProduct source and minimal engine patches are included in the local development repository.\n")
await copyFile(join(root, "README.md"), join(output, "README.md"))
const maintenanceFiles = ["patches/opencode/001-filesystem-search-import-cycle.patch", "patches/opencode/002-portable-workspace-paths.patch", "patches/opencode/manifest.json", "patches/opencode/README.md", "docs/opencode-patches.md", "docs/system-design.md", "docs/implementation-status.md"]
for (const name of maintenanceFiles) { await mkdir(join(output, name, ".."), { recursive: true }); await copyFile(join(root, name), join(output, name)) }
const files: Record<string, string> = {}
for (const name of ["xingyao.exe", "README.md", "THIRD-PARTY-NOTICES.txt", ...maintenanceFiles, ...(enginePath ? ["opencode.exe", ...(await Bun.file(join(output, "OPENCODE-LICENSE.txt")).exists() ? ["OPENCODE-LICENSE.txt"] : [])] : [])]) files[name] = new Bun.CryptoHasher("sha256").update(await Bun.file(join(output, name)).arrayBuffer()).digest("hex")
const engineVersion = enginePath ? Bun.spawnSync([join(output, "opencode.exe"), "--version"], { stdout: "pipe", stderr: "ignore", windowsHide: true }).stdout.toString().trim() : null
await Bun.write(join(output, "release.json"), JSON.stringify({ product: "xingyao-xuanji", version: PRODUCT_VERSION, protocolVersion: PROTOCOL_VERSION, schemaVersion: SCHEMA_VERSION, platform: "windows-x64", adapter: "legacy-http-v1", engineVersion, sourceHash: await sourceHash(root), createdAt: new Date().toISOString(), files, validation: "development-candidate", knownLimitations: ["V2 API is not supported", "Host NTFS working database; portable snapshots require safe exit", "Model credentials are host-local", "Model-based memory extraction and long-term personality learning are not enabled"] }, null, 2))
console.log(output)
