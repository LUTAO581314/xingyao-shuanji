import { existsSync, readFileSync, writeFileSync, renameSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"

/** Stable Windows workspace paths are required by OpenCode's stored session directory. */
export function mountPortable(portableRoot: string): { root: string; release(): void } {
  if (process.platform !== "win32") return { root: portableRoot, release() {} }
  const target = resolve(portableRoot)
  const markerPath = join(target, "drive.json")
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { driveId: string; preferredLetter?: string }
  if (typeof marker.driveId !== "string") throw new Error("便携身份标识缺失")
  const normalize = (path: string) => resolve(path).replace(/\\+$/, "").toLowerCase()
  const physicalTarget = normalize(realpathSync.native(target))
  const mappings = () => {
    const result = Bun.spawnSync(["subst.exe"], { stdout: "pipe", stderr: "pipe", windowsHide: true })
    if (result.exitCode !== 0) throw new Error("无法读取 Windows 路径映射")
    const found = new Map<string, string | null>()
    for (const line of result.stdout.toString().split(/\r?\n/)) {
      // SUBST emits the target in the active Windows code page. Read only the
      // ASCII drive letter; resolve the Unicode target through filesystem APIs.
      const match = /^([A-Z]):\\:\s*=>/i.exec(line.trim())
      if (match) {
        const letter = match[1]!.toUpperCase()
        try { found.set(letter, normalize(realpathSync.native(`${letter}:\\`))) }
        catch { found.set(letter, null) } // Broken/unknown mappings stay occupied.
      }
    }
    return found
  }
  const existing = mappings()
  if (marker.preferredLetter && !/^[D-Z]$/.test(marker.preferredLetter)) throw new Error("稳定盘符设置无效")
  const candidates = marker.preferredLetter ? [marker.preferredLetter] : ["X", "Y", "Z", "R", "Q", "P", "N", "M"]
  for (const letter of candidates) {
    const mapped = existing.get(letter)
    const same = mapped === physicalTarget
    if (!same && (existing.has(letter) || existsSync(`${letter}:\\`))) {
      if (marker.preferredLetter) throw new Error(`星杳使用的稳定路径 ${letter}: 已被其他设备占用。请释放该盘符后重试；会话数据未修改。`)
      continue
    }
    const root = `${letter}:\\`
    const created = !same
    if (created) {
      const result = Bun.spawnSync(["subst.exe", `${letter}:`, target], { stdout: "pipe", stderr: "pipe", windowsHide: true })
      if (result.exitCode !== 0) { if (marker.preferredLetter) throw new Error("创建稳定工作路径失败"); continue }
    }
    const releaseCreated = () => {
      if (created && mappings().get(letter) === physicalTarget) Bun.spawnSync(["subst.exe", `${letter}:`, "/D"], { stdout: "ignore", stderr: "ignore", windowsHide: true })
    }
    try {
      const mappedIdentity = JSON.parse(readFileSync(join(root, "drive.json"), "utf8")) as { driveId: string }
      if (mappedIdentity.driveId !== marker.driveId || mappings().get(letter) !== physicalTarget) throw new Error("工作路径映射与便携身份不一致")
      if (!marker.preferredLetter) {
        // The identity marker is tiny; keep the previous marker for recovery on exFAT.
        writeFileSync(join(target, "drive.previous.json"), JSON.stringify(marker))
        const next = JSON.stringify({ ...marker, preferredLetter: letter })
        const temporary = join(target, `drive-${crypto.randomUUID()}.json`)
        writeFileSync(temporary, next, { flag: "wx" })
        try { renameSync(temporary, markerPath) } catch { writeFileSync(markerPath, next) }
      }
    } catch (error) {
      // A failed first mount must not leak the mapping it just created.
      try { releaseCreated() } catch { /* Preserve the original failure. */ }
      throw error
    }
    let released = false
    return { root, release() {
      if (released || !created) return
      released = true
      releaseCreated()
    } }
  }
  throw new Error("没有可用的稳定盘符，无法保证会话跨设备接续")
}
