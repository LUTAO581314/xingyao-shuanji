import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { WorkspaceFiles, type WorkspaceFilesOptions, type WorkspaceSaveBoundary, type WorkspaceRecoveryBoundary } from "../src/workspace-files"

const fixtureRoots: string[] = []
afterEach(() => {
  for (const directory of fixtureRoots.splice(0)) {
    const parent = resolve(dirname(directory))
    if (![resolve(tmpdir()), resolve("F:/")].includes(parent) || !/^xingyao-recovery-fixture-/.test(directory.split(/[\\/]/).at(-1)!)) throw new Error("Unsafe recovery fixture cleanup")
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

function fixture(base = tmpdir(), original = "original\n") {
  const directory = mkdtempSync(join(base, "xingyao-recovery-fixture-")); fixtureRoots.push(directory)
  const project = join(directory, "project"), state = join(directory, "private-state")
  mkdirSync(project); mkdirSync(state)
  const path = join(project, "note.md"); writeFileSync(path, original)
  const open = (options: WorkspaceFilesOptions = {}) => { const files = new WorkspaceFiles({ ...options, recoveryStateDirectory: state }), root = files.open(project); return { files, root } }
  return { directory, project, state, path, original, open }
}
type Fixture = ReturnType<typeof fixture>

function crashSave(f: Fixture, boundary: WorkspaceSaveBoundary, relativePath = "note.md") {
  const code = `import { WorkspaceFiles } from ${JSON.stringify(resolve(import.meta.dir, "../src/workspace-files.ts"))}; const files=new WorkspaceFiles({recoveryStateDirectory:process.env.TEST_STATE,afterBoundary(phase,context){if(phase===process.env.TEST_PHASE){console.log(context.recoveryDirectory);process.exit(42)}}}); const root=files.open(process.env.TEST_PROJECT); const before=files.read(root.id,process.env.TEST_PATH); files.save(root.id,process.env.TEST_PATH,{expectedSha256:before.sha256,text:'proposal\\n'});`
  const result = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, TEST_STATE: f.state, TEST_PROJECT: f.project, TEST_PHASE: boundary, TEST_PATH: relativePath }, stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 10000 })
  expect(result.exitCode, result.stderr.toString()).toBe(42)
  const recovery = result.stdout.toString().trim()
  expect(resolve(dirname(recovery))).toBe(resolve(f.project))
  return recovery
}
function crashRecovery(f: Fixture, boundary: WorkspaceRecoveryBoundary) {
  const code = `import { WorkspaceFiles } from ${JSON.stringify(resolve(import.meta.dir, "../src/workspace-files.ts"))}; const files=new WorkspaceFiles({recoveryStateDirectory:process.env.TEST_STATE,afterRecoveryBoundary(phase){if(phase===process.env.TEST_PHASE)process.exit(43)}}); const root=files.open(process.env.TEST_PROJECT); console.log(JSON.stringify(files.recover(root.id)));`
  const result = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, TEST_STATE: f.state, TEST_PROJECT: f.project, TEST_PHASE: boundary }, stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 10000 })
  expect(result.exitCode, result.stderr.toString() + result.stdout.toString()).toBe(43)
}
const boundaries: WorkspaceSaveBoundary[] = ["recovery-created", "backup-verified", "proposed-verified", "before-archive", "source-archived", "destination-created", "destination-written", "destination-verified"]
for (const base of [tmpdir(), ...(process.platform === "win32" && existsSync("F:/") ? ["F:/"] : [])]) {
  const volume = resolve(base).startsWith("F:") ? "actual F exFAT" : "temporary NTFS"
  for (const boundary of boundaries) test(`${volume}: fresh process recovers abrupt save exit at ${boundary}`, () => {
    const f = fixture(base), recovery = crashSave(f, boundary), { files, root } = f.open()
    const recovered = files.recover(root.id)
    const status = ["destination-written", "destination-verified"].includes(boundary) ? "committed" : ["source-archived", "destination-created"].includes(boundary) ? "restored" : "unchanged"
    expect(recovered.entries).toHaveLength(1)
    expect(recovered.entries[0]!.status, JSON.stringify(recovered)).toBe(status)
    expect(readFileSync(f.path, "utf8")).toBe(status === "committed" ? "proposal\n" : f.original)
    if (boundaries.indexOf(boundary) >= boundaries.indexOf("proposed-verified")) expect(readFileSync(join(recovery, "proposed"), "utf8")).toBe("proposal\n")
    if (["restored", "committed"].includes(status)) {
      expect(readFileSync(join(recovery, "original"), "utf8")).toBe(f.original)
      expect(readFileSync(join(recovery, "before"), "utf8")).toBe(f.original)
    }
    expect(files.recover(root.id).entries[0]!.status).toBe(status)
    const read = files.read(root.id, "note.md")
    expect(files.save(root.id, "note.md", { expectedSha256: read.sha256, text: "next save\n" }).changed).toBe(true)
  })

  for (const boundary of ["recovery-ready", "recovery-destination-created", "recovery-copy-progress", "recovery-destination-written", "recovery-restored"] as const) test(`${volume}: another interruption at ${boundary} keeps every version`, () => {
    const f = fixture(base, "x".repeat(131072) + "\n"), recovery = crashSave(f, "source-archived")
    crashRecovery(f, boundary)
    const before = existsSync(f.path) ? readFileSync(f.path) : null
    const { files, root } = f.open(), result = files.recover(root.id), entry = result.entries[0]!
    if (["recovery-destination-created", "recovery-copy-progress"].includes(boundary)) {
      expect(entry.status, JSON.stringify(result)).toBe("conflict")
      expect(readFileSync(f.path)).toEqual(before!)
    } else {
      expect(entry.status, JSON.stringify(result)).toBe("restored")
      expect(readFileSync(f.path, "utf8")).toBe(f.original)
    }
    expect(readFileSync(join(recovery, "original"), "utf8")).toBe(f.original)
    expect(readFileSync(join(recovery, "before"), "utf8")).toBe(f.original)
    expect(readFileSync(join(recovery, "proposed"), "utf8")).toBe("proposal\n")
  })
}

test("same identity changed content and identical-content replacement files are preserved", () => {
  for (const replacement of [false, true]) {
    const f = fixture(), recovery = crashSave(f, "destination-written")
    if (replacement) { renameSync(f.path, join(f.project, "moved.md")); writeFileSync(f.path, "proposal\n") }
    else writeFileSync(f.path, "external\n")
    const expected = readFileSync(f.path), { files, root } = f.open()
    expect(files.recover(root.id).entries[0]!.status).toBe("conflict")
    expect(readFileSync(f.path)).toEqual(expected)
    expect(readFileSync(join(recovery, "original"), "utf8")).toBe(f.original)
  }
})

test("external recreation after archive and external deletion after install never trigger overwrite", () => {
  const created = fixture(), a = crashSave(created, "source-archived")
  writeFileSync(created.path, "external\n")
  const first = created.open()
  expect(first.files.recover(first.root.id).entries[0]!.status).toBe("conflict")
  expect(readFileSync(created.path, "utf8")).toBe("external\n")
  expect(readFileSync(join(a, "original"), "utf8")).toBe(created.original)
  const deleted = fixture(); crashSave(deleted, "destination-written"); unlinkSync(deleted.path)
  const second = deleted.open()
  expect(second.files.recover(second.root.id).entries[0]!.status).toBe("conflict")
  expect(existsSync(deleted.path)).toBe(false)
})

test("replaced parent, root and junction identities leave unrelated files untouched", () => {
  for (const kind of ["parent", "root", "junction"] as const) {
    const f = fixture(), nested = join(f.project, "nested")
    mkdirSync(nested); renameSync(f.path, join(nested, "note.md"))
    crashSave(f, "source-archived", "nested/note.md")
    if (kind === "root") { renameSync(f.project, join(f.directory, "old-root")); mkdirSync(f.project); mkdirSync(nested) }
    else { renameSync(nested, join(f.project, "old-parent")); if (kind === "junction") { const outside = join(f.directory, "outside"); mkdirSync(outside); symlinkSync(outside, nested, process.platform === "win32" ? "junction" : "dir") } else mkdirSync(nested) }
    writeFileSync(join(nested, "note.md"), "external\n")
    const { files, root } = f.open(); files.recover(root.id)
    expect(readFileSync(join(nested, "note.md"), "utf8")).toBe("external\n")
  }
})

test("untrusted, old, tampered and truncated root journals are manual and cannot recreate files", () => {
  for (const kind of ["untrusted", "old", "tampered", "truncated"] as const) {
    const f = fixture(), recovery = crashSave(f, "source-archived")
    const latest = readdirSync(recovery).filter(name => /\.json$/.test(name)).sort().at(-1)!
    if (kind === "untrusted") { const ledger = join(f.state, recovery.split(/[\\/]/).at(-1)!.slice(".xingyao-edit-".length)); rmSync(ledger, { recursive: true }) }
    if (kind === "old") writeFileSync(join(recovery, latest), JSON.stringify({ format: 1, phase: "archived" }))
    if (kind === "tampered") { const path = join(recovery, latest), record = JSON.parse(readFileSync(path, "utf8")); record.relativePath = "other.md"; writeFileSync(path, JSON.stringify(record)) }
    if (kind === "truncated") unlinkSync(join(recovery, latest))
    const { files, root } = f.open(), result = files.recover(root.id)
    expect(result.entries[0]!.status).toBe("manual")
    expect(existsSync(f.path)).toBe(false)
    expect(readFileSync(join(recovery, "original"), "utf8")).toBe(f.original)
  }
})

test("root and file proofs survive a process boundary, reject changes and do not authorize arbitrary roots", () => {
  const f = fixture(), first = f.open(), rootProof = first.files.rootProof(first.root.id), proof = first.files.fileProof(first.root.id, "note.md")
  const next = f.open()
  expect(() => next.files.verifyRootProof(next.root.id, structuredClone(rootProof))).not.toThrow()
  expect(next.files.verifyFileProof(next.root.id, "note.md", structuredClone(proof)).text).toBe(f.original)
  expect(() => next.files.verifyRootProof("unknown", rootProof)).toThrow()
  writeFileSync(f.path, "external\n")
  expect(() => next.files.verifyFileProof(next.root.id, "note.md", proof)).toThrow()
  renameSync(f.project, join(f.directory, "moved-root")); mkdirSync(f.project); writeFileSync(f.path, f.original)
  const replaced = f.open()
  expect(() => replaced.files.verifyRootProof(replaced.root.id, rootProof)).toThrow()
})

test("a live save lock is respected by recovery in an actual separate process", () => {
  const f = fixture()
  let result: ReturnType<typeof Bun.spawnSync> | undefined
  const { files, root } = f.open({ afterBoundary(phase) {
    if (phase !== "source-archived") return
    const code = `import { WorkspaceFiles } from ${JSON.stringify(resolve(import.meta.dir, "../src/workspace-files.ts"))}; const files=new WorkspaceFiles({recoveryStateDirectory:process.env.TEST_STATE}); const root=files.open(process.env.TEST_PROJECT); console.log(JSON.stringify(files.recover(root.id)));`
    result = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, TEST_STATE: f.state, TEST_PROJECT: f.project }, stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 10000 })
  } })
  const read = files.read(root.id, "note.md")
  files.save(root.id, "note.md", { expectedSha256: read.sha256, text: "saved\n" })
  expect(result!.exitCode, result!.stderr?.toString()).toBe(0)
  expect(JSON.parse(result!.stdout!.toString()).entries[0].status).toBe("busy")
  expect(readFileSync(f.path, "utf8")).toBe("saved\n")
})

test("writes during recovery copying stop before another chunk overwrites external bytes", () => {
  const f = fixture(tmpdir(), "x".repeat(131072) + "\n"), recovery = crashSave(f, "source-archived")
  const { files, root } = f.open({ afterRecoveryBoundary(phase, context) {
    if (phase === "recovery-copy-progress") writeFileSync(context.absolutePath, "external at copy boundary\n")
  } })
  expect(files.recover(root.id).entries[0]!.status).toBe("conflict")
  expect(readFileSync(f.path, "utf8")).toBe("external at copy boundary\n")
  expect(readFileSync(join(recovery, "original"), "utf8")).toBe(f.original)
  const next = f.open()
  expect(next.files.recover(next.root.id).entries[0]!.status).toBe("conflict")
  expect(readFileSync(f.path, "utf8")).toBe("external at copy boundary\n")
})

test("replacing an ancestor above the selected root invalidates proof and recovery", () => {
  const f = fixture(), parent = join(f.directory, "parent"), oldParent = join(f.directory, "old-parent")
  mkdirSync(parent); const selected = join(parent, "selected"); renameSync(f.project, selected)
  const files = new WorkspaceFiles({ recoveryStateDirectory: f.state }), root = files.open(selected), proof = files.fileProof(root.id, "note.md")
  renameSync(parent, oldParent); mkdirSync(parent); renameSync(join(oldParent, "selected"), selected)
  expect(() => files.fileProof(root.id, "note.md")).toThrow()
  const next = new WorkspaceFiles({ recoveryStateDirectory: f.state }), nextRoot = next.open(selected)
  expect(() => next.verifyFileProof(nextRoot.id, "note.md", proof)).toThrow()
})

if (process.platform === "win32" && existsSync("F:/")) test("actual F exFAT caught failures restore without hard links and preserve proposal copies", () => {
  for (const selected of ["source-archived", "destination-created", "destination-written", "destination-verified"] as const) {
    const f = fixture("F:/"), { files, root } = f.open({ afterBoundary(phase) { if (phase === selected) throw new Error("synthetic save failure") } })
    const read = files.read(root.id, "note.md")
    expect(() => files.save(root.id, "note.md", { expectedSha256: read.sha256, text: "proposal\n" })).toThrow("原件已恢复")
    expect(readFileSync(f.path, "utf8")).toBe(f.original)
    const entry = files.recoveryList(root.id).entries[0]!
    expect(entry.status).toBe("restored")
    expect(readFileSync(entry.proposedPath!, "utf8")).toBe("proposal\n")
    expect(readFileSync(entry.backupPath!, "utf8")).toBe(f.original)
  }
})
