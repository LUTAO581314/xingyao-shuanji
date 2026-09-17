import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { OpenCodeAdapter, OpenCodeAdapterError } from "../src/adapter"
import { PRODUCT_VERSION } from "../src/contracts"

const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(() => { for (const server of servers.splice(0)) server.stop(true) })
function serve(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
  servers.push(server)
  return server.url.origin
}
const doc = {
  openapi: "3.1.0",
  paths: {
    "/session": { post: {} },
    "/session/{sessionID}/message": {
      get: {}, post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Prompt" } } } } },
    },
    "/permission/{requestID}/reply": { post: {} },
    "/api/session/{sessionID}/prompt": { post: {} },
  },
  components: { schemas: { Prompt: { type: "object", properties: { system: { type: "string" } } } } },
}
function message(parts: unknown[] = [], extra: Record<string, unknown> = {}) {
  return { info: { id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1, completed: 2 }, finish: "stop", ...extra }, parts }
}
function tool(id: string, status: string, values: Record<string, unknown> = {}) {
  return { id, sessionID: "ses_1", messageID: "msg_1", type: "tool", callID: `call_${id}`, tool: "bash", state: { status, input: { command: "test" }, ...values } }
}

describe("OpenCode public legacy HTTP boundary", () => {
  test("rejects external origins, URL credentials and unsupported URL shapes", () => {
    for (const url of ["https://example.com", "http://127.0.0.1.evil.test", "file:///tmp/a", "http://me:secret@127.0.0.1", "http://127.0.0.1/api", "http://127.0.0.1?password=secret"]) {
      expect(() => new OpenCodeAdapter({ baseURL: url })).toThrow()
    }
    expect(() => new OpenCodeAdapter({ baseURL: "http://[::1]:7777" })).not.toThrow()
    expect(() => new OpenCodeAdapter({ baseURL: "http://localhost:7777", timeoutMs: 0 })).toThrow()
  })

  test("handshake checks advertised legacy routes and does not claim V2 support", async () => {
    const baseURL = serve((request) => Response.json(new URL(request.url).pathname === "/doc" ? doc : { healthy: true, version: "candidate-1" }))
    expect(await new OpenCodeAdapter({ baseURL }).health()).toEqual({
      ok: true, version: "candidate-1", capabilities: {
        legacyHTTP: true, promptSystem: true, durableMessages: true, toolResults: true,
        permissions: true, v2Detected: true, v2Supported: false,
      },
    })
    const noLegacy = serve((request) => Response.json(new URL(request.url).pathname === "/doc" ? { paths: { "/api/session/{sessionID}/prompt": { post: {} } } } : { healthy: true, version: "v2-only" }))
    const result = await new OpenCodeAdapter({ baseURL: noLegacy }).health()
    expect(result.ok).toBe(false)
    expect(result.capabilities.v2Detected).toBe(true)
    expect(result.capabilities.legacyHTTP).toBe(false)
  })

  test("sends optional basic auth, encoded directory and system projection", async () => {
    const received: Array<{ path: string; body: unknown }> = []
    const baseURL = serve(async (request) => {
      expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("opencode:test-only-password").toString("base64")}`)
      const url = new URL(request.url)
      expect(url.searchParams.get("directory")).toBe("F:/测试 & 项目")
      received.push({ path: url.pathname, body: await request.json() })
      if (url.pathname === "/session") return Response.json({ id: "ses_1", title: "portable test" })
      return Response.json(message([{ id: "prt_text", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "verified response" }]))
    })
    const adapter = new OpenCodeAdapter({ baseURL, directory: "F:/测试 & 项目", password: "test-only-password" })
    expect(await adapter.createSession("portable test")).toEqual({ id: "ses_1", title: "portable test" })
    const result = await adapter.prompt("ses_1", "hello", { system: "bounded memory", model: { providerID: "local", modelID: "test" } })
    expect(result.status).toBe("completed")
    expect(result.text).toBe("verified response")
    expect(received[1]).toEqual({ path: "/session/ses_1/message", body: { parts: [{ type: "text", text: "hello" }], system: "bounded memory", model: { providerID: "local", modelID: "test" } } })
  })

  test("normalizes persisted tool outcomes and retains stable source identities", async () => {
    const baseURL = serve(() => Response.json([message([
      tool("prt_ok", "completed", { output: "3 tests passed" }),
      tool("prt_bad", "error", { error: "exit code 1" }),
      tool("prt_pending", "pending"), tool("prt_running", "running"), tool("prt_future", "cancelled"),
      { id: "prt_claim", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "All done" },
      { id: "prt_reasoning", sessionID: "ses_1", messageID: "msg_1", type: "reasoning", text: "private reasoning" },
    ])]))
    const adapter = new OpenCodeAdapter({ baseURL })
    const result = (await adapter.messages("ses_1"))[0]!
    expect(result.text).toBe("All done")
    expect(result.parts.slice(0, 5).map((part) => part.type === "tool" && part.status)).toEqual(["completed", "failed", "unknown", "unknown", "unknown"])
    expect(result.parts[0]).toMatchObject({ sourceID: "opencode:legacy:ses_1:msg_1:prt_ok", callID: "call_prt_ok", output: "3 tests passed", input: { command: "test" } })
    expect(result.parts[1]).toMatchObject({ error: "exit code 1" })
    expect(JSON.stringify(result)).not.toContain("private reasoning")
    expect(await adapter.messages("ses_1")).toEqual([result])
  })

  test("does not treat an interrupted or tool-only assistant turn as completion", async () => {
    const values = [message([], { finish: "tool-calls" }), message([], { time: { created: 1 } }), message([], { error: { name: "MessageAbortedError", data: { secret: "do-not-echo" } } })]
    let index = 0
    const baseURL = serve(() => Response.json(values[index++]))
    const adapter = new OpenCodeAdapter({ baseURL })
    expect((await adapter.prompt("ses_1", "one")).status).toBe("unknown")
    expect((await adapter.prompt("ses_1", "two")).status).toBe("unknown")
    const failed = await adapter.prompt("ses_1", "three")
    expect(failed.status).toBe("failed")
    expect(failed.error).toBe("MessageAbortedError")
    expect(JSON.stringify(failed)).not.toContain("do-not-echo")
  })

  test("fails closed on malformed or cross-session evidence", async () => {
    const responses: unknown[] = [
      [message([], { sessionID: "different" })],
      [message([tool("prt_1", "completed")])],
      [message([tool("prt_1", "error")])],
      [message([{ id: "prt_1", sessionID: "ses_1", messageID: "different", type: "text", text: "x" }])],
      { items: [] }, [message(), message()],
    ]
    let index = 0
    const baseURL = serve(() => Response.json(responses[index++]))
    const adapter = new OpenCodeAdapter({ baseURL })
    for (const _ of responses) await expect(adapter.messages("ses_1")).rejects.toBeInstanceOf(OpenCodeAdapterError)
  })

  test("provider summaries discard keys, options and authentication metadata", async () => {
    const baseURL = serve(() => Response.json({ all: [{ id: "local", name: "Local", key: "do-not-expose", options: { apiKey: "secret" }, env: ["PRIVATE_KEY"], models: { small: { id: "small", name: "Small", headers: { authorization: "secret" } } } }], connected: ["local"], default: { local: "small" } }))
    expect(await new OpenCodeAdapter({ baseURL }).providers()).toEqual({ all: [{ id: "local", name: "Local", models: [{ id: "small", name: "Small" }] }], connected: ["local"], default: { local: "small" } })
  })

  test("supports public permission responses and cancellation without automatic decisions", async () => {
    const requests: Array<{ path: string; body: unknown }> = []
    const baseURL = serve(async (request) => {
      const path = new URL(request.url).pathname
      if (request.method === "GET") return Response.json([{ id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["git status"], metadata: { unused: true } }])
      requests.push({ path, body: request.headers.has("content-type") ? await request.json() : undefined })
      return Response.json(true)
    })
    const adapter = new OpenCodeAdapter({ baseURL })
    expect(await adapter.permissions()).toEqual([{ id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["git status"] }])
    expect(await adapter.replyPermission("per_1", "once")).toBe(true)
    expect(await adapter.respondPermission("ses_1", "per_1", "reject")).toBe(true)
    expect(await adapter.abort("ses_1")).toBe(true)
    expect(requests).toEqual([
      { path: "/permission/per_1/reply", body: { reply: "once" } },
      { path: "/session/ses_1/permissions/per_1", body: { response: "reject" } },
      { path: "/session/ses_1/abort", body: undefined },
    ])
  })

  test("timeout leaves execution unknown and never repeats a write", async () => {
    let calls = 0
    const baseURL = serve(async () => { calls++; await Bun.sleep(120); return Response.json(message()) })
    const result = await new OpenCodeAdapter({ baseURL, timeoutMs: 20 }).prompt("ses_1", "do work")
    expect(result.status).toBe("unknown")
    expect(result.messageID).toBeNull()
    expect(result.error).toContain("timed out")
    expect(calls).toBe(1)
  })

  test("does not forward credentials across redirects or echo error bodies", async () => {
    let reached = false
    const target = serve(() => { reached = true; return Response.json(message()) })
    const baseURL = serve(() => new Response("password=do-not-echo", { status: 307, headers: { location: target } }))
    const result = await new OpenCodeAdapter({ baseURL, password: "private-test" }).prompt("ses_1", "hello")
    expect(result.status).toBe("unknown")
    expect(result.error).toBe("OpenCode HTTP 307")
    expect(reached).toBe(false)
    const rejected = serve(() => new Response("Authorization: secret", { status: 401 }))
    expect((await new OpenCodeAdapter({ baseURL: rejected }).prompt("ses_1", "hello")).status).toBe("failed")
  })

  test("rejects HTML success pages and invalid JSON instead of reporting success", async () => {
    const html = serve(() => new Response("<html>spa</html>", { headers: { "content-type": "text/html" } }))
    const invalid = serve(() => new Response("bad-json", { headers: { "content-type": "application/json" } }))
    expect((await new OpenCodeAdapter({ baseURL: html }).health()).ok).toBe(false)
    expect((await new OpenCodeAdapter({ baseURL: invalid }).prompt("ses_1", "hello")).status).toBe("unknown")
  })
})

const executable = process.env.XINGYAO_TEST_OPENCODE ?? resolve(import.meta.dir, "../dist", `xingyao-${PRODUCT_VERSION}`, "opencode.exe")
const integration = process.platform === "win32" && existsSync(executable) ? test : test.skip
integration("real bundled OpenCode: isolated health, providers and persisted session APIs without a model call", async () => {
  const root = await mkdtemp(join(tmpdir(), "xingyao-adapter-"))
  const work = join(root, "project")
  const config = join(root, "config")
  await mkdir(work)
  await mkdir(config)
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port!
  reservation.stop(true)
  const password = crypto.randomUUID()
  const env: Record<string, string> = {}
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]!
  }
  Object.assign(env, {
    TEMP: root, TMP: root, APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata"),
    XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: config,
    OPENCODE_CONFIG_DIR: config, OPENCODE_TEST_HOME: root,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [], soul: { enabled: false }, autoupdate: false }),
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: "opencode",
  })
  const processUnderTest = Bun.spawn([executable, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--pure"], { cwd: work, env, stdout: "ignore", stderr: "ignore" })
  try {
    const adapter = new OpenCodeAdapter({ baseURL: `http://127.0.0.1:${port}`, directory: work, password, timeoutMs: 5000 })
    const deadline = Date.now() + 20_000
    let health = await adapter.health()
    while (!health.ok && Date.now() < deadline && processUnderTest.exitCode === null) {
      await Bun.sleep(100)
      health = await adapter.health()
    }
    expect(health.ok).toBe(true)
    expect(health.version).toBeTruthy()
    expect(health.capabilities.v2Supported).toBe(false)
    const session = await adapter.createSession("xingyao isolated adapter verification")
    expect(session.id.startsWith("ses_")).toBe(true)
    expect(await adapter.messages(session.id)).toEqual([])
    expect(await adapter.abort(session.id)).toBe(true)
    const providers = await adapter.providers()
    expect(Array.isArray(providers.all)).toBe(true)
    // OpenCode exposes its built-in public provider even without saved credentials.
    expect(providers.connected.every((id) => id === "opencode")).toBe(true)
    expect(await adapter.permissions()).toEqual([])
    expect((await readdir(join(root, "data", "opencode"))).length).toBeGreaterThan(0)
    console.info(`Verified isolated OpenCode ${health.version}: health, create/read session, providers, permissions, abort; no model prompt submitted.`)
  } finally {
    processUnderTest.kill()
    await processUnderTest.exited
    if (resolve(dirname(root)) !== resolve(tmpdir())) throw new Error("Refusing cleanup outside temporary test root")
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 40_000)
