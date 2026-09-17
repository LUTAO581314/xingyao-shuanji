import { SoulStore, ConflictError, SealedError } from "./store"
import { OpenCodeAdapter } from "./adapter"
import type { NormalizedMessage, NormalizedPart } from "./adapter"
import { createCheckpoint, listCheckpoints } from "./checkpoint"
import { KnowledgeStore } from "./knowledge"
import { GraphStore } from "./knowledge-graph"
import { FileOrganizer } from "./files"
import { LearningStore } from "./learning"
import { PRODUCT_VERSION, PROTOCOL_VERSION } from "./contracts"
import type { MemoryKind } from "./contracts"
import html from "./web/index.html" with { type: "text" }
import css from "./web/style.css" with { type: "text" }
import javascript from "./web/app.js" with { type: "text" }
import cytoscape from "./web/vendor/cytoscape.min.js" with { type: "text" }

// Cytoscape 3.34.3 inserts this one fixed stylesheet. Authorize its exact bytes
// while keeping arbitrary inline styles and scripts blocked.
const cytoscapeStyleHash = new Bun.CryptoHasher("sha256").update(".__________cytoscape_container { position: relative; }").digest("base64")

export type ServerOptions = {
  store: SoulStore
  adapter: OpenCodeAdapter
  vaultDir: string
  token: string
  port?: number
  onShutdown?: () => Promise<void>
  configPath?: string
  configureModel?: (config: { baseURL: string; model: string; apiKey: string }) => Promise<OpenCodeAdapter>
  checkpointExtensions?: (directory: string) => Promise<Record<string, string>>
  stopExecution?: () => Promise<void>
}

export class ModelConfigurationError extends Error {
  constructor(message: string, readonly recoveredAdapter: OpenCodeAdapter) { super(message) }
}

export function startServer(options: ServerOptions) {
  const store = options.store
  const knowledge = new KnowledgeStore(store.db)
  const graph = new GraphStore(store.db)
  const files = new FileOrganizer(store.db)
  const learning = new LearningStore(store.db)
  const jobs = new Map<string, Promise<void>>()
  const cancelled = new Set<string>()
  const reconciling = new Set<string>()
  let mutations = 0
  let checkpointing = false
  let shuttingDown = false
  let lastActivity = Date.now()
  let checkpointError: string | null = null
  let configuring = false
  let checkpointPromise: Promise<unknown> | undefined
  let shutdownPromise: Promise<import("./contracts").CheckpointInfo> | undefined
  const closed = Promise.withResolvers<void>()
  void closed.promise.catch(() => {})
  const closeRuntime = async () => {
    try { await options.onShutdown?.() } finally { await server.stop(true) }
  }
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } })

  const createSnapshot = async (ownRequest: boolean) => {
    if (checkpointing) throw new ConflictError("正在同步，请等待完成")
    if (jobs.size || reconciling.size || mutations > Number(ownRequest)) throw new ConflictError("请等待当前执行和文件操作结束后同步")
    checkpointing = true
    try {
      const result = await createCheckpoint(store.db, options.vaultDir, store.identityId, store.revision, store.meta("checkpoint_generation") || null, options.checkpointExtensions)
      store.setMeta("checkpoint_generation", result.generation)
      store.setMeta("checkpoint_revision", String(result.revision))
      checkpointError = null
      return result
    } catch (error) { checkpointError = error instanceof Error ? error.message : "检查点失败"; throw error }
    finally { checkpointing = false }
  }
  const checkpoint = (ownRequest = false) => {
    if (checkpointing) return Promise.reject(new ConflictError("正在同步，请等待完成"))
    const pending = createSnapshot(ownRequest)
    checkpointPromise = pending
    void pending.finally(() => { if (checkpointPromise === pending) checkpointPromise = undefined }).catch(() => {})
    return pending
  }

  const shutdown = (force = false, ownRequest = false) => {
    if (shutdownPromise) return shutdownPromise
    if (!force && (jobs.size || reconciling.size || mutations > Number(ownRequest))) return Promise.reject(new ConflictError("请先等待当前操作完成并核实正在执行的任务"))
    shuttingDown = true
    shutdownPromise = (async () => {
      while (mutations > Number(ownRequest) || configuring) await Bun.sleep(10)
      if (force) {
        for (const id of jobs.keys()) cancelled.add(id)
        await options.stopExecution?.()
        await Promise.allSettled([...jobs.values()])
      }
      await checkpointPromise?.catch(() => {})
      const snapshot = await checkpoint(ownRequest)
      setTimeout(() => { void closeRuntime().then(closed.resolve, closed.reject) }, 250)
      return snapshot
    })().catch(async error => {
      if (force) { await closeRuntime().then(closed.resolve, closed.reject) }
      shuttingDown = false
      shutdownPromise = undefined
      throw error
    })
    return shutdownPromise
  }

  function recordParts(taskId: string, parts: NormalizedPart[]) {
    for (const part of parts) {
      if (part.type !== "tool") continue
      const execution = part.execution
      // An upstream lifecycle completion only means the tool returned. The adapter
      // classifies evidence according to the tool's contract; the whole task still
      // awaits its separate acceptance step.
      const status = execution.outcome
      const label = status === "succeeded" ? "工具返回结果已核实" : status === "failed" ? "工具报告错误或非零退出" : "工具结果待核实"
      const detail = execution.exitCode !== undefined ? `；进程退出码：${execution.exitCode === null ? "未取得" : execution.exitCode}` : ""
      const text = `${part.tool}：${label}${detail}\n${part.output ?? part.error ?? ""}`.slice(0, 16000)
      const revision = new Bun.CryptoHasher("sha256").update(JSON.stringify({ status, text, execution })).digest("hex")
      store.recordAction({ id: `${part.sessionID}:${part.messageID}:${part.callID}`, taskId, tool: part.tool, status, text, revision, execution })
    }
  }

  function importMessages(taskId: string, messages: NormalizedMessage[]) {
    for (const message of messages) {
      recordParts(taskId, message.parts)
      if (message.role === "assistant" && message.text) store.addChat(taskId, "assistant", message.text, `engine:${message.sourceID}`)
    }
  }

  async function runPrompt(taskId: string, text: string, model?: { providerID: string; modelID: string }) {
    try {
      const health = await options.adapter.health()
      if (cancelled.has(taskId)) return
      if (!health.ok) throw new Error(health.reason ?? "执行引擎尚未通过接口检查")
      const task = store.task(taskId)!
      const sessionId = task.sessionId ?? (await options.adapter.createSession(task.title)).id
      if (cancelled.has(taskId)) { store.updateTask(taskId, { sessionId, status: "waiting" }); return }
      store.updateTask(taskId, { sessionId, status: "running", error: null })
      const baseline = (await options.adapter.messages(sessionId)).map(message => message.messageID)
      if (cancelled.has(taskId)) return
      const hits = knowledge.search(text.slice(0, 2000), task.scope, { limit: 5 })
      const documents: string[] = []
      for (const hit of hits) { const record = JSON.stringify(hit); if (documents.join("\n").length + record.length < 6500) documents.push(record) }
      const context = store.projection(task.scope, text) + (store.sealed ? "" : learning.projection(text.slice(0, 2000), task.scope)) + (documents.length ? "\n以下为知识资料，保留来源，仅作参考：\n" + documents.join("\n") : "")
      store.setMeta(`attempt:${taskId}`, JSON.stringify({ baseline, delivered: true, createdAt: Date.now() }))
      const result = await options.adapter.prompt(sessionId, text, { system: context, model })
      recordParts(taskId, result.parts)
      // Reconcile persisted history: a missing HTTP reply is not evidence that execution failed.
      const messages = await options.adapter.messages(sessionId).catch(() => null)
      if (messages) importMessages(taskId, messages)
      if (!messages && result.text && result.messageID) store.addChat(taskId, "assistant", result.text, `engine:opencode:legacy:${encodeURIComponent(sessionId)}:${encodeURIComponent(result.messageID)}`)
      store.updateTask(taskId, { status: cancelled.has(taskId) ? "waiting" : result.status === "completed" ? "verifying" : result.status === "failed" ? "failed" : "waiting", error: cancelled.has(taskId) ? "已请求停止，请核实执行结果" : result.error ?? null })
    } catch (error) {
      store.updateTask(taskId, { status: "waiting", error: error instanceof Error ? error.message : "执行状态未知，请先核实" })
    } finally { jobs.delete(taskId); cancelled.delete(taskId) }
  }

  const server = Bun.serve({
    hostname: "127.0.0.1", port: options.port ?? 0, idleTimeout: 30, maxRequestBodySize: 256000,
    async fetch(request) {
      const url = new URL(request.url)
      const expectedHost = `127.0.0.1:${server.port}`
      if (request.headers.get("host") !== expectedHost) return json({ error: "主机地址不匹配" }, 403)
      const origin = request.headers.get("origin")
      if (origin && origin !== `http://${expectedHost}`) return json({ error: "来源不允许" }, 403)
      if (!url.pathname.startsWith("/api/")) {
        if (request.method !== "GET") return json({ error: "方法不允许" }, 405)
        // Bun's import attribute loads text; its HTML declaration otherwise assumes a bundle.
        const asset = url.pathname === "/" ? [html as unknown as string, "text/html"] : url.pathname === "/style.css" ? [css, "text/css"] : url.pathname === "/app.js" ? [javascript, "text/javascript"] : url.pathname === "/vendor/cytoscape.min.js" ? [cytoscape, "text/javascript"] : null
        if (!asset) return json({ error: "不存在" }, 404)
        return new Response(asset[0], { headers: { "Content-Type": `${asset[1]}; charset=utf-8`, "Cache-Control": "no-store", "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self' 'sha256-${cytoscapeStyleHash}'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } })
      }
      if (request.headers.get("authorization") !== `Bearer ${options.token}`) return json({ error: "请通过启动器打开工作台" }, 401)
      const mutation = !["GET", "HEAD"].includes(request.method)
      if (mutation) { mutations++; lastActivity = Date.now() }
      try {
        if (shuttingDown) return json({ error: "正在安全退出" }, 503)
        if (configuring && mutation) throw new ConflictError("正在切换模型连接，请稍后操作")
        if (checkpointing && mutation) throw new ConflictError("正在保存检查点，请稍后操作")
        const method = request.method
        const path = url.pathname
        const body = async () => {
          if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) throw new Error("请求需要 JSON")
          if (Number(request.headers.get("content-length")) > 200000) throw new Error("请求过大")
          const raw = await request.text()
          if (raw.length > 200000) throw new Error("请求过大")
          const value: unknown = JSON.parse(raw)
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求格式无效")
          return value as Record<string, unknown>
        }
        if (method === "GET" && path === "/api/state") return json({ version: PRODUCT_VERSION, protocol: PROTOCOL_VERSION, identityId: store.identityId, identity: JSON.parse(store.meta("identity")), affect: store.affect(), sealed: store.sealed, revision: store.revision, checkpointGeneration: store.meta("checkpoint_generation") || null, checkpointRevision: Number(store.meta("checkpoint_revision") || -1), unsynced: store.revision !== Number(store.meta("checkpoint_revision") || -1), checkpointing, checkpointError, tasks: store.tasks(), sleep: store.sleepReports(), busy: [...jobs.keys()] })
        if (method === "GET" && path === "/api/engine") return json(await options.adapter.health())
        if (method === "GET" && path === "/api/settings") return json({ configPath: options.configPath ?? "未配置" })
        if (method === "POST" && path === "/api/settings/model") {
          if (jobs.size || reconciling.size || mutations > 1) throw new ConflictError("请等待当前任务完成后更换模型连接")
          if (!options.configureModel) throw new Error("当前启动方式不支持修改模型配置")
          configuring = true
          try {
            const input = await body()
            const baseURL = new URL(text(input.baseURL, 2048))
            if (!["https:", "http:"].includes(baseURL.protocol) || baseURL.username || baseURL.password || baseURL.search || baseURL.hash) throw new Error("模型接口地址无效")
            if (baseURL.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(baseURL.hostname)) throw new Error("远程模型接口需要 HTTPS")
            options.adapter = await options.configureModel({ baseURL: baseURL.toString(), model: text(input.model, 200), apiKey: text(input.apiKey, 8000) })
            return json({ ok: true })
          } catch (error) { if (error instanceof ModelConfigurationError) options.adapter = error.recoveredAdapter; throw error }
          finally { configuring = false }
        }
        if (method === "GET" && path === "/api/providers") return json(await options.adapter.providers())
        if (method === "GET" && path === "/api/permissions") return json(await options.adapter.permissions())
        if (method === "POST" && path === "/api/permissions/reply") {
          const input = await body()
          const reply = text(input.reply, 20)
          if (!["once", "always", "reject"].includes(reply)) throw new Error("授权选项无效")
          return json({ ok: await options.adapter.replyPermission(text(input.id, 200), reply as "once" | "always" | "reject") })
        }
        if (method === "GET" && path === "/api/memories") return json(store.memories({ scope: url.searchParams.get("scope") ?? undefined, query: url.searchParams.get("q") ?? undefined, private: url.searchParams.get("private") === "true", history: url.searchParams.get("history") === "true" }))
        if (method === "POST" && path === "/api/memories") {
          const input = await body()
          const kind = text(input.kind, 30) as MemoryKind
          if (!["preference", "fact", "inference", "episode", "commitment"].includes(kind)) throw new Error("记忆类型无效")
          const key = text(input.key, 200)
          if (input.pinned !== undefined && typeof input.pinned !== "boolean") throw new Error("固定保留标记必须是布尔值")
          return json(store.once(`memory:${key}`, input, () => store.explicitMemory({ key, kind, text: text(input.text, 12000), scope: text(input.scope ?? "global", 300), private: input.private === true, ...(input.pinned === undefined ? {} : { pinned: input.pinned as boolean }) })), 201)
        }
        const memoryRoute = /^\/api\/memories\/([^/]+)$/.exec(path)
        if (memoryRoute && ["PATCH", "DELETE"].includes(method)) {
          const input = await body()
          const revision = positiveInteger(input.revision)
          if (method === "PATCH") return json(store.correctMemory(memoryRoute[1], revision, text(input.text, 12000)))
          store.forgetMemory(memoryRoute[1], revision)
          return json({ ok: true, backupNotice: "活动记忆及派生记录已清除。已有检查点、OpenCode 会话及原始文件需分别处理。" })
        }
        if (method === "POST" && path === "/api/seal") { const input = await body(); if (typeof input.sealed !== "boolean") throw new Error("需要明确封存状态"); store.setSealed(input.sealed); return json({ sealed: store.sealed }) }
        if (method === "POST" && path === "/api/sleep") { if (jobs.size) throw new ConflictError("前台正在工作，整理暂缓"); return json(store.sleep()) }
        if (method === "POST" && path === "/api/checkpoint") return json(await checkpoint(true))
        if (method === "GET" && path === "/api/checkpoints") return json(await listCheckpoints(options.vaultDir))
        if (method === "GET" && ["/api/graph", "/api/graph/source"].includes(path)) {
          const includePrivate = url.searchParams.get("private")
          if (includePrivate !== null && !["true", "false"].includes(includePrivate)) throw new Error("图谱私密选项需要 true 或 false")
          const context = { scope: url.searchParams.get("scope") ?? "global", includePrivate: includePrivate === "true" }
          const optionalInteger = (name: string) => {
            const raw = url.searchParams.get(name)
            if (raw === null) return undefined
            if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error("图谱分页与数量需要非负整数")
            return Number(raw)
          }
          if (path === "/api/graph") return json(graph.build({ ...context, maxNodes: optionalInteger("maxNodes"), maxEdges: optionalInteger("maxEdges") }))
          const source = graph.source({ ...context, id: text(url.searchParams.get("id"), 1024), startLine: optionalInteger("startLine"), lineLimit: optionalInteger("lineLimit") })
          return source ? json(source) : json({ error: "当前范围内没有可查看的来源，请刷新图谱" }, 404)
        }
        if (method === "GET" && path === "/api/knowledge") return json(knowledge.documents())
        if (method === "GET" && path === "/api/knowledge/search") return json(knowledge.search(url.searchParams.get("q") ?? "", url.searchParams.get("scope") ?? "global"))
        if (method === "POST" && path === "/api/knowledge") { const input = await body(); return json(await knowledge.importFile(text(input.path, 4096), text(input.scope ?? "global", 300), { private: input.private === true }), 201) }
        const knowledgeRoute = /^\/api\/knowledge\/([^/]+)$/.exec(path)
        if (knowledgeRoute && method === "DELETE") { knowledge.remove(knowledgeRoute[1]); return json({ ok: true }) }
        if (knowledgeRoute && method === "POST") return json(await knowledge.refresh(knowledgeRoute[1]))
        if (method === "GET" && path === "/api/files") return json(files.list())
        if (method === "POST" && path === "/api/files") { const input = await body(); return json(await files.plan(text(input.directory, 4096)), 201) }
        const fileRoute = /^\/api\/files\/([^/]+)\/(apply|undo)$/.exec(path)
        if (fileRoute && method === "POST") {
          const undo = fileRoute[2] === "undo"
          const plan = await (undo ? files.undo(fileRoute[1]) : files.apply(fileRoute[1]))
          const referenceWarnings: string[] = []
          for (const item of plan.items) if (item.status === (undo ? "undone" : "moved")) {
            try { await knowledge.relocate(undo ? item.target : item.source, undo ? item.source : item.target, item.sha256) }
            catch (error) { referenceWarnings.push(error instanceof Error ? error.message : "引用更新失败") }
          }
          return json({ ...plan, referenceWarnings })
        }
        if (method === "GET" && path === "/api/skills") return json(learning.list(url.searchParams.get("scope") ?? undefined, url.searchParams.get("private") === "true"))
        if (method === "GET" && path === "/api/skills/sources") return json(learning.observations(url.searchParams.get("scope") ?? undefined))
        if (method === "POST" && path === "/api/skills") {
          if (store.sealed) throw new SealedError("封存期间不新增经验")
          const input = await body()
          if (!Array.isArray(input.sourceIds) || !input.sourceIds.length) throw new Error("请选择实际来源")
          return json(learning.propose({ title: text(input.title, 200), scope: text(input.scope ?? "global", 300), when: text(input.when, 2000), steps: lines(input.steps), avoid: lines(input.avoid, true), sourceIds: input.sourceIds.map(positiveInteger) }), 201)
        }
        const skillRoute = /^\/api\/skills\/([^/]+)(?:\/(promote))?$/.exec(path)
        if (skillRoute && method === "DELETE") { learning.retract(skillRoute[1]); return json({ ok: true }) }
        if (skillRoute && method === "POST" && skillRoute[2]) {
          if (store.sealed) throw new SealedError("封存期间不启用新经验")
          const input = await body()
          return json(learning.promote(skillRoute[1], positiveInteger(input.revision), typeof input.manualCheck === "string" ? input.manualCheck : undefined))
        }
        if (method === "POST" && path === "/api/tasks") { const input = await body(); return json(store.once(`task:${text(input.key, 200)}`, input, () => store.createTask(text(input.title, 200), text(input.scope ?? "global", 300))), 201) }
        const taskRoute = /^\/api\/tasks\/([^/]+)(?:\/(chat|reconcile|abort|complete))?$/.exec(path)
        if (taskRoute) {
          const id = taskRoute[1]
          const task = store.task(id)
          if (!task) return json({ error: "任务不存在" }, 404)
          if (method === "GET" && !taskRoute[2]) return json({ ...task, messages: store.chats(id), actions: store.actions(id) })
          if (method === "POST" && taskRoute[2] === "chat") {
            const input = await body()
            const message = text(input.text, 24000)
            const model = input.model && typeof input.model === "object" ? { providerID: text((input.model as Record<string, unknown>).providerID, 200), modelID: text((input.model as Record<string, unknown>).modelID, 200) } : undefined
            const key = text(input.key, 200)
            let fresh = false
            const result = store.once(`chat:${key}`, { id, message, model }, () => {
              if (jobs.has(id) || reconciling.has(id) || task.status === "running") throw new ConflictError("任务正在执行或核实")
              if (task.status === "waiting" && task.sessionId) throw new ConflictError("请先核实上一次执行结果")
              store.addChat(id, "user", message, `request:${key}`)
              store.updateTask(id, { status: "running", error: null }); fresh = true
              store.setMeta(`attempt:${id}`, JSON.stringify({ baseline: null, delivered: false }))
              return { taskId: id, accepted: true }
            })
            if (fresh) jobs.set(id, runPrompt(id, message, model))
            return json(result, 202)
          }
          if (method === "POST" && taskRoute[2] === "reconcile") {
            if (jobs.has(id) || reconciling.has(id)) throw new ConflictError("任务仍在执行或核实")
            if (!task.sessionId) { store.updateTask(id, { status: "ready", error: null }); return json({ ok: true }) }
            reconciling.add(id)
            try {
              const messages = await options.adapter.messages(task.sessionId)
              importMessages(id, messages)
              const attempt = JSON.parse(store.meta(`attempt:${id}`) || "{}") as { baseline?: string[] | null; delivered?: boolean }
              const fresh = attempt.baseline ? messages.filter(message => !attempt.baseline!.includes(message.messageID)) : []
              const last = fresh.at(-1)
              const settled = !!(last?.role === "assistant" && last.status !== "unknown" && !last.parts.some(part => part.type === "tool" && part.status === "unknown"))
              const neverSent = attempt.delivered === false
              store.updateTask(id, { status: neverSent ? "ready" : settled ? last!.status === "failed" ? "failed" : "verifying" : "waiting", error: settled || neverSent ? null : "本次请求的后端结果尚未确定，旧会话记录不会作为本次完成证据" })
              return json({ settled, messages: messages.length })
            } finally { reconciling.delete(id) }
          }
          if (method === "POST" && taskRoute[2] === "abort") { cancelled.add(id); if (task.sessionId) await options.adapter.abort(task.sessionId); store.updateTask(id, { status: "waiting", error: "已请求停止，请核实可能已发生的操作" }); return json({ ok: true }) }
          if (method === "POST" && taskRoute[2] === "complete") { if (jobs.has(id) || reconciling.has(id) || task.status !== "verifying") throw new ConflictError("任务尚未进入验收阶段"); return json(store.updateTask(id, { status: "completed", error: null })) }
        }
        if (method === "POST" && path === "/api/shutdown") {
          const snapshot = await shutdown(false, true)
          return json({ ok: true, generation: snapshot.generation, message: "已保存检查点。应用关闭后可在 Windows 弹出设备。" })
        }
        return json({ error: "接口不存在" }, 404)
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "操作失败" }, error instanceof ConflictError || error instanceof SealedError ? 409 : 400)
      } finally { if (mutation) mutations-- }
    },
  })
  const maintenance = async () => {
    if (shuttingDown || checkpointing || jobs.size || reconciling.size || mutations || Date.now() - lastActivity < 5 * 60_000) return
    if (!store.sealed && store.experiencesAfter(Number(store.meta("sleep_cursor")), 1).length) store.sleep()
    if (store.revision !== Number(store.meta("checkpoint_revision") || -1)) await checkpoint()
  }
  return { server, checkpoint, jobs, maintenance, shutdown, closed: closed.promise }
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error(`需要非空文本，长度不超过 ${max}`)
  return value.trim()
}
function positiveInteger(value: unknown) { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("版本必须为正整数"); return value }
function lines(value: unknown, allowEmpty = false): string[] {
  if (allowEmpty && (value === "" || value === undefined)) return []
  return text(value, 12000).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}
