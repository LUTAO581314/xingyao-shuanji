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
  /** Independent background budgets; never lengthen foreground requests. */
  memoryExtractionTimeoutMs?: number
  memoryCleanupTimeoutMs?: number
}

export type AdapterCapabilities = {
  legacyHTTP: boolean
  promptSystem: boolean
  durableMessages: boolean
  toolResults: boolean
  permissions: boolean
  collaboration: boolean
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
export type CollaborationStatus = { type: "idle" | "busy" } | { type: "retry"; attempt: number; next: number }
export type CollaborationTool = {
  sourceID: string; callID: string; tool: string; status: "completed" | "failed" | "unknown"
  execution: ToolExecutionEvidence
}
export type CollaborationMessage = {
  sourceID: string; messageID: string; role: "user" | "assistant"; text: string
  status: "completed" | "failed" | "unknown"; createdAt: number; completedAt?: number
  tools: CollaborationTool[]
}
export type CollaborationSession = {
  sessionID: string; parentSessionID: string; title: string; agent: string | null; depth: number
  status: CollaborationStatus; createdAt: number; updatedAt: number
  messageCount: number; messages: CollaborationMessage[]; transcriptTruncated: boolean
}
export type CollaborationView = {
  rootSessionID: string; sessions: CollaborationSession[]; truncated: boolean
  limits: { sessions: number; depth: number; transcriptBytes: number }
}
export type Subagent = { name: string; description: string | null }
export type DelegationSessionInput = {
  rootSessionID: string
  delegationID: string
  taskID: string
  title: string
  agent: string
}

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
  readonly #memoryTimeout: number
  readonly #memoryCleanupTimeout: number

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
    this.#memoryTimeout = boundedTimeout(options.memoryExtractionTimeoutMs ?? Math.min(this.#timeout, 60_000), 60_000)
    this.#memoryCleanupTimeout = boundedTimeout(options.memoryCleanupTimeoutMs ?? Math.min(this.#timeout, 10_000), 10_000)
    this.#headers = new Headers({ accept: "application/json" })
    if (options.password !== undefined) {
      this.#headers.set("authorization", `Basic ${Buffer.from(`${options.username ?? "opencode"}:${options.password}`, "utf8").toString("base64")}`)
    }
  }

  async health(): Promise<{ ok: boolean; version: string | null; capabilities: AdapterCapabilities; reason?: string }> {
    const capabilities: AdapterCapabilities = {
      legacyHTTP: false, promptSystem: false, durableMessages: false, toolResults: false,
      permissions: false, collaboration: false, v2Detected: false, v2Supported: false,
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
      capabilities.collaboration = has("/session/{sessionID}/children", "get") && has("/session/status", "get")
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

  async subagents(): Promise<Subagent[]> {
    const value = await this.#request("GET", "/agent", undefined, { maxBytes: COLLABORATION_RESPONSE_BYTES })
    if (!Array.isArray(value)) throw protocol("Expected an array of OpenCode agents")
    const result: Subagent[] = []
    for (const raw of value) {
      const agent = record(raw, "agent")
      const name = delegationText(agent.name, 100, "agent name")
      if (typeof agent.mode !== "string" || agent.hidden !== undefined && typeof agent.hidden !== "boolean") throw protocol("Invalid OpenCode agent projection")
      if (agent.mode === "subagent" && agent.hidden !== true) result.push({ name, description: typeof agent.description === "string" ? agent.description.slice(0, 500) : null })
    }
    if (new Set(result.map(agent => agent.name)).size !== result.length) throw protocol("Duplicate OpenCode subagent name")
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  async createDelegationSession(input: DelegationSessionInput): Promise<{ id: string }> {
    delegationInput(input)
    const value = await this.#request("POST", "/session", {
      parentID: input.rootSessionID, title: input.title, agent: input.agent,
      metadata: { xingyao: { kind: "delegation", delegationID: input.delegationID, taskID: input.taskID } },
    }, { timeoutMs: Math.min(this.#timeout, 15_000), maxBytes: COLLABORATION_RESPONSE_BYTES })
    return delegationSession(value, input)
  }

  /** Resolve a lost create response by its durable product identity. Never
   * create another session while the first POST may have committed. */
  async findDelegationSession(input: DelegationSessionInput): Promise<{ id: string } | null> {
    delegationInput(input)
    const value = await this.#request("GET", `/session/${segment(input.rootSessionID)}/children`, undefined, { maxBytes: COLLABORATION_RESPONSE_BYTES })
    if (!Array.isArray(value)) throw protocol("Expected an array of child sessions")
    const ids = new Set<string>(), matches: Array<{ id: string }> = []
    for (const raw of value) {
      const session = record(raw, "child session")
      const id = string(session.id, "child session id")
      if (ids.has(id)) throw protocol("Duplicate child session identity")
      ids.add(id)
      if (session.parentID !== input.rootSessionID) throw protocol("Child session has the wrong parent")
      const owner = delegationOwner(session)
      if (owner?.kind === "delegation" && owner.delegationID === input.delegationID) matches.push(delegationSession(session, input))
    }
    if (matches.length > 1) throw protocol("Multiple child sessions claim the same delegation")
    return matches[0] ?? null
  }

  async assertDelegationSession(sessionID: string, input: DelegationSessionInput): Promise<void> {
    delegationInput(input)
    const session = delegationSession(await this.#request("GET", `/session/${segment(sessionID)}`, undefined, { maxBytes: COLLABORATION_RESPONSE_BYTES }), input)
    if (session.id !== sessionID) throw protocol("Delegation session identity mismatch")
  }

  async delegationMessages(sessionID: string, input: DelegationSessionInput): Promise<NormalizedMessage[]> {
    await this.assertDelegationSession(sessionID, input)
    return await this.messages(sessionID)
  }

  async delegationStatus(sessionID: string, input: DelegationSessionInput): Promise<CollaborationStatus> {
    await this.assertDelegationSession(sessionID, input)
    const statuses = record(await this.#request("GET", "/session/status", undefined, { maxBytes: COLLABORATION_RESPONSE_BYTES }), "session statuses")
    return statuses[sessionID] === undefined ? { type: "idle" } : collaborationStatus(statuses[sessionID])
  }

  async promptDelegation(sessionID: string, text: string, input: DelegationSessionInput): Promise<PromptResult> {
    await this.assertDelegationSession(sessionID, input)
    return await this.prompt(sessionID, text, { agent: input.agent })
  }

  async abortDelegation(sessionID: string, input: DelegationSessionInput): Promise<boolean> {
    await this.assertDelegationSession(sessionID, input)
    return await this.abort(sessionID)
  }

  /** The caller persists this ID on its background job before prompting. These
   * sessions are never task sessions and their messages are not experiences. */
  async createMemoryExtractionSession(jobID: string): Promise<{ id: string }> {
    extractionJobID(jobID)
    const result = await this.#request("POST", "/session", {
      title: extractionTitle(jobID), agent: "build",
      metadata: { xingyao: { kind: "memory-extraction", jobID } },
      permission: extractionPermission,
    }, { timeoutMs: this.#memoryCleanupTimeout, maxBytes: EXTRACTION_RESPONSE_BYTES })
    const id = string(record(result, "extraction session").id, "extraction session id")
    extractionSession(result, id, jobID, true)
    return { id }
  }

  /** Plain JSON text transport: the qualified engine's native format field
   * breaks full-history reads and does not validate JSON Schema. The domain
   * must separately validate candidate JSON and its exact source revisions.
   * Failures throw; a failed or uncertain request is never silently retried. */
  async promptMemoryExtraction(sessionID: string, input: string, options: { system: string; model?: { providerID: string; modelID: string }; jobID?: string }): Promise<PromptResult> {
    extractionText(input, 65_536, "input")
    extractionText(options.system, 32_768, "system")
    if (options.model) { extractionText(options.model.providerID, 200, "provider ID"); extractionText(options.model.modelID, 300, "model ID") }
    const endpoint = `/session/${segment(sessionID)}`
    const deadline = Date.now() + this.#memoryTimeout
    const read = (path: string, history = false) => this.#request("GET", path, undefined, {
      timeoutMs: remaining(deadline), maxBytes: EXTRACTION_RESPONSE_BYTES, completeHistory: history,
    })
    if (options.jobID !== undefined) extractionJobID(options.jobID)
    const jobID = extractionSession(await read(endpoint), sessionID, options.jobID, true)
    const before = await read(`${endpoint}/message`, true)
    if (!Array.isArray(before) || before.length !== 0) throw protocol("Extraction session already contains a request; reconcile instead of resending")
    // Do not forward arbitrary caller fields, format, tools or non-text parts.
    const raw = await this.#request("POST", `${endpoint}/message`, {
      agent: "build", parts: [{ type: "text", text: input }], system: options.system,
      ...(options.model ? { model: { providerID: options.model.providerID, modelID: options.model.modelID } } : {}),
    }, { timeoutMs: remaining(deadline), maxBytes: EXTRACTION_RESPONSE_BYTES })
    const response = extractionMessage(raw, sessionID)
    if (response.role !== "assistant" || response.status !== "completed" || record(record(raw, "extraction response").info, "extraction info").finish !== "stop") {
      throw protocol("Extraction did not return a completed assistant response")
    }
    const history = await read(`${endpoint}/message`, true)
    if (!Array.isArray(history)) throw protocol("Expected complete extraction history")
    const messages = history.map(item => extractionMessage(item, sessionID))
    if (messages.some(message => message.parts.some(part => part.type === "tool"))) throw protocol("Extraction session attempted a tool; candidate batch rejected")
    if (messages.length !== 2 || messages[0]!.role !== "user" || messages[1]!.role !== "assistant"
      || messages[0]!.messageID === messages[1]!.messageID || messages[0]!.text !== input
      || messages[0]!.parts.length !== 1 || messages[0]!.parts[0]!.type !== "text") throw protocol("Extraction history does not match the single admitted request")
    const user = record(record(history[0], "extraction user").info, "extraction user info")
    const assistant = record(record(history[1], "extraction assistant").info, "extraction assistant info")
    if (user.system !== options.system || user.agent !== "build" || user.format !== undefined || user.tools !== undefined
      || assistant.parentID !== messages[0]!.messageID || assistant.finish !== "stop"
      || canonicalJSON(messages[1]) !== canonicalJSON(response)) throw protocol("Extraction response differs from its persisted request or result")
    extractionText(response.text, 65_536, "output")
    extractionSession(await read(endpoint), sessionID, jobID, true)
    const permissions = await read("/permission")
    if (!Array.isArray(permissions) || permissions.some(item => record(item, "extraction permission").sessionID === sessionID)) throw protocol("Extraction has an unexpected permission request")
    return { messageID: response.messageID, text: response.text, parts: response.parts, status: "completed" }
  }

  /** Cleanup is scoped to a job-owned session. Deletion can recurse upstream,
   * so sessions with children are preserved for explicit investigation. */
  async deleteMemoryExtractionSession(sessionID: string, jobID: string): Promise<boolean> {
    extractionJobID(jobID)
    const endpoint = `/session/${segment(sessionID)}`
    const deadline = Date.now() + this.#memoryCleanupTimeout
    const call = (method: "GET" | "POST" | "DELETE", path: string) => this.#request(method, path, undefined, {
      timeoutMs: remaining(deadline), maxBytes: EXTRACTION_RESPONSE_BYTES,
    })
    const absent = async (path: string): Promise<boolean> => {
      try { await call("GET", path); return false }
      catch (error) { if (error instanceof OpenCodeAdapterError && error.kind === "http" && error.status === 404) return true; throw error }
    }
    let session: unknown
    try { session = await call("GET", endpoint) }
    catch (error) {
      if (!(error instanceof OpenCodeAdapterError && error.kind === "http" && error.status === 404)) throw error
      if (!await absent(`${endpoint}/message`)) throw protocol("Deleted extraction session still exposes messages")
      return true
    }
    extractionSession(session, sessionID, jobID, false)
    if (await call("POST", `${endpoint}/abort`) !== true) throw protocol("Extraction abort was not acknowledged")
    extractionSession(await call("GET", endpoint), sessionID, jobID, false)
    const children = await call("GET", `${endpoint}/children`)
    if (!Array.isArray(children) || children.length) throw protocol("Extraction session has unexpected children; refusing recursive deletion")
    if (await call("DELETE", endpoint) !== true) throw protocol("Extraction deletion was not acknowledged")
    const sessionAbsent = await absent(endpoint)
    const messagesAbsent = await absent(`${endpoint}/message`)
    if (!sessionAbsent || !messagesAbsent) throw protocol("Extraction deletion could not be verified")
    return true
  }

  async prompt(sessionID: string, text: string, options: { system?: string; model?: { providerID: string; modelID: string }; agent?: string } = {}): Promise<PromptResult> {
    const endpoint = `/session/${segment(sessionID)}/message`
    if (!text.trim()) throw new Error("Prompt text cannot be empty")
    try {
      const response = await this.#request("POST", endpoint, {
        parts: [{ type: "text", text }],
        ...(options.agent !== undefined ? { agent: options.agent } : {}),
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

  /** Read a bounded, source-preserving projection of descendants belonging to
   * one product task session. It never creates, resumes or mutates a child. */
  async collaboration(rootSessionID: string): Promise<CollaborationView> {
    segment(rootSessionID)
    const deadline = Date.now() + COLLABORATION_TIMEOUT_MS
    const call = (path: string, maxBytes = COLLABORATION_RESPONSE_BYTES, completeHistory = false) => this.#request("GET", path, undefined, {
      timeoutMs: collaborationRemaining(deadline), maxBytes, completeHistory,
    })
    const rawStatuses = record(await call("/session/status"), "session statuses")
    const queue: Array<{ parent: string; depth: number }> = [{ parent: rootSessionID, depth: 1 }]
    const seen = new Set([rootSessionID]), sessions: CollaborationSession[] = []
    let transcriptBytes = 0, truncated = false
    while (queue.length && sessions.length < COLLABORATION_MAX_SESSIONS) {
      const current = queue.shift()!
      const rawChildren = await call(`/session/${segment(current.parent)}/children`)
      if (!Array.isArray(rawChildren)) throw protocol("Expected an array of child sessions")
      if (current.depth > COLLABORATION_MAX_DEPTH) {
        if (rawChildren.length) truncated = true
        continue
      }
      for (const rawChild of rawChildren) {
        if (sessions.length >= COLLABORATION_MAX_SESSIONS) { truncated = true; break }
        const child = collaborationSession(rawChild, current.parent, current.depth, rawStatuses)
        if (seen.has(child.sessionID)) throw protocol("Duplicate or cyclic collaboration session")
        seen.add(child.sessionID)
        const rawHistory = await call(`/session/${segment(child.sessionID)}/message`, COLLABORATION_HISTORY_BYTES, true)
        if (!Array.isArray(rawHistory)) throw protocol("Expected complete child session message history")
        const normalized = rawHistory.map(item => normalizeMessage(item, child.sessionID))
        if (new Set(normalized.map(message => message.messageID)).size !== normalized.length) throw protocol("Duplicate message identity in collaboration history")
        const projected = normalized.map(collaborationMessage)
        const admitted: CollaborationMessage[] = []
        let transcriptTruncated = false
        for (let index = projected.length - 1; index >= 0; index--) {
          const message = projected[index]!, bytes = Buffer.byteLength(JSON.stringify(message))
          if (transcriptBytes + bytes > COLLABORATION_TRANSCRIPT_BYTES) { transcriptTruncated = true; continue }
          transcriptBytes += bytes; admitted.unshift(message)
        }
        sessions.push({ ...child, messageCount: normalized.length, messages: admitted, transcriptTruncated })
        queue.push({ parent: child.sessionID, depth: current.depth + 1 })
      }
    }
    if (queue.length) truncated = true
    return { rootSessionID, sessions, truncated, limits: { sessions: COLLABORATION_MAX_SESSIONS, depth: COLLABORATION_MAX_DEPTH, transcriptBytes: COLLABORATION_TRANSCRIPT_BYTES } }
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
    const result = await this.#request("POST", `/session/${segment(sessionID)}/abort`, undefined, { timeoutMs: Math.min(this.#timeout, 10_000), maxBytes: EXTRACTION_RESPONSE_BYTES })
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

  async #request(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, policy: { timeoutMs?: number; maxBytes?: number; completeHistory?: boolean } = {}): Promise<unknown> {
    const url = new URL(path, this.#url)
    if (this.#directory !== undefined) url.searchParams.set("directory", this.#directory)
    const headers = new Headers(this.#headers)
    if (body !== undefined) headers.set("content-type", "application/json")
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), policy.timeoutMs ?? this.#timeout)
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
      if (policy.completeHistory && (response.headers.get("x-next-cursor") || /\brel\s*=\s*"?next\b/i.test(response.headers.get("link") ?? ""))) {
        await response.body?.cancel()
        throw protocol("Paginated extraction history is unsupported")
      }
      const raw = policy.maxBytes === undefined ? await response.text() : await boundedResponse(response, policy.maxBytes)
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

const EXTRACTION_RESPONSE_BYTES = 1_048_576
const COLLABORATION_RESPONSE_BYTES = 262_144
const COLLABORATION_HISTORY_BYTES = 1_048_576
const COLLABORATION_TRANSCRIPT_BYTES = 2 * 1_048_576
const COLLABORATION_MAX_SESSIONS = 32
const COLLABORATION_MAX_DEPTH = 4
const COLLABORATION_TIMEOUT_MS = 15_000
const extractionPermission = [{ permission: "*", pattern: "*", action: "deny" }]
function extractionTitle(jobID: string) { return `Xingyao memory extraction ${jobID}` }
function delegationText(value: unknown, maximum: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) throw protocol(`Invalid delegation ${field}`)
  return value
}
function delegationInput(input: DelegationSessionInput) {
  delegationText(input.rootSessionID, 300, "root session ID")
  delegationText(input.delegationID, 200, "ID")
  delegationText(input.taskID, 200, "task ID")
  delegationText(input.title, 200, "title")
  delegationText(input.agent, 100, "agent")
}
function delegationOwner(session: Record<string, unknown>): Record<string, unknown> | null {
  if (!isRecord(session.metadata) || !isRecord(session.metadata.xingyao)) return null
  return session.metadata.xingyao
}
function delegationSession(value: unknown, input: DelegationSessionInput): { id: string } {
  const session = record(value, "delegation session")
  const owner = delegationOwner(session)
  if (!owner || owner.kind !== "delegation" || owner.delegationID !== input.delegationID || owner.taskID !== input.taskID
    || session.parentID !== input.rootSessionID || session.title !== input.title || session.agent !== input.agent) {
    throw protocol("Delegation session ownership mismatch")
  }
  return { id: string(session.id, "delegation session id") }
}
function extractionJobID(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error("Invalid memory extraction job ID")
}
function extractionText(value: string, maximum: number, field: string) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) throw protocol(`Invalid memory extraction ${field}`)
}
function extractionSession(value: unknown, sessionID: string, expectedJobID: string | undefined, restricted: boolean): string {
  const session = record(value, "memory extraction session")
  const owner = record(record(session.metadata, "memory extraction metadata").xingyao, "memory extraction ownership")
  const jobID = string(owner.jobID, "memory extraction job ID")
  extractionJobID(jobID)
  if (session.id !== sessionID || owner.kind !== "memory-extraction" || expectedJobID !== undefined && jobID !== expectedJobID
    || session.title !== extractionTitle(jobID) || session.parentID !== undefined && session.parentID !== null) throw protocol("Memory extraction session ownership mismatch")
  if (restricted && (!Array.isArray(session.permission) || canonicalJSON(session.permission) !== canonicalJSON(extractionPermission))) throw protocol("Memory extraction session must deny all tools")
  return jobID
}
function extractionMessage(raw: unknown, sessionID: string): NormalizedMessage {
  const message = normalizeMessage(raw, sessionID)
  if (message.parts.some(part => part.type === "text" && (part.ignored || part.synthetic)
    || part.type === "other" && !["reasoning", "step-start", "step-finish"].includes(part.kind))) throw protocol("Unexpected extraction message part")
  if (!timestamp(message.time.created) || message.time.completed !== undefined && (!timestamp(message.time.completed) || message.time.completed < message.time.created)) throw protocol("Invalid extraction message timestamps")
  return message
}
function boundedTimeout(value: number, maximum: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > maximum) throw new Error(`Memory request timeout must be positive and at most ${maximum} ms`)
  return value
}
function remaining(deadline: number): number {
  const value = deadline - Date.now()
  if (value <= 0) throw new OpenCodeAdapterError("timeout", "OpenCode memory operation timed out; reconcile before retrying")
  return value
}
function collaborationRemaining(deadline: number): number {
  const value = deadline - Date.now()
  if (value <= 0) throw new OpenCodeAdapterError("timeout", "OpenCode collaboration view timed out")
  return value
}
async function boundedResponse(response: Response, maximum: number): Promise<string> {
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel()
    throw protocol("OpenCode memory response exceeds the size limit")
  }
  if (!response.body) throw protocol("Missing OpenCode JSON response body")
  const reader = response.body.getReader()
  let bytes = 0, text = ""
  const decoder = new TextDecoder("utf-8", { fatal: true })
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return text + decoder.decode()
      bytes += chunk.value.byteLength
      if (bytes > maximum) { await reader.cancel(); throw protocol("OpenCode memory response exceeds the size limit") }
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally { reader.releaseLock() }
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

function collaborationSession(value: unknown, parentSessionID: string, depth: number, statuses: Record<string, unknown>): Omit<CollaborationSession, "messageCount" | "messages" | "transcriptTruncated"> {
  const session = record(value, "collaboration session")
  const sessionID = string(session.id, "collaboration session id")
  if (session.parentID !== parentSessionID) throw protocol("Collaboration child does not belong to the requested parent")
  const title = string(session.title, "collaboration title")
  const agent = session.agent === undefined || session.agent === null ? null : string(session.agent, "collaboration agent")
  const time = record(session.time, "collaboration time")
  if (!timestamp(time.created) || !timestamp(time.updated) || time.updated < time.created) throw protocol("Invalid collaboration session timestamps")
  const status = statuses[sessionID] === undefined ? { type: "idle" as const } : collaborationStatus(statuses[sessionID])
  return { sessionID, parentSessionID, title, agent, depth, status, createdAt: time.created, updatedAt: time.updated }
}

function collaborationStatus(value: unknown): CollaborationStatus {
  const status = record(value, "collaboration status")
  if (status.type === "idle" || status.type === "busy") return { type: status.type }
  if (status.type === "retry" && Number.isSafeInteger(status.attempt) && (status.attempt as number) >= 0 && timestamp(status.next)) {
    return { type: "retry", attempt: status.attempt as number, next: status.next as number }
  }
  throw protocol("Invalid collaboration session status")
}

function collaborationMessage(message: NormalizedMessage): CollaborationMessage {
  if (!timestamp(message.time.created) || message.time.completed !== undefined && (!timestamp(message.time.completed) || message.time.completed < message.time.created)) {
    throw protocol("Invalid collaboration message timestamps")
  }
  return {
    sourceID: message.sourceID, messageID: message.messageID, role: message.role, text: message.text,
    status: message.status, createdAt: message.time.created,
    ...(message.time.completed !== undefined ? { completedAt: message.time.completed } : {}),
    tools: message.parts.flatMap(part => part.type === "tool" ? [{
      sourceID: part.sourceID, callID: part.callID, tool: part.tool, status: part.status, execution: part.execution,
    }] : []),
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
