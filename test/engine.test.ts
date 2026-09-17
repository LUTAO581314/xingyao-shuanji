import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { EngineStartError, startEngine } from "../src/engine"
import { PRODUCT_VERSION } from "../src/contracts"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (resolve(dirname(root)) !== resolve(tmpdir())) throw new Error("Unexpected test directory")
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "xingyao-engine-"))
  roots.push(root)
  const hostDir = join(root, "host")
  const projectDir = join(root, "project")
  await mkdir(hostDir)
  await mkdir(projectDir)
  return { root, hostDir, projectDir }
}

describe("owned OpenCode engine", () => {
  test("validates paths and timeout before spawning", async () => {
    const dirs = await fixture()
    await expect(startEngine({ ...dirs, executable: "relative.exe" })).rejects.toBeInstanceOf(EngineStartError)
    await expect(startEngine({ ...dirs, executable: join(dirs.root, "missing.exe") })).rejects.toThrow("executable is unavailable")
    await expect(startEngine({ ...dirs, executable: process.execPath, startupTimeoutMs: 0 })).rejects.toThrow("timeout")
  })

  test("accepts only explicitly selected product configuration within hostDir", async () => {
    const dirs = await fixture()
    const outside = join(dirs.root, "outside.json")
    await writeFile(outside, "{}")
    await expect(startEngine({ ...dirs, executable: process.execPath, configPath: outside })).rejects.toThrow("within hostDir")
    const configPath = join(dirs.hostDir, "provider.json")
    for (const content of ["invalid-json", "[]", '{"permission":"allow"}', '{"soul":{"enabled":true}}', '{"plugin":["external-plugin"]}', '{"provider":{"test":{"options":{"apiKey":"{file:../legacy/auth.json}"}}}}']) {
      await writeFile(configPath, content)
      await expect(startEngine({ ...dirs, executable: process.execPath, configPath })).rejects.toBeInstanceOf(EngineStartError)
    }
  })

  test("an exited child yields a bounded, sanitized startup failure", async () => {
    const dirs = await fixture()
    // Bun itself has no local 'serve' entrypoint in this empty project, so it exits.
    await expect(startEngine({ ...dirs, executable: process.execPath, startupTimeoutMs: 1000 })).rejects.toBeInstanceOf(EngineStartError)
  }, 5000)
})

const executable = process.env.XINGYAO_TEST_OPENCODE ?? resolve(import.meta.dir, "../dist", `xingyao-${PRODUCT_VERSION}`, "opencode.exe")
const real = process.platform === "win32" && existsSync(executable) ? test : test.skip
real("startup timeout terminates its own real child before returning", async () => {
  const dirs = await fixture()
  const error = await startEngine({ ...dirs, executable, startupTimeoutMs: 1 }).then(async (engine) => { await engine.stop(); return undefined }, (error: unknown) => error)
  expect(error).toBeInstanceOf(EngineStartError)
  expect((error as EngineStartError).kind).toBe("timeout")
  const pid = (error as EngineStartError).pid
  expect(pid).toBeNumber()
  expect(() => process.kill(pid!, 0)).toThrow()
}, 10_000)

real("stop is idempotent and does not kill a separately owned engine", async () => {
  const a = await fixture()
  const b = await fixture()
  const first = await startEngine({ ...a, executable })
  let second: Awaited<ReturnType<typeof startEngine>> | undefined
  try {
    second = await startEngine({ ...b, executable })
    expect(first.pid).not.toBe(second.pid)
    expect(first.version).toBeTruthy()
    expect((await second.adapter.health()).ok).toBe(true)
    await Promise.all([first.stop(), first.stop()])
    expect((await first.adapter.health()).ok).toBe(false)
    expect((await second.adapter.health()).ok).toBe(true)
  } finally { await first.stop(); await second?.stop() }
}, 40_000)
