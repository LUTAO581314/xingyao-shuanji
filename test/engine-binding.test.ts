import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { main } from "../src/main"
import { SCHEMA_VERSION } from "../src/contracts"
import { SoulStore } from "../src/store"

const executable = process.env.XINGYAO_TEST_OPENCODE ?? resolve(import.meta.dir, "../dist/engines/0.0.0-product-dev-20260918-engine.6-source/opencode.exe")
const real = process.platform === "win32" && (existsSync(executable) || !!process.env.XINGYAO_TEST_OPENCODE) ? test : test.skip
const roots: string[] = []
const runtimes: NonNullable<Awaited<ReturnType<typeof main>>>[] = []
const signals = ["SIGINT", "SIGTERM"] as const
const originalListeners = new Map<string, Set<(...args: any[]) => void>>()
let engineVersion = "", engineHash = ""
const hash = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex")

beforeAll(() => {
  if (process.platform !== "win32" || !existsSync(executable)) return
  const result = Bun.spawnSync([executable, "--version"], { stdout: "pipe", stderr: "ignore", windowsHide: true, timeout: 10_000 })
  expect(result.exitCode).toBe(0)
  engineVersion = result.stdout!.toString().trim()
  expect(engineVersion).toMatch(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/)
  engineHash = hash(executable)
})
beforeEach(() => {
  for (const signal of signals) originalListeners.set(signal, new Set(process.listeners(signal)))
})
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) { await runtime.stop(); await runtime.closed }
  for (const signal of signals) {
    for (const listener of process.listeners(signal)) if (!originalListeners.get(signal)?.has(listener)) process.removeListener(signal, listener)
  }
  for (const root of roots.splice(0)) {
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.includes("xingyao-engine-binding-")) throw new Error("Unexpected temporary identity")
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xingyao-engine-binding-")); roots.push(root)
  const host = join(root, "host"), project = join(root, "project"), portable = join(root, "portable")
  for (const path of [host, project, portable]) mkdirSync(path)
  return { root, host, project, portable, database: join(host, "soul.db") }
}
type Fixture = ReturnType<typeof fixture>
function prepare(f: Fixture, version?: string, sha256?: string, oldSchema = true) {
  const store = new SoulStore(f.database)
  try {
    store.explicitMemory({ key: "binding-fixture", scope: "binding", kind: "fact", text: "Synthetic identity for engine binding only" })
    if (version !== undefined) store.setMeta("engine_version", version)
    if (sha256 !== undefined) store.setMeta("engine_sha256", sha256)
    if (oldSchema) {
      store.db.exec("DROP TABLE action_revisions")
      store.db.query("DELETE FROM meta WHERE key IN ('action_evidence_version','source_revision_version','action_evidence_validation_version','root_learning_policy_version')").run()
      store.db.exec("PRAGMA user_version=1")
    }
  } finally { store.close() }
}
function syntheticEngineDatabase(f: Fixture, name = "opencode-product-dev.db") {
  const directory = join(f.host, "opencode", "data", "opencode"); mkdirSync(directory, { recursive: true })
  const path = join(directory, name)
  const db = new Database(path)
  try { db.exec("CREATE TABLE test_evidence(value TEXT)"); db.query("INSERT INTO test_evidence VALUES (?)").run("Synthetic fixture; never pass this database to an engine") }
  finally { db.close(true) }
  return path
}
function inspect(path: string) {
  const db = new Database(path, { readonly: true, strict: true })
  try {
    const meta = (key: string) => db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key=?").get(key)?.value ?? ""
    return { version: meta("engine_version"), sha256: meta("engine_sha256"), identity: meta("identity_id"), revision: meta("revision"), schema: db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version }
  } finally { db.close(true) }
}
async function start(f: Fixture, options: { offline?: boolean; engine?: string } = {}) {
  const runtime = await main(["--portable-root", f.portable, "--host-root", f.host, "--project", f.project,
    "--engine", options.engine ?? executable, "--no-open", ...(options.offline ? ["--offline"] : [])])
  if (!runtime) throw new Error("The isolated product runtime did not start")
  runtimes.push(runtime)
  const url = new URL(JSON.parse(readFileSync(join(f.host, "running.json"), "utf8")).url)
  const api = async <T>(path: string, body?: unknown, expected = 200): Promise<T> => {
    const response = await fetch(`${url.origin}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${decodeURIComponent(url.hash.slice(7))}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    expect(response.status).toBe(expected)
    return await response.json() as T
  }
  return { runtime, api }
}

real("same-host engine version mismatch is rejected before domain migration or engine database writes", async () => {
  expect(existsSync(executable)).toBe(true)
  const f = fixture(); prepare(f, "0.0.0-product-binding-other-version", engineHash)
  const engineDb = syntheticEngineDatabase(f)
  const before = inspect(f.database), domainBytes = hash(f.database), engineBytes = hash(engineDb)
  await expect(start(f)).rejects.toThrow("宿主引擎版本")
  expect(inspect(f.database)).toEqual(before)
  expect(hash(f.database)).toBe(domainBytes)
  expect(hash(engineDb)).toBe(engineBytes)
  expect(before.schema).toBe(1)
  expect(existsSync(join(f.host, "engine-config.json"))).toBe(false)
  expect(existsSync(join(f.host, "running.json"))).toBe(false)
  expect(existsSync(join(f.host, ".xingyao-writer.lock"))).toBe(false)
})

real("same-version but different engine SHA-256 is rejected without replacing the saved binding", async () => {
  const f = fixture(), wrongHash = engineHash[0] === "0" ? "1" + engineHash.slice(1) : "0" + engineHash.slice(1)
  prepare(f, engineVersion, wrongHash)
  const engineDb = syntheticEngineDatabase(f)
  const before = inspect(f.database), domainBytes = hash(f.database), engineBytes = hash(engineDb)
  await expect(start(f)).rejects.toThrow("SHA-256")
  expect(inspect(f.database)).toEqual(before)
  expect(hash(f.database)).toBe(domainBytes)
  expect(hash(engineDb)).toBe(engineBytes)
  expect(existsSync(join(f.host, "running.json"))).toBe(false)
})

for (const name of ["opencode.db", "opencode-product-dev.db"]) real(`existing ${name} without a version binding is never adopted implicitly`, async () => {
  const f = fixture(); prepare(f)
  const engineDb = syntheticEngineDatabase(f, name), before = inspect(f.database), domainBytes = hash(f.database), engineBytes = hash(engineDb)
  await expect(start(f)).rejects.toThrow("缺少版本绑定")
  expect(inspect(f.database)).toEqual(before)
  expect(hash(f.database)).toBe(domainBytes)
  expect(hash(engineDb)).toBe(engineBytes)
  expect(existsSync(join(f.host, "engine-config.json"))).toBe(false)
})

real("offline startup can inspect a differently bound identity without starting or rebinding its engine", async () => {
  const f = fixture(), oldVersion = "0.0.0-product-offline-preserved", oldHash = "9".repeat(64)
  prepare(f, oldVersion, oldHash)
  const engineDb = syntheticEngineDatabase(f), engineBytes = hash(engineDb), identity = inspect(f.database).identity
  const { runtime, api } = await start(f, { offline: true })
  expect((await api<{ ok: boolean }>("/api/engine")).ok).toBe(false)
  expect(inspect(f.database)).toMatchObject({ identity, version: oldVersion, sha256: oldHash, schema: SCHEMA_VERSION })
  expect(hash(engineDb)).toBe(engineBytes)
  expect(existsSync(join(f.host, "opencode", "home"))).toBe(false)
  await runtime.stop(); await runtime.closed
  expect(hash(engineDb)).toBe(engineBytes)
  expect(inspect(f.database).version).toBe(oldVersion)
})

real("the real source-built engine binds a new identity and restarts against the same version and bytes", async () => {
  const f = fixture()
  const first = await start(f)
  const health = await first.api<{ ok: boolean; version: string }>("/api/engine")
  expect(health).toMatchObject({ ok: true, version: engineVersion })
  const bound = inspect(f.database)
  expect(bound.version).toBe(engineVersion)
  expect(bound.sha256).toBe(engineHash)
  await first.runtime.stop(); await first.runtime.closed
  expect(JSON.parse(readFileSync(join(f.host, "running.json"), "utf8")).stopped).toBe(true)
  expect(existsSync(join(f.host, ".xingyao-writer.lock"))).toBe(false)
  const second = await start(f)
  expect(await second.api<{ ok: boolean; version: string }>("/api/engine")).toMatchObject({ ok: true, version: engineVersion })
  expect(inspect(f.database)).toMatchObject({ identity: bound.identity, version: engineVersion, sha256: engineHash })
  await second.api("/api/settings/model", { baseURL: "http://127.0.0.1:9/v1", model: "binding-no-request", apiKey: "synthetic-test-value" })
  expect(await second.api<{ ok: boolean; version: string }>("/api/engine")).toMatchObject({ ok: true, version: engineVersion })
  expect(inspect(f.database)).toMatchObject({ identity: bound.identity, version: engineVersion, sha256: engineHash })
}, 60_000)

real("offline model reconfiguration cannot bypass a mismatched host binding and activate a different engine", async () => {
  const f = fixture(), priorVersion = "0.0.0-product-protected-offline-version", priorHash = "3".repeat(64)
  prepare(f, priorVersion, priorHash, false)
  const started = await start(f, { offline: true })
  await started.api("/api/settings/model", { baseURL: "http://127.0.0.1:9/v1", model: "fixture-never-contacted", apiKey: "synthetic-test-value" }, 400)
  expect((await started.api<{ ok: boolean }>("/api/engine")).ok).toBe(false)
  expect(inspect(f.database)).toMatchObject({ version: priorVersion, sha256: priorHash })
  expect(existsSync(join(f.host, "opencode", "home"))).toBe(false)
}, 30_000)

test("a real child with inconsistent CLI and service versions is stopped and never becomes the product adapter", async () => {
  const f = fixture()
  // Bun itself supplies the real --version process. Its local 'serve' entrypoint
  // starts a synthetic legacy HTTP engine under startEngine's isolated env; no
  // mocked adapter or patched runtime method can bypass the ownership checks.
  writeFileSync(join(f.project, "serve"), `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){
 const expected="Basic "+Buffer.from(process.env.OPENCODE_SERVER_USERNAME+":"+process.env.OPENCODE_SERVER_PASSWORD).toString("base64");
 if(request.headers.get("authorization")!==expected)return new Response("Unauthorized",{status:401});
 const path=new URL(request.url).pathname;
 if(path==="/global/health")return Response.json({healthy:true,version:"synthetic-service-other-version"});
 if(path==="/doc")return Response.json({paths:{"/session":{post:{}},"/session/{sessionID}/message":{get:{},post:{requestBody:{content:{"application/json":{schema:{properties:{system:{type:"string"}}}}}}}}}});
 return new Response("Not found",{status:404});
}});
writeFileSync(join(import.meta.dir,"service-process.json"),JSON.stringify({pid:process.pid,port:server.port}));
console.log("opencode server listening on http://127.0.0.1:"+server.port);
`)
  const errors: string[] = [], previousError = console.error
  console.error = (...values: unknown[]) => { errors.push(values.map(String).join(" ")) }
  let started: Awaited<ReturnType<typeof start>>
  try { started = await start(f, { engine: process.execPath }) }
  finally { console.error = previousError }
  const child = JSON.parse(readFileSync(join(f.project, "service-process.json"), "utf8")) as { pid: number; port: number }
  expect(() => process.kill(child.pid, 0)).toThrow()
  expect(errors.some(value => value.includes("服务版本与启动前版本探测不符"))).toBe(true)
  expect((await started.api<{ ok: boolean }>("/api/engine")).ok).toBe(false)
  expect(inspect(f.database).version).toBe(Bun.version)
  expect(inspect(f.database).sha256).toBe(hash(process.execPath))
  await started.api("/api/settings/model", { baseURL: "http://127.0.0.1:9/v1", model: "synthetic-service", apiKey: "synthetic-test-value" }, 400)
  const reconfigured = JSON.parse(readFileSync(join(f.project, "service-process.json"), "utf8")) as { pid: number }
  expect(() => process.kill(reconfigured.pid, 0)).toThrow()
  expect((await started.api<{ ok: boolean }>("/api/engine")).ok).toBe(false)
  expect(inspect(f.database).version).toBe(Bun.version)
}, 15_000)
