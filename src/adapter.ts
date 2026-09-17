/** Public legacy OpenCode HTTP adapter. The separate /api V2 protocol is not implemented.
 * Health probes describe advertised routes; compatibility still requires release tests.
 * Tool completion is execution evidence, never proof that the user's whole task succeeded.
 */
export type AdapterOptions = {
  baseURL: string
  directory?: string
  username?: string
  password?: string
  timeoutMs?: number
}

export type AdapterCapabilities = {
  legacyHTTP: boolean
  promptSystem: boolean
  durableMessages: boolean
  toolResults: boolean
  permissions: boolean
  v2Detected: boolean
  v2Supported: false
}

export type Source = { sourceID: string; sessionID: string; messageID: string; id: string }
/** Tool/OS execution only. Neither outcome proves the user's overall goal.
 * basis is adapter-generated; arbitrary upstream metadata is never copied here.
 */
export type ToolExecutionEvidence = {
  version: 1
  lifecycle: "completed" | "failed" | "unknown"
  outcome: "succeeded" | "failed" | "unknown"
  basis: string
  exitCode?: number | null
  startedAt?: number
  finishedAt?: number
}
export type NormalizedPart = Source & (
  | { type: "text"; text: string; synthetic: boolean; ignored: boolean }
  | { type: "tool"; callID: string; tool: string; status: "completed" | "failed" | "unknown";
      upstreamStatus: string; input: Record<string, unknown>; execution: ToolExecutionEvidence; output?: string; error?: string }
  | { type: "other"; kind: string }
)
export type NormalizedMessage = {
  sourceID: string
  sessionID: string
  messageID: string
  role: "user" | "assistant"
  text: string
  parts: NormalizedPart[]
  status: "completed" | "failed" | "unknown"
  time: { created: number; completed?: number }
  error?: string
}
export type PromptResult = Pick<NormalizedMessage, "text" | "parts" | "status" | "error"> & {
  messageID: string | null
}
export type ProviderSummary = { id: string; name: string; models: Array<{ id: string; name: string }> }
export type ProviderStatus = { all: ProviderSummary[]; connected: string[]; default: Record<string, string> }
export type PermissionRequest = { id: string; sessionID: string; permission: string; patterns: string[] }
export type MigrationDigest = { sessionID: string; messageCount: number; sha256: string }

export class OpenCodeAdapterError extends Error {
  constructor(readonly kind: "http" | "timeout" | "network" | "protocol" | "unsupported", message: string, readonly status?: number) {
    super(message)
    this.name = "OpenCodeAdapterError"
  }
}

export class OpenCodeAdapter {
  readonly #url: URL
  readonly #headers: Headers
  readonly #directory?: string
  readonly #timeout: number

  constructor(options: AdapterOptions) {
    const url = new URL(options.baseURL)
    if (!["http:", "https:"].includes(url.protocol)
      || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("OpenCode baseURL must be a loopback HTTP origin without credentials or a path")
    }
    // Avoid resolving a mutable hostname when authentication is enabled.
    if (url.hostname === "localhost") url.hostname = "127.0.0.1"
    if (options.username?.includes(":")) throw new Error("Basic auth username cannot contain a colon")
    this.#url = url
    this.#directory = options.directory
    this.#timeout = options.timeoutMs ?? 120_000
    if (!Number.isFinite(this.#timeout) || this.#timeout <= 0 || this.#timeout > 2_147_483_647) {
      throw new Error("timeoutMs must be a positive finite timer duration")
    }
    this.#headers = new Headers({ accept: "application/json" })
    if (options.password !== undefined) {
      this.#headers.set("authorization", `Basic ${Buffer.from(`${options.username ?? "opencode"}:${options.password}`, "utf8").toString("base64")}`)
    }
  }

  async health(): Promise<{ ok: boolean; version: string | null; capabilities: AdapterCapabilities; reason?: string }> {
    const capabilities: AdapterCapabilities = {
      legacyHTTP: false, promptSystem: false, durableMessages: false, toolResults: false,
      permissions: false, v2Detected: false, v2Supported: false,
    }
    let version: string | null = null
    try {
      const result = record(await this.#request("GET", "/global/health"), "health")
      version = string(result.version, "health.version")
      if (result.healthy !== true) throw protocol("OpenCode reports unhealthy")
      const doc = record(await this.#request("GET", "/doc"), "API document")
      const paths = record(doc.paths, "API paths")
      const has = (path: string, method: string) => isRecord(paths[path]) && isRecord(paths[path][method])
      capabilities.legacyHTTP = has("/session", "post") && has("/session/{sessionID}/message", "post")
      capabilities.durableMessages = has("/session/{sessionID}/message", "get")
      capabilities.toolResults = capabilities.durableMessages
      capabilities.permissions = has("/permission/{requestID}/reply", "post")
      capabilities.v2Detected = has("/api/session/{sessionID}/prompt", "post")
      capabilities.promptSystem = hasSystemField(doc, paths)
      const ok = capabilities.legacyHTTP && capabilities.durableMessages && capabilities.promptSystem
      return { ok, version, capabilities, ...(!ok ? { reason: "Required legacy HTTP routes or prompt system field are not advertised; V2 is not supported" } : {}) }
    } catch (error) {
      return { ok: false, version, capabilities, reason: safeError(error) }
    }
  }

  async createSession(title?: string): Promise<{ id: string; title?: string }> {
    const result = record(await this.#request("POST", "/session", title === undefined ? {} : { title }), "session")
    return { id: string(result.id, "session.id"), ...(typeof result.title === "string" ? { title: result.title } : {}) }
  }

  async prompt(sessionID: string, text: string, options: { system?: string; model?: { providerID: string; modelID: string } } = {}): Promise<PromptResult> {
    const endpoint = `/session/${segment(sessionID)}/message`
    if (!text.trim()) throw new Error("Prompt text cannot be empty")
    try {
      const response = await this.#request("POST", endpoint, {
        parts: [{ type: "text", text }],
        ...(options.system !== undefined ? { system: options.system } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
      })
      const result = normalizeMessage(response, sessionID)
      if (result.role !== "assistant") throw protocol("Prompt response must contain an assistant message")
      return { messageID: result.messageID, text: result.text, parts: result.parts, status: result.status, ...(result.error ? { error: result.error } : {}) }
    } catch (error) {
      // A lost response can follow a committed tool action. Never retry this POST.
      const rejected = error instanceof OpenCodeAdapterError && error.kind === "http"
        && [401, 403, 404, 422].includes(error.status ?? 0)
      return { messageID: null, text: "", parts: [], status: rejected ? "failed" : "unknown", error: safeError(error) }
    }
  }

  async messages(sessionID: string): Promise<NormalizedMessage[]> {
    // The supported legacy contract returns the complete history when limit is absent.
    // A future paginated-only contract requires a different adapter; never invent a cursor.
    const value = await this.#request("GET", `/session/${segment(sessionID)}/message`)
    if (!Array.isArray(value)) throw protocol("Expected an array of persisted messages")
    const results = value.map((item) => normalizeMessage(item, sessionID))
    const ids = new Set<string>()
    for (const message of results) {
      if (ids.has(message.messageID)) throw protocol("Duplicate message identity in history")
      ids.add(message.messageID)
    }
    return results
  }

  /** Compare quiescent legacy sessions across isolated engine copies. Includes
   * every public JSON field, even attachments omitted by the UI normalizer.
   * Metadata bracketing detects concurrent updates; it is not a transaction or
   * permission to migrate an active session. The caller must stop its writers.
   */
  async migrationDigest(sessionID: string): Promise<MigrationDigest> {
    const endpoint = `/session/${segment(sessionID)}`
    const before = migrationSession(await this.#request("GET", endpoint), sessionID)
    const value = await this.#request("GET", `${endpoint}/message`)
    if (!Array.isArray(value)) throw protocol("Expected complete legacy session message history")
    const ids = new Set<string>()
    for (const raw of value) {
      const message = normalizeMessage(raw, sessionID)
      if (ids.has(message.messageID)) throw protocol("Duplicate message identity in migration history")
      ids.add(message.messageID)
    }
    const after = migrationSession(await this.#request("GET", endpoint), sessionID)
    if (canonicalJSON(before) !== canonicalJSON(after)) throw protocol("Session metadata changed during migration snapshot")
    const bytes = new TextEncoder().encode(canonicalJSON({ session: before, messages: value }))
    const digest = await crypto.subtle.digest("SHA-256", bytes)
    return { sessionID, messageCount: value.length, sha256: Buffer.from(digest).toString("hex") }
  }

  async abort(sessionID: string): Promise<boolean> {
    const result = await this.#request("POST", `/session/${segment(sessionID)}/abort`)
    if (typeof result !== "boolean") throw protocol("Invalid abort acknowledgement")
    return result
  }

  async providers(): Promise<ProviderStatus> {
    const result = record(await this.#request("GET", "/provider"), "providers")
    if (!Array.isArray(result.all)) throw protocol("Invalid provider list")
    const defaults = record(result.default, "provider defaults")
    const all = result.all.map((value) => {
      const provider = record(value, "provider")
      const models = record(provider.models, "provider models")
      return {
        id: string(provider.id, "provider.id"), name: string(provider.name, "provider.name"),
        models: Object.entries(models).map(([id, value]) => {
          const model = record(value, "model")
          return { id: typeof model.id === "string" ? model.id : id, name: string(model.name, "model.name") }
        }),
      }
    })
    // Whitelisting deliberately excludes provider.key, options, env and auth metadata.
    return { all, connected: strings(result.connected, "connected providers"), default: Object.fromEntries(Object.entries(defaults).map(([id, value]) => [id, string(value, "default model")])) }
  }

  async permissions(): Promise<PermissionRequest[]> {
    const result = await this.#request("GET", "/permission")
    if (!Array.isArray(result)) throw protocol("Invalid pending permission list")
    return result.map((value) => {
      const item = record(value, "permission")
      return { id: string(item.id, "permission.id"), sessionID: string(item.sessionID, "permission.sessionID"), permission: string(item.permission, "permission.name"), patterns: strings(item.patterns, "permission.patterns") }
    })
  }

  async replyPermission(requestID: string, reply: "once" | "always" | "reject"): Promise<boolean> {
    if (!["once", "always", "reject"].includes(reply)) throw new Error("Invalid permission response")
    const result = await this.#request("POST", `/permission/${segment(requestID)}/reply`, { reply })
    if (typeof result !== "boolean") throw protocol("Invalid permission acknowledgement")
    return result
  }

  async respondPermission(sessionID: string, permissionID: string, response: "once" | "always" | "reject"): Promise<boolean> {
    if (!["once", "always", "reject"].includes(response)) throw new Error("Invalid permission response")
    const result = await this.#request("POST", `/session/${segment(sessionID)}/permissions/${segment(permissionID)}`, { response })
    if (typeof result !== "boolean") throw protocol("Invalid permission acknowledgement")
    return result
  }

  async #request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const url = new URL(path, this.#url)
    if (this.#directory !== undefined) url.searchParams.set("directory", this.#directory)
    const headers = new Headers(this.#headers)
    if (body !== undefined) headers.set("content-type", "application/json")
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.#timeout)
    try {
      const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: controller.signal })
      if (!response.ok) {
        await response.body?.cancel()
        throw new OpenCodeAdapterError("http", `OpenCode HTTP ${response.status}`, response.status)
      }
      if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
        await response.body?.cancel()
        throw protocol("Expected an OpenCode JSON response")
      }
      const raw = await response.text()
      try { return JSON.parse(raw) as unknown }
      catch { throw protocol("Invalid OpenCode JSON response") }
    } catch (error) {
      if (controller.signal.aborted) throw new OpenCodeAdapterError("timeout", "OpenCode request timed out; execution may still be running")
      if (error instanceof OpenCodeAdapterError) throw error
      // Network exception text can include URLs or credentials supplied by a server.
      throw new OpenCodeAdapterError("network", "OpenCode connection failed")
    } finally { clearTimeout(timeout) }
  }
}

function normalizeMessage(value: unknown, sessionID: string): NormalizedMessage {
  const message = record(value, "message")
  const info = record(message.info, "message.info")
  const id = string(info.id, "message.id")
  if (info.sessionID !== sessionID) throw protocol("Message belongs to a different session")
  if (info.role !== "user" && info.role !== "assistant") throw protocol("Unsupported message role")
  if (!Array.isArray(message.parts)) throw protocol("Invalid message parts")
  const time = record(info.time, "message.time")
  if (!finite(time.created) || (time.completed !== undefined && !finite(time.completed))) throw protocol("Invalid message time")
  const parts = message.parts.map((part) => normalizePart(part, sessionID, id))
  if (new Set(parts.map((part) => part.id)).size !== parts.length) throw protocol("Duplicate part identity")
  const error = info.error === undefined ? undefined : errorName(info.error)
  const complete = info.role === "user" || (finite(time.completed) && typeof info.finish === "string" && info.finish !== "tool-calls")
  return {
    sourceID: sourceID(sessionID, id), sessionID, messageID: id, role: info.role,
    text: parts.filter((part): part is NormalizedPart & { type: "text" } => part.type === "text" && !part.ignored).map((part) => part.text).join("\n"),
    parts, status: error ? "failed" : complete ? "completed" : "unknown",
    time: { created: time.created, ...(finite(time.completed) ? { completed: time.completed } : {}) },
    ...(error ? { error } : {}),
  }
}

function migrationSession(value: unknown, sessionID: string): Record<string, unknown> {
  const session = record(value, "migration session")
  if (session.id !== sessionID) throw protocol("Migration session identity mismatch")
  const time = record(session.time, "migration session time")
  if (!timestamp(time.created) || !timestamp(time.updated)) throw protocol("Invalid migration session timestamps")
  return session
}

function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`
  throw protocol("Unsupported JSON value in migration snapshot")
}

function normalizePart(value: unknown, sessionID: string, messageID: string): NormalizedPart {
  const part = record(value, "part")
  const id = string(part.id, "part.id")
  if (part.sessionID !== sessionID || part.messageID !== messageID) throw protocol("Part source identity mismatch")
  const base: Source = { sourceID: sourceID(sessionID, messageID, id), sessionID, messageID, id }
  const type = string(part.type, "part.type")
  if (type === "text") {
    if (typeof part.text !== "string") throw protocol("Invalid text part")
    return { ...base, type, text: part.text, synthetic: part.synthetic === true, ignored: part.ignored === true }
  }
  if (type !== "tool") return { ...base, type: "other", kind: type }
  const state = record(part.state, "tool.state")
  const upstreamStatus = string(state.status, "tool.status")
  const tool = string(part.tool, "tool.name")
  const input = record(state.input, "tool.input")
  if (upstreamStatus === "completed" && typeof state.output !== "string") throw protocol("Completed tool has no persisted output")
  if (upstreamStatus === "error" && typeof state.error !== "string") throw protocol("Failed tool has no persisted error")
  return {
    ...base, type: "tool", callID: string(part.callID, "tool.callID"), tool, input,
    upstreamStatus, status: upstreamStatus === "completed" ? "completed" : upstreamStatus === "error" ? "failed" : "unknown",
    execution: executionEvidence(tool, upstreamStatus, state, part),
    ...(upstreamStatus === "completed" ? { output: state.output as string } : {}),
    ...(upstreamStatus === "error" ? { error: state.error as string } : {}),
  }
}

function executionEvidence(tool: string, status: string, state: Record<string, unknown>, part: Record<string, unknown>): ToolExecutionEvidence {
  const lifecycle = status === "completed" ? "completed" : status === "error" ? "failed" : "unknown"
  const metadata = isRecord(state.metadata) ? state.metadata : {}
  const time = isRecord(state.time) ? state.time : {}
  const startedAt = timestamp(time.start) ? time.start : undefined
  const finishedAt = timestamp(time.end) && (startedAt === undefined || time.end >= startedAt) ? time.end : undefined
  const result: ToolExecutionEvidence = {
    version: 1, lifecycle, outcome: "unknown", basis: "unrecognized-tool-contract",
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
  }
  // The qualified legacy runtime executes its shell under the historical "bash"
  // name. "shell" accepts the same explicit metadata.exit contract. Names of
  // unknown/custom/MCP tools do not inherit this meaning from their output text.
  const shell = tool === "bash" || tool === "shell"
  const builtin = tool === "read" || tool === "write" || tool === "edit"
  // Provider-executed calls can use familiar tool names without executing the
  // qualified local implementation. Their metadata is not an OS result contract.
  if (isRecord(part.metadata) && part.metadata.providerExecuted === true) return { ...result, basis: "provider-executed-tool" }
  if (shell && (metadata.exit === null || exitCode(metadata.exit))) result.exitCode = metadata.exit
  // Legacy cancellation can retain metadata from a running tool. That progress
  // must not become positive/negative learning about the eventual side effects.
  if (metadata.interrupted === true) return { ...result, basis: "tool-interrupted" }
  if (lifecycle === "unknown") return { ...result, basis: "tool-not-terminal" }
  if (!shell && !builtin) return result
  if (lifecycle === "failed") return { ...result, outcome: "failed", basis: "builtin-tool-error" }
  if (shell) {
    if (typeof result.exitCode !== "number") return { ...result, basis: "shell-exit-unavailable" }
    return { ...result, outcome: result.exitCode === 0 ? "succeeded" : "failed", basis: result.exitCode === 0 ? "shell-exit-zero" : "shell-exit-nonzero" }
  }
  // Reviewed legacy read/write/edit return only after the tool operation has
  // returned. Diagnostics or a partial read are not a whole-task verdict, and
  // a tool exception may follow side effects. Never parse their output as proof.
  return { ...result, outcome: "succeeded", basis: "builtin-tool-completed" }
}

function hasSystemField(doc: Record<string, unknown>, paths: Record<string, unknown>): boolean {
  const path = paths["/session/{sessionID}/message"]
  if (!isRecord(path) || !isRecord(path.post) || !isRecord(path.post.requestBody)) return false
  const content = path.post.requestBody.content
  if (!isRecord(content) || !isRecord(content["application/json"])) return false
  const schemas = isRecord(doc.components) && isRecord(doc.components.schemas) ? doc.components.schemas : {}
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 12 || !isRecord(value)) return false
    if (isRecord(value.properties) && isRecord(value.properties.system)) return true
    if (typeof value.$ref === "string" && value.$ref.startsWith("#/components/schemas/")) {
      return visit(schemas[value.$ref.slice("#/components/schemas/".length)], depth + 1)
    }
    return [value.anyOf, value.allOf, value.oneOf].some((items) => Array.isArray(items) && items.some((item) => visit(item, depth + 1)))
  }
  return visit(content["application/json"].schema, 0)
}

function sourceID(...ids: string[]): string { return `opencode:legacy:${ids.map(encodeURIComponent).join(":")}` }
function segment(value: string): string {
  if (!value || value === "." || value === "..") throw new Error("A valid OpenCode identifier is required")
  return encodeURIComponent(value)
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) }
function record(value: unknown, field: string): Record<string, unknown> { if (!isRecord(value)) throw protocol(`Invalid ${field}`); return value }
function string(value: unknown, field: string): string { if (typeof value !== "string" || !value) throw protocol(`Invalid ${field}`); return value }
function strings(value: unknown, field: string): string[] { if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) throw protocol(`Invalid ${field}`); return value }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) }
function timestamp(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 }
function exitCode(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= -2_147_483_648 && value <= 4_294_967_295 }
function protocol(message: string): OpenCodeAdapterError { return new OpenCodeAdapterError("protocol", message) }
function safeError(error: unknown): string { return error instanceof OpenCodeAdapterError ? error.message : "Invalid OpenCode response" }
function errorName(error: unknown): string {
  const value = record(error, "assistant error")
  // Error data may contain request headers; keep only a bounded code from a known shape.
  return typeof value.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,80}$/.test(value.name) ? value.name : "AssistantError"
}
