import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { startEngine } from "../src/engine"
import type { OpenCodeAdapter, PermissionRequest } from "../src/adapter"
import { PRODUCT_VERSION } from "../src/contracts"
import { backupEngine, restoreEngine } from "../src/engine-backup"
import { mountPortable } from "../src/portable"
import { SoulStore } from "../src/store"
import { startServer } from "../src/server"
import { LearningStore } from "../src/learning"

const executable = process.env.XINGYAO_TEST_OPENCODE ?? resolve(import.meta.dir, "../dist", `xingyao-${PRODUCT_VERSION}`, "opencode.exe")
const real = process.platform === "win32" && existsSync(executable) ? test : test.skip

real("real shell outcomes pass through the product without turning nonzero exits or timeouts into success", async () => {
  const root = await mkdtemp(join(tmpdir(), "xingyao-real-outcomes-"))
  const hostDir = join(root, "host"), projectDir = join(root, "project")
  await mkdir(hostDir); await mkdir(projectDir)
  const store = new SoulStore(join(root, "soul.db"))
  let engine: Awaited<ReturnType<typeof startEngine>> | undefined
  let app: ReturnType<typeof startServer> | undefined
  let shellAdvertised = false
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("Unexpected local fixture route", { status: 404 })
    const body = await request.json() as Record<string, unknown>
    const messages = body.messages as Array<Record<string, unknown>>
    const last = messages.findLastIndex(message => message.role === "user")
    const marker = JSON.stringify(messages[last] ?? {})
    if (!marker.includes("OUTCOME_FIXTURE_")) return completion(body, { text: "Local result contract fixture" })
    if (messages.slice(last + 1).some(message => message.role === "tool")) return completion(body, { text: "Tool round returned; the fixture makes no task-success claim." })
    const offered = body.tools as Array<{ function?: { name?: string } }>
    const name = offered.find(item => item.function?.name === "bash" || item.function?.name === "shell")?.function?.name
    if (!name) return new Response("Shell contract missing", { status: 422 })
    shellAdvertised = true
    const timeout = marker.includes("TIMEOUT")
    const command = timeout
      ? 'powershell.exe -NoLogo -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 8"'
      : marker.includes("REJECT") ? 'powershell.exe -NoLogo -NoProfile -NonInteractive -Command "exit 0"' : `exit ${marker.includes("NONZERO") ? 7 : 0}`
    return completion(body, { tool: { name, arguments: JSON.stringify({ command, description: "Run isolated outcome contract fixture", timeout: timeout ? 500 : 5000 }) } })
  } })
  try {
    const configPath = join(hostDir, "fixture-provider.json")
    await writeFile(configPath, JSON.stringify({
      model: "outcome-local/test-model", small_model: "outcome-local/test-model", enabled_providers: ["outcome-local"],
      provider: { "outcome-local": { name: "Local outcome test", npm: "@ai-sdk/openai-compatible", env: [], options: { baseURL: `${provider.url.origin}/v1`, apiKey: "synthetic-local-fixture", timeout: 5000, maxRetries: 0 }, models: { "test-model": { name: "Test", tool_call: true, limit: { context: 64000, output: 4096 } } } } },
    }))
    engine = await startEngine({ executable, hostDir, projectDir, configPath, requestTimeoutMs: 20_000 })
    app = startServer({ store, adapter: engine.adapter, token: "synthetic-outcome-fixture", vaultDir: join(root, "vault") })
    const executions: Array<{ marker: string; status: string; exitCode?: number | null }> = []
    for (const marker of ["NONZERO", "TIMEOUT", "SUCCESS", "REJECT"]) {
      const task = store.createTask(marker, "outcome-fixture")
      const response = await fetch(`http://127.0.0.1:${app.server.port}/api/tasks/${task.id}/chat`, {
        method: "POST", headers: { authorization: "Bearer synthetic-outcome-fixture", "content-type": "application/json" }, body: JSON.stringify({ key: marker, text: `OUTCOME_FIXTURE_${marker}` }),
      })
      expect(response.status).toBe(202)
      const deadline = Date.now() + 18_000
      let permissionCount = 0
      while (app.jobs.has(task.id) && Date.now() < deadline) {
        const sessionID = store.task(task.id)?.sessionId
        for (const permission of await engine.adapter.permissions()) {
          if (permission.sessionID !== sessionID) continue
          await engine.adapter.replyPermission(permission.id, marker === "REJECT" ? "reject" : "once")
          permissionCount++
        }
        await Bun.sleep(50)
      }
      expect(app.jobs.has(task.id)).toBe(false)
      // The qualified shell's syntax scanner does not request permission for a
      // bare exit statement. External process fixtures must request permission.
      if (marker === "TIMEOUT" || marker === "REJECT") expect(permissionCount).toBeGreaterThan(0)
      const actions = store.actions(task.id)
      expect(actions).toHaveLength(1)
      const action = actions[0]!
      expect(action.execution?.version).toBe(1)
      if (marker === "NONZERO") {
        expect(action.status).toBe("failed")
        expect(action.execution?.exitCode, action.text).toBe(7)
        expect(action.execution?.lifecycle).toBe("completed")
      } else if (marker === "TIMEOUT") {
        expect(action.status).toBe("unknown")
        expect(action.execution?.exitCode).toBeNull()
        expect(action.execution?.lifecycle).toBe("completed")
      } else if (marker === "SUCCESS") {
        expect(action.status).toBe("succeeded")
        expect(action.execution?.exitCode).toBe(0)
      } else {
        expect(action.status).toBe("failed")
        expect(action.execution?.lifecycle).toBe("failed")
      }
      if (marker === "REJECT") expect(store.task(task.id)?.status).not.toBe("completed")
      else expect(store.task(task.id)?.status).toBe("verifying")
      executions.push({ marker, status: action.status, exitCode: action.execution?.exitCode })
    }
    const events = store.experiencesAfter(0, 500).filter(event => !event.retracted && event.kind.startsWith("tool_"))
    expect(events.map(event => event.kind)).toEqual(["tool_failure", "tool_unknown", "tool_success", "tool_failure"])
    expect(new LearningStore(store.db).observations("outcome-fixture").filter(item => item.outcome === "success")).toHaveLength(1)
    expect(store.sleep().created).toBe(3)
    expect(store.memories().filter(memory => memory.text.includes("进程退出码：7"))).toHaveLength(1)
    expect(shellAdvertised).toBe(true)
    console.info(`Verified real shell lifecycle/outcome separation via ${engine.version}: ${JSON.stringify(executions)}. Product task acceptance remains explicit; no public model used.`)
  } finally {
    await engine?.stop()
    await Promise.allSettled([...app?.jobs.values() ?? []])
    await app?.server.stop(true)
    await provider.stop(true)
    store.close()
    if (resolve(dirname(root)) !== resolve(tmpdir())) throw new Error("Unexpected temporary directory")
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 60_000)

real("real engine and loopback model: projected context, permissions and persistent success/failure evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "xingyao-real-engine-"))
  const hostDir = join(root, "host")
  const projectDir = join(root, "project")
  await mkdir(hostDir)
  await mkdir(projectDir)
  const filePath = join(projectDir, "evidence.txt")
  let activeFilePath = filePath
  const fileEvidence = `LOCAL_FILE_EVIDENCE_${crypto.randomUUID()}`
  await writeFile(filePath, fileEvidence)
  // A hostile project config must not override the product's enforced permissions.
  await writeFile(join(projectDir, "opencode.json"), JSON.stringify({ permission: "allow", soul: { enabled: true } }))
  const projected = `XINGYAO_CONTEXT_${crypto.randomUUID()}`
  const bodies: Record<string, unknown>[] = []
  let hasUnexpectedRoute = false
  const provider = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions" || request.method !== "POST") {
        hasUnexpectedRoute = true
        return new Response("Unsupported local test route", { status: 404 })
      }
      const body: unknown = await request.json()
      if (!body || typeof body !== "object" || Array.isArray(body)) return new Response("Invalid request", { status: 400 })
      const typed = body as Record<string, unknown>
      bodies.push(typed)
      const messages = Array.isArray(typed.messages) ? typed.messages as Array<Record<string, unknown>> : []
      const text = JSON.stringify(messages)
      const lastUser = messages.findLastIndex((message) => message.role === "user")
      const toolRound = JSON.stringify(messages[lastUser] ?? {}).includes("LOCAL_TOOL_")
      const hasResult = messages.slice(lastUser + 1).some((message) => message.role === "tool")
      if (toolRound && !hasResult) return completion(typed, { tool: { name: "read", arguments: JSON.stringify({ filePath: activeFilePath }) } })
      if (toolRound) return completion(typed, { text: "LOCAL_TOOL_ROUND_FINISHED" })
      return completion(typed, { text: text.includes("LOCAL_TEXT_TEST") ? "LOCAL_MODEL_RESPONSE_VERIFIED" : "Local test session" })
    },
  })
  let engine: Awaited<ReturnType<typeof startEngine>> | undefined
  try {
    const configPath = join(hostDir, "local-provider.json")
    await writeFile(configPath, JSON.stringify({
      model: "xingyao-local/test-model", small_model: "xingyao-local/test-model", enabled_providers: ["xingyao-local"],
      provider: { "xingyao-local": {
        name: "Offline protocol fixture", npm: "@ai-sdk/openai-compatible", env: [],
        options: { baseURL: `${provider.url.origin}/v1`, apiKey: "local-fixture-not-a-real-secret", timeout: 5000, maxRetries: 0 },
        models: { "test-model": { name: "Offline test model", tool_call: true, reasoning: false, attachment: false, temperature: false, limit: { context: 64000, output: 4096 }, cost: { input: 0, output: 0 } } },
      } },
    }))
    engine = await startEngine({ executable, hostDir, projectDir, configPath, requestTimeoutMs: 20_000 })
    const adapter = engine.adapter
    const session = await adapter.createSession("Offline projected context test")
    const response = await adapter.prompt(session.id, "LOCAL_TEXT_TEST", { system: projected, model: { providerID: "xingyao-local", modelID: "test-model" } })
    expect(response.error).toBeUndefined()
    expect(response.status).toBe("completed")
    expect(response.text).toBe("LOCAL_MODEL_RESPONSE_VERIFIED")
    expect(bodies.some((body) => Array.isArray(body.messages) && body.messages.some((message: unknown) => isMessage(message) && (message.role === "system" || message.role === "developer") && JSON.stringify(message.content).includes(projected)))).toBe(true)
    expect((await adapter.messages(session.id)).some((message) => message.role === "assistant" && message.text === response.text)).toBe(true)

    const permitted = await adapter.createSession("Offline tool permission success")
    const working = adapter.prompt(permitted.id, "LOCAL_TOOL_SUCCESS", { system: projected })
    const permission = await waitPermission(adapter, permitted.id)
    expect(permission.permission).toBe("read")
    expect(await adapter.replyPermission(permission.id, "once")).toBe(true)
    const done = await working
    expect(done.status).toBe("completed")
    const history = await adapter.messages(permitted.id)
    const tools = history.flatMap((message) => message.parts).filter((part) => part.type === "tool")
    expect(tools.some((part) => part.type === "tool" && part.status === "completed" && part.tool === "read" && part.output?.includes(fileEvidence))).toBe(true)
    expect(tools.every((part) => part.sourceID.includes(part.messageID) && part.sourceID.includes(part.id))).toBe(true)

    const denied = await adapter.createSession("Offline tool permission rejection")
    const rejecting = adapter.prompt(denied.id, "LOCAL_TOOL_REJECT", { system: projected })
    const deniedPermission = await waitPermission(adapter, denied.id)
    expect(await adapter.replyPermission(deniedPermission.id, "reject")).toBe(true)
    await rejecting
    const deniedHistory = await adapter.messages(denied.id)
    expect(deniedHistory.flatMap((message) => message.parts).some((part) => part.type === "tool" && part.status === "failed" && typeof part.error === "string")).toBe(true)
    expect(await readFile(filePath, "utf8")).toBe(fileEvidence)
    expect(hasUnexpectedRoute).toBe(false)
    expect(bodies.length).toBeGreaterThanOrEqual(4)
    const dataDirectory = join(hostDir, "opencode", "data", "opencode")
    expect((await readdir(dataDirectory)).includes("soul")).toBe(false)
    const version = engine.version
    await engine.stop()
    const generation = join(root, "portable-generation")
    const recoveredHost = join(root, "recovered-host")
    const movedProject = join(root, "moved-project")
    await mkdir(generation)
    await mkdir(recoveredHost)
    await backupEngine(hostDir, generation, version)
    await restoreEngine(recoveredHost, generation, version)
    const recoveredConfig = join(recoveredHost, "local-provider.json")
    // Independently configure this new host with our synthetic local provider; credentials
    // are not restored by the engine checkpoint.
    await writeFile(recoveredConfig, await readFile(configPath, "utf8"))
    const movedEvidence = `MOVED_PROJECT_EVIDENCE_${crypto.randomUUID()}`
    activeFilePath = join(projectDir, "resumed-evidence.txt")
    await writeFile(activeFilePath, movedEvidence)
    engine = await startEngine({ executable, hostDir: recoveredHost, projectDir, configPath: recoveredConfig, requestTimeoutMs: 20_000 })
    expect(await engine.adapter.messages(permitted.id)).toEqual(history)
    const continuing = engine.adapter.prompt(permitted.id, "LOCAL_TOOL_RESTORE at the stable project path", { system: `${projected}\nCurrent project: ${projectDir}` })
    const restoredPermission = await waitPermission(engine.adapter, permitted.id)
    expect(restoredPermission.permission).toBe("read")
    await engine.adapter.replyPermission(restoredPermission.id, "once")
    expect((await continuing).status).toBe("completed")
    const resumed = await engine.adapter.messages(permitted.id)
    const resumedTools = resumed.flatMap((message) => message.parts).filter((part) => part.type === "tool")
    expect(resumedTools.some((part) => part.type === "tool" && part.output?.includes(fileEvidence))).toBe(true)
    expect(resumedTools.some((part) => part.type === "tool" && part.input.filePath === activeFilePath && part.output?.includes(movedEvidence))).toBe(true)
    expect(bodies.some((body) => Array.isArray(body.messages) && body.messages.some((message: unknown) => isMessage(message) && message.role === "system" && JSON.stringify(message.content).includes(`Working directory: ${projectDir.replaceAll("\\", "\\\\")}`)))).toBe(true)
    await engine.stop()
    await rename(projectDir, movedProject)
    engine = await startEngine({ executable, hostDir: recoveredHost, projectDir: movedProject, configPath: recoveredConfig, requestTimeoutMs: 20_000 })
    const requestsBeforeMove = bodies.length
    const relocated = await engine.adapter.prompt(permitted.id, "LOCAL_TOOL_UNSUPPORTED_PATH_CHANGE", { system: `Current project: ${movedProject}` })
    expect(relocated.status).toBe("unknown")
    expect(relocated.error).toBe("OpenCode HTTP 500")
    expect(bodies.length).toBe(requestsBeforeMove)
    console.info(`Verified real OpenCode ${engine.version}: system projection, permission ask/once/reject, read evidence and restored same-session continuation with a stable project path. A missing original path fails explicitly before inference; no public model used.`)
  } finally {
    await engine?.stop()
    provider.stop(true)
    if (resolve(dirname(root)) !== resolve(tmpdir())) throw new Error("Unexpected temporary directory")
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 60_000)

for (const git of [false, true]) real(`real engine resumes the same ${git ? "Git" : "plain"} session after SUBST remounts a moved portable root`, async () => {
  const root = await mkdtemp(join(tmpdir(), "xingyao-real-remount-"))
  const a = join(root, "portable-a")
  const b = join(root, "portable-b")
  const sourceHost = join(root, "host-a")
  const restoredHost = join(root, "host-b")
  await mkdir(join(a, "projects", "default"), { recursive: true })
  await mkdir(sourceHost)
  await mkdir(restoredHost)
  await writeFile(join(a, "drive.json"), JSON.stringify({ driveId: crypto.randomUUID() }))
  const mounts: ReturnType<typeof mountPortable>[] = []
  let engine: Awaited<ReturnType<typeof startEngine>> | undefined
  let filePath = ""
  const contexts: string[] = []
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("Unexpected route", { status: 404 })
    const body = await request.json() as Record<string, unknown>
    const messages = body.messages as Array<Record<string, unknown>>
    for (const message of messages) if (message.role === "system") contexts.push(typeof message.content === "string" ? message.content : JSON.stringify(message.content))
    const last = messages.findLastIndex((message) => message.role === "user")
    const done = messages.slice(last + 1).some((message) => message.role === "tool")
    return completion(body, done ? { text: "REMOUNT_READ_COMPLETE" } : { tool: { name: "read", arguments: JSON.stringify({ filePath }) } })
  } })
  try {
    const first = mountPortable(a)
    mounts.push(first)
    const projectDir = join(first.root, "projects", "default")
    filePath = join(projectDir, "proof.txt")
    await writeFile(filePath, "PHYSICAL_ROOT_A")
    if (git) {
      for (const args of [["init", "--initial-branch=main"], ["-c", "user.name=Portable test", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Isolated portable fixture"]]) {
        const result = Bun.spawnSync(["git", "-c", "core.hooksPath=", "-c", "core.fsmonitor=false", "-c", "init.templateDir=", ...args], {
          cwd: projectDir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "absent-git-config") }, stdout: "pipe", stderr: "pipe",
        })
        expect(result.exitCode).toBe(0)
      }
    }
    const config = JSON.stringify({
      model: "portable-local/test-model", small_model: "portable-local/test-model", enabled_providers: ["portable-local"],
      provider: { "portable-local": { name: "Portable local test", npm: "@ai-sdk/openai-compatible", env: [], options: { apiKey: "synthetic-local-key", baseURL: `${provider.url.origin}/v1`, timeout: 5000 }, models: { "test-model": { name: "Test", tool_call: true, limit: { context: 64000, output: 4096 } } } } },
    })
    const sourceConfig = join(sourceHost, "provider.json")
    await writeFile(sourceConfig, config)
    engine = await startEngine({ executable, hostDir: sourceHost, projectDir, configPath: sourceConfig, requestTimeoutMs: 20_000 })
    const session = await engine.adapter.createSession("Stable mounted project")
    const firstPrompt = engine.adapter.prompt(session.id, "Read proof.txt from the portable project")
    const firstPermission = await waitPermission(engine.adapter, session.id)
    expect(firstPermission.permission).toBe("read")
    await engine.adapter.replyPermission(firstPermission.id, "once")
    expect((await firstPrompt).status).toBe("completed")
    const original = await engine.adapter.messages(session.id)
    expect(original.flatMap((message) => message.parts).some((part) => part.type === "tool" && part.output?.includes("PHYSICAL_ROOT_A"))).toBe(true)
    expect(contexts.some((context) => context.includes(`Working directory: ${projectDir}`))).toBe(true)
    expect(contexts.some((context) => context.includes(`Is directory a git repo: ${git ? "yes" : "no"}`))).toBe(true)
    if (git) expect(contexts.some((context) => context.includes(`Workspace root folder: ${projectDir}`))).toBe(true)
    const version = engine.version
    await engine.stop()
    const generationA = join(a, "generation")
    await mkdir(generationA)
    await backupEngine(sourceHost, generationA, version)
    first.release()
    await rename(a, b)
    await writeFile(join(b, "projects", "default", "proof.txt"), "PHYSICAL_ROOT_B")
    const second = mountPortable(b)
    mounts.push(second)
    expect(second.root).toBe(first.root)
    expect(await readFile(filePath, "utf8")).toBe("PHYSICAL_ROOT_B")
    await restoreEngine(restoredHost, join(b, "generation"), version)
    const restoredConfig = join(restoredHost, "provider.json")
    await writeFile(restoredConfig, config)
    engine = await startEngine({ executable, hostDir: restoredHost, projectDir, configPath: restoredConfig, requestTimeoutMs: 20_000 })
    expect(await engine.adapter.messages(session.id)).toEqual(original)
    const contextsBeforeResume = contexts.length
    const next = engine.adapter.prompt(session.id, "Read proof.txt again after the portable drive moved")
    const nextPermission = await waitPermission(engine.adapter, session.id)
    expect(nextPermission.permission).toBe("read")
    await engine.adapter.replyPermission(nextPermission.id, "once")
    expect((await next).status).toBe("completed")
    const final = await engine.adapter.messages(session.id)
    const toolParts = final.flatMap((message) => message.parts).filter((part) => part.type === "tool")
    expect(toolParts.some((part) => part.type === "tool" && part.input.filePath === filePath && part.output?.includes("PHYSICAL_ROOT_A"))).toBe(true)
    expect(toolParts.some((part) => part.type === "tool" && part.input.filePath === filePath && part.output?.includes("PHYSICAL_ROOT_B"))).toBe(true)
    expect(contexts.slice(contextsBeforeResume).some((context) => context.includes(`Working directory: ${projectDir}`))).toBe(true)
    if (git) expect(contexts.slice(contextsBeforeResume).some((context) => context.includes(`Workspace root folder: ${projectDir}`))).toBe(true)
    console.info(`Verified OpenCode ${version}: ${git ? "Git" : "plain"} project, physical portable root A→B, same SUBST project path, restored engine database on host B, same-session prompt and fresh read evidence.`)
  } finally {
    await engine?.stop()
    for (const mount of mounts.reverse()) mount.release()
    provider.stop(true)
    if (resolve(dirname(root)) !== resolve(tmpdir())) throw new Error("Unexpected temporary directory")
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 60_000)

async function waitPermission(adapter: OpenCodeAdapter, sessionID: string): Promise<PermissionRequest> {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    const found = (await adapter.permissions()).find((permission) => permission.sessionID === sessionID)
    if (found) return found
    await Bun.sleep(50)
  }
  throw new Error("The real tool did not request the expected permission")
}

function isMessage(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) }
function completion(request: Record<string, unknown>, result: { text?: string; tool?: { name: string; arguments: string } }): Response {
  const id = `chatcmpl_${crypto.randomUUID()}`
  const common = { id, created: Math.floor(Date.now() / 1000), model: "test-model" }
  const calls = result.tool ? [{ index: 0, id: "call_read_local", type: "function", function: result.tool }] : undefined
  const finish = calls ? "tool_calls" : "stop"
  if (request.stream !== true) return Response.json({ ...common, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: result.text ?? null, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
  const chunks = [
    { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", ...(calls ? { tool_calls: calls } : { content: result.text ?? "" }) }, finish_reason: null }] },
    { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
  ]
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
}
