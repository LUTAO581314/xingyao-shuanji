import { afterEach, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readlink, realpath, rename, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { verifyTrackedSource } from "../script/engine-source"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (resolve(dirname(root)) !== resolve(await realpath(tmpdir()))) throw new Error("Unexpected source test directory")
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
  }
})

async function git(root: string, args: string[], input?: Uint8Array) {
  const child = Bun.spawn(["git", "-c", `safe.directory=${root.replaceAll("\\", "/")}`, ...args], {
    cwd: root, stdin: input ?? "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, ".git", "no-global-config") },
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`Fixture Git failed: ${stderr}`)
  return stdout.trim()
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "xingyao-source-test-")))
  roots.push(root)
  await git(root, ["init", "--initial-branch=source-test"])
  await git(root, ["config", "core.autocrlf", "false"])
  await git(root, ["config", "core.symlinks", "false"])
  await mkdir(join(root, "script"))
  await writeFile(join(root, "script/build.ts"), "const answer = 1\n")
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 255, 128, 10, 13, 0]))
  await git(root, ["add", "--", "script/build.ts", "binary.bin"])
  return { root, tree: await git(root, ["write-tree"]) }
}

test("source provenance hashes every tracked text and binary file against the expected tree", async () => {
  const f = await fixture()
  expect(await verifyTrackedSource(f.root, f.tree)).toEqual({ trackedFiles: 2, trackedLinks: 0 })
  const file = join(f.root, "script/build.ts")
  const before = await lstat(file)
  await writeFile(file, "const answer = 2\n")
  await utimes(file, before.atime, before.mtime)
  await expect(verifyTrackedSource(f.root, f.tree)).rejects.toThrow("Source blob mismatch: script/build.ts")
  await writeFile(file, "const answer = 1\n")
  await writeFile(join(f.root, "binary.bin"), Buffer.from([0, 255, 129, 10, 13, 0]))
  await expect(verifyTrackedSource(f.root, f.tree)).rejects.toThrow("Source blob mismatch: binary.bin")
})

for (const flag of ["assume-unchanged", "skip-worktree"]) test(`source provenance rejects ${flag} even before content changes`, async () => {
  const f = await fixture()
  await git(f.root, ["update-index", `--${flag}`, "script/build.ts"])
  await expect(verifyTrackedSource(f.root, f.tree)).rejects.toThrow("Source index contains")
  await writeFile(join(f.root, "script/build.ts"), "const answer = 9\n")
  await expect(verifyTrackedSource(f.root, f.tree)).rejects.toThrow("Source index contains")
})

test("source provenance rejects a changed index tree and missing tracked files", async () => {
  const f = await fixture()
  await writeFile(join(f.root, "script/build.ts"), "const answer = 3\n")
  await git(f.root, ["add", "--", "script/build.ts"])
  await expect(verifyTrackedSource(f.root, f.tree)).rejects.toThrow("Patched source tree mismatch")
  const changed = await git(f.root, ["write-tree"])
  await unlink(join(f.root, "binary.bin"))
  await expect(verifyTrackedSource(f.root, changed)).rejects.toThrow()
})

test("source provenance rejects redirected parents and regular files replaced with links", async () => {
  const f = await fixture()
  await rename(join(f.root, "script"), join(f.root, "moved-script"))
  await symlink(join(f.root, "moved-script"), join(f.root, "script"), process.platform === "win32" ? "junction" : "dir")
  await expect(verifyTrackedSource(f.root, f.tree)).rejects.toThrow("Source parent is redirected")
  await unlink(join(f.root, "script"))
  await rename(join(f.root, "moved-script"), join(f.root, "script"))
  await unlink(join(f.root, "binary.bin"))
  await symlink(join(f.root, "script"), join(f.root, "binary.bin"), process.platform === "win32" ? "junction" : "dir")
  await expect(verifyTrackedSource(f.root, f.tree)).rejects.toThrow("Source file type mismatch: binary.bin")
})

test("source provenance hashes native link targets without following them", async () => {
  const f = await fixture()
  const link = join(f.root, "directory-link")
  await symlink(join(f.root, "script"), link, process.platform === "win32" ? "junction" : "dir")
  const target = await readlink(link)
  const blob = await git(f.root, ["hash-object", "-w", "--stdin"], Buffer.from(target))
  await git(f.root, ["update-index", "--add", "--cacheinfo", `120000,${blob},directory-link`])
  const tree = await git(f.root, ["write-tree"])
  expect(await verifyTrackedSource(f.root, tree)).toEqual({ trackedFiles: 3, trackedLinks: 1 })
  await unlink(link)
  await symlink(f.root, link, process.platform === "win32" ? "junction" : "dir")
  await expect(verifyTrackedSource(f.root, tree)).rejects.toThrow("Source link target mismatch")
})

test("source provenance accepts Git for Windows link files only with the matching target bytes and checkout mode", async () => {
  const f = await fixture()
  const link = join(f.root, "source-link")
  await writeFile(link, "script/build.ts")
  const blob = await git(f.root, ["hash-object", "-w", "--", link])
  await git(f.root, ["update-index", "--add", "--cacheinfo", `120000,${blob},source-link`])
  const tree = await git(f.root, ["write-tree"])
  if (process.platform !== "win32") {
    await expect(verifyTrackedSource(f.root, tree)).rejects.toThrow("Source file type mismatch")
    return
  }
  expect(await verifyTrackedSource(f.root, tree)).toEqual({ trackedFiles: 3, trackedLinks: 1 })
  await writeFile(link, "binary.bin")
  await expect(verifyTrackedSource(f.root, tree)).rejects.toThrow("Source blob mismatch: source-link")
  await writeFile(link, "script/build.ts")
  await git(f.root, ["config", "core.symlinks", "true"])
  await expect(verifyTrackedSource(f.root, tree)).rejects.toThrow("Source file type mismatch")
})
