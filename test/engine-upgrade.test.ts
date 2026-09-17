import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { startEngine, type Engine } from "../src/engine"
import { backupEngine, restoreEngine, verifyEngineCheckpoint } from "../src/engine-backup"
import { migrateEngineCheckpoint, type EngineMigrationBoundary } from "../src/engine-migration"
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from "../src/checkpoint"
import { SoulStore } from "../src/store"
import { startServer } from "../src/server"
import { main } from "../src/main"
import type { Task } from "../src/contracts"
import type { MigrationDigest, NormalizedMessage, OpenCodeAdapter } from "../src/adapter"

const from = {
  executable: process.env.XINGYAO_UPGRADE_FROM_ENGINE ?? resolve(import.meta.dir, "../dist/xingyao-0.1.0-dev.5/opencode.exe"),
  version: "0.0.0-product-dev-20260917-engine.5",
  sha256: "528277b2ea4178093a192da0fe33ef4768e7ae5514a7b21de006d07212c6df83",
}
const to = {
  executable: process.env.XINGYAO_UPGRADE_TO_ENGINE ?? resolve(import.meta.dir, "../dist/engines/0.0.0-product-dev-20260918-engine.6-source/opencode.exe"),
  version: "0.0.0-product-dev-20260918-engine.6-source",
  sha256: process.env.XINGYAO_UPGRADE_TO_SHA256 ?? "f02b6bbba598d4f2e9e1c1f75794104b9581129ae199d3130b4bc2e552ee748b",
}
if (!/^[a-f0-9]{64}$/.test(to.sha256)) throw new Error("XINGYAO_UPGRADE_TO_SHA256 must be exactly 64 lowercase hexadecimal characters")
const real = process.platform === "win32" && existsSync(from.executable) && existsSync(to.executable) ? test : test.skip
const sha = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

real("real engine upgrade preserves public evidence, continues with permissions, restores the new snapshot and rolls back from the original old snapshot", async () => {
  expect(sha(await readFile(from.executable))).toBe(from.sha256)
  expect(sha(await readFile(to.executable))).toBe(to.sha256)
  const root = await realpath(await mkdtemp(join(tmpdir(), "xingyao-engine-upgrade-")))
  const projectDir = join(root, "stable-project")
  await mkdir(projectDir)
  const generations = { old: join(root, "old-generation"), upgraded: join(root, "new-generation") }
  await mkdir(generations.old); await mkdir(generations.upgraded)
  let activeRead = ""
  let engine: Engine | undefined
  let unexpectedRoutes = 0
  let inferenceCount = 0
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions") {
      unexpectedRoutes++
      return new Response("Unexpected fixture route", { status: 404 })
    }
    inferenceCount++
    const body = await request.json() as Record<string, unknown>
    const messages = body.messages as Array<{ role?: string; content?: unknown }>
    const lastUser = messages.findLastIndex((message) => message.role === "user")
    const marker = JSON.stringify(messages[lastUser] ?? {})
    const returned = messages.slice(lastUser + 1).some((message) => message.role === "tool")
    if (!returned && marker.includes("UPGRADE_READ_")) {
      return completion(body, { tool: { name: "read", arguments: JSON.stringify({ filePath: activeRead }) } })
    }
    if (!returned && marker.includes("UPGRADE_SHELL_NONZERO")) {
      const tools = body.tools as Array<{ function?: { name?: string } }>
      const shell = tools.find((tool) => tool.function?.name === "bash" || tool.function?.name === "shell")?.function?.name
      if (!shell) return new Response("Missing shell tool", { status: 422 })
      return completion(body, { tool: { name: shell, arguments: JSON.stringify({ command: "exit 7", description: "Isolated upgrade failure evidence", timeout: 5000 }) } })
    }
    return completion(body, { text: marker.includes("UPGRADE_TEXT_") ? "UPGRADE_TEXT_REPLY" : returned ? "UPGRADE_TOOL_ROUND_RETURNED" : "Local upgrade fixture" })
  } })
  const config = JSON.stringify({
    model: "upgrade-local/test-model", small_model: "upgrade-local/test-model", enabled_providers: ["upgrade-local"],
    provider: { "upgrade-local": { name: "Local upgrade fixture", npm: "@ai-sdk/openai-compatible", env: [],
      options: { baseURL: `${provider.url.origin}/v1`, apiKey: "synthetic-loopback-fixture", timeout: 5000, maxRetries: 0 },
      models: { "test-model": { name: "Upgrade test", tool_call: true, limit: { context: 128000, output: 4096 } } },
    } },
  })
  async function start(candidate: typeof from, host: string) {
    await mkdir(host, { recursive: true })
    const configPath = join(host, "local-provider.json")
    await writeFile(configPath, config)
    engine = await startEngine({ executable: candidate.executable, hostDir: host, projectDir, configPath,
      startupTimeoutMs: 25000, requestTimeoutMs: 20000 })
    expect(engine.version).toBe(candidate.version)
    return engine.adapter
  }
  async function readRound(adapter: OpenCodeAdapter, sessionID: string, label: string, reply: "once" | "reject" = "once") {
    activeRead = join(projectDir, `${label}.txt`)
    const proof = `ISOLATED_UPGRADE_FILE_${label}`
    await writeFile(activeRead, proof)
    const working = adapter.prompt(sessionID, `UPGRADE_READ_${label}`)
    const outcome = await permissionRound(adapter, sessionID, working, reply)
    expect(outcome.permissions).toBeGreaterThan(0)
    const history = await adapter.messages(sessionID)
    const part = history.flatMap((message) => message.parts).findLast((part) => part.type === "tool" && part.input.filePath === activeRead)
    expect(part?.type).toBe("tool")
    if (part?.type !== "tool") throw new Error("Missing persisted read evidence")
    expect(part.tool).toBe("read")
    expect(part.execution.outcome).toBe(reply === "once" ? "succeeded" : "failed")
    if (reply === "once") {
      expect(outcome.result.status).toBe("completed")
      expect(part.output).toContain(proof)
    } else {
      expect(part.status).toBe("failed")
      expect(part.error).toBeString()
      expect(part.output).toBeUndefined()
    }
    return history
  }
  async function capture(adapter: OpenCodeAdapter, sessions: string[]) {
    const histories: Record<string, NormalizedMessage[]> = {}
    const digests: Record<string, MigrationDigest> = {}
    for (const session of sessions) {
      histories[session] = await adapter.messages(session)
      digests[session] = await adapter.migrationDigest(session)
      expect(digests[session]!.messageCount).toBe(histories[session]!.length)
    }
    return { histories, digests }
  }
  async function check(adapter: OpenCodeAdapter, captured: Awaited<ReturnType<typeof capture>>) {
    for (const [session, messages] of Object.entries(captured.histories)) {
      expect(await adapter.messages(session)).toEqual(messages)
      expect(await adapter.migrationDigest(session)).toEqual(captured.digests[session]!)
    }
  }
  async function continueProductTask(store: SoulStore, adapter: OpenCodeAdapter, taskID: string, label: string, vaultDir: string) {
    const sessionID = store.task(taskID)!.sessionId!
    activeRead = join(projectDir, `${label}.txt`)
    const proof = `ISOLATED_UPGRADE_FILE_${label}`
    await writeFile(activeRead, proof)
    const app = startServer({ store, adapter, token: "synthetic-upgrade-task-token", vaultDir })
    try {
      const response = await fetch(`http://127.0.0.1:${app.server.port}/api/tasks/${taskID}/chat`, {
        method: "POST", headers: { authorization: "Bearer synthetic-upgrade-task-token", "content-type": "application/json" },
        body: JSON.stringify({ key: label, text: `UPGRADE_READ_${label}` }),
      })
      expect(response.status).toBe(202)
      expect(app.jobs.size).toBe(1)
      const outcome = await permissionRound(adapter, sessionID, Promise.all([...app.jobs.values()]), "once")
      expect(outcome.permissions).toBeGreaterThan(0)
      expect(store.task(taskID)?.status).toBe("verifying")
      expect(store.task(taskID)?.sessionId).toBe(sessionID)
      const action = store.actions(taskID).findLast(action => action.tool === "read" && action.text.includes(proof))
      expect(action?.status).toBe("succeeded")
      expect(action?.execution?.outcome).toBe("succeeded")
      // Re-importing old history must preserve its failed process result as well.
      expect(store.actions(taskID).some(action => action.execution?.exitCode === 7 && action.status === "failed")).toBe(true)
    } finally {
      if (app.jobs.size) await adapter.abort(sessionID).catch(() => false)
      await Promise.allSettled([...app.jobs.values()])
      await app.server.stop(true)
    }
  }
  try {
    const oldHost = join(root, "host-old")
    const original = await start(from, oldHost)
    const session = await original.createSession("Upgrade evidence main")
    const rejected = await original.createSession("Upgrade evidence rejected")
    const sessions = [session.id, rejected.id]
    expect((await original.prompt(session.id, "UPGRADE_TEXT_OLD")).text).toBe("UPGRADE_TEXT_REPLY")
    await readRound(original, session.id, "OLD_ACCEPT")
    const nonzero = await permissionRound(original, session.id, original.prompt(session.id, "UPGRADE_SHELL_NONZERO"), "once")
    expect(nonzero.result.error).toBeUndefined()
    const shell = (await original.messages(session.id)).flatMap((message) => message.parts)
      .findLast((part) => part.type === "tool" && (part.tool === "bash" || part.tool === "shell"))
    expect(shell?.type).toBe("tool")
    if (shell?.type !== "tool") throw new Error("Missing old shell evidence")
    expect(shell.execution.outcome).toBe("failed")
    expect(shell.execution.lifecycle).toBe("completed")
    expect(shell.execution.exitCode).toBe(7)
    await readRound(original, rejected.id, "OLD_REJECT", "reject")
    const oldHistory = await capture(original, sessions)
    await engine!.stop()
    const oldCheckpoint = await backupEngine(oldHost, generations.old, from.version)
    expect(oldCheckpoint.files.length).toBeGreaterThan(0)
    const oldCheckpointHash = sha(await readFile(join(generations.old, "engine", "complete.json")))

    // Exercise the product's public migration operation with a real paired
    // domain checkpoint, rather than proving only an engine database copy.
    const vaultDir = join(root, "paired-vault")
    await mkdir(vaultDir)
    const sourceStore = new SoulStore(join(oldHost, "soul.db"))
    const task = sourceStore.createTask("Paired upgrade main", "upgrade-project")
    const rejectedTask = sourceStore.createTask("Paired upgrade rejected", "upgrade-project")
    const aliasTask = sourceStore.createTask("Second binding of main session", "upgrade-project")
    sourceStore.createTask("No engine session yet", "upgrade-project")
    sourceStore.updateTask(task.id, { sessionId: session.id })
    sourceStore.updateTask(rejectedTask.id, { sessionId: rejected.id, status: "failed" })
    sourceStore.updateTask(aliasTask.id, { sessionId: session.id, status: "verifying" })
    const memory = sourceStore.explicitMemory({ key: "paired-memory", text: "保留升级前的可追溯偏好", kind: "preference", scope: "upgrade-project" })
    sourceStore.setMeta("engine_version", from.version)
    sourceStore.setMeta("engine_sha256", from.sha256)
    const originalTasks = sourceStore.tasks()
    const sourceIdentity = sourceStore.identityId
    let sourceCheckpoint: Awaited<ReturnType<typeof createCheckpoint>>
    try {
      sourceCheckpoint = await createCheckpoint(sourceStore.db, vaultDir, sourceIdentity, sourceStore.revision, null, async directory => {
        const saved = await backupEngine(oldHost, directory, from.version)
        const hashes: Record<string, string> = {}
        for (const file of saved.files) hashes[`engine/${file.path}`] = file.sha256
        hashes["engine/complete.json"] = sha(await readFile(join(directory, "engine/complete.json")))
        return hashes
      })
      sourceStore.setMeta("checkpoint_generation", sourceCheckpoint.generation)
      sourceStore.setMeta("checkpoint_revision", String(sourceCheckpoint.revision))
    } finally { sourceStore.close() }
    const sourceGenerationDir = join(vaultDir, "checkpoints", sourceCheckpoint.generation)
    const oldHostFiles = await fingerprint(oldHost, name => name.startsWith(".engine-migration-"))
    const sourceFiles = await fingerprint(sourceGenerationDir)
    const migrationInput = { hostDir: oldHost, vaultDir, generation: sourceCheckpoint.generation, projectDir, from, to }
    // A stopped host may still have committed data solely in its WAL. Build
    // this fixture by copying a quiescent, open writer's committed files, then
    // close the builder. The copied host itself has no active SQLite process.
    const walBuilderHost = join(root, "wal-builder-host")
    const dirtyHost = join(root, "host-with-unsynced-wal")
    const dirtyVault = join(root, "wal-isolated-vault")
    await cp(oldHost, walBuilderHost, { recursive: true, errorOnExist: true, force: false })
    await cp(vaultDir, dirtyVault, { recursive: true, errorOnExist: true, force: false })
    const walBuilder = new SoulStore(join(walBuilderHost, "soul.db"))
    try {
      expect(walBuilder.revision).toBe(sourceCheckpoint.revision)
      walBuilder.db.exec("PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)")
      const mainDatabaseHash = sha(await readFile(join(walBuilderHost, "soul.db")))
      walBuilder.createTask("Committed exclusively in the unsynced WAL", "upgrade-project")
      expect(walBuilder.revision).toBe(sourceCheckpoint.revision + 1)
      expect(sha(await readFile(join(walBuilderHost, "soul.db")))).toBe(mainDatabaseHash)
      expect((await readFile(join(walBuilderHost, "soul.db-wal"))).length).toBeGreaterThan(32)
      await cp(walBuilderHost, dirtyHost, { recursive: true, errorOnExist: true, force: false })
    } finally { walBuilder.close() }
    const dirtyHostFiles = await fingerprint(dirtyHost)
    const dirtyVaultFiles = await fingerprint(dirtyVault)
    await expect(migrateEngineCheckpoint({ ...migrationInput, hostDir: dirtyHost, vaultDir: dirtyVault })).rejects.toThrow("未同步变化")
    expect(await fingerprint(dirtyHost, name => name.startsWith(".engine-migration-"))).toEqual(dirtyHostFiles)
    expect(await fingerprint(dirtyVault)).toEqual(dirtyVaultFiles)
    expect(await listCheckpoints(dirtyVault)).toEqual([sourceCheckpoint])
    const prepublicationBoundaries: EngineMigrationBoundary[] = ["source-restored", "baseline-verified", "candidate-started", "history-verified"]
    const beforeMigrationInference = inferenceCount
    for (const boundary of prepublicationBoundaries) {
      const visited: EngineMigrationBoundary[] = []
      await expect(migrateEngineCheckpoint({ ...migrationInput, afterBoundary(actual) {
        visited.push(actual)
        if (actual === boundary) throw new Error(`INJECTED_${boundary}`)
      } })).rejects.toThrow(`INJECTED_${boundary}`)
      expect(visited.at(-1)).toBe(boundary)
      expect(await listCheckpoints(vaultDir)).toEqual([sourceCheckpoint])
      expect(await fingerprint(oldHost, name => name.startsWith(".engine-migration-"))).toEqual(oldHostFiles)
      expect(await fingerprint(sourceGenerationDir)).toEqual(sourceFiles)
    }
    const migrated = await migrateEngineCheckpoint(migrationInput)
    expect(inferenceCount).toBe(beforeMigrationInference)
    expect(migrated.checkpoint.identityId).toBe(sourceIdentity)
    expect(migrated.checkpoint.parent).toBe(sourceCheckpoint.generation)
    expect(migrated.checkpoint.revision).toBe(sourceCheckpoint.revision + 1)
    expect(migrated.evidence).toMatchObject({
      sourceGeneration: sourceCheckpoint.generation, sourceCheckpointSha256: sourceCheckpoint.sha256,
      identityId: sourceIdentity, sourceEngineVersion: from.version, sourceEngineSha256: from.sha256,
      targetEngineVersion: to.version, targetEngineSha256: to.sha256,
      contract: "legacy-public-session-archive-v1", scope: "all-product-task-session-bindings", outcome: "passed",
      sessions: sessions.toSorted().map(id => oldHistory.digests[id]!),
    })
    const complete = await listCheckpoints(vaultDir)
    expect(complete).toHaveLength(2)
    expect(complete.filter(checkpoint => !complete.some(other => other.parent === checkpoint.generation))).toEqual([migrated.checkpoint])
    const migratedDir = join(vaultDir, "checkpoints", migrated.checkpoint.generation)
    expect(JSON.parse(await readFile(join(migratedDir, "upgrade/engine-migration.json"), "utf8"))).toEqual(migrated.evidence)
    expect((await verifyEngineCheckpoint(migratedDir)).engineVersion).toBe(to.version)
    expect(await fingerprint(oldHost, name => name.startsWith(".engine-migration-"))).toEqual(oldHostFiles)
    expect(await fingerprint(sourceGenerationDir)).toEqual(sourceFiles)

    // main() must adopt the newly migrated portable head even when a clean
    // host still contains the old domain/engine pair. Use independent copies:
    // ordinary startup and shutdown may legitimately update this branch.
    const startupPortable = join(root, "startup-portable")
    const startupHost = join(root, "startup-clean-old-host")
    const startupVault = join(startupPortable, "vault")
    await cp(oldHost, startupHost, { recursive: true, errorOnExist: true, force: false,
      filter: source => !basename(source).startsWith(".engine-migration-") })
    await cp(vaultDir, startupVault, { recursive: true, errorOnExist: true, force: false })
    await writeFile(join(startupHost, "engine-config.json"), config)
    const signals = ["SIGINT", "SIGTERM"] as const
    const listeners = new Map(signals.map(signal => [signal, new Set(process.listeners(signal))]))
    let runtime: Awaited<ReturnType<typeof main>>
    try {
      runtime = await main(["--portable-root", startupPortable, "--host-root", startupHost,
        "--engine", to.executable, "--project", projectDir, "--no-open"])
      if (!runtime) throw new Error("Normal startup did not create the isolated migrated runtime")
      const running = JSON.parse(await readFile(join(startupHost, "running.json"), "utf8")) as { url: string }
      const url = new URL(running.url)
      async function api<T>(path: string): Promise<T> {
        const response = await fetch(`${url.origin}${path}`, { headers: { authorization: `Bearer ${decodeURIComponent(url.hash.slice(7))}` } })
        expect(response.status).toBe(200)
        return await response.json() as T
      }
      const state = await api<{ identityId: string; checkpointGeneration: string; revision: number; tasks: Task[] }>("/api/state")
      expect(state.identityId).toBe(sourceIdentity)
      expect(state.checkpointGeneration).toBe(migrated.checkpoint.generation)
      expect(state.revision).toBe(migrated.checkpoint.revision)
      expect(state.tasks).toEqual(originalTasks)
      expect(await api<{ ok: boolean; version: string }>("/api/engine")).toMatchObject({ ok: true, version: to.version })
      expect(await api<unknown[]>("/api/memories?scope=upgrade-project")).toContainEqual(memory)
      expect(inferenceCount).toBe(beforeMigrationInference)
    } finally {
      try { await runtime?.stop() } finally {
        for (const signal of signals) for (const listener of process.listeners(signal)) {
          if (!listeners.get(signal)!.has(listener)) process.removeListener(signal, listener)
        }
      }
    }
    const startupCheckpoints = await listCheckpoints(startupVault)
    expect(startupCheckpoints).toHaveLength(3)
    const startupHead = startupCheckpoints.find(checkpoint => !startupCheckpoints.some(other => other.parent === checkpoint.generation))!
    expect(startupHead.parent).toBe(migrated.checkpoint.generation)
    expect((await verifyEngineCheckpoint(join(startupVault, "checkpoints", startupHead.generation))).engineVersion).toBe(to.version)
    expect(await fingerprint(oldHost, name => name.startsWith(".engine-migration-"))).toEqual(oldHostFiles)
    expect(await fingerprint(sourceGenerationDir)).toEqual(sourceFiles)
    expect(await listCheckpoints(vaultDir)).toEqual(complete)

    for (const restore of [
      { candidate: to, checkpoint: migrated.checkpoint, label: "PRODUCT_NEW_RESTORE" },
      { candidate: from, checkpoint: sourceCheckpoint, label: "PRODUCT_OLD_ROLLBACK" },
    ]) {
      const host = join(root, restore.label)
      await restoreCheckpoint(vaultDir, restore.checkpoint.generation, join(host, "soul.db"))
      await restoreEngine(host, join(vaultDir, "checkpoints", restore.checkpoint.generation), restore.candidate.version)
      const restoredStore = new SoulStore(join(host, "soul.db"))
      try {
        expect(restoredStore.identityId).toBe(sourceIdentity)
        expect(restoredStore.tasks()).toEqual(originalTasks)
        expect(restoredStore.memory(memory.id)).toEqual(memory)
        expect(restoredStore.meta("engine_version")).toBe(restore.candidate.version)
        expect(restoredStore.meta("engine_sha256")).toBe(restore.candidate.sha256)
        expect(restoredStore.meta("checkpoint_generation")).toBe(restore.checkpoint.generation)
        const adapter = await start(restore.candidate, host)
        await check(adapter, oldHistory)
        expect(JSON.stringify(await adapter.messages(session.id))).not.toContain("PRODUCT_NEW_RESTORE")
        await continueProductTask(restoredStore, adapter, task.id, restore.label, vaultDir)
        await engine!.stop()
      } finally { await engine?.stop(); restoredStore.close() }
    }
    expect(await fingerprint(oldHost, name => name.startsWith(".engine-migration-"))).toEqual(oldHostFiles)
    expect(await fingerprint(sourceGenerationDir)).toEqual(sourceFiles)
    expect(await listCheckpoints(vaultDir)).toEqual(complete)

    const upgradedHost = join(root, "host-upgrade-staging")
    await mkdir(upgradedHost)
    await expect(restoreEngine(upgradedHost, generations.old, to.version)).rejects.toThrow("version mismatch")
    // Restore validates the OLD snapshot using the OLD exact version. The NEW
    // engine itself subsequently owns startup migration of this isolated copy.
    await restoreEngine(upgradedHost, generations.old, from.version)
    const upgraded = await start(to, upgradedHost)
    await check(upgraded, oldHistory)
    await readRound(upgraded, session.id, "NEW_ACCEPT")
    await readRound(upgraded, rejected.id, "NEW_REJECT", "reject")
    const newHistory = await capture(upgraded, sessions)
    expect(newHistory.histories[session.id]!.slice(0, oldHistory.histories[session.id]!.length)).toEqual(oldHistory.histories[session.id]!)
    expect(newHistory.histories[rejected.id]!.slice(0, oldHistory.histories[rejected.id]!.length)).toEqual(oldHistory.histories[rejected.id]!)
    await engine!.stop()
    const newCheckpoint = await backupEngine(upgradedHost, generations.upgraded, to.version)
    expect(newCheckpoint.engineVersion).toBe(to.version)
    expect(newCheckpoint.files.length).toBeGreaterThan(0)

    const newRestoreHost = join(root, "host-new-restored")
    await mkdir(newRestoreHost)
    await expect(restoreEngine(newRestoreHost, generations.upgraded, from.version)).rejects.toThrow("version mismatch")
    await restoreEngine(newRestoreHost, generations.upgraded, to.version)
    const newRestored = await start(to, newRestoreHost)
    await check(newRestored, newHistory)
    await readRound(newRestored, session.id, "NEW_RESTORE_ACCEPT")
    await engine!.stop()

    expect(sha(await readFile(join(generations.old, "engine", "complete.json")))).toBe(oldCheckpointHash)
    expect(await verifyEngineCheckpoint(generations.old)).toEqual(oldCheckpoint)
    const rollbackHost = join(root, "host-rollback-old")
    await mkdir(rollbackHost)
    await restoreEngine(rollbackHost, generations.old, from.version)
    const rolledBack = await start(from, rollbackHost)
    await check(rolledBack, oldHistory)
    expect(JSON.stringify(await rolledBack.messages(session.id))).not.toContain("NEW_ACCEPT")
    await readRound(rolledBack, session.id, "OLD_ROLLBACK_ACCEPT")
    await engine!.stop()
    expect(unexpectedRoutes).toBe(0)
    expect(inferenceCount).toBeGreaterThan(10)
    expect(sha(await readFile(from.executable))).toBe(from.sha256)
    expect(sha(await readFile(to.executable))).toBe(to.sha256)
    console.info(JSON.stringify({ evidence: "real engine upgrade and independent rollback", from: { version: from.version, sha256: from.sha256 },
      to: { version: to.version, sha256: to.sha256 }, sessions: sessions.length,
      oldMessageCounts: Object.values(oldHistory.histories).map((messages) => messages.length),
      upgradedMessageCounts: Object.values(newHistory.histories).map((messages) => messages.length),
      oldPublicDigests: Object.values(oldHistory.digests), upgradedPublicDigests: Object.values(newHistory.digests),
      oldSnapshot: oldCheckpoint.files, newSnapshot: newCheckpoint.files,
      productMigration: { sourceGeneration: sourceCheckpoint.generation, targetGeneration: migrated.checkpoint.generation,
        identityPreserved: true, originalTaskCount: originalTasks.length, uniqueSessionCount: migrated.evidence.sessions.length,
        prepublicationFailuresVerified: prepublicationBoundaries, originalHostAndCheckpointBytePreserved: true,
        committedUnsyncedWalRejectedAndPreserved: true, normalStartupAdoptsMigratedHead: true,
        newAndOldProductTasksContinued: true, evidence: migrated.evidence },
      checks: ["exact public history before continuation", "old read success and exit 7 remain attributed", "fresh read permission once and reject after upgrade",
        "new snapshot restored with new engine", "original old snapshot unchanged", "old rollback history excludes new writes", "old engine continues independently"],
      limitation: "Only this binary pair, legacy HTTP, stable project path, local deterministic model; no generic future-version migration guarantee" }))
  } finally {
    await engine?.stop()
    await provider.stop(true)
    if (resolve(dirname(root)) !== resolve(await realpath(tmpdir()))) throw new Error("Unexpected upgrade fixture path")
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 180000)

async function permissionRound<T>(adapter: OpenCodeAdapter, sessionID: string, working: Promise<T>, reply: "once" | "reject") {
  let finished = false
  let permissions = 0
  void working.then(() => { finished = true }, () => { finished = true })
  const seen = new Set<string>()
  const deadline = Date.now() + 22000
  try {
    while (!finished && Date.now() < deadline) {
      for (const permission of await adapter.permissions()) {
        if (permission.sessionID !== sessionID || seen.has(permission.id)) continue
        seen.add(permission.id)
        expect(await adapter.replyPermission(permission.id, reply)).toBe(true)
        permissions++
      }
      if (!finished) await Bun.sleep(40)
    }
    if (!finished) throw new Error("Upgrade fixture prompt did not finish within deadline")
    return { result: await working, permissions }
  } catch (error) {
    await adapter.abort(sessionID).catch(() => false)
    await working.catch(() => undefined)
    throw error
  }
}

async function fingerprint(directory: string, exclude: (name: string) => boolean = () => false): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  async function visit(path: string, prefix: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!prefix && exclude(entry.name)) continue
      const name = prefix + entry.name
      if (entry.isDirectory()) await visit(join(path, entry.name), name + "/")
      else if (entry.isFile()) files[name] = sha(await readFile(join(path, entry.name)))
      else throw new Error("Unexpected non-file in isolated upgrade fixture")
    }
  }
  await visit(directory, "")
  return files
}

function completion(request: Record<string, unknown>, result: { text?: string; tool?: { name: string; arguments: string } }) {
  const common = { id: `chatcmpl_${crypto.randomUUID()}`, created: Math.floor(Date.now() / 1000), model: "test-model" }
  const calls = result.tool ? [{ index: 0, id: `call_${crypto.randomUUID()}`, type: "function", function: result.tool }] : undefined
  const finish = calls ? "tool_calls" : "stop"
  if (request.stream !== true) return Response.json({ ...common, object: "chat.completion", choices: [{ index: 0,
    message: { role: "assistant", content: result.text ?? null, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
  const chunks = [
    { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", ...(calls ? { tool_calls: calls } : { content: result.text ?? "" }) }, finish_reason: null }] },
    { ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
  ]
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
}
