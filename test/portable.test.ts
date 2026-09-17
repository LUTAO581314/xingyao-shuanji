import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mountPortable } from "../src/portable"

test.skipIf(process.platform !== "win32")("portable identity keeps the same workspace path after changing its physical directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "xingyao-mount-"))
  let first: ReturnType<typeof mountPortable> | undefined, second: ReturnType<typeof mountPortable> | undefined
  try {
    const a = join(dir, "便携 A user's data & workspace"), b = join(dir, "迁移 B 工作目录")
    mkdirSync(a); mkdirSync(b)
    writeFileSync(join(a, "drive.json"), JSON.stringify({ driveId: crypto.randomUUID() }))
    writeFileSync(join(a, "marker.txt"), "first physical directory")
    first = mountPortable(a)
    expect(readFileSync(join(first.root, "marker.txt"), "utf8")).toBe("first physical directory")
    const marker = readFileSync(join(a, "drive.json"), "utf8")
    const identity = JSON.parse(marker)
    expect(identity.preferredLetter).toBe(first.root[0])
    const shared = mountPortable(a)
    expect(shared.root).toBe(first.root)
    shared.release()
    expect(readFileSync(join(first.root, "marker.txt"), "utf8")).toBe("first physical directory")
    writeFileSync(join(b, "drive.json"), marker)
    expect(() => mountPortable(b)).toThrow("占用")
    first.release()
    writeFileSync(join(b, "marker.txt"), "second physical directory")
    second = mountPortable(b)
    expect(second.root).toBe(first.root)
    expect(readFileSync(join(second.root, "marker.txt"), "utf8")).toBe("second physical directory")
  } finally { second?.release(); first?.release(); rmSync(dir, { recursive: true, force: true }) }
})

test.skipIf(process.platform !== "win32")("failed portable identity persistence releases only its newly created mapping", () => {
  const dir = mkdtempSync(join(tmpdir(), "xingyao-mount-failure-"))
  const letters = () => Bun.spawnSync(["subst.exe"], { stdout: "pipe", stderr: "ignore", windowsHide: true }).stdout.toString().split(/\r?\n/).map(line => /^([A-Z]):/i.exec(line)?.[1]).filter(Boolean).sort()
  try {
    const portable = join(dir, "中文失败目录")
    mkdirSync(portable)
    writeFileSync(join(portable, "drive.json"), JSON.stringify({ driveId: crypto.randomUUID() }))
    mkdirSync(join(portable, "drive.previous.json"))
    const before = letters()
    expect(() => mountPortable(portable)).toThrow()
    expect(letters()).toEqual(before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
