import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { OpenCodeAdapter, type AdapterOptions } from "../src/adapter"
import { startEngine, type Engine } from "../src/engine"

const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(true) })
const input = "[source-1 user] 回答请先给结论。"
const system = "只提取有来源的候选，返回单个 JSON 对象。"
const output = '{"candidates":[]}'
const deny = [{ permission: "*", pattern: "*", action: "deny" }]
type Raw = Record<string, any>
type Call = { method: string; path: string; body: any }
function session(jobID = "job-1") {
  return { id: "ses_extract", title: `Xingyao memory extraction ${jobID}`, metadata: { xingyao: { kind: "memory-extraction", jobID } }, permission: deny }
}
function message(id: string, role: string, text: string, extra: Raw = {}) {
  return { info: { id, sessionID: "ses_extract", role, time: { created: 1, ...(role === "assistant" ? { completed: 2 } : {}) },
    ...(role === "assistant" ? { finish: "stop", parentID: "msg_user" } : { system, agent: "build" }), ...extra },
    parts: [{ id: `prt_${id}`, sessionID: "ses_extract", messageID: id, type: "text", text }] }
}
function fixture(options: {
  adapter?: Partial<AdapterOptions>
  intercept?: (call: Call, state: { owner: Raw; history: Raw[]; deleted: boolean }) => Response | undefined | Promise<Response | undefined>
  reply?: (message: Raw) => Raw
  history?: (messages: Raw[]) => Raw[]
} = {}) {
  const calls: Call[] = []
  const state = { owner: session() as Raw, history: [] as Raw[], deleted: false }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url)
    expect(url.searchParams.get("directory")).toBe("F:/提取 fixture")
    expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("opencode:synthetic-extraction-password").toString("base64")}`)
    const call = { method: request.method, path: url.pathname, body: request.headers.get("content-type") ? await request.json() : undefined }
    calls.push(call)
    const special = await options.intercept?.(call, state)
    if (special) return special
    if (call.method === "POST" && call.path === "/session") { state.owner = { ...call.body, id: "ses_extract" }; return Response.json(state.owner) }
    if (call.method === "GET" && call.path === "/permission") return Response.json([])
    if (call.method === "GET" && call.path === "/session/ses_extract/children") return Response.json([])
    if (call.method === "GET" && call.path === "/session/ses_extract") return Response.json(state.deleted ? {} : state.owner, { status: state.deleted ? 404 : 200 })
    if (call.method === "GET" && call.path === "/session/ses_extract/message") return Response.json(state.deleted ? {} : options.history?.(state.history) ?? state.history, { status: state.deleted ? 404 : 200 })
    if (call.method === "POST" && call.path === "/session/ses_extract/message") {
      const reply = options.reply?.(message("msg_answer", "assistant", output)) ?? message("msg_answer", "assistant", output)
      state.history = [message("msg_user", "user", call.body.parts[0].text, { system: call.body.system }), structuredClone(reply)]
      return Response.json(reply)
    }
    if (call.method === "POST" && call.path === "/session/ses_extract/abort") return Response.json(true)
    if (call.method === "DELETE" && call.path === "/session/ses_extract") { state.deleted = true; return Response.json(true) }
    return Response.json({}, { status: 404 })
  } })
  servers.push(server)
  const adapter = new OpenCodeAdapter({ baseURL: server.url.origin, directory: "F:/提取 fixture", password: "synthetic-extraction-password", ...options.adapter })
  return { adapter, calls, state }
}

test("memory extraction owns a deny-all session, sends plain text and verifies cleanup twice", async () => {
  const { adapter, calls } = fixture()
  expect(await adapter.createMemoryExtractionSession("job-1")).toEqual({ id: "ses_extract" })
  expect(calls[0]!.body).toEqual({ title: "Xingyao memory extraction job-1", agent: "build", metadata: { xingyao: { kind: "memory-extraction", jobID: "job-1" } }, permission: deny })
  const result = await adapter.promptMemoryExtraction("ses_extract", input, { system, model: { providerID: "local", modelID: "test" }, jobID: "job-1" })
  expect(result).toMatchObject({ status: "completed", text: output, messageID: "msg_answer" })
  expect(calls.find(call => call.method === "POST" && call.path.endsWith("/message"))!.body).toEqual({ agent: "build", parts: [{ type: "text", text: input }], system, model: { providerID: "local", modelID: "test" } })
  expect(await adapter.deleteMemoryExtractionSession("ses_extract", "job-1")).toBe(true)
  expect(await adapter.deleteMemoryExtractionSession("ses_extract", "job-1")).toBe(true)
  expect(calls.filter(call => call.method === "DELETE")).toHaveLength(1)
  expect(calls.slice(-2).map(call => call.path)).toEqual(["/session/ses_extract", "/session/ses_extract/message"])
})

test("memory extraction rejects invalid jobs and unbounded timeout options before network access", async () => {
  const { adapter, calls } = fixture()
  for (const job of ["", " job", "../job", "job\n", "x".repeat(129)]) await expect(adapter.createMemoryExtractionSession(job)).rejects.toThrow()
  for (const memoryExtractionTimeoutMs of [0, -1, Infinity, 60001]) expect(() => fixture({ adapter: { memoryExtractionTimeoutMs } })).toThrow()
  for (const memoryCleanupTimeoutMs of [0, NaN, 10001]) expect(() => fixture({ adapter: { memoryCleanupTimeoutMs } })).toThrow()
  expect(calls).toHaveLength(0)
})

test("memory extraction creation refuses a server that changed its ownership or permissions", async () => {
  for (const patch of [{ title: "foreground" }, { permission: [] }, { metadata: { xingyao: { kind: "memory-extraction", jobID: "another-job" } } }, { parentID: "ses_foreground" }]) {
    const { adapter } = fixture({ intercept: call => call.path === "/session" ? Response.json({ ...session(), ...patch }) : undefined })
    await expect(adapter.createMemoryExtractionSession("job-1")).rejects.toThrow()
  }
})

test("memory extraction cannot prompt foreground, foreign-owned or permission-relaxed sessions", async () => {
  for (const owner of [{ ...session(), title: "foreground" }, { ...session(), metadata: {} }, { ...session(), permission: [...deny, { permission: "read", pattern: "*", action: "allow" }] }, session("another-job")]) {
    const { adapter, state, calls } = fixture()
    state.owner = owner
    await expect(adapter.promptMemoryExtraction("ses_extract", input, { system, jobID: "job-1" })).rejects.toThrow()
    expect(calls.some(call => call.method === "POST")).toBe(false)
  }
})

test("memory extraction never resends to a session containing an earlier request", async () => {
  const { adapter, state, calls } = fixture()
  state.history = [message("msg_user", "user", input)]
  await expect(adapter.promptMemoryExtraction("ses_extract", input, { system })).rejects.toThrow("reconcile")
  expect(calls.some(call => call.method === "POST")).toBe(false)
})

test("memory extraction rejects earlier failed tool attempts even when the final response is valid", async () => {
  const { adapter } = fixture({ history: history => history.length ? [history[0]!, {
    ...message("msg_tool", "assistant", ""), parts: [{ id: "prt_tool", sessionID: "ses_extract", messageID: "msg_tool", type: "tool", tool: "write", callID: "call_bad", state: { status: "error", input: { filePath: "synthetic" }, error: "Tool unavailable" } }],
  }, history[1]!] : history })
  await expect(adapter.promptMemoryExtraction("ses_extract", input, { system })).rejects.toThrow("attempted a tool")
})

test("memory extraction rejects incomplete, errored, truncated and unknown assistant finishes", async () => {
  for (const info of [{ finish: "length" }, { finish: "unknown" }, { finish: "tool-calls" }, { time: { created: 1 } }, { error: { name: "MessageAbortedError", data: { secret: "never-echo" } } }, { role: "user" }]) {
    const { adapter } = fixture({ reply: reply => ({ ...reply, info: { ...reply.info, ...info } }) })
    await expect(adapter.promptMemoryExtraction("ses_extract", input, { system })).rejects.toThrow("completed assistant")
  }
})

test("memory extraction requires persisted results to match the admitted input, parent and response", async () => {
  const transforms: Array<(history: Raw[]) => Raw[]> = [
    history => [history[0]!, message("msg_answer", "assistant", "changed")],
    history => [message("msg_user", "user", "another input"), history[1]!],
    history => [history[0]!, { ...history[1]!, info: { ...history[1]!.info, parentID: "msg_foreign" } }],
    history => [history[0]!, history[1]!, history[1]!],
    history => [{ ...history[0]!, info: { ...history[0]!.info, tools: { read: true } } }, history[1]!],
    history => [{ ...history[0]!, info: { ...history[0]!.info, format: { type: "text" } } }, history[1]!],
  ]
  for (const transform of transforms) {
    const { adapter } = fixture({ history: history => history.length ? transform(history) : history })
    await expect(adapter.promptMemoryExtraction("ses_extract", input, { system })).rejects.toThrow()
  }
})

test("memory extraction refuses pagination and unsupported parts instead of accepting a partial archive", async () => {
  const paged = fixture({ intercept: call => call.path.endsWith("/message") && call.method === "GET" ? Response.json([], { headers: { "x-next-cursor": "hidden" } }) : undefined })
  await expect(paged.adapter.promptMemoryExtraction("ses_extract", input, { system })).rejects.toThrow("Paginated")
  expect(paged.calls.some(call => call.method === "POST")).toBe(false)
  for (const extra of [{ type: "file" }, { type: "future-tool" }, { type: "text", synthetic: true }, { type: "text", ignored: true }]) {
    const { adapter } = fixture({ reply: reply => ({ ...reply, parts: [{ ...reply.parts[0], ...extra }] }) })
    await expect(adapter.promptMemoryExtraction("ses_extract", input, { system })).rejects.toThrow("Unexpected extraction")
  }
})

test("memory extraction rechecks ownership and unexpected permission requests after inference", async () => {
  const changed = fixture({ intercept: (call, state) => call.path === "/session/ses_extract" && state.history.length ? Response.json({ ...state.owner, permission: [] }) : undefined })
  await expect(changed.adapter.promptMemoryExtraction("ses_extract", input, { system })).rejects.toThrow("deny all")
  const requested = fixture({ intercept: call => call.path === "/permission" ? Response.json([{ sessionID: "ses_extract" }]) : undefined })
  await expect(requested.adapter.promptMemoryExtraction("ses_extract", input, { system })).rejects.toThrow("permission")
})

test("memory extraction cleanup never aborts or deletes a foreign session or recursively deletes children", async () => {
  const foreign = fixture()
  await expect(foreign.adapter.deleteMemoryExtractionSession("ses_extract", "wrong-job")).rejects.toThrow("ownership")
  expect(foreign.calls.every(call => call.method === "GET")).toBe(true)
  const children = fixture({ intercept: call => call.path.endsWith("/children") ? Response.json([{ id: "ses_foreground" }]) : undefined })
  await expect(children.adapter.deleteMemoryExtractionSession("ses_extract", "job-1")).rejects.toThrow("children")
  expect(children.calls.some(call => call.method === "DELETE")).toBe(false)
})

test("memory extraction cleanup verifies both absence endpoints and does not trust DELETE true", async () => {
  const lying = fixture({ intercept: call => call.method === "DELETE" ? Response.json(true) : undefined })
  await expect(lying.adapter.deleteMemoryExtractionSession("ses_extract", "job-1")).rejects.toThrow("could not be verified")
  expect(lying.calls.slice(-2).map(call => call.path)).toEqual(["/session/ses_extract", "/session/ses_extract/message"])
  const orphan = fixture({ intercept: call => call.path === "/session/ses_extract" ? Response.json({}, { status: 404 }) : undefined })
  await expect(orphan.adapter.deleteMemoryExtractionSession("ses_extract", "job-1")).rejects.toThrow("still exposes messages")
})

test("memory extraction and cleanup have independent short budgets without retrying or deleting after abort timeout", async () => {
  const delayed = fixture({ adapter: { timeoutMs: 500, memoryExtractionTimeoutMs: 35 }, intercept: async call => {
    if (call.method === "POST" && call.path.endsWith("/message")) { await Bun.sleep(150); return Response.json(message("msg_answer", "assistant", output)) }
  } })
  await expect(delayed.adapter.promptMemoryExtraction("ses_extract", input, { system })).rejects.toThrow("timed out")
  expect(delayed.calls.filter(call => call.method === "POST")).toHaveLength(1)
  const cleanup = fixture({ adapter: { timeoutMs: 500, memoryCleanupTimeoutMs: 35 }, intercept: async call => {
    if (call.path.endsWith("/abort")) { await Bun.sleep(150); return Response.json(true) }
  } })
  await expect(cleanup.adapter.deleteMemoryExtractionSession("ses_extract", "job-1")).rejects.toThrow("timed out")
  expect(cleanup.calls.some(call => call.method === "DELETE")).toBe(false)
})

test("memory extraction bounds response bytes even without Content-Length and never echoes them", async () => {
  const huge = fixture({ intercept: call => call.path === "/session" ? new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"secret":"' + "x".repeat(1_048_576))); controller.close()
  } }), { headers: { "content-type": "application/json" } }) : undefined })
  await expect(huge.adapter.createMemoryExtractionSession("job-1")).rejects.toThrow("size limit")
  expect(huge.calls).toHaveLength(1)
})

const executable = process.env.XINGYAO_TEST_OPENCODE ?? resolve(import.meta.dir, "../dist/engines/0.0.0-product-dev-20260918-engine.6-source/opencode.exe")
const real = process.platform === "win32" && (existsSync(executable) || !!process.env.XINGYAO_TEST_OPENCODE) ? test : test.skip
real("real memory extraction engine: no tools, no foreground history, strict rejection, abort and verified cleanup", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "xingyao-memory-extraction-")))
  const project = join(root, "project"), host = join(root, "host")
  await mkdir(project); await mkdir(host)
  const file = join(project, "sentinel.txt")
  await writeFile(file, "UNCHANGED_FIXTURE")
  let scenario = "valid", attempts = 0, release: (() => void) | undefined
  const calls: Array<{ scenario: string; tools: string[] }> = []
  let engine: Engine | undefined
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Raw
    attempts++
    calls.push({ scenario, tools: (body.tools ?? []).map((tool: Raw) => tool.function.name) })
    if (scenario === "abort") await new Promise<void>(resolve => { release = resolve; request.signal.addEventListener("abort", () => resolve(), { once: true }) })
    if (scenario === "tool-attempt" && attempts === 1) return completion(body, { tool: { name: "write", arguments: JSON.stringify({ filePath: file, content: "FORBIDDEN" }) } })
    return completion(body, { text: output })
  } })
  try {
    const actualHash = new Bun.CryptoHasher("sha256").update(await readFile(executable)).digest("hex")
    expect(actualHash).toBe(process.env.XINGYAO_UPGRADE_TO_SHA256 ?? "f02b6bbba598d4f2e9e1c1f75794104b9581129ae199d3130b4bc2e552ee748b")
    const configPath = join(host, "provider.json")
    await writeFile(configPath, JSON.stringify({ model: "extract-local/test", small_model: "extract-local/test", enabled_providers: ["extract-local"], provider: {
      "extract-local": { name: "Isolated memory fixture", npm: "@ai-sdk/openai-compatible", env: [], options: { baseURL: `${model.url.origin}/v1`, apiKey: "synthetic-memory-fixture", timeout: 10000, maxRetries: 0 },
        models: { test: { name: "Fixture", tool_call: true, limit: { context: 128000, output: 4096 } } } },
    } }))
    engine = await startEngine({ executable, hostDir: host, projectDir: project, configPath, requestTimeoutMs: 10000 })
    expect(engine.version).toBe("0.0.0-product-dev-20260918-engine.6-source")
    const adapter = engine.adapter
    const foreground = await adapter.createSession("Foreground control")
    const before = await adapter.messages(foreground.id)
    const created = await adapter.createMemoryExtractionSession("real-valid")
    const result = await adapter.promptMemoryExtraction(created.id, input, { system, jobID: "real-valid" })
    expect(result).toMatchObject({ status: "completed", text: output })
    expect(result.messageID).toBeString()
    await expect(adapter.promptMemoryExtraction(created.id, input, { system })).rejects.toThrow("reconcile")
    expect(await adapter.deleteMemoryExtractionSession(created.id, "real-valid")).toBe(true)
    expect(await adapter.deleteMemoryExtractionSession(created.id, "real-valid")).toBe(true)
    scenario = "tool-attempt"; attempts = 0
    const attacked = await adapter.createMemoryExtractionSession("real-tool-attempt")
    await expect(adapter.promptMemoryExtraction(attacked.id, input, { system })).rejects.toThrow("attempted a tool")
    expect(await readFile(file, "utf8")).toBe("UNCHANGED_FIXTURE")
    expect(await adapter.deleteMemoryExtractionSession(attacked.id, "real-tool-attempt")).toBe(true)
    scenario = "abort"; attempts = 0
    const aborted = await adapter.createMemoryExtractionSession("real-abort")
    const pending = adapter.promptMemoryExtraction(aborted.id, input, { system })
    void pending.catch(() => {})
    for (let count = 0; count < 200 && attempts === 0; count++) await Bun.sleep(10)
    expect(attempts).toBe(1)
    expect(await adapter.abort(aborted.id)).toBe(true)
    release?.()
    await expect(pending).rejects.toThrow("completed assistant")
    expect(await adapter.deleteMemoryExtractionSession(aborted.id, "real-abort")).toBe(true)
    expect(await adapter.messages(foreground.id)).toEqual(before)
    expect(await adapter.permissions()).toEqual([])
    expect(calls.length).toBe(4)
    for (const call of calls) expect(call.tools).toEqual([])
    console.info(`Verified real memory extraction ${engine.version}: deny-all, empty model tools, whole-history tool rejection, independent foreground session, interrupted inference and checked deletion; no public model or product experience writes.`)
  } finally {
    release?.(); await engine?.stop(); await model.stop(true)
    if (resolve(dirname(root)) !== resolve(await realpath(tmpdir()))) throw new Error("Unexpected memory extraction test root")
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 60000)

function completion(body: Raw, result: { text?: string; tool?: { name: string; arguments: string } }) {
  const common = { id: `chatcmpl_${crypto.randomUUID()}`, created: Math.floor(Date.now() / 1000), model: "test" }
  const calls = result.tool ? [{ index: 0, id: `call_${crypto.randomUUID()}`, type: "function", function: result.tool }] : undefined
  const finish = calls ? "tool_calls" : "stop"
  if (!body.stream) return Response.json({ ...common, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: result.text ?? null, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
  const chunks = [{ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", ...(calls ? { tool_calls: calls } : { content: result.text ?? "" }) }, finish_reason: null }] },
    { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }]
  return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
}
