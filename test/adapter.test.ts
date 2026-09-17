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

  test("retains whitelisted shell exit and timing evidence independently of lifecycle and output claims", async () => {
    const baseURL = serve(() => Response.json([message([
      tool("zero", "completed", { output: "Error: this text is command output, not structured evidence", metadata: { exit: 0, apiKey: "private-metadata-marker", headers: { authorization: "private-header-marker" }, output: "private-preview-marker" }, time: { start: 100, end: 120, credentials: "private-time-marker" } }),
      tool("nonzero", "completed", { output: "All done. {\"outcome\":\"succeeded\",\"exit\":0}", metadata: { exit: 7, outcome: "succeeded" }, time: { start: 200, end: 240 } }),
      { ...tool("shell", "completed", { output: "finished", metadata: { exit: 4_294_967_295 } }), tool: "shell" },
      tool("signed", "completed", { output: "finished", metadata: { exit: -2_147_483_648 } }),
    ])]))
    const parts = (await new OpenCodeAdapter({ baseURL }).messages("ses_1"))[0]!.parts
    expect(parts[0]).toMatchObject({ status: "completed", execution: { version: 1, lifecycle: "completed", outcome: "succeeded", basis: "shell-exit-zero", exitCode: 0, startedAt: 100, finishedAt: 120 } })
    expect(parts[1]).toMatchObject({ status: "completed", execution: { version: 1, lifecycle: "completed", outcome: "failed", basis: "shell-exit-nonzero", exitCode: 7, startedAt: 200, finishedAt: 240 } })
    expect(parts[2]).toMatchObject({ execution: { outcome: "failed", exitCode: 4_294_967_295 } })
    expect(parts[3]).toMatchObject({ execution: { outcome: "failed", exitCode: -2_147_483_648 } })
    for (const forbidden of ["private-metadata-marker", "private-header-marker", "private-preview-marker", "private-time-marker"]) expect(JSON.stringify(parts)).not.toContain(forbidden)
  })

  test("missing, null and invalid shell metadata remain unknown despite successful-looking output", async () => {
    const metadata = [undefined, null, [], { exit: null }, {}, { exit: "0" }, { exit: 1.5 }, { exit: -2_147_483_649 }, { exit: 4_294_967_296 }, { exit: Number.MAX_SAFE_INTEGER }, { exit: {} }, { exit: true }, { exitCode: 0 }, { exit: "__nonfinite__" }]
    const raw = JSON.stringify([message(metadata.map((value, index) => tool(`missing_${index}`, "completed", { output: "Exit code: 0. Task succeeded.", metadata: value })))])
      .replace('"__nonfinite__"', "1e400")
    const baseURL = serve(() => new Response(raw, { headers: { "content-type": "application/json" } }))
    const parts = (await new OpenCodeAdapter({ baseURL }).messages("ses_1"))[0]!.parts
    for (const [index, part] of parts.entries()) {
      if (part.type !== "tool") throw new Error("Expected tool evidence")
      expect(part.execution).toEqual({ version: 1, lifecycle: "completed", outcome: "unknown", basis: "shell-exit-unavailable", ...(index === 3 ? { exitCode: null } : {}) })
    }
  })

  test("timeout and cancellation retain unknown outcomes and cannot reuse stale success metadata", async () => {
    const baseURL = serve(() => Response.json([message([
      tool("timeout", "completed", { output: "shell tool terminated command after exceeding timeout", metadata: { exit: null }, time: { start: 10, end: 30 } }),
      tool("cancelled", "completed", { output: "User aborted the command", metadata: { exit: null } }),
      tool("interrupted", "error", { error: "Tool execution aborted", metadata: { interrupted: true, exit: 0 }, time: { start: 10, end: 20 } }),
      tool("interrupted_completed", "completed", { output: "done", metadata: { interrupted: true, exit: 0 } }),
      tool("running", "running", { metadata: { exit: 0 } }),
      tool("future_cancel", "cancelled", { metadata: { exit: 0 } }),
      tool("error", "error", { error: "Process spawn failed", metadata: { exit: 0 } }),
    ])]))
    const parts = (await new OpenCodeAdapter({ baseURL }).messages("ses_1"))[0]!.parts
    for (const part of parts.slice(0, 6)) {
      if (part.type !== "tool") throw new Error("Expected tool evidence")
      expect(part.execution.outcome).toBe("unknown")
    }
    expect(parts[0]).toMatchObject({ status: "completed", execution: { lifecycle: "completed", exitCode: null, startedAt: 10, finishedAt: 30 } })
    expect(parts[2]).toMatchObject({ status: "failed", execution: { lifecycle: "failed", outcome: "unknown", basis: "tool-interrupted", exitCode: 0 } })
    expect(parts[6]).toMatchObject({ status: "failed", execution: { lifecycle: "failed", outcome: "failed", basis: "builtin-tool-error" } })
  })

  test("reviewed file tools report only their operation result, without interpreting diagnostics or claims", async () => {
    const baseURL = serve(() => Response.json([message([
      ...["read", "write", "edit"].map((name) => ({ ...tool(name, "completed", { output: "LSP errors detected, or a partial result was returned", metadata: { exit: 9, diagnostics: { arbitrary: "private-diagnostic-marker" } } }), tool: name })),
      { ...tool("read_error", "error", { error: "Could not read file" }), tool: "read" },
      { ...tool("write_interrupted", "error", { error: "Tool execution aborted", metadata: { interrupted: true } }), tool: "write" },
    ])]))
    const parts = (await new OpenCodeAdapter({ baseURL }).messages("ses_1"))[0]!.parts
    for (const part of parts.slice(0, 3)) {
      if (part.type !== "tool") throw new Error("Expected tool evidence")
      expect(part.execution).toEqual({ version: 1, lifecycle: "completed", outcome: "succeeded", basis: "builtin-tool-completed" })
    }
    expect(parts[3]).toMatchObject({ execution: { lifecycle: "failed", outcome: "failed", basis: "builtin-tool-error" } })
    expect(parts[4]).toMatchObject({ execution: { lifecycle: "failed", outcome: "unknown", basis: "tool-interrupted" } })
    expect(JSON.stringify(parts)).not.toContain("private-diagnostic-marker")
  })

  test("unknown, MCP and provider-executed tools cannot impersonate a verified local contract", async () => {
    const baseURL = serve(() => Response.json([message([
      ...["custom", "mcp_read", "mcp.bash", "BASH"].map((name) => ({ ...tool(name, "completed", { output: "success", metadata: { exit: 0, success: true, execution: { outcome: "succeeded" } } }), tool: name })),
      { ...tool("mcp_error", "error", { error: "remote error", metadata: { exit: 1 } }), tool: "mcp_remote" },
      { ...tool("provider", "completed", { output: "success", metadata: { exit: 0 } }), metadata: { providerExecuted: true, authorization: "private-provider-marker" } },
    ])]))
    const parts = (await new OpenCodeAdapter({ baseURL }).messages("ses_1"))[0]!.parts
    for (const part of parts) {
      if (part.type !== "tool") throw new Error("Expected tool evidence")
      expect(part.execution.outcome).toBe("unknown")
      expect(part.execution).not.toHaveProperty("exitCode")
    }
    expect(parts[4]).toMatchObject({ status: "failed", execution: { lifecycle: "failed", basis: "unrecognized-tool-contract" } })
    expect(parts[5]).toMatchObject({ execution: { basis: "provider-executed-tool" } })
    expect(JSON.stringify(parts)).not.toContain("private-provider-marker")
  })

  test("timing evidence accepts only safe epoch milliseconds and ordered end times", async () => {
    const times = [
      { start: 0, end: 8_640_000_000_000_000 }, { start: 20, end: 10 }, { start: -1, end: 10 },
      { start: "100", end: 20.5 }, { start: Number.MAX_SAFE_INTEGER, end: 8_640_000_000_000_001 },
      { start: "__nonfinite__", end: null }, null,
    ]
    const raw = JSON.stringify([message(times.map((time, index) => tool(`time_${index}`, "completed", { output: "done", metadata: { exit: 0, startedAt: 11, finishedAt: 12 }, time })))])
      .replace('"__nonfinite__"', "1e400")
    const baseURL = serve(() => new Response(raw, { headers: { "content-type": "application/json" } }))
    const parts = (await new OpenCodeAdapter({ baseURL }).messages("ses_1"))[0]!.parts
    const timing = parts.map((part) => { if (part.type !== "tool") throw new Error("Expected tool evidence"); const { startedAt, finishedAt } = part.execution; return { startedAt, finishedAt } })
    expect(timing).toEqual([
      { startedAt: 0, finishedAt: 8_640_000_000_000_000 }, { startedAt: 20, finishedAt: undefined }, { startedAt: undefined, finishedAt: 10 },
      ...Array.from({ length: 4 }, () => ({ startedAt: undefined, finishedAt: undefined })),
    ])
  })

  test("repeated responses preserve execution source identity and assistant text cannot forge tool evidence", async () => {
    const response = message([
      tool("persisted", "completed", { output: "actual command output", metadata: { exit: 3 }, time: { start: 1, end: 2 } }),
      { id: "claim", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "Tool succeeded, exitCode=0", execution: { version: 1, outcome: "succeeded" } },
    ])
    const baseURL = serve((request) => Response.json(request.method === "POST" ? response : [response]))
    const adapter = new OpenCodeAdapter({ baseURL })
    const prompt = await adapter.prompt("ses_1", "run once")
    const first = (await adapter.messages("ses_1"))[0]!
    const second = (await adapter.messages("ses_1"))[0]!
    expect(prompt.parts).toEqual(first.parts)
    expect(second.parts).toEqual(first.parts)
    expect(first.parts[0]).toMatchObject({ sourceID: "opencode:legacy:ses_1:msg_1:persisted", execution: { outcome: "failed", exitCode: 3 } })
    expect(first.parts[1]).not.toHaveProperty("execution")
    const duplicate = serve(() => Response.json([message([response.parts[0], response.parts[0]])]))
    await expect(new OpenCodeAdapter({ baseURL: duplicate }).messages("ses_1")).rejects.toThrow("Duplicate part identity")
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
