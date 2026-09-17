// Standalone after-fixes audit. The original baseline report is read-only.
// It never opens a user database or runs model calls.
import assert from "node:assert/strict"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { join, relative, isAbsolute } from "node:path"
import { tmpdir } from "node:os"
import { ProjectionCoverageError, SoulStore } from "../src/store"
import { OpenCodeAdapter } from "../src/adapter"
import { startServer } from "../src/server"
import { LearningStore } from "../src/learning"
import { memoryActivation } from "../src/affect"
import { PRODUCT_VERSION } from "../src/contracts"

const tempRoot = realpathSync(tmpdir())
const fixtureDir = mkdtempSync(join(tempRoot, "xingyao-soul-audit-"))
const fixedNow = 1_000_000_000
const baselineFile = Bun.file(new URL("../reports/architecture-audit-2026-09-17.json", import.meta.url))
const baselineBytes = await baselineFile.exists() ? await baselineFile.arrayBuffer() : null
const baselineHash = baselineBytes ? new Bun.CryptoHasher("sha256").update(baselineBytes).digest("hex") : null
const checks: string[] = []
function verify(description: string, check: () => void) { check(); checks.push(description) }
const store = new SoulStore(join(fixtureDir, "fixture.db"), () => fixedNow)
const revisionStore = new SoulStore(join(fixtureDir, "revisions.db"), () => fixedNow)
let memoryNow = 0
const ageStore = new SoulStore(join(fixtureDir, "age.db"), () => memoryNow)
let migrationStore = new SoulStore(join(fixtureDir, "migration.db"), () => memoryNow)
let delivered = false
const sessionID = "synthetic-audit-session"
const messageID = "synthetic-audit-message"
const cases = [
  { name: "nonzero-exit-one", exit: 1, output: "synthetic failing command" },
  { name: "timeout", exit: null, output: "<shell_metadata>shell tool terminated command after exceeding timeout 100 ms.</shell_metadata>" },
  { name: "nonzero-exit-two", exit: 2, output: "synthetic failing test" },
]
const rawMessage = {
  info: { id: messageID, sessionID, role: "assistant", time: { created: fixedNow, completed: fixedNow + 1 }, finish: "stop" },
  parts: cases.map((item, index) => ({
    id: `synthetic-part-${index}`, sessionID, messageID, type: "tool", tool: "shell", callID: item.name,
    state: { status: "completed", input: { command: `synthetic-${item.name}` }, output: item.output,
      title: item.name, metadata: { exit: item.exit, truncated: false }, time: { start: fixedNow, end: fixedNow + 1 } },
  })),
}
const fixtureEngine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  if (request.method === "POST") { delivered = true; return Response.json(rawMessage) }
  return Response.json(delivered ? [rawMessage] : [])
} })
class FixtureAdapter extends OpenCodeAdapter {
  override async health() { return { ok: true, version: "synthetic-fixture", capabilities: { legacyHTTP: true, promptSystem: true, durableMessages: true, toolResults: true, permissions: true, v2Detected: false, v2Supported: false as const } } }
  override async createSession() { return { id: sessionID } }
}
const adapter = new FixtureAdapter({ baseURL: `http://127.0.0.1:${fixtureEngine.port}` })
const app = startServer({ store, adapter, token: "synthetic-audit-token", vaultDir: join(fixtureDir, "unused-vault") })
async function request(path: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${app.server.port}${path}`, {
    method: "POST", headers: { authorization: "Bearer synthetic-audit-token", "content-type": "application/json" }, body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Fixture HTTP ${response.status}: ${await response.text()}`)
  return response.json()
}
try {
  const task = store.createTask("Synthetic outcome audit", "audit")
  await request(`/api/tasks/${task.id}/chat`, { key: "audit-prompt", text: "synthetic fixture" })
  await Promise.allSettled([...app.jobs.values()])
  const normalized = (await adapter.messages(sessionID))[0]!.parts
  const actions = store.actions(task.id)
  const toolEvents = store.experiencesAfter(0).filter(event => event.kind.startsWith("tool_"))
  const emotionValenceAfterThree = store.affect().emotion[0]
  const sleep = store.sleep()
  const learning = new LearningStore(store.db)
  const candidate = learning.propose({ title: "Synthetic arbitrary procedure", scope: "audit", when: "synthetic", steps: ["An unrelated procedure not present in the source commands"], avoid: [], sourceIds: toolEvents.map(event => event.id) })
  let promotionError = ""
  try { learning.promote(candidate.id, candidate.revision) } catch (error) { promotionError = error instanceof Error ? error.message : String(error) }
  const evaluated = learning.read(candidate.id)!
  verify("Nonzero shell exits are failed; absent exit code remains unknown and none is succeeded", () => {
    assert.deepEqual(actions.map(action => action.status), ["failed", "unknown", "failed"])
    assert.deepEqual(toolEvents.map(event => event.kind), ["tool_failure", "tool_unknown", "tool_failure"])
    assert(actions.every(action => !action.text.includes("执行成功")))
  })
  verify("Whitelisted execution evidence preserves exit=1/null/2 without positive emotion or successful skill samples", () => {
    assert.deepEqual(normalized.filter(part => part.type === "tool").map(part => part.execution.exitCode), [1, null, 2])
    assert(emotionValenceAfterThree! < 0)
    assert.equal(evaluated.evaluation.successes, 0)
    assert.equal(evaluated.evaluation.failures, 2)
    assert.equal(evaluated.evaluation.unknownSources, 1)
    assert.equal(evaluated.status, "draft")
    assert(promotionError.length > 0)
    assert.equal(sleep.created, 2)
  })
  for (let index = 0; index < 10; index++) store.recordAction({ id: `synthetic-later-failure-${index}`, taskId: task.id, tool: "shell", status: "failed", text: "synthetic later failed attempt", revision: "1" })
  const afterLaterFailures = learning.read(candidate.id)!

  const omittedPinned = await request("/api/memories", { key: "commitment-no-pinned", kind: "commitment", text: "Synthetic unique commitment", scope: "audit" })
  const beforeOversized = store.projection("audit", "unrelated-query-without-overlap")
  verify("Omitted pinned defaults to true for a commitment and is included for an unrelated query", () => {
    assert.equal(omittedPinned.pinned, true)
    assert(beforeOversized.includes(omittedPinned.id))
  })
  const oversized = store.explicitMemory({ key: "oversized", kind: "commitment", text: "OVERSIZED-COMMITMENT-MARKER " + "x".repeat(7000), scope: "audit", pinned: true })
  let projectionError: ProjectionCoverageError | undefined
  try { store.projection("audit", "unrelated-query-without-overlap") }
  catch (error) { if (!(error instanceof ProjectionCoverageError)) throw error; projectionError = error }
  verify("Oversized pinned commitment raises an explicit coverage error rather than disappearing", () => {
    assert(projectionError instanceof ProjectionCoverageError)
    assert(projectionError.memoryIds.includes(oversized.id))
    assert(projectionError.requiredCharacters > projectionError.limit)
  })

  const revisionTask = revisionStore.createTask("Synthetic one-call revision audit", "audit")
  const valences: number[] = []
  for (let index = 1; index <= 3; index++) {
    revisionStore.recordAction({ id: "same-synthetic-call", taskId: revisionTask.id, tool: "read", status: "succeeded", text: `synthetic result revision ${index}`, revision: String(index) })
    valences.push(revisionStore.affect().emotion[0])
  }
  const revisionSleep = revisionStore.sleep()
  verify("Three revisions of one call keep one active source, one active memory and one emotional contribution", () => {
    assert.equal(revisionStore.actions(revisionTask.id).length, 1)
    assert.equal(revisionStore.experiencesAfter(0).filter(source => !source.retracted).length, 1)
    assert.equal(revisionStore.memories().length, 1)
    assert.equal(revisionSleep.created, 1)
    assert(valences.every(value => Math.abs(value! - 0.175) < 1e-12))
    assert.equal(revisionStore.memories()[0]!.text, "synthetic result revision 3")
  })

  const source = ageStore.appendExperience({ sourceKey: "old-synthetic-source", scope: "audit", kind: "tool_success", ownership: "experienced", text: "old synthetic source", observedAt: 0 })
  memoryNow = 90 * 24 * 60 * 60 * 1000
  ageStore.sleep()
  const lateMemory = ageStore.memories()[0]!
  verify("Archiving a ninety-day-old source retains its actual age", () => {
    assert.equal(lateMemory.sourceObservedAt, source.observedAt)
    assert.equal(lateMemory.createdAt, memoryNow)
    assert(Math.abs(memoryActivation(lateMemory, "", memoryNow) - 2 ** (-90 / 14)) < 1e-12)
  })

  // Emulate an old memory JSON shape without changing any real database. The
  // absent revision marker activates the transactional backfill on reopen.
  const migrationSource = migrationStore.appendExperience({ sourceKey: "legacy-age", scope: "audit", kind: "observation", ownership: "told", text: "synthetic legacy memory", observedAt: 0 })
  const migratedMemory = migrationStore.remember({ text: migrationSource.text, scope: "audit", kind: "fact", sourceIds: [migrationSource.id] })
  const { sourceObservedAt: _, ...legacyMemory } = migratedMemory
  migrationStore.db.query("UPDATE memories SET body=? WHERE id=?").run(JSON.stringify(legacyMemory), migratedMemory.id)
  migrationStore.db.query("DELETE FROM meta WHERE key='source_revision_version'").run()
  migrationStore.close()
  migrationStore = new SoulStore(join(fixtureDir, "migration.db"), () => memoryNow)
  const restoredMemory = migrationStore.memory(migratedMemory.id)!
  const migrationRevision = migrationStore.revision
  migrationStore.close()
  migrationStore = new SoulStore(join(fixtureDir, "migration.db"), () => memoryNow)
  verify("Missing source-revision marker backfills legacy memory age once and preserves it on another reopen", () => {
    assert.equal(restoredMemory.sourceObservedAt, 0)
    assert.equal(restoredMemory.createdAt, memoryNow)
    assert.equal(migrationStore.meta("source_revision_version"), "1")
    assert.equal(migrationStore.revision, migrationRevision)
    assert.equal(migrationStore.memory(migratedMemory.id)!.sourceObservedAt, 0)
  })
  verify("Historical audit baseline remains byte-for-byte unchanged", () => {
    // The script's only report writer below uses a distinct after-fixes path.
    assert(!baselineFile.name?.endsWith("architecture-audit-after-fixes-2026-09-17.json"))
  })
  if (baselineHash) assert.equal(new Bun.CryptoHasher("sha256").update(await baselineFile.arrayBuffer()).digest("hex"), baselineHash)
  const report = {
    mode: "after-fixes-regression",
    baseline: { path: "reports/architecture-audit-2026-09-17.json", available: baselineBytes !== null, sha256: baselineHash, policy: "Historical pre-fix results are not rewritten. This run repeats their semantic scenarios against current source; it does not claim a new release or full-suite acceptance." },
    productVersion: PRODUCT_VERSION,
    method: "Synthetic persisted-tool payloads through the real HTTP adapter and product server; temporary SQLite identities only. No live engine, model, credentials, or user data were accessed. Fixture health and session creation are stubbed; message normalization, action recording, affect, sleep, learning and memory APIs use product code.",
    outcomeContamination: {
      supplied: cases.map(item => ({ name: item.name, upstreamStatus: "completed", metadataExit: item.exit })),
      normalized: normalized.map(part => ({ type: part.type, ...(part.type === "tool" ? { callID: part.callID, lifecycleStatus: part.status, execution: part.execution, arbitraryMetadataCopied: "metadata" in part } : {}) })),
      storedActions: actions.map(action => ({ status: action.status, text: action.text, execution: action.execution })),
      experienceKinds: toolEvents.map(event => event.kind),
      emotionValenceAfterThree,
      sleepCreated: sleep.created,
      archivedKinds: store.memories().filter(memory => memory.kind === "episode").map(memory => memory.kind),
      skillPromotion: { promoted: false, error: promotionError, status: evaluated.status, successes: evaluated.evaluation.successes, failures: evaluated.evaluation.failures, unknownSources: evaluated.evaluation.unknownSources, selectedCallStatistic: evaluated.evaluation.probability, statisticMeaning: "Beta statistic over the selected decidable calls; not verified skill efficacy. No manual override was supplied." },
      skillAfterTenNewFailedCalls: { status: afterLaterFailures.status, successes: afterLaterFailures.evaluation.successes, failures: afterLaterFailures.evaluation.failures, unknownSources: afterLaterFailures.evaluation.unknownSources, selectedCallStatistic: afterLaterFailures.evaluation.probability, limitation: "New calls outside the selected source IDs remain unlinked to the skill; automatic skill-use attribution is still absent." },
    },
    commitment: { omittedPinnedApiValue: omittedPinned.pinned, omittedPinnedIncludedForUnrelatedQuery: beforeOversized.includes(omittedPinned.id), oversizedLength: oversized.text.length, oversizedPinned: oversized.pinned, oversizedProjectionReturned: false, coverageError: { code: projectionError!.code, requiredCharacters: projectionError!.requiredCharacters, limit: projectionError!.limit, fixedMemoryCount: projectionError!.memoryIds.length } },
    sameCallRevisions: { callCount: revisionStore.actions(revisionTask.id).length, historicalSourceCount: revisionStore.experiencesAfter(0).length, activeSourceCount: revisionStore.experiencesAfter(0).filter(source => !source.retracted).length, activeMemoryCount: revisionStore.memories().length, valences, sleepCreated: revisionSleep.created },
    lateArchivalAge: { sourceObservedAt: source.observedAt, memorySourceObservedAt: lateMemory.sourceObservedAt, memoryCreatedAt: lateMemory.createdAt, elapsedDays: 90, activationWithEmptyQuery: memoryActivation(lateMemory, "", memoryNow), activationIfUsingSourceAge: 2 ** (-90 / 14), exactMatchAfterAnother90Days: memoryActivation(lateMemory, "old synthetic source", memoryNow + 90 * 24 * 60 * 60 * 1000), limitation: "Recency decay still affects ranking only; semantic compression and automatic deletion were not added by these fixes." },
    legacyMemoryAge: { marker: migrationStore.meta("source_revision_version"), memoryCreatedAt: restoredMemory.createdAt, sourceObservedAt: restoredMemory.sourceObservedAt, repeatedOpenChangedRevision: migrationStore.revision !== migrationRevision },
    assertions: { passed: checks.length, checks },
    references: {
      normalizer: "src/adapter.ts#executionEvidence", recorder: "src/server.ts#recordParts", actionSources: "src/store.ts#recordAction", sleep: "src/store.ts#sleep", memoryBudget: "src/store.ts#projection", memoryUpgrade: "src/store.ts#upgradeSourceEvidence", commitmentApi: "src/server.ts POST /api/memories", learningEvidenceSelection: "src/learning.ts#assessment", memoryAge: "src/affect.ts#memoryActivation",
      upstreamShell: "C:/Users/LT/Documents/trae/packages/opencode/src/tool/shell.ts:542-594", upstreamToolCompletion: "C:/Users/LT/Documents/trae/packages/opencode/src/session/processor.ts:174-179",
    },
  }
  await Bun.write(new URL("../reports/architecture-audit-after-fixes-2026-09-17.json", import.meta.url), JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify(report, null, 2))
} finally {
  await app.server.stop(true)
  await fixtureEngine.stop(true)
  await Promise.allSettled([...app.jobs.values()])
  store.close(); revisionStore.close(); ageStore.close(); migrationStore.close()
  const resolved = realpathSync(fixtureDir)
  const within = relative(tempRoot, resolved)
  if (!within.startsWith("..") && !isAbsolute(within) && within.startsWith("xingyao-soul-audit-")) rmSync(resolved, { recursive: true, force: true })
}
