import { afterEach, expect, test } from "bun:test"
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { MAX_WORKSPACE_FILE_BYTES, WorkspaceFileError, WorkspaceFiles, type WorkspaceFilesOptions, type WorkspaceSaveBoundary } from "../src/workspace-files"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.includes("xingyao-workspace-files-")) throw new Error("Unexpected temporary fixture root")
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

function fixture(options: WorkspaceFilesOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "xingyao-workspace-files-")); roots.push(directory)
  const project = join(directory, "project"); mkdirSync(project)
  const path = join(project, "note.md")
  writeFileSync(path, "original\n")
  const files = new WorkspaceFiles(options), root = files.open(project)
  return { directory, project, path, files, root }
}

function failure(work: () => unknown): WorkspaceFileError {
  let error: unknown
  try { work() } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(WorkspaceFileError)
  return error as WorkspaceFileError
}

test("authorized roots browse bounded project entries and do not expose runtime, credential or recovery paths", () => {
  const f = fixture()
  for (const name of ["docs", ".git", ".xingyao-edit-private", ".product-restore-private", "node_modules"]) mkdirSync(join(f.project, name))
  for (const name of ["auth.json", ".env", "engine-config.json", "notes.txt", "photo.png"]) writeFileSync(join(f.project, name), "fixture")
  const protectedPath = join(f.project, "active-host"); mkdirSync(protectedPath)
  writeFileSync(join(protectedPath, "soul.db"), "synthetic runtime marker")
  const names = f.files.list(f.root.id).entries.map(entry => entry.name)
  expect(names).toEqual(["docs", "note.md", "notes.txt", "photo.png"])
  expect(f.files.list(f.root.id).entries.find(entry => entry.name === "photo.png")?.editable).toBe(false)
  expect(f.files.open(f.project).id).toBe(f.root.id)
  expect(f.files.roots()).toEqual([f.root])
  for (const value of ["../note.md", "docs/../note.md", "note.md:secret", "CON.txt", "note.md.", f.path, ".git/config", ".env", ".xingyao-edit-private/proposed"]) {
    expect(failure(() => f.files.read(f.root.id, value)).kind).toBe("denied")
  }
  expect(failure(() => f.files.read("unknown-root", "note.md")).kind).toBe("denied")
  expect(failure(() => f.files.open(protectedPath)).kind).toBe("denied")
  const restricted = new WorkspaceFiles({ protectedDirectories: [join(f.project, "docs")] })
  expect(failure(() => restricted.open(join(f.project, "docs"))).kind).toBe("denied")
  const restrictedRoot = restricted.open(f.project)
  expect(restricted.list(restrictedRoot.id).entries.some(entry => entry.name === "docs")).toBe(false)
})

test("real junctions and hardlinks are excluded and cannot be read or saved", () => {
  const f = fixture(), outside = join(f.directory, "outside")
  mkdirSync(outside); writeFileSync(join(outside, "external.md"), "outside")
  const junction = join(f.project, "linked")
  symlinkSync(outside, junction, process.platform === "win32" ? "junction" : "dir")
  linkSync(f.path, join(f.project, "hard.md"))
  expect(f.files.list(f.root.id).entries.some(entry => entry.name === "linked")).toBe(false)
  expect(failure(() => f.files.open(junction)).kind).toBe("denied")
  expect(failure(() => f.files.read(f.root.id, "linked/external.md")).kind).toBe("denied")
  expect(failure(() => f.files.read(f.root.id, "hard.md")).kind).toBe("denied")
  expect(failure(() => f.files.read(f.root.id, "note.md")).kind).toBe("denied")
  expect(readFileSync(join(outside, "external.md"), "utf8")).toBe("outside")
})

test("file and directory limits bound actual filesystem reads and UTF-8 writes", () => {
  const f = fixture()
  writeFileSync(join(f.project, "large.md"), Buffer.alloc(MAX_WORKSPACE_FILE_BYTES + 1, 65))
  writeFileSync(join(f.project, "binary.txt"), Buffer.from([0x61, 0, 0x62]))
  writeFileSync(join(f.project, "bad-utf8.txt"), Buffer.from([0xc3, 0x28]))
  writeFileSync(join(f.project, "private.txt"), "-----BEGIN PRIVATE KEY-----\nfixture-only")
  for (const name of ["large.md", "binary.txt", "bad-utf8.txt", "private.txt"]) failure(() => f.files.read(f.root.id, name))
  const read = f.files.read(f.root.id, "note.md")
  for (const text of ["中".repeat(MAX_WORKSPACE_FILE_BYTES / 2), "broken\ud800", "a\0b"]) failure(() => f.files.save(f.root.id, "note.md", { text, expectedSha256: read.sha256 }))
  expect(readFileSync(f.path, "utf8")).toBe("original\n")
  for (let n = 0; n < 510; n++) closeSync(openSync(join(f.project, `entry-${n}.md`), "wx"))
  const listing = f.files.list(f.root.id)
  expect(listing.truncated).toBe(true)
  expect(listing.entries.length).toBeLessThanOrEqual(500)
})

test("save preserves BOM and CRLF, archives the exact original and records verified proposal and commit", () => {
  const f = fixture()
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("first\r\nsecond\r\n")])
  writeFileSync(f.path, original)
  const read = f.files.read(f.root.id, "note.md")
  expect(read.bom).toBe(true); expect(read.lineEnding).toBe("crlf")
  const saved = f.files.save(f.root.id, "note.md", { expectedSha256: read.sha256, text: "new\ntext\n" })
  expect(saved.text).toBe("new\r\ntext\r\n")
  expect(saved.bom).toBe(true); expect(saved.changed).toBe(true)
  expect(readFileSync(saved.backupPath!)).toEqual(original)
  expect(readFileSync(join(dirname(saved.backupPath!), "before"))).toEqual(original)
  expect(readFileSync(join(dirname(saved.backupPath!), "proposed"))).toEqual(readFileSync(f.path))
  expect(readdirSync(dirname(saved.backupPath!)).some(name => name.endsWith("-committed.json"))).toBe(true)
  expect(f.files.list(f.root.id).entries.map(entry => entry.name)).toEqual(["note.md"])
  expect(failure(() => f.files.read(f.root.id, `${dirname(saved.backupPath!).split(/[\\/]/).at(-1)}/before`)).kind).toBe("denied")
  expect(f.files.save(f.root.id, "note.md", { expectedSha256: saved.sha256, text: "new\ntext\n" })).toMatchObject({ changed: false, backupPath: null })
})

test("optimistic saves reject unread, stale-content and identical-content replacement entries", () => {
  const f = fixture()
  expect(failure(() => f.files.save(f.root.id, "note.md", { expectedSha256: "0".repeat(64), text: "new" })).kind).toBe("conflict")
  const read = f.files.read(f.root.id, "note.md")
  writeFileSync(f.path, "external changed\n")
  expect(failure(() => f.files.save(f.root.id, "note.md", { expectedSha256: read.sha256, text: "new" })).kind).toBe("conflict")
  const reread = f.files.read(f.root.id, "note.md")
  renameSync(f.path, join(f.project, "external-original.md")); writeFileSync(f.path, reread.text)
  expect(failure(() => f.files.save(f.root.id, "note.md", { expectedSha256: reread.sha256, text: "new" })).kind).toBe("conflict")
  expect(readFileSync(f.path, "utf8")).toBe(reread.text)
})

test("a replaced parent directory invalidates a baseline even when the original file identity was moved into it", () => {
  const f = fixture(), nested = join(f.project, "nested"), archived = join(f.project, "old-parent")
  mkdirSync(nested); renameSync(f.path, join(nested, "note.md"))
  const read = f.files.read(f.root.id, "nested/note.md")
  renameSync(nested, archived); mkdirSync(nested); renameSync(join(archived, "note.md"), join(nested, "note.md"))
  expect(failure(() => f.files.save(f.root.id, "nested/note.md", { expectedSha256: read.sha256, text: "new" })).kind).toBe("conflict")
  expect(readFileSync(join(nested, "note.md"), "utf8")).toBe("original\n")
})

const boundaries: WorkspaceSaveBoundary[] = ["recovery-created", "backup-verified", "proposed-verified", "before-archive", "source-archived", "destination-created", "destination-written", "destination-verified"]
for (const phase of boundaries) test(`caught failure at ${phase} preserves or restores the original file`, () => {
  const f = fixture({ afterBoundary(boundary) { if (boundary === phase) throw new Error(`injected ${phase}`) } })
  const read = f.files.read(f.root.id, "note.md")
  const error = failure(() => f.files.save(f.root.id, "note.md", { expectedSha256: read.sha256, text: "proposed\n" }))
  expect(error.kind).toBe("recovery")
  expect(readFileSync(f.path, "utf8")).toBe("original\n")
  expect(error.recoveryDirectory).toBeTruthy()
  if (boundaries.indexOf(phase) >= boundaries.indexOf("proposed-verified")) expect(readFileSync(join(error.recoveryDirectory!, "proposed"), "utf8")).toBe("proposed\n")
  if (boundaries.indexOf(phase) >= boundaries.indexOf("source-archived")) {
    expect(error.message).toContain("原件已恢复")
    expect(readFileSync(error.backupPath!, "utf8")).toBe("original\n")
  }
  // Recovery released the save lock; an independent editor can read the result.
  const next = new WorkspaceFiles(), root = next.open(f.project)
  const baseline = next.read(root.id, "note.md")
  expect(next.save(root.id, "note.md", { expectedSha256: baseline.sha256, text: "subsequent\n" }).changed).toBe(true)
})

for (const phase of ["before-archive", "source-archived", "destination-created", "destination-written", "destination-verified"] as const) test(`external contents introduced at ${phase} are never overwritten by success or rollback`, () => {
  const f = fixture({ afterBoundary(boundary, context) { if (boundary === phase) writeFileSync(context.absolutePath, "EXTERNAL_EDIT\n") } })
  const read = f.files.read(f.root.id, "note.md")
  const error = failure(() => f.files.save(f.root.id, "note.md", { expectedSha256: read.sha256, text: "proposed\n" }))
  expect(readFileSync(f.path, "utf8")).toBe("EXTERNAL_EDIT\n")
  expect(readFileSync(join(error.recoveryDirectory!, "before"), "utf8")).toBe("original\n")
  expect(readFileSync(join(error.recoveryDirectory!, "proposed"), "utf8")).toBe("proposed\n")
  if (phase !== "before-archive") expect(readFileSync(join(error.recoveryDirectory!, "original"), "utf8")).toBe("original\n")
})

test("swapping the authorized parent for a real junction during save cannot write outside the project", () => {
  let outside = "", parent = "", moved = ""
  const f = fixture({ afterBoundary(phase) {
    if (phase === "before-archive") { renameSync(parent, moved); symlinkSync(outside, parent, process.platform === "win32" ? "junction" : "dir") }
  } })
  outside = join(f.directory, "outside"); mkdirSync(outside); writeFileSync(join(outside, "note.md"), "EXTERNAL\n")
  parent = join(f.project, "nested"); mkdirSync(parent); renameSync(f.path, join(parent, "note.md")); moved = join(f.project, "moved-parent")
  const read = f.files.read(f.root.id, "nested/note.md")
  failure(() => f.files.save(f.root.id, "nested/note.md", { expectedSha256: read.sha256, text: "proposed\n" }))
  expect(readFileSync(join(outside, "note.md"), "utf8")).toBe("EXTERNAL\n")
  expect(readdirSync(outside)).toEqual(["note.md"])
  expect(readFileSync(join(moved, "note.md"), "utf8")).toBe("original\n")
})

test("independent instances and overlapping roots cannot save over an in-flight proposal", () => {
  let second!: WorkspaceFiles, secondRoot = "", baseline = ""
  let attempted = false
  const f = fixture({ afterBoundary(phase) {
    if (phase === "before-archive") {
      attempted = true
      expect(failure(() => second.save(secondRoot, "project/note.md", { expectedSha256: baseline, text: "loser\n" })).kind).toBe("conflict")
    }
  } })
  second = new WorkspaceFiles(); secondRoot = second.open(f.directory).id; baseline = second.read(secondRoot, "project/note.md").sha256
  const read = f.files.read(f.root.id, "note.md")
  const saved = f.files.save(f.root.id, "note.md", { expectedSha256: read.sha256, text: "winner\n" })
  expect(attempted).toBe(true); expect(readFileSync(f.path, "utf8")).toBe("winner\n")
  expect(readFileSync(saved.backupPath!, "utf8")).toBe("original\n")
  expect(failure(() => second.save(secondRoot, "project/note.md", { expectedSha256: baseline, text: "stale\n" })).kind).toBe("conflict")
})

test("another actual Bun process observes the save lock and leaves the owner's file untouched", () => {
  let project = "", result: ReturnType<typeof Bun.spawnSync> | undefined
  const f = fixture({ afterBoundary(phase) {
    if (phase !== "before-archive") return
    const code = `import { WorkspaceFiles, WorkspaceFileError } from ${JSON.stringify(resolve(import.meta.dir, "../src/workspace-files.ts"))}; const w=new WorkspaceFiles(); const r=w.open(process.env.XINGYAO_TEST_PROJECT); const b=w.read(r.id,'note.md'); try { w.save(r.id,'note.md',{expectedSha256:b.sha256,text:'CHILD_OVERWRITE'}); process.exitCode=10; } catch(e) { if(!(e instanceof WorkspaceFileError)||e.kind!=='conflict') throw e; console.log('EXPECTED_SAVE_CONFLICT'); }`
    result = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, XINGYAO_TEST_PROJECT: project }, stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 5000 })
  } })
  project = f.project
  const read = f.files.read(f.root.id, "note.md")
  const saved = f.files.save(f.root.id, "note.md", { expectedSha256: read.sha256, text: "parent saved\n" })
  expect(result!.exitCode, result!.stderr?.toString()).toBe(0)
  expect(result!.stdout?.toString()).toContain("EXPECTED_SAVE_CONFLICT")
  expect(readFileSync(f.path, "utf8")).toBe("parent saved\n")
  expect(readFileSync(saved.backupPath!, "utf8")).toBe("original\n")
})

test("a swapped recovery directory cannot redirect proposal writes into an unrelated directory", () => {
  let outside = "", preserved = ""
  const f = fixture({ afterBoundary(phase, context) {
    if (phase === "backup-verified") {
      preserved = `${context.recoveryDirectory}-preserved`
      renameSync(context.recoveryDirectory, preserved)
      symlinkSync(outside, context.recoveryDirectory, process.platform === "win32" ? "junction" : "dir")
    }
  } })
  outside = join(f.directory, "outside"); mkdirSync(outside); writeFileSync(join(outside, "keep.txt"), "external")
  const read = f.files.read(f.root.id, "note.md")
  failure(() => f.files.save(f.root.id, "note.md", { expectedSha256: read.sha256, text: "proposal\n" }))
  expect(readdirSync(outside)).toEqual(["keep.txt"])
  expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("external")
  expect(readFileSync(f.path, "utf8")).toBe("original\n")
  expect(readFileSync(join(preserved, "before"), "utf8")).toBe("original\n")
})

test("abrupt process exit preserves archived original and proposal for manual recovery, then reclaims its stale lock", () => {
  const f = fixture()
  const code = `import { WorkspaceFiles } from ${JSON.stringify(resolve(import.meta.dir, "../src/workspace-files.ts"))}; const w=new WorkspaceFiles({afterBoundary(p,c){if(p==='source-archived'){console.log(c.recoveryDirectory);process.exit(42)}}}); const r=w.open(process.env.XINGYAO_TEST_PROJECT); const b=w.read(r.id,'note.md'); w.save(r.id,'note.md',{expectedSha256:b.sha256,text:'proposal before crash\\n'});`
  const result = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, XINGYAO_TEST_PROJECT: f.project }, stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 5000 })
  expect(result.exitCode, result.stderr?.toString()).toBe(42)
  const recovery = result.stdout!.toString().trim()
  expect(resolve(dirname(recovery))).toBe(resolve(f.project))
  expect(existsSync(f.path)).toBe(false)
  expect(readFileSync(join(recovery, "original"), "utf8")).toBe("original\n")
  expect(readFileSync(join(recovery, "before"), "utf8")).toBe("original\n")
  expect(readFileSync(join(recovery, "proposed"), "utf8")).toBe("proposal before crash\n")
  expect(failure(() => f.files.read(f.root.id, "note.md")).kind).toBe("conflict")
  // Explicit owner recovery: this is not an automatic startup feature.
  linkSync(join(recovery, "original"), f.path); unlinkSync(join(recovery, "original"))
  const read = f.files.read(f.root.id, "note.md")
  expect(f.files.save(f.root.id, "note.md", { expectedSha256: read.sha256, text: "after recovery\n" }).changed).toBe(true)
  expect(readFileSync(f.path, "utf8")).toBe("after recovery\n")
})
