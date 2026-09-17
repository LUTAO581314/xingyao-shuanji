import { lstat, mkdir, readFile, readlink, realpath, writeFile } from "node:fs/promises"
import path from "node:path"

const productRoot = path.resolve(import.meta.dir, "..")
const patchRoot = path.join(productRoot, "patches", "opencode")
const manifestPath = path.join(patchRoot, "manifest.json")
const markerName = "xingyao-engine-source.json"

type SourceFile = { path: string; deleted?: boolean; bytes?: number; sha256?: string; gitBlob?: string }
type Manifest = {
  format: number
  upstream: { repository: string; commit: string; tree: string }
  patchedTree: string
  patches: { file: string; sha256: string; bytes: number; files: string[] }[]
  files: SourceFile[]
  inspectionRoots: string[]
}

function hash(bytes: Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}

function samePath(left: string, right: string) {
  const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)
  return normalize(left) === normalize(right)
}

function safeRelative(value: string) {
  return !!value && !value.includes("\\") && !value.includes(":") && !value.startsWith("/") &&
    value.split("/").every((part) => !!part && part !== "." && part !== "..")
}

async function git(checkout: string, args: string[]) {
  // Public Git operations never inherit the user's Git config, credential helpers, or Git overrides.
  const allowed = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "SYSTEMDRIVE"])
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())))
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(checkout, ".git", "xingyao-empty-global-config"),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  })
  const proc = Bun.spawn(["git", "-c", `safe.directory=${checkout.replaceAll("\\", "/")}`, "-c", "core.longpaths=true", "-c", "core.autocrlf=false", "-c",
    "core.hooksPath=.git/xingyao-disabled-hooks", "-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60", ...args], {
    cwd: checkout, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ])
  if (code !== 0) throw new Error(`git ${args[0]} failed (${code}): ${stderr.slice(-6000) || stdout.slice(-6000)}`)
  return stdout.trim()
}

async function loadManifest() {
  const bytes = await readFile(manifestPath)
  const manifest = JSON.parse(bytes.toString("utf8")) as Manifest
  if (manifest.format !== 2 || manifest.upstream.repository !== "https://github.com/anomalyco/opencode.git" ||
    ![manifest.upstream.commit, manifest.upstream.tree, manifest.patchedTree].every((value) => /^[0-9a-f]{40}$/.test(value))) {
    throw new Error("Unsupported or invalid engine source manifest")
  }
  if (!manifest.patches.length || !manifest.files.length || !manifest.inspectionRoots.length) throw new Error("Empty source inventory")
  const paths = manifest.files.map((file) => file.path)
  if (new Set(paths).size !== paths.length || paths.some((file) => !safeRelative(file) || !(file === "bun.lock" || file.startsWith("packages/")))) {
    throw new Error("Unsafe or duplicate source inventory paths")
  }
  if (manifest.inspectionRoots.some((file) => !safeRelative(file))) throw new Error("Unsafe inspection root")
  for (const patch of manifest.patches) {
    if (!/^[0-9]{3}-[a-z0-9-]+\.patch$/.test(patch.file) || !/^[0-9a-f]{64}$/.test(patch.sha256) ||
      !patch.files.length || patch.files.some((file) => !paths.includes(file))) throw new Error("Invalid patch inventory")
    const bytes = await readFile(path.join(patchRoot, patch.file))
    if (bytes.length !== patch.bytes || hash(bytes) !== patch.sha256) throw new Error(`Patch integrity failure: ${patch.file}`)
  }
  return { manifest, manifestHash: hash(bytes) }
}

export async function verifyTrackedSource(checkout: string, expectedTree: string) {
  if (!/^[0-9a-f]{40}$/.test(expectedTree)) throw new Error("Invalid expected source tree")
  const flagged = await git(checkout, ["ls-files", "-v", "-z"])
  if (flagged.split("\0").filter(Boolean).some((entry) => !entry.startsWith("H "))) {
    throw new Error("Source index contains assume-unchanged, skip-worktree, or unsupported entries")
  }
  const monitored = await git(checkout, ["ls-files", "-f", "-z"])
  if (monitored.split("\0").filter(Boolean).some((entry) => !entry.startsWith("H "))) {
    throw new Error("Source index contains fsmonitor-valid or unsupported entries")
  }
  if (await git(checkout, ["write-tree"]) !== expectedTree) throw new Error("Patched source tree mismatch")
  const listing = await git(checkout, ["ls-tree", "-r", "-z", "--full-tree", expectedTree])
  const entries = listing.split("\0").filter(Boolean).map((entry) => {
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(entry)
    if (!match || !safeRelative(match[3]!)) throw new Error("Unsupported entry in expected source tree")
    return { mode: match[1]!, blob: match[2]!, file: match[3]! }
  })
  if (!entries.length) throw new Error("Empty expected source tree")
  const linkFiles = process.platform === "win32" &&
    await git(checkout, ["config", "--type=bool", "--default=true", "--get", "core.symlinks"]) === "false"
  const directories = new Map<string, Promise<void>>()
  const blobHash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha1")
    .update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
  async function check(entry: typeof entries[number]) {
    const absolute = path.join(checkout, entry.file)
    const parent = path.dirname(absolute)
    if (!directories.has(parent)) directories.set(parent, (async () => {
      if (!samePath(await realpath(parent), parent)) throw new Error(`Source parent is redirected: ${entry.file}`)
    })())
    await directories.get(parent)
    const stat = await lstat(absolute)
    if (entry.mode === "120000" && stat.isSymbolicLink()) {
      // Hash the link itself, never the target. Windows may expose separators
      // differently from the link spelling recorded by Git.
      const target = await readlink(absolute)
      if (blobHash(Buffer.from(target)) !== entry.blob && !(process.platform === "win32" &&
        blobHash(Buffer.from(target.replaceAll("\\", "/"))) === entry.blob)) {
        throw new Error(`Source link target mismatch: ${entry.file}`)
      }
      return
    }
    // Git for Windows with core.symlinks=false writes the link-target bytes
    // as an ordinary file. This is valid only for a tree entry of mode 120000.
    if (!stat.isFile() || (entry.mode === "120000" && !linkFiles)) throw new Error(`Source file type mismatch: ${entry.file}`)
    if (entry.mode !== "120000" && process.platform !== "win32" && Boolean(stat.mode & 0o111) !== (entry.mode === "100755")) {
      throw new Error(`Source executable mode mismatch: ${entry.file}`)
    }
    if (blobHash(await readFile(absolute)) !== entry.blob) throw new Error(`Source blob mismatch: ${entry.file}`)
  }
  // Read every tracked file, including unchanged upstream files, without
  // trusting the Git stat cache, filters, index flags, or filesystem monitor.
  for (let offset = 0; offset < entries.length; offset += 32) {
    const results = await Promise.allSettled(entries.slice(offset, offset + 32).map(check))
    const failure = results.find((result) => result.status === "rejected")
    if (failure?.status === "rejected") throw failure.reason
  }
  return { trackedFiles: entries.length, trackedLinks: entries.filter((entry) => entry.mode === "120000").length }
}

async function inspect(checkout: string, manifest: Manifest) {
  const dotgit = path.join(checkout, ".git")
  if (!(await lstat(dotgit)).isDirectory() || (await lstat(dotgit)).isSymbolicLink() ||
    !samePath(await realpath(dotgit), dotgit)) throw new Error("An independent Git directory is required")
  if (!samePath(await git(checkout, ["rev-parse", "--show-toplevel"]), checkout) ||
    !samePath(await git(checkout, ["rev-parse", "--absolute-git-dir"]), dotgit)) throw new Error("Checkout is redirected")
  if (await git(checkout, ["rev-parse", "HEAD"]) !== manifest.upstream.commit ||
    await git(checkout, ["rev-parse", "HEAD^{tree}"]) !== manifest.upstream.tree) throw new Error("Upstream base mismatch")
  const tracked = await verifyTrackedSource(checkout, manifest.patchedTree)
  await git(checkout, ["diff", "--quiet", "--ignore-submodules", "--"])
  if (await git(checkout, ["ls-files", "--others", "--exclude-standard"])) throw new Error("Untracked files found in source checkout")
  if (await git(checkout, ["ls-files", "--others", "--ignored", "--exclude-standard", "--", ...manifest.inspectionRoots, ":(exclude,glob)**/node_modules/**"])) {
    throw new Error("Ignored files found inside source or build-script directories")
  }
  for (const file of manifest.files) {
    const absolute = path.join(checkout, file.path)
    if (file.deleted) {
      try { await lstat(absolute) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
      throw new Error(`Deleted source file exists: ${file.path}`)
    }
    if (!(await lstat(absolute)).isFile() || !samePath(await realpath(absolute), absolute)) throw new Error(`Source path is redirected: ${file.path}`)
    const bytes = await readFile(absolute)
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`Source content mismatch: ${file.path}`)
  }
  return tracked
}

async function main() {
  const [command, destination, flag, reference, ...extra] = process.argv.slice(2)
  if (!destination || !path.isAbsolute(destination) || !["prepare", "verify"].includes(command ?? "") || extra.length ||
    (flag !== undefined && (command !== "prepare" || flag !== "--reference" || !reference || !path.isAbsolute(reference))) ||
    (reference !== undefined && flag !== "--reference")) {
    throw new Error("Usage: bun run script/engine-source.ts prepare <new-absolute-directory> [--reference <absolute-local-repository>] | verify <absolute-directory>")
  }
  const checkout = path.resolve(destination)
  if (samePath(checkout, path.parse(checkout).root) || samePath(checkout, productRoot)) throw new Error("Unsafe destination")
  const { manifest, manifestHash } = await loadManifest()
  let tracked: Awaited<ReturnType<typeof inspect>>
  if (command === "prepare") {
    if (!samePath(await realpath(path.dirname(checkout)), path.dirname(checkout))) throw new Error("Destination parent is redirected")
    if (reference && (!samePath(await realpath(reference), reference) || !(await lstat(reference)).isDirectory())) {
      throw new Error("Reference must be an existing unredirected local repository")
    }
    // Exclusive creation is intentional: never clean, reset, or reuse an existing directory.
    await mkdir(checkout)
    await git(checkout, ["init", "--initial-branch=engine-source"])
    await git(checkout, ["config", "core.autocrlf", "false"])
    await git(checkout, ["config", "core.hooksPath", ".git/xingyao-disabled-hooks"])
    await git(checkout, ["remote", "add", "origin", manifest.upstream.repository])
    if (reference) await git(checkout, ["fetch", "--no-tags", "--depth=1", path.resolve(reference), manifest.upstream.commit])
    await git(checkout, ["fetch", "--no-tags", "--depth=1", "origin", manifest.upstream.commit])
    await git(checkout, ["checkout", "--detach", manifest.upstream.commit])
    if (await git(checkout, ["rev-parse", "HEAD^{tree}"]) !== manifest.upstream.tree) throw new Error("Fetched upstream tree mismatch")
    for (const patch of manifest.patches) {
      const file = path.join(patchRoot, patch.file)
      await git(checkout, ["apply", "--check", "--index", file])
      await git(checkout, ["apply", "--index", file])
      console.log(`Applied ${patch.file}`)
    }
    tracked = await inspect(checkout, manifest)
    await writeFile(path.join(checkout, ".git", markerName), JSON.stringify({
      format: 1, manifestHash, base: manifest.upstream.commit, tree: manifest.patchedTree, preparedAt: new Date().toISOString(),
    }, null, 2) + "\n", { flag: "wx" })
  } else {
    if (!samePath(await realpath(checkout), checkout)) throw new Error("Checkout is redirected")
    const marker = JSON.parse(await readFile(path.join(checkout, ".git", markerName), "utf8"))
    if (marker.format !== 1 || marker.manifestHash !== manifestHash || marker.base !== manifest.upstream.commit || marker.tree !== manifest.patchedTree) {
      throw new Error("Missing or outdated source preparation receipt; use prepare with a new directory")
    }
    tracked = await inspect(checkout, manifest)
  }
  console.log(JSON.stringify({ checkout, upstreamCommit: manifest.upstream.commit, sourceTree: manifest.patchedTree,
    manifestSha256: manifestHash, changedPaths: manifest.files.length, ...tracked, sourceVerified: true,
    dependenciesVerified: false, compiledEngineVerified: false }, null, 2))
}

if (import.meta.main) await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Engine source preparation failed")
  process.exitCode = 1
})
