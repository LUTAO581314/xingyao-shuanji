export {}

const version = "0.0.0-xingyao-collaboration-browser-fixture"
if (process.argv.includes("--version")) { console.log(version); process.exit(0) }

const now = Date.now()
const root = { id: "ses_root", title: "Xingyao collaboration browser root", time: { created: now - 60_000, updated: now } }
const child = (id: string, parentID: string, title: string, agent: string, offset: number, metadata?: unknown) => ({ id, parentID, title, agent, ...(metadata ? { metadata } : {}), time: { created: now - offset, updated: now } })
const children: Record<string, Record<string, unknown>[]> = {
  ses_root: [child("ses_review", "ses_root", "审查记忆边界", "review", 50_000), child("ses_compat", "ses_root", "验证上游兼容", "compat", 45_000)],
  ses_review: [child("ses_nested", "ses_review", "核对来源隔离", "validation", 30_000)],
  ses_compat: [], ses_nested: [],
}
const text = (sessionID: string, messageID: string, id: string, value: string) => ({ id, sessionID, messageID, type: "text", text: value })
const message = (sessionID: string, id: string, role: "user" | "assistant", value: string, parts: unknown[] = []) => ({
  info: { id, sessionID, role, time: { created: now - 20_000, completed: now - 10_000 }, ...(role === "assistant" ? { finish: "stop" } : {}) },
  parts: [text(sessionID, id, `${id}_text`, value), ...parts],
})
const marker = '<img src=x onerror="globalThis.collaborationXss=1">'
const tool = { id: "prt_tool", sessionID: "ses_compat", messageID: "msg_compat", type: "tool", callID: "call_compat", tool: "bash", state: {
  status: "completed", input: { command: "private-command-marker" }, output: "private-output-marker", metadata: { exit: 0, authorization: "private-auth-marker" }, time: { start: now - 15_000, end: now - 14_000 },
} }
const histories: Record<string, unknown[]> = {
  ses_root: [],
  ses_review: [message("ses_review", "msg_review", "assistant", `候选记忆只保留为待审提案。${marker}`)],
  ses_compat: [message("ses_compat", "msg_compat", "assistant", "公开接口与工具证据已核对。", [tool])],
  ses_nested: [message("ses_nested", "msg_nested", "user", "验证子会话不会进入主聊天或记忆。")],
}
const sessions: Record<string, Record<string, unknown>> = { ses_root: root, ...Object.fromEntries(Object.values(children).flat().map(item => [item.id as string,item])) }
let ownedCount = 0, rootMessageCount = 0, childMessageCount = 0

const doc = { openapi: "3.1.0", paths: {
  "/session": { post: {} },
  "/session/{sessionID}/message": { get: {}, post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Prompt" } } } } } },
  "/session/{sessionID}/children": { get: {} }, "/session/status": { get: {} }, "/permission/{requestID}/reply": { post: {} },
}, components: { schemas: { Prompt: { type: "object", properties: { system: { type: "string" } } } } } }

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url), path = url.pathname
  if (request.method === "GET" && path === "/global/health") return Response.json({ healthy: true, version })
  if (request.method === "GET" && path === "/doc") return Response.json(doc)
  if (request.method === "GET" && path === "/provider") return Response.json({ all: [], connected: [], default: {} })
  if (request.method === "GET" && path === "/agent") return Response.json([{ name: "build", mode: "primary" }, { name: "explore", mode: "subagent", description: "快速检索与分析" }, { name: "general", mode: "subagent", description: "复杂通用任务" }])
  if (request.method === "GET" && path === "/permission") return Response.json([])
  if (request.method === "GET" && path === "/session/status") return Response.json({ ses_review: { type: "busy", internal: "private-status-marker" }, ses_nested: { type: "retry", attempt: 1, next: now + 60_000, error: "private-retry-marker" } })
  if (request.method === "POST" && path === "/session") {
    const body = await request.json() as { parentID?: string; title?: string; agent?: string; metadata?: unknown }
    if (!body.parentID) return Response.json(root)
    const id = `ses_owned_${++ownedCount}`
    const owned = child(id, body.parentID, body.title ?? "Owned delegation", body.agent ?? "explore", 1000, body.metadata)
    sessions[id] = owned; (children[body.parentID] ??= []).push(owned); children[id] = []; histories[id] = []
    return Response.json(owned)
  }
  const sessionMatch = /^\/session\/([^/]+)$/.exec(path)
  if (request.method === "GET" && sessionMatch) {
    const session = sessions[decodeURIComponent(sessionMatch[1]!)]
    return session ? Response.json(session) : new Response("not found", { status: 404 })
  }
  const childMatch = /^\/session\/([^/]+)\/children$/.exec(path)
  if (request.method === "GET" && childMatch) return Response.json(children[decodeURIComponent(childMatch[1]!)] ?? [])
  const messageMatch = /^\/session\/([^/]+)\/message$/.exec(path)
  if (messageMatch) {
    const sessionID = decodeURIComponent(messageMatch[1]!)
    if (request.method === "GET") return Response.json(histories[sessionID] ?? [])
    if (request.method === "POST" && sessions[sessionID]) {
      const body = await request.json() as { parts?: Array<{ type?: string; text?: string }> }
      const userText = body.parts?.find(part => part.type === "text")?.text ?? ""
      if (sessionID === "ses_root") {
        const index = ++rootMessageCount
        const user = message(sessionID, `msg_root_user_${index}`, "user", userText), assistant = message(sessionID, `msg_root_assistant_${index}`, "assistant", index === 1 ? "已分派架构审查、兼容验证和来源隔离核对。" : "我已核对委派来源，并把可靠结论纳入主任务汇总。")
        histories[sessionID]!.push(user,assistant); return Response.json(assistant)
      }
      const index = ++childMessageCount
      const user = message(sessionID, `msg_child_user_${index}`, "user", userText), assistant = message(sessionID, `msg_child_assistant_${index}`, "assistant", index === 1 ? "已完成界面与状态边界检查，建议保留显式交回步骤。" : "补充核对完成：继续操作复用了同一个子会话，没有创建重复委派。")
      histories[sessionID]!.push(user,assistant); return Response.json(assistant)
    }
  }
  if (request.method === "POST" && /^\/session\/[^/]+\/abort$/.test(path)) return Response.json(true)
  return new Response("not found", { status: 404 })
} })
console.log(`opencode server listening on ${server.url.origin}`)
await new Promise(() => {})
