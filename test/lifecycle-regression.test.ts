import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { SoulStore } from "../src/store"
import { ModelConfigurationError, startServer } from "../src/server"
import { main } from "../src/main"
import type { OpenCodeAdapter } from "../src/adapter"

const directories: string[] = []
const cleanup: Array<() => void | Promise<void>> = []
const signals = ["SIGINT", "SIGTERM"] as const
const existingListeners = new Map<string, Set<(...args: any[]) => void>>()

beforeEach(() => {
  for (const signal of signals) existingListeners.set(signal, new Set(process.listeners(signal)))
})

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  for (const signal of signals) {
    for (const listener of process.listeners(signal)) if (!existingListeners.get(signal)?.has(listener)) process.removeListener(signal, listener)
  }
  for (const directory of directories.splice(0)) {
    if (resolve(dirname(directory)) !== resolve(tmpdir()) || !directory.includes("xingyao-lifecycle-")) throw new Error("Unexpected temporary test directory")
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "xingyao-lifecycle-"))
  directories.push(directory)
  return directory
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function switchingModel() {
  const directory = await temporary()
  const store = new SoulStore(join(directory, "soul.db"))
  const started = deferred()
  const released = deferred()
  let prompts = 0
  const adapter = {
    health: async () => ({ ok: true }), createSession: async () => ({ id: "test-session" }), messages: async () => [],
    prompt: async () => { prompts++; return { status: "completed", messageID: "test-response", text: "completed", parts: [] } },
  } as unknown as OpenCodeAdapter
  const app = startServer({ store, adapter, token: "lifecycle-fixture-token", vaultDir: join(directory, "vault"),
    configureModel: async () => { started.resolve(); await released.promise; return adapter },
  })
  const request = (path: string, body: unknown) => fetch(`http://127.0.0.1:${app.server.port}${path}`, { method: "POST",
    headers: { authorization: "Bearer lifecycle-fixture-token", "content-type": "application/json" }, body: JSON.stringify(body),
  })
  cleanup.push(async () => { released.resolve(); await app.server.stop(true); await Promise.allSettled([...app.jobs.values()]); store.close() })
  const configuration = request("/api/settings/model", { baseURL: "http://127.0.0.1:9/v1", model: "test", apiKey: "fixture-only" })
  await started.promise
  return { store, app, request, configuration, released, prompts: () => prompts }
}

test("model switching excludes new prompt dispatch until the adapter replacement commits", async () => {
  const fixture = await switchingModel()
  const task = fixture.store.createTask("test", "project-a")
  let response: Response
  try {
    response = await fixture.request(`/api/tasks/${task.id}/chat`, { key: "during-model-change", text: "run a test operation" })
  } finally { fixture.released.resolve() }
  await fixture.configuration
  await Promise.allSettled([...fixture.app.jobs.values()])
  expect(response.status).toBe(409)
  expect(fixture.prompts()).toBe(0)
})

test("an external checkpoint cannot snapshot across a single in-flight model mutation", async () => {
  const fixture = await switchingModel()
  let error: unknown
  try { await fixture.app.checkpoint() } catch (caught) { error = caught }
  finally { fixture.released.resolve() }
  await fixture.configuration
  expect(error).toBeInstanceOf(Error)
})

test("concurrent lifecycle stop calls share one shutdown and one server close", async () => {
  const directory = await temporary()
  const runtime = await main(["--portable-root", join(directory, "portable"), "--host-root", join(directory, "host"),
    "--engine", join(directory, "absent-engine.exe"), "--offline", "--no-open"])
  if (!runtime) throw new Error("The offline runtime did not start")
  cleanup.push(() => runtime.stop())
  const released = deferred()
  const original = runtime.server.stop.bind(runtime.server)
  let serverStops = 0
  runtime.server.stop = async (...args: Parameters<typeof original>) => { serverStops++; await released.promise; return original(...args) }
  const first = runtime.stop()
  const second = runtime.stop()
  try { await Bun.sleep(50) } finally { released.resolve() }
  await Promise.all([first, second])
  expect(serverStops).toBe(1)
})

test("a failed model change replaces the stopped adapter with the recovered adapter", async () => {
  const directory = await temporary()
  const store = new SoulStore(join(directory, "soul.db"))
  let oldHealthCalls = 0
  let recoveredHealthCalls = 0
  const oldAdapter = { health: async () => { oldHealthCalls++; return { ok: true, version: "old-process" } } } as unknown as OpenCodeAdapter
  const recoveredAdapter = { health: async () => { recoveredHealthCalls++; return { ok: true, version: "recovered-process" } } } as unknown as OpenCodeAdapter
  const app = startServer({
    store, adapter: oldAdapter, token: "lifecycle-recovery-token", vaultDir: join(directory, "vault"),
    configureModel: async () => { throw new ModelConfigurationError("fixture configuration rejected; previous settings restored", recoveredAdapter) },
  })
  cleanup.push(async () => { await app.server.stop(true); store.close() })
  const request = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${app.server.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer lifecycle-recovery-token", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  expect(await (await request("/api/engine")).json()).toMatchObject({ ok: true, version: "old-process" })
  expect(oldHealthCalls).toBe(1)
  const failed = await request("/api/settings/model", { baseURL: "http://127.0.0.1:9/v1", model: "rejected-fixture", apiKey: "fixture-only" })
  expect(failed.status).toBe(400)
  expect((await failed.json()).error).toContain("previous settings restored")
  for (let attempt = 0; attempt < 2; attempt++) {
    const health = await request("/api/engine")
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ ok: true, version: "recovered-process" })
  }
  expect(recoveredHealthCalls).toBe(2)
  expect(oldHealthCalls).toBe(1)
})
