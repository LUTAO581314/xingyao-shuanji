import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { PRODUCT_VERSION } from "../src/contracts"

const executable = resolve(import.meta.dir, `../dist/xingyao-${PRODUCT_VERSION}/xingyao.exe`)
test.skipIf(process.platform !== "win32" || !existsSync(executable))("compiled Windows product starts, serves real assets, checkpoints and restores on another host", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xingyao-compiled-"))
  let child: ReturnType<typeof Bun.spawn> | undefined
  async function start(host: string) {
    child = Bun.spawn([executable, "--portable-root", join(dir, "portable"), "--host-root", host, "--offline", "--no-open"], { stdout: "ignore", stderr: "pipe", windowsHide: true })
    const until = Date.now() + 25_000
    while (Date.now() < until) {
      if (child.exitCode !== null) throw new Error(`Compiled product exited: ${child.stderr instanceof ReadableStream ? await new Response(child.stderr).text() : "stderr unavailable"}`)
      const running = await readFile(join(host, "running.json"), "utf8").then(value => JSON.parse(value) as { url: string }).catch(() => null)
      if (running?.url) {
        const url = new URL(running.url)
        return async (path: string, data?: unknown) => {
          const response = await fetch(`${url.origin}${path}`, { method: data ? "POST" : "GET", headers: { authorization: `Bearer ${decodeURIComponent(url.hash.slice(7))}`, "content-type": "application/json" }, body: data ? JSON.stringify(data) : undefined })
          return response
        }
      }
      await Bun.sleep(40)
    }
    throw new Error("Compiled product did not become ready")
  }
  async function exited() { await Promise.race([child!.exited, Bun.sleep(8000).then(() => { throw new Error("Compiled product did not exit cleanly") })]) }
  try {
    const api = await start(join(dir, "host-a"))
    expect(await (await api("/")).text()).toContain("经验技能")
    expect(await (await api("/app.js")).text()).toContain("refreshSkills")
    const original = await (await api("/api/state")).json()
    expect(original.version).toBe(PRODUCT_VERSION)
    const reopenedWindow = Bun.spawn([executable, "--portable-root", join(dir, "portable"), "--host-root", join(dir, "host-a"), "--offline", "--no-open"], { stdout: "pipe", stderr: "ignore", windowsHide: true })
    expect(await reopenedWindow.exited).toBe(0)
    expect(await new Response(reopenedWindow.stdout).text()).toContain("已经在运行")
    expect((await api("/api/memories", { key: "compiled-pref", text: "独立发行恢复验收", kind: "preference", scope: "global" })).status).toBe(201)
    expect((await api("/api/shutdown", {})).status).toBe(200)
    await exited()
    const reopened = await start(join(dir, "host-b"))
    expect((await (await reopened("/api/state")).json()).identityId).toBe(original.identityId)
    expect((await (await reopened("/api/memories")).json())[0].text).toBe("独立发行恢复验收")
    expect((await reopened("/api/shutdown", {})).status).toBe(200)
    await exited()
  } finally { if (child?.exitCode === null) { child.kill(); await child.exited }; await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 60_000)
