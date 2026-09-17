import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { startEngine } from "../src/engine"
import { startServer } from "../src/server"
import { SoulStore } from "../src/store"
import { acquireHostLock, restoreCheckpoint } from "../src/checkpoint"
import { backupEngine, restoreEngine, verifyEngineCheckpoint } from "../src/engine-backup"
import { PRODUCT_VERSION } from "../src/contracts"
import type { Action, ChatMessage, CheckpointInfo, Memory, SleepReport, Task } from "../src/contracts"
import type { PermissionRequest } from "../src/adapter"
import type { DocumentSummary } from "../src/knowledge"

const executable = process.env.XINGYAO_TEST_OPENCODE ?? resolve(import.meta.dir, "../dist", `xingyao-${PRODUCT_VERSION}`, "opencode.exe")
// Explicitly selecting a missing candidate must fail, rather than produce a skipped
// release check. Ordinary platform-independent runs may omit the native artifact.
const integration = process.platform === "win32" && (existsSync(executable) || !!process.env.XINGYAO_TEST_OPENCODE) ? test : test.skip

type TaskDetail = Task & { messages: ChatMessage[]; actions: Action[] }
type ModelBody = Record<string, unknown>

integration("actual product story: sourced context, permission, sleep, correction and domain/engine restore", async () => {
  expect(existsSync(executable)).toBe(true)
  const binaryHash = await digest(executable)
  const root = await mkdtemp(join(tmpdir(), "xingyao-product-integration-"))
  const hostA = join(root, "host-a")
  const hostB = join(root, "host-b")
  const project = join(root, "portable-project")
  const vault = join(root, "portable-vault")
  await Promise.all([hostA, hostB, project, vault].map(path => mkdir(path)))
  const releaseA = acquireHostLock(hostA)
  const releaseB = acquireHostLock(hostB)
  const nonce = crypto.randomUUID()
  const oldPreference = `OLD_PREFERENCE_${nonce}`
  const newPreference = `NEW_PREFERENCE_${nonce}`
  const knowledgeEvidence = `KNOWLEDGE_EVIDENCE_${nonce}`
  const privateEvidence = `PRIVATE_EXCLUDED_${nonce}`
  const otherScopeEvidence = `OTHER_SCOPE_EXCLUDED_${nonce}`
  const fileEvidence = `ACTUAL_READ_RESULT_${nonce}`
  const evidenceFile = join(project, "evidence.txt")
  const knowledgeFile = join(project, "便携校验说明.md")
  await writeFile(evidenceFile, fileEvidence)
  await writeFile(knowledgeFile, `# 便携校验\n${knowledgeEvidence}\n读取指定校验文件，保留真实工具结果和引用来源。\n`)
  const captured: ModelBody[] = []
  let unexpectedModelRoute = false
  const provider = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions") {
        unexpectedModelRoute = true
        return new Response("Only the local fixture route is supported", { status: 404 })
      }
      const body = await request.json() as ModelBody
      captured.push(body)
      const messages = Array.isArray(body.messages) ? body.messages as ModelBody[] : []
      const transcript = JSON.stringify(messages)
      const offersRead = Array.isArray(body.tools) && body.tools.some(value => isRecord(value) && isRecord(value.function) && value.function.name === "read")
      const hasToolResult = messages.some(message => message.role === "tool")
      if (offersRead && transcript.includes("PRODUCT_READ_TOOL") && !hasToolResult) {
        return completion(body, { tool: { name: "read", arguments: JSON.stringify({ filePath: evidenceFile }) } })
      }
      return completion(body, { text: transcript.includes("PRODUCT_READ_TOOL") ? "PRODUCT_READ_CONFIRMED" : "PRODUCT_CONTEXT_CONFIRMED" })
    },
  })

  let engineA: Awaited<ReturnType<typeof startEngine>> | undefined
  let engineB: Awaited<ReturnType<typeof startEngine>> | undefined
  let appA: ReturnType<typeof startServer> | undefined
  let appB: ReturnType<typeof startServer> | undefined
  let storeA: SoulStore | undefined
  let storeB: SoulStore | undefined
  try {
    const config = {
      model: "xingyao-local/test-model", small_model: "xingyao-local/test-model", enabled_providers: ["xingyao-local"],
      provider: { "xingyao-local": {
        name: "Offline product acceptance fixture", npm: "@ai-sdk/openai-compatible", env: [],
        options: { baseURL: `${provider.url.origin}/v1`, apiKey: "fixture-only-not-a-real-secret", timeout: 5000, maxRetries: 0 },
        models: { "test-model": { name: "Offline fixture model", tool_call: true, reasoning: false, attachment: false, temperature: false,
          limit: { context: 64000, output: 4096 }, cost: { input: 0, output: 0 } } },
      } },
    }
    const configA = join(hostA, "local-provider.json")
    await writeFile(configA, JSON.stringify(config))
    engineA = await startEngine({ executable, hostDir: hostA, projectDir: project, configPath: configA, requestTimeoutMs: 25_000 })
    const engineVersion = engineA.version
    storeA = new SoulStore(join(hostA, "soul.db"))
    const identityId = storeA.identityId
    const tokenA = crypto.randomUUID()
    appA = startServer({
      store: storeA, adapter: engineA.adapter, vaultDir: vault, token: tokenA,
      checkpointExtensions: async directory => {
        const backup = await backupEngine(hostA, directory, engineVersion)
        const files: Record<string, string> = { "engine/complete.json": await digest(join(directory, "engine", "complete.json")) }
        for (const file of backup.files) files[`engine/${file.path}`] = file.sha256
        return files
      },
    })
    const apiA = api(appA.server.port!, tokenA)
    const preference = await apiA<Memory>("POST", "/api/memories", {
      key: "initial-pref", kind: "preference", scope: "portable-check", text: `便携校验使用约定 ${oldPreference}`, pinned: true,
    }, 201)
    await apiA("POST", "/api/memories", { key: "private-pref", kind: "fact", scope: "portable-check", text: privateEvidence, pinned: true, private: true }, 201)
    await apiA("POST", "/api/memories", { key: "other-pref", kind: "fact", scope: "other-project", text: otherScopeEvidence, pinned: true }, 201)
    const document = await apiA<DocumentSummary>("POST", "/api/knowledge", { path: knowledgeFile, scope: "portable-check" }, 201)
    const task = await apiA<Task>("POST", "/api/tasks", { key: "task-read", title: "便携校验真实工具测试", scope: "portable-check" }, 201)
    const firstModelIndex = captured.length
    await apiA("POST", `/api/tasks/${task.id}/chat`, { key: "read-request", text: "PRODUCT_READ_TOOL：请进行便携校验，读取指定证据文件并核对结果。" }, 202)
    const permission = await waitFor(async () => {
      const current = await apiA<TaskDetail>("GET", `/api/tasks/${task.id}`)
      const pending = await apiA<PermissionRequest[]>("GET", "/api/permissions")
      return pending.find(item => item.sessionID === current.sessionId)
    }, 15_000, "real read permission through the product API")
    expect(permission.permission).toBe("read")
    expect(await apiA<{ ok: boolean }>("POST", "/api/permissions/reply", { id: permission.id, reply: "once" })).toEqual({ ok: true })
    const finished = await waitFor(async () => {
      const current = await apiA<TaskDetail>("GET", `/api/tasks/${task.id}`)
      return current.status !== "running" ? current : undefined
    }, 25_000, "real read task completion")
    expect(finished.status).toBe("verifying")
    expect(finished.error).toBeNull()
    expect(finished.actions.some(action => action.tool === "read" && action.status === "succeeded" && action.text.includes(fileEvidence))).toBe(true)
    expect(finished.messages.some(message => message.role === "assistant" && message.text.includes("PRODUCT_READ_CONFIRMED"))).toBe(true)
    expect(finished.sessionId).toBeTruthy()
    const originalSession = finished.sessionId!
    const firstSystems = systemTexts(captured.slice(firstModelIndex))
    expect(firstSystems.some(system => system.includes(oldPreference) && system.includes(knowledgeEvidence))).toBe(true)
    expect(firstSystems.every(system => !system.includes(privateEvidence) && !system.includes(otherScopeEvidence))).toBe(true)
    expect(storeA.affect().emotion[0]!).toBeGreaterThan(0)
    expect((await apiA<Task>("POST", `/api/tasks/${task.id}/complete`)).status).toBe("completed")

    const sleep = await apiA<SleepReport>("POST", "/api/sleep")
    expect(sleep.created).toBeGreaterThanOrEqual(1)
    const memoryCount = (await apiA<Memory[]>("GET", "/api/memories?scope=portable-check")).length
    const repeatedSleep = await apiA<SleepReport>("POST", "/api/sleep")
    expect(repeatedSleep.created).toBe(0)
    expect((await apiA<Memory[]>("GET", "/api/memories?scope=portable-check")).length).toBe(memoryCount)
    const corrected = await apiA<Memory>("PATCH", `/api/memories/${preference.id}`, { revision: preference.revision, text: `便携校验改用新约定 ${newPreference}` })
    const secondTask = await apiA<Task>("POST", "/api/tasks", { key: "task-revised", title: "纠正后的便携校验", scope: "portable-check" }, 201)
    const correctedIndex = captured.length
    await apiA("POST", `/api/tasks/${secondTask.id}/chat`, { key: "revised-request", text: "PRODUCT_REVISED_CONTEXT：现在便携校验采用什么约定？" }, 202)
    const secondFinished = await waitFor(async () => {
      const current = await apiA<TaskDetail>("GET", `/api/tasks/${secondTask.id}`)
      return current.status !== "running" ? current : undefined
    }, 25_000, "corrected context task")
    expect(secondFinished.status).toBe("verifying")
    const correctedSystems = systemTexts(captured.slice(correctedIndex))
    expect(correctedSystems.some(system => system.includes(newPreference) && system.includes(knowledgeEvidence))).toBe(true)
    expect(correctedSystems.every(system => !system.includes(oldPreference))).toBe(true)
    const snapshot = await apiA<CheckpointInfo>("POST", "/api/checkpoint")
    const generation = join(vault, "checkpoints", snapshot.generation)
    const engineSnapshot = await verifyEngineCheckpoint(generation)
    expect(engineSnapshot.files.length).toBeGreaterThan(0)
    expect(snapshot.identityId).toBe(identityId)

    await appA.server.stop(true)
    appA = undefined
    await engineA.stop()
    engineA = undefined
    storeA.close()
    storeA = undefined

    await restoreCheckpoint(vault, snapshot.generation, join(hostB, "soul.db"))
    await restoreEngine(hostB, generation, engineVersion)
    storeB = new SoulStore(join(hostB, "soul.db"))
    expect(storeB.identityId).toBe(identityId)
    expect(storeB.revision).toBe(snapshot.revision)
    expect(storeB.memory(corrected.id)?.text).toContain(newPreference)
    expect(storeB.memory(preference.id)?.status).toBe("superseded")
    expect(storeB.task(task.id)?.sessionId).toBe(originalSession)
    const configB = join(hostB, "local-provider.json")
    await writeFile(configB, JSON.stringify(config))
    engineB = await startEngine({ executable, hostDir: hostB, projectDir: project, configPath: configB, requestTimeoutMs: 25_000 })
    expect(engineB.version).toBe(engineVersion)
    const restoredHistory = await engineB.adapter.messages(originalSession)
    expect(restoredHistory.flatMap(message => message.parts).some(part => part.type === "tool" && part.status === "completed" && part.output?.includes(fileEvidence))).toBe(true)
    const tokenB = crypto.randomUUID()
    appB = startServer({ store: storeB, adapter: engineB.adapter, vaultDir: vault, token: tokenB })
    const apiB = api(appB.server.port!, tokenB)
    const imported = await apiB<DocumentSummary[]>("GET", "/api/knowledge")
    expect(imported.some(item => item.id === document.id && item.contentHash === document.contentHash)).toBe(true)
    const thirdTask = await apiB<Task>("POST", "/api/tasks", { key: "task-restored", title: "迁移后便携校验", scope: "portable-check" }, 201)
    const restoredIndex = captured.length
    await apiB("POST", `/api/tasks/${thirdTask.id}/chat`, { key: "restored-request", text: "PRODUCT_RESTORED_CONTEXT：恢复后继续便携校验。" }, 202)
    const thirdFinished = await waitFor(async () => {
      const current = await apiB<TaskDetail>("GET", `/api/tasks/${thirdTask.id}`)
      return current.status !== "running" ? current : undefined
    }, 25_000, "restored product context")
    expect(thirdFinished.status).toBe("verifying")
    const restoredSystems = systemTexts(captured.slice(restoredIndex))
    expect(restoredSystems.some(system => system.includes(newPreference) && system.includes(knowledgeEvidence))).toBe(true)
    expect(restoredSystems.every(system => !system.includes(oldPreference) && !system.includes(privateEvidence) && !system.includes(otherScopeEvidence))).toBe(true)
    expect(unexpectedModelRoute).toBe(false)
    expect(await digest(executable)).toBe(binaryHash)
    console.info(JSON.stringify({ acceptance: "product-soul-integration-and-restore", engineVersion, executable, sha256: binaryHash,
      domainRestored: true, engineSessionRestored: true, actualToolPermissionAndEvidence: true, publicModelUsed: false }))
  } finally {
    await appA?.server.stop(true)
    await appB?.server.stop(true)
    await engineA?.stop()
    await engineB?.stop()
    await Promise.allSettled([...(appA?.jobs.values() ?? []), ...(appB?.jobs.values() ?? [])])
    storeA?.close()
    storeB?.close()
    await provider.stop(true)
    releaseA()
    releaseB()
    if (resolve(dirname(root)) !== resolve(tmpdir()) || !root.includes("xingyao-product-integration-")) throw new Error("Unexpected temporary integration directory")
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 90_000)

function api(port: number, token: string) {
  return async <T = unknown>(method: string, path: string, body?: unknown, expected = 200): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const value = await response.json()
    if (response.status !== expected) throw new Error(`Product API ${method} ${path} returned ${response.status}: ${JSON.stringify(value)}`)
    return value as T
  }
}

async function waitFor<T>(sample: () => Promise<T | undefined>, timeout: number, label: string): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await sample()
    if (value !== undefined) return value
    await Bun.sleep(50)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function systemTexts(requests: ModelBody[]): string[] {
  return requests.flatMap(request => Array.isArray(request.messages) ? request.messages : [])
    .filter(message => isRecord(message) && (message.role === "system" || message.role === "developer"))
    .map(message => JSON.stringify((message as ModelBody).content))
}

async function digest(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  const reader = Bun.file(path).stream().getReader()
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      hasher.update(item.value)
    }
  } finally { reader.releaseLock() }
  return hasher.digest("hex")
}

function isRecord(value: unknown): value is ModelBody { return value !== null && typeof value === "object" && !Array.isArray(value) }

function completion(request: ModelBody, result: { text?: string; tool?: { name: string; arguments: string } }): Response {
  const common = { id: `chatcmpl_${crypto.randomUUID()}`, created: Math.floor(Date.now() / 1000), model: "test-model" }
  const calls = result.tool ? [{ index: 0, id: "call_product_read", type: "function", function: result.tool }] : undefined
  const finish = calls ? "tool_calls" : "stop"
  if (request.stream !== true) return Response.json({ ...common, object: "chat.completion", choices: [{ index: 0,
    message: { role: "assistant", content: result.text ?? null, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
  const chunks = [
    { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", ...(calls ? { tool_calls: calls } : { content: result.text ?? "" }) }, finish_reason: null }] },
    { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
  ]
  return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
}
