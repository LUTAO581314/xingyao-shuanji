import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { OpenCodeAdapter, type CollaborationView } from "../src/adapter"
import { startServer } from "../src/server"
import { SoulStore } from "../src/store"

const root = resolve(import.meta.dir, "..")
const previewRoot = join(root, ".local", "collaboration-preview", String(Date.now()))
const host = join(previewRoot, "host")
const vault = join(previewRoot, "portable")
const project = join(previewRoot, "project")
mkdirSync(project, { recursive: true })
writeFileSync(join(project, "预览说明.md"), "# 星杳协作预览\n\n本目录只用于展示子智能体协作界面。\n")

class PreviewAdapter extends OpenCodeAdapter {
  constructor() { super({ baseURL: "http://127.0.0.1:1", timeoutMs: 100 }) }
  override async health() {
    return { ok: true, version: "OpenCode preview", capabilities: {
      legacyHTTP: true, promptSystem: true, durableMessages: true, toolResults: true,
      permissions: true, collaboration: true, v2Detected: false, v2Supported: false as const,
    } }
  }
  override async collaboration(rootSessionID: string): Promise<CollaborationView> {
    const now = Date.now()
    const execution = { version: 1 as const, lifecycle: "completed" as const, outcome: "succeeded" as const, basis: "shell-exit-zero", exitCode: 0, startedAt: now - 31_000, finishedAt: now - 25_000 }
    return {
      rootSessionID, truncated: false, limits: { sessions: 32, depth: 4, transcriptBytes: 2 * 1024 * 1024 },
      sessions: [
        {
          sessionID: "ses_architecture", parentSessionID: rootSessionID, title: "审查灵魂、记忆与遗忘结构", agent: "architecture-review", depth: 1,
          status: { type: "busy" }, createdAt: now - 9 * 60_000, updatedAt: now - 18_000, messageCount: 2, transcriptTruncated: false,
          messages: [
            { sourceID: "opencode:legacy:ses_architecture:msg_delegate", messageID: "msg_delegate", role: "user", text: "检查人格、情绪、记忆和睡眠整理之间的边界，找出三个月后最可能失控的地方。", status: "completed", createdAt: now - 9 * 60_000, completedAt: now - 9 * 60_000, tools: [] },
            { sourceID: "opencode:legacy:ses_architecture:msg_progress", messageID: "msg_progress", role: "assistant", text: "已确认长期记忆不能由模型自述直接写入。正在核对遗忘、冲突记忆和可撤销学习的闭环。", status: "unknown", createdAt: now - 80_000, tools: [] },
          ],
        },
        {
          sessionID: "ses_upstream", parentSessionID: rootSessionID, title: "验证 OpenCode 上游兼容边界", agent: "upstream-compat", depth: 1,
          status: { type: "idle" }, createdAt: now - 8 * 60_000, updatedAt: now - 25_000, messageCount: 2, transcriptTruncated: false,
          messages: [
            { sourceID: "opencode:legacy:ses_upstream:msg_delegate", messageID: "msg_delegate", role: "user", text: "只通过公共 HTTP 接口检查会话、工具证据和升级兼容，不修改上游私有数据库。", status: "completed", createdAt: now - 8 * 60_000, completedAt: now - 8 * 60_000, tools: [] },
            { sourceID: "opencode:legacy:ses_upstream:msg_result", messageID: "msg_result", role: "assistant", text: "公共会话接口已核对。产品补丁保持在适配层，升级时可以重新跑兼容门禁。", status: "completed", createdAt: now - 60_000, completedAt: now - 25_000, tools: [{ sourceID: "opencode:legacy:ses_upstream:msg_result:tool_test", callID: "call_test", tool: "bash", status: "completed", execution }] },
          ],
        },
        {
          sessionID: "ses_memory", parentSessionID: "ses_architecture", title: "核对记忆来源与睡眠整理", agent: "memory-validation", depth: 2,
          status: { type: "retry", attempt: 1, next: now + 45_000 }, createdAt: now - 5 * 60_000, updatedAt: now - 12_000, messageCount: 2, transcriptTruncated: false,
          messages: [
            { sourceID: "opencode:legacy:ses_memory:msg_delegate", messageID: "msg_delegate", role: "user", text: "验证候选记忆有来源、需主人审阅，并且封存时停止提取和采纳。", status: "completed", createdAt: now - 5 * 60_000, completedAt: now - 5 * 60_000, tools: [] },
            { sourceID: "opencode:legacy:ses_memory:msg_wait", messageID: "msg_wait", role: "assistant", text: "确定性检查已经完成；一项模型质量检查等待重试。主任务不会把等待状态误当成完成。", status: "unknown", createdAt: now - 12_000, tools: [] },
          ],
        },
      ],
    }
  }
}

const store = new SoulStore(join(host, "soul.db"))
const task = store.createTask("把 OpenCode 改装成星杳专属主力", "global")
store.updateTask(task.id, { sessionId: "ses_preview_root", status: "running" })
store.addChat(task.id, "user", "重新设计整个体系，并让子智能体的工作过程可检查。", "preview-user")
store.addChat(task.id, "assistant", "我正在把架构审查、上游兼容和记忆验证分开推进；最后由主任务核对并交付。", "preview-assistant")

const token = crypto.randomUUID() + crypto.randomUUID()
const app = startServer({ store, adapter: new PreviewAdapter(), vaultDir: vault, token, workspaceDirectory: project, onShutdown: async () => store.close() })
const url = `http://127.0.0.1:${app.server.port}/#token=${encodeURIComponent(token)}`
mkdirSync(join(root, ".local", "collaboration-preview"), { recursive: true })
writeFileSync(join(root, ".local", "collaboration-preview", "latest.json"), JSON.stringify({ url, previewRoot, pid: process.pid }, null, 2))
console.log(url)

let closing = false
const close = async () => {
  if (closing) return
  closing = true
  await app.server.stop(true)
  store.close()
  process.exit(0)
}
process.on("SIGINT", () => void close())
process.on("SIGTERM", () => void close())
await app.closed
