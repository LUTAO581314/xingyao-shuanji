import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const rootThread = "01a0aede-90f2-7a73-baf2-0408fa980f18"
const codexRoot = process.env.CODEX_HOME ?? join(process.env.USERPROFILE!, ".codex")
const repo = resolve(process.env.CHAT_ARCHIVE_OUTPUT ?? join(import.meta.dir, ".."))
const exportedAt = new Date().toISOString()
const destination = join(repo, "conversations", "2026-09-17", rootThread)
type Row = { timestamp?: string; type: string; payload: Record<string, any> }
type Source = { path: string; name: string; meta: Record<string, any>; rows: Row[]; bytes: number }
type RecordItem = { timestamp: string | null; sourceLine: number; kind: string; [key: string]: unknown }
const sources: Source[] = []
for (const folder of ["sessions", "archived_sessions"]) {
  for (const name of new Bun.Glob("**/*.jsonl").scanSync({ cwd: join(codexRoot, folder), onlyFiles: true })) {
    const path = join(codexRoot, folder, name)
    const bytes = readFileSync(path)
    const lines = bytes.toString("utf8").split("\n")
    let first: Row
    try { first = JSON.parse(lines[0]!) } catch { continue }
    if (first.type !== "session_meta") continue
    sources.push({ path, name: relative(codexRoot, path).replaceAll("\\", "/"), meta: first.payload, bytes: bytes.length,
      rows: lines.flatMap((line, i) => { if (!line.trim()) return []; try { return [JSON.parse(line)] } catch { if (i === lines.length - 1) return []; throw new Error("Malformed complete session record") } }) })
  }
}
const identities = new Set([rootThread])
let expanded = true
while (expanded) {
  expanded = false
  for (const source of sources) {
    const parent = source.meta.parent_thread_id ?? source.meta.source?.subagent?.thread_spawn?.parent_thread_id
    if (parent && identities.has(parent) && !identities.has(source.meta.id)) { identities.add(source.meta.id); expanded = true }
  }
}
const selected = sources.filter(source => identities.has(source.meta.id)).sort((a, b) => a.name.localeCompare(b.name))
if (!selected.length) throw new Error("No task records found")
mkdirSync(destination, { recursive: true })
const redactions: Record<string, number> = {}
const excluded: Record<string, number> = {}
const count = (table: Record<string, number>, key: string) => { table[key] = (table[key] ?? 0) + 1 }
const sensitiveKey = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|authorization|proxy-authorization|cookie|set-cookie|client[_-]?secret|secret|token)$/i
function redactText(value: string): string {
  const rules: [string, RegExp, string][] = [
    ["private_key", /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+)?PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
    ["provider_key", /\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{16,}/g, "[REDACTED_CREDENTIAL]"],
    ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]"],
    ["auth_header", /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "[REDACTED_AUTHORIZATION]"],
    ["url_token", /([#?&](?:token|access_token|api_key|key)=)[^\s"'<>\\)\]}]+/gi, "$1[REDACTED]"],
    ["credential_assignment", /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization|secret|token)["']?\s*[:=]\s*["'])[^"'\r\n]*(["'])/gi, "$1[REDACTED]$2"],
    ["escaped_credential", /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|secret|token)\\"\s*:\s*\\")[^\r\n]*?(\\")/gi, "$1[REDACTED]$2"],
  ]
  for (const [name, expression, replacement] of rules) value = value.replace(expression, (...args) => {
    count(redactions, name)
    return replacement.replace(/\$(\d)/g, (_, index) => args[Number(index)] ?? "")
  })
  return value
}
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 40) return "[NESTING_LIMIT]"
  if (typeof value === "string") {
    // Tool results commonly contain JSON serialized inside another JSON record.
    if (/^\s*[{[]/.test(value)) {
      try { return JSON.stringify(sanitize(JSON.parse(value), depth + 1)) } catch { /* Plain text/code. */ }
    }
    return redactText(value)
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, depth + 1))
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (sensitiveKey.test(key) && item !== null && item !== undefined) { count(redactions, "structured_credential"); output[key] = "[REDACTED]" }
      else output[key] = sanitize(item, depth + 1)
    }
    return output
  }
  return value
}
function content(value: unknown): unknown {
  if (typeof value === "string") return sanitize(value)
  if (!Array.isArray(value)) return sanitize(value)
  return value.map(item => {
    if (item && typeof item === "object" && ["text", "input_text", "output_text"].includes(item.type)) return { type: item.type, text: sanitize(item.text) }
    // Keep a visible media descriptor; do not include opaque runtime metadata.
    if (item && typeof item === "object") {
      const copy: Record<string, unknown> = { type: item.type ?? "attachment" }
      for (const key of ["text", "image_url", "url", "mimeType", "data", "path"]) if (item[key] !== undefined) copy[key] = sanitize(item[key])
      return copy
    }
    return sanitize(item)
  })
}
function printable(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(item => item && typeof item === "object" && "text" in item ? String(item.text) : JSON.stringify(item)).join("\n\n")
  return JSON.stringify(value, null, 2)
}
const files: { path: string; sha256: string; bytes: number }[] = []
function write(path: string, text: string) {
  writeFileSync(path, text, "utf8")
  const bytes = Buffer.from(text)
  files.push({ path: relative(destination, path).replaceAll("\\", "/"), sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), bytes: bytes.length })
}
const rolls: any[] = []
for (let n = 0; n < selected.length; n++) {
  const source = selected[n]!
  const items: RecordItem[] = []
  const skipped: Record<string, number> = {}
  for (let i = 0; i < source.rows.length; i++) {
    const row = source.rows[i]!, p = row.payload ?? {}
    if (row.type !== "response_item") { count(skipped, row.type); continue }
    const base = { timestamp: row.timestamp ?? null, sourceLine: i + 1 }
    if (p.type === "message" && ["user", "assistant"].includes(p.role)) {
      if (p.role === "assistant" && (p.channel === "analysis" || p.phase && !["commentary", "final_answer"].includes(p.phase))) { count(skipped, "internal_reasoning"); continue }
      const text = printable(p.content)
      if (p.role === "user" && /^\s*<(?:environment_context|codex_internal_context|system_reminder|app-context)\b/.test(text)) { count(skipped, "runtime_context"); continue }
      items.push({ ...base, kind: "message", role: p.role, phase: p.phase ?? null, content: content(p.content) })
    } else if (p.type === "agent_message") {
      items.push({ ...base, kind: "agent_message", author: p.author, recipient: p.recipient, content: content(p.content) })
    } else if (["function_call", "custom_tool_call"].includes(p.type)) {
      items.push({ ...base, kind: "tool_call", name: p.namespace ? `${p.namespace}.${p.name}` : p.name, callId: p.call_id, input: sanitize(p.arguments ?? p.input) })
    } else if (["function_call_output", "custom_tool_call_output"].includes(p.type)) {
      items.push({ ...base, kind: "tool_result", callId: p.call_id, output: content(p.output) })
    } else count(skipped, p.type === "message" ? `internal_${p.role}` : p.type ?? "unknown")
  }
  for (const [kind, quantity] of Object.entries(skipped)) excluded[kind] = (excluded[kind] ?? 0) + quantity
  const agent = source.meta.agent_path ?? "/root"
  const slug = `${String(n + 1).padStart(2, "0")}-${agent.replace(/^\//, "").replaceAll("/", "--")}`
  write(join(destination, `${slug}.jsonl`), items.map(item => JSON.stringify(item)).join("\n") + "\n")
  const conversational = items.filter(item => item.kind !== "tool_call" && item.kind !== "tool_result")
  const markdown = [`# ${agent}`, `导出时间：${exportedAt}`, `来源片段：\`${source.name}\``, "此文件展示对话与协作消息。完整工具调用和结果位于同名 JSONL。凭据已脱敏；子任务中保留的继承上下文可能与主任务重复。"]
  for (const item of conversational) {
    const label = item.kind === "agent_message" ? `${item.author} → ${item.recipient}` : item.role === "user" ? "用户" : "助理"
    markdown.push(`## ${item.timestamp ?? "时间未记录"} · ${label}`, printable(item.content))
  }
  write(join(destination, `${slug}.md`), markdown.join("\n\n") + "\n")
  rolls.push({ agent, threadId: source.meta.id, sessionId: source.meta.session_id, parentThreadId: source.meta.parent_thread_id ?? null, source: source.name,
    originalBytes: source.bytes, sourceRecords: source.rows.length, exportedRecords: items.length, messages: conversational.length,
    toolCalls: items.filter(item => item.kind === "tool_call").length, toolResults: items.filter(item => item.kind === "tool_result").length,
    markdown: `${slug}.md`, jsonl: `${slug}.jsonl`, excluded: skipped })
}
const manifest = { format: 1, rootThread, title: "检测 F 盘健康状态", exportedAt, repository: "LUTAO581314/xingyao-shuanji", visibility: "public",
  scope: "当前根任务的全部本地历史片段，以及按 parent_thread_id 递归找到的全部子智能体；不包含其他无关任务。",
  exclusions: ["系统/开发者指令、隐藏推理、加密运行内容及内部上下文不属于可导出的可见聊天", "凭据值脱敏", "原始日志已被截断的工具结果无法由导出恢复"],
  threads: identities.size, fragments: rolls, redactions, excluded, files }
writeFileSync(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
const total = rolls.reduce((sum, item) => sum + item.exportedRecords, 0)
const graphNodes = [...new Map(rolls.map(r => [r.threadId, { agent: r.agent, parent: r.parentThreadId }])).entries()]
const graphIds = new Map(graphNodes.map(([id], index) => [id, `n${index}`]))
const graph = ["flowchart TD", ...graphNodes.map(([id, meta]) => `  ${graphIds.get(id)}["${meta.agent}"]`), ...graphNodes.filter(([, meta]) => meta.parent && graphIds.has(meta.parent)).map(([id, meta]) => `  ${graphIds.get(meta.parent)} --> ${graphIds.get(id)}`)].join("\n")
const index = `# 星杳 · 璇玑聊天档案\n\n任务：检测 F 盘健康状态\n\n本次快照时间：${exportedAt}。共 ${identities.size} 个任务身份、${rolls.length} 个历史片段、${total} 条可见消息与工具记录。\n\n此档案应用户要求上传到公开仓库。保留用户与助理对话、子智能体之间的协作消息、工具调用及结果；密钥、访问令牌等凭据值已脱敏。系统和开发者指令、隐藏推理与内部运行上下文不在导出范围内。原始日志没有保存或已经截断的内容无法补回。\n\n导出为时间点快照，之后的新消息不属于本次快照。主任务的历史片段全部保留；子智能体可能包含继承的对话上下文，未按相似文本删除。\n\n| 历史片段 | 身份 | 对话/协作消息 | 工具调用/结果 | 文件 |\n| --- | --- | ---: | ---: | --- |\n${rolls.map((r, i) => `| ${i + 1} | ${r.agent} | ${r.messages} | ${r.toolCalls}/${r.toolResults} | [阅读](${r.markdown}) · [JSONL](${r.jsonl}) |`).join("\n")}\n\n[导出清单与文件校验](manifest.json)记录来源、排除类别、脱敏计数和 SHA-256。JSONL 包含对应片段的完整可导出工具记录。\n\n子智能体关系：\n\n\`\`\`mermaid\nflowchart TD\n  root[主任务] --> dynamics[soul_dynamics]\n  root --> stability[soul_stability]\n  root --> compat[upstream_compat]\n  compat --> review[launcher_entry_review]\n\`\`\`\n`
writeFileSync(join(destination, "README.md"), index.replace(/flowchart TD[\s\S]*?(?=\n```)/, graph))
writeFileSync(join(repo, "README.md"), `# 星杳 · 璇玑对话档案\n\n[打开本任务的完整导出索引](conversations/2026-09-17/${rootThread}/README.md)\n\n此分支用于保存当前任务及全部子智能体的可导出聊天与工具记录。快照截止 ${exportedAt}；凭据值已脱敏。产品源码与安装制品不在此档案分支中。\n`)
console.log(JSON.stringify({ exportedAt, destination, threads: identities.size, fragments: rolls.length, records: total, redactions, files: files.length }, null, 2))
