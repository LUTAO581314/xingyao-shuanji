import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import { tmpdir } from "node:os"
import { ProjectionCoverageError, SoulStore } from "../src/store"
import { LearningStore } from "../src/learning"
import { memoryActivation } from "../src/affect"
import type { Action, Experience, Memory } from "../src/contracts"

const DAY = 86_400_000
const TEMP = realpathSync(tmpdir())
const fixtures: { dir: string; store: SoulStore }[] = []
function fixture() {
  const dir = mkdtempSync(join(TEMP, "xingyao-source-revision-"))
  let now = 1_000_000
  const resource = { dir, store: new SoulStore(join(dir, "soul.db"), () => now) }
  fixtures.push(resource)
  return {
    get store() { return resource.store },
    now: (value: number) => { now = value },
    reopen: () => { resource.store.close(); resource.store = new SoulStore(join(dir, "soul.db"), () => now); return resource.store },
  }
}
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.store.close()
    const resolved = realpathSync(fixture.dir)
    const child = relative(TEMP, resolved)
    if (child.startsWith("xingyao-source-revision-") && !isAbsolute(child) && !child.startsWith("..")) rmSync(resolved, { recursive: true, force: true })
  }
})
function action(store: SoulStore, taskId: string, id: string, revision: string, status: Action["status"] = "succeeded") {
  store.recordAction({ id, taskId, tool: "synthetic-test", status, text: `synthetic ${id} ${revision}`, revision })
  return store.experiencesAfter(0, 500).at(-1)!
}
function legacy(store: SoulStore) {
  store.db.query("DELETE FROM meta WHERE key IN ('source_revision_version','action_evidence_version','action_evidence_validation_version','root_learning_policy_version')").run()
  store.db.exec("DROP TABLE action_revisions")
  for (const row of store.db.query<{ id: string; body: string }, []>("SELECT id,body FROM memories").all()) {
    const memory = JSON.parse(row.body) as Memory
    delete memory.sourceObservedAt
    store.db.query("UPDATE memories SET body=? WHERE id=?").run(JSON.stringify(memory), row.id)
  }
}

test("the domain derives recorded status from valid execution evidence", () => {
  const f = fixture()
  const task = f.store.createTask("synthetic", "a")
  f.store.recordAction({ id: "status-mismatch", taskId: task.id, tool: "shell", status: "succeeded", text: "synthetic nonzero exit", revision: "one",
    execution: { version: 1, lifecycle: "completed", outcome: "failed", exitCode: 1, basis: "structured exit", finishedAt: 1_000_000 } })
  expect(f.store.actions(task.id)[0]!.status).toBe("failed")
  expect(f.store.experiencesAfter(0)[0]!.kind).toBe("tool_failure")
  expect(f.store.experiencesAfter(0)[0]!.evidence?.status).toBe("failed")
  expect(f.store.affect().emotion[0]!).toBeLessThan(0)
  expect(f.store.sleep().created).toBe(1)
  const learning = new LearningStore(f.store.db)
  expect(learning.observations("a")[0]!.outcome).toBe("failure")
})

test("invalid structured evidence is rejected atomically instead of strengthening an existing result", () => {
  const f = fixture()
  const task = f.store.createTask("synthetic", "a")
  action(f.store, task.id, "existing", "old", "failed")
  const revision = f.store.revision
  const affect = f.store.affect()
  const valid = { version: 1, lifecycle: "completed", outcome: "succeeded", basis: "structured exit", exitCode: 0 }
  const invalid = [null, {}, { ...valid, version: 2 }, { ...valid, lifecycle: "running" }, { ...valid, outcome: "great" },
    { ...valid, exitCode: 1 }, { ...valid, exitCode: "0" }, { ...valid, exitCode: NaN }, { ...valid, exitCode: 0.5 },
    { ...valid, lifecycle: "unknown" }, { ...valid, startedAt: -1 }, { ...valid, finishedAt: Infinity },
    { ...valid, startedAt: 20, finishedAt: 10 }, { ...valid, basis: "" }, { ...valid, basis: "x".repeat(201) }]
  for (const [index, execution] of invalid.entries()) {
    expect(() => f.store.recordAction({ id: "existing", taskId: task.id, tool: "shell", status: "succeeded", text: "success prose", revision: `invalid-${index}`, execution: execution as Action["execution"] })).toThrow()
  }
  expect(() => f.store.recordAction({ id: "custom", taskId: task.id, tool: "unreviewed-custom-tool", status: "succeeded", text: "success prose", revision: "one", execution: valid as Action["execution"] })).toThrow("契约未知")
  expect(f.store.revision).toBe(revision)
  expect(f.store.affect()).toEqual(affect)
  expect(f.store.experiencesAfter(0)).toHaveLength(1)
  expect(f.store.actions(task.id)[0]!.status).toBe("failed")
})

test("structured evidence stores only the domain fields", () => {
  const f = fixture()
  const task = f.store.createTask("synthetic", "a")
  const execution = { version: 1 as const, lifecycle: "completed" as const, outcome: "succeeded" as const, basis: "structured exit", exitCode: 0, extra: "SYNTHETIC-EXTRA-METADATA" }
  f.store.recordAction({ id: "one", taskId: task.id, tool: "shell", status: "failed", text: "synthetic", revision: "one", execution })
  expect(f.store.actions(task.id)[0]!.status).toBe("succeeded")
  expect(JSON.stringify(f.store.actions(task.id))).not.toContain("SYNTHETIC-EXTRA-METADATA")
  expect(JSON.stringify(f.store.experiencesAfter(0))).not.toContain("SYNTHETIC-EXTRA-METADATA")
})

test("validation upgrade quarantines contradictory persisted results and admits one valid reconciliation", () => {
  const f = fixture()
  const task = f.store.createTask("synthetic", "a")
  const ids = ["a", "b", "c"].map(id => action(f.store, task.id, id, "old").id)
  f.store.sleep()
  const oldMemory = f.store.memories().find(memory => memory.sourceIds.includes(ids[0]!))!
  const learning = new LearningStore(f.store.db)
  const skill = learning.propose({ title: "synthetic", scope: "a", when: "synthetic", steps: ["synthetic procedure"], avoid: [], sourceIds: ids })
  learning.promote(skill.id, skill.revision)
  const old = { ...f.store.actions(task.id).find(item => item.id === "a")!, tool: "shell" }
  const execution = { version: 1 as const, lifecycle: "completed" as const, outcome: "failed" as const, basis: "structured exit", exitCode: 1, finishedAt: 1_000_000 }
  f.store.db.query("UPDATE actions SET body=? WHERE id=?").run(JSON.stringify({ ...old, execution }), old.id)
  f.store.db.query("DELETE FROM meta WHERE key='action_evidence_validation_version'").run()
  f.reopen()
  expect(f.store.actions(task.id).find(item => item.id === "a")!.status).toBe("unknown")
  expect(f.store.actions(task.id).find(item => item.id === "a")!.execution).toBeUndefined()
  expect(f.store.experience(ids[0]!)?.retracted).toBe(true)
  expect(f.store.memory(oldMemory.id)?.status).toBe("invalidated")
  expect(new LearningStore(f.store.db).read(skill.id)?.status).toBe("needs_review")
  expect(f.store.affect().emotion[0]).toBeCloseTo(0.30625)
  const once = f.store.revision
  f.reopen()
  expect(f.store.revision).toBe(once)
  f.store.recordAction({ ...old, execution })
  expect(f.store.actions(task.id).find(item => item.id === "a")!.status).toBe("failed")
  expect(f.store.experiencesAfter(0).filter(source => !source.retracted && source.evidence?.actionId === "a").map(source => source.kind)).toEqual(["tool_failure"])
  expect(f.store.sleep().created).toBe(1)
  const currentRevision = f.store.revision
  f.store.recordAction({ ...old, execution })
  expect(f.store.revision).toBe(currentRevision)
  expect(new LearningStore(f.store.db).read(skill.id)?.status).toBe("needs_review")
})

test("validation upgrade distrusts version-one evidence with an invalid internal shape", () => {
  const f = fixture()
  const task = f.store.createTask("synthetic", "a")
  const source = action(f.store, task.id, "bad-shape", "old")
  const old = f.store.actions(task.id)[0]!
  f.store.db.query("UPDATE actions SET body=? WHERE id=?").run(JSON.stringify({ ...old, execution: { version: 1, outcome: "succeeded" } }), old.id)
  f.store.db.query("DELETE FROM meta WHERE key='action_evidence_validation_version'").run()
  f.reopen()
  expect(f.store.actions(task.id)[0]!.status).toBe("unknown")
  expect(f.store.experience(source.id)?.retracted).toBe(true)
  expect(f.store.affect().emotion).toEqual([0, 0, 0])
  expect(f.store.sleep().created).toBe(0)
})

test("a root received while sealed remains excluded after unsealing and output revisions", () => {
  const f = fixture()
  const task = f.store.createTask("synthetic", "a")
  f.store.setSealed(true)
  const first = action(f.store, task.id, "sealed-root", "one")
  f.store.setSealed(false)
  f.now(first.observedAt + 1000)
  const second = action(f.store, task.id, "sealed-root", "two")
  f.reopen()
  expect(f.store.experience(second.id)?.observedAt).toBe(first.observedAt)
  expect(f.store.affect().emotion).toEqual([0, 0, 0])
  expect(f.store.sleep().created).toBe(0)
  expect(new LearningStore(f.store.db).observations("a")).toEqual([])
})

test("an enabled root revised during seal can never regain retrospective learning", () => {
  const f = fixture()
  const task = f.store.createTask("synthetic", "a")
  action(f.store, task.id, "root", "one")
  f.store.sleep()
  f.store.setSealed(true)
  action(f.store, task.id, "root", "two", "failed")
  f.store.setSealed(false)
  action(f.store, task.id, "root", "three", "failed")
  expect(f.store.affect().emotion).toEqual([0, 0, 0])
  expect(f.store.sleep().created).toBe(0)
  expect(f.store.memories()).toHaveLength(0)
  expect(new LearningStore(f.store.db).observations("a")).toEqual([])
  action(f.store, task.id, "new-call", "one")
  expect(f.store.sleep().created).toBe(1)
})

test("a nonterminal root first observed under seal does not learn from its later completion", () => {
  const f = fixture()
  const task = f.store.createTask("synthetic", "a")
  f.store.setSealed(true)
  action(f.store, task.id, "root", "pending", "unknown")
  f.store.setSealed(false)
  action(f.store, task.id, "root", "terminal")
  expect(f.store.sleep().created).toBe(0)
  expect(f.store.affect().emotion).toEqual([0, 0, 0])
})

test("root-policy upgrade withdraws an already revived post-seal source exactly once", () => {
  const f = fixture()
  const task = f.store.createTask("synthetic", "a")
  f.store.setSealed(true)
  action(f.store, task.id, "root", "one")
  f.store.setSealed(false)
  const revived = action(f.store, task.id, "root", "two")
  // Prior implementation enabled each new snapshot from current seal state.
  f.store.db.query("UPDATE experience_policy SET affect_enabled=1,learning_enabled=1 WHERE experience_id=?").run(revived.id)
  expect(f.store.sleep().created).toBe(1)
  const memory = f.store.memories()[0]!
  f.store.db.query("DELETE FROM meta WHERE key='root_learning_policy_version'").run()
  f.reopen()
  expect(f.store.experience(revived.id)?.retracted).toBe(true)
  expect(f.store.memory(memory.id)?.status).toBe("invalidated")
  expect(f.store.affect().emotion).toEqual([0, 0, 0])
  const once = f.store.revision
  f.reopen()
  expect(f.store.revision).toBe(once)
  action(f.store, task.id, "root", "three")
  expect(f.store.sleep().created).toBe(0)
  expect(new LearningStore(f.store.db).observations("a")).toEqual([])
})

test("same-call revisions replace affect and sleeping memory without reviving old emotion", () => {
  const f = fixture()
  const task = f.store.createTask("synthetic", "a")
  const first = action(f.store, task.id, "one-call", "v1")
  f.store.sleep()
  const oldMemory = f.store.memories()[0]!
  f.now(1_000_000 + DAY)
  const decayed = f.store.affect()
  const second = action(f.store, task.id, "one-call", "v2")
  expect(second.observedAt).toBe(first.observedAt)
  expect(f.store.affect().emotion).toEqual(decayed.emotion)
  expect(f.store.affect().mood).toEqual(decayed.mood)
  expect(f.store.experience(first.id)?.retracted).toBe(true)
  expect(f.store.memory(oldMemory.id)?.status).toBe("invalidated")
  expect(f.store.memory(oldMemory.id)?.text).toBe(oldMemory.text)
  expect(f.store.sleep().created).toBe(1)
  expect(f.store.memories()).toHaveLength(1)
  expect(f.store.memories()[0]!.sourceIds).toEqual([second.id])
  expect(f.store.memories()[0]!.sourceObservedAt).toBe(first.observedAt)
})

test("current and previously seen revisions are idempotent after restart", () => {
  const f = fixture()
  const task = f.store.createTask("synthetic", "a")
  action(f.store, task.id, "one-call", "v1")
  action(f.store, task.id, "one-call", "v2", "failed")
  f.reopen()
  const revision = f.store.revision
  const state = f.store.affect()
  for (let index = 0; index < 10; index++) {
    action(f.store, task.id, "one-call", "v2", "failed")
    action(f.store, task.id, "one-call", "v1")
  }
  expect(f.store.revision).toBe(revision)
  expect(f.store.affect()).toEqual(state)
  expect(f.store.actions(task.id)[0]!.revision).toBe("v2")
  expect(f.store.experiencesAfter(0)).toHaveLength(2)
  expect(f.store.sleep().created).toBe(1)
  expect(f.store.memories()[0]!.text).toContain("v2")
})

test("a first-seen stale running snapshot cannot revoke a terminal result", () => {
  const f = fixture()
  const task = f.store.createTask("synthetic", "a")
  const terminal = { version: 1 as const, lifecycle: "completed" as const, outcome: "succeeded" as const, basis: "exit", exitCode: 0, finishedAt: 1_000_100 }
  f.store.recordAction({ id: "terminal-first", taskId: task.id, tool: "shell", status: "succeeded", text: "terminal result", revision: "v2", execution: terminal })
  const source = f.store.experiencesAfter(0)[0]!
  const affect = f.store.affect()
  f.store.recordAction({ id: "terminal-first", taskId: task.id, tool: "shell", status: "running", text: "late old snapshot", revision: "v1" })
  f.store.recordAction({ id: "terminal-first", taskId: task.id, tool: "shell", status: "unknown", text: "unknown lifecycle", revision: "unknown-lifecycle", execution: { version: 1, lifecycle: "unknown", outcome: "unknown", basis: "incomplete" } })
  f.store.recordAction({ id: "terminal-first", taskId: task.id, tool: "shell", status: "unknown", text: "untimed terminal", revision: "untimed", execution: { version: 1, lifecycle: "completed", outcome: "unknown", basis: "missing result" } })
  f.store.recordAction({ id: "terminal-first", taskId: task.id, tool: "shell", status: "failed", text: "older finished snapshot", revision: "older-terminal", execution: { ...terminal, outcome: "failed", finishedAt: 1_000_099, exitCode: 1 } })
  expect(f.store.actions(task.id)[0]!.revision).toBe("v2")
  expect(f.store.experience(source.id)?.retracted).toBe(false)
  expect(f.store.affect()).toEqual(affect)
  f.store.recordAction({ id: "terminal-first", taskId: task.id, tool: "shell", status: "unknown", text: "new verified incomplete outcome", revision: "v3", execution: { ...terminal, outcome: "unknown", finishedAt: 1_000_101, exitCode: null } })
  expect(f.store.actions(task.id)[0]!.revision).toBe("v3")
  expect(f.store.experience(source.id)?.retracted).toBe(true)
  expect(f.store.affect().emotion).toEqual([0, 0, 0])
})

test("new revision keeps the ordering of simultaneous independent emotion roots", () => {
  const f = fixture()
  const task = f.store.createTask("synthetic", "a")
  action(f.store, task.id, "first", "v1")
  action(f.store, task.id, "second", "v1", "failed")
  const before = f.store.affect()
  action(f.store, task.id, "first", "v2")
  expect(f.store.affect().emotion).toEqual(before.emotion)
  expect(f.store.affect().mood).toEqual(before.mood)
})

test("privacy deletion removes structured execution evidence and blocks its replay", () => {
  const f = fixture()
  const task = f.store.createTask("synthetic", "a")
  const input = { id: "private-result", taskId: task.id, tool: "shell", status: "failed" as const, text: "synthetic private result", revision: "v1", execution: { version: 1 as const, lifecycle: "completed" as const, outcome: "failed" as const, basis: "private evidence marker", exitCode: 1, finishedAt: 1_000_000 } }
  f.store.recordAction(input)
  f.store.sleep()
  const memory = f.store.memories()[0]!
  f.store.forgetMemory(memory.id, memory.revision)
  expect(f.store.actions(task.id)[0]!.execution).toBeUndefined()
  f.reopen()
  f.store.recordAction({ ...input, revision: "v2", execution: { ...input.execution, basis: "private marker replay" } })
  expect(f.store.actions(task.id)[0]!.execution).toBeUndefined()
  expect(f.store.experiencesAfter(0).every(source => source.evidence === undefined)).toBe(true)
  expect(f.store.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM actions WHERE body LIKE '%private marker%'").get()!.count).toBe(0)
})

test("sealed revisions withdraw stale evidence but are never learned after unsealing", () => {
  const f = fixture()
  const task = f.store.createTask("synthetic", "a")
  const old = action(f.store, task.id, "one-call", "v1")
  f.store.sleep()
  f.store.setSealed(true)
  const current = action(f.store, task.id, "one-call", "v2", "failed")
  expect(f.store.experience(old.id)?.retracted).toBe(true)
  expect(f.store.affect().emotion).toEqual([0, 0, 0])
  f.reopen()
  f.store.setSealed(false)
  expect(f.store.sleep().created).toBe(0)
  expect(f.store.memories()).toHaveLength(0)
  expect(f.store.db.query("SELECT affect_enabled,learning_enabled FROM experience_policy WHERE experience_id=?").get(current.id)).toEqual({ affect_enabled: 0, learning_enabled: 0 })
})

test("a changed result withdraws already approved skill projections", () => {
  const f = fixture()
  const task = f.store.createTask("synthetic", "a")
  const ids = ["a", "b", "c"].map(id => action(f.store, task.id, id, "v1").id)
  const learning = new LearningStore(f.store.db)
  const proposal = learning.propose({ title: "synthetic", scope: "a", when: "synthetic", steps: ["synthetic procedure"], avoid: [], sourceIds: ids })
  learning.promote(proposal.id, proposal.revision)
  action(f.store, task.id, "a", "v2", "failed")
  expect(learning.read(proposal.id)?.status).toBe("needs_review")
  expect(learning.projection("synthetic", "a")).toBe("")
  expect(learning.read(proposal.id)?.steps).toEqual(["synthetic procedure"])
})

test("late sleep uses source time, while an explicit correction has its own new date", () => {
  const f = fixture()
  const source = f.store.appendExperience({ sourceKey: "old", scope: "a", ownership: "observed", kind: "tool_success", text: "old synthetic observation" })
  f.now(source.observedAt + 90 * DAY)
  f.store.sleep()
  const memory = f.store.memories()[0]!
  expect(memory.createdAt).toBe(source.observedAt + 90 * DAY)
  expect(memory.sourceObservedAt).toBe(source.observedAt)
  expect(memoryActivation(memory, "", memory.createdAt)).toBeCloseTo(2 ** (-90 / 14), 12)
  const corrected = f.store.correctMemory(memory.id, memory.revision, "corrected synthetic observation")
  expect(corrected.sourceObservedAt).toBe(memory.createdAt)
  expect(memoryActivation(corrected, "", corrected.createdAt)).toBe(1)
})

test("first ingestion of a delayed structured result respects its actual result time", () => {
  const f = fixture()
  const task = f.store.createTask("synthetic", "a")
  f.now(1_000_000 + DAY)
  f.store.recordAction({ id: "delayed", taskId: task.id, tool: "shell", status: "failed", text: "synthetic", revision: "v1", execution: { version: 1, lifecycle: "completed", outcome: "failed", basis: "exit", exitCode: 1, finishedAt: 1_000_000 } })
  expect(f.store.experiencesAfter(0)[0]!.observedAt).toBe(1_000_000)
  expect(Math.abs(f.store.affect().emotion[0]!)).toBeLessThan(0.000001)
})

test("legacy unverified successes are quarantined once without deleting text or reviving corrections", () => {
  const f = fixture()
  const task = f.store.createTask("legacy synthetic", "a")
  const ids = ["a", "b", "c"].map(id => action(f.store, task.id, id, "v1").id)
  f.store.sleep()
  const memories = f.store.memories()
  const correctedOld = memories.find(memory => memory.sourceIds.includes(ids[1]!))!
  const correction = f.store.correctMemory(correctedOld.id, correctedOld.revision, "user corrected independent content")
  const learning = new LearningStore(f.store.db)
  const proposal = learning.propose({ title: "synthetic", scope: "a", when: "synthetic", steps: ["synthetic procedure"], avoid: [], sourceIds: [ids[0]!, ids[2]!] })
  legacy(f.store)
  f.reopen()
  expect(f.store.actions(task.id).every(item => item.status === "unknown" && item.revision.startsWith("legacy-unverified:"))).toBe(true)
  expect(f.store.actions(task.id)[0]!.text).toContain("synthetic a v1")
  expect(f.store.experience(ids[0]!)?.text).toContain("synthetic a v1")
  expect(ids.every(id => f.store.experience(id)?.retracted)).toBe(true)
  expect(f.store.affect().emotion).toEqual([0, 0, 0])
  expect(f.store.memory(correction.id)?.status).toBe("active")
  expect(f.store.memory(correctedOld.id)?.status).toBe("superseded")
  expect(new LearningStore(f.store.db).read(proposal.id)?.status).toBe("needs_review")
  expect(f.store.meta("action_evidence_version")).toBe("1")
  const onceRevision = f.store.revision
  f.reopen()
  expect(f.store.revision).toBe(onceRevision)
  expect(f.store.actions(task.id)[0]!.revision).toBe("legacy-unverified:v1")
  f.now(1_000_000 + DAY)
  f.store.recordAction({ id: "a", taskId: task.id, tool: "shell", status: "failed", text: "synthetic real-result fixture", revision: "verified-failure", execution: { version: 1, lifecycle: "completed", outcome: "failed", basis: "exit", exitCode: 1 } })
  expect(f.store.actions(task.id)[0]!.status).toBe("failed")
  expect(f.store.experiencesAfter(0).at(-1)!.observedAt).toBe(1_000_000)
  expect(f.store.sleep().created).toBe(1)
  action(f.store, task.id, "a", "v1")
  expect(f.store.actions(task.id)[0]!.revision).toBe("verified-failure")
})

test("legacy revision migration repairs existing duplicate memories and timestamps", () => {
  const f = fixture()
  const task = f.store.createTask("legacy synthetic", "a")
  const first = action(f.store, task.id, "one", "v1")
  f.store.sleep()
  const oldMemory = f.store.memories()[0]!
  f.now(1_000_000 + DAY)
  const last = action(f.store, task.id, "one", "v2")
  f.store.sleep()
  // Reconstruct the old implementation's persisted duplicate state, not a new
  // production path: both revisions live and their derived memories active.
  const legacyFirst = { ...f.store.experience(first.id)!, retracted: false }
  const legacyLast: Experience = { ...last, observedAt: 1_000_000 + DAY }
  f.store.db.query("UPDATE experiences SET body=? WHERE id=?").run(JSON.stringify(legacyFirst), first.id)
  f.store.db.query("UPDATE experiences SET body=? WHERE id=?").run(JSON.stringify(legacyLast), last.id)
  f.store.db.query("UPDATE memories SET body=? WHERE id=?").run(JSON.stringify({ ...oldMemory, status: "active" }), oldMemory.id)
  f.store.db.query("DELETE FROM meta WHERE key='source_revision_version'").run()
  for (const memory of f.store.memories({ history: true })) {
    delete memory.sourceObservedAt
    f.store.db.query("UPDATE memories SET body=? WHERE id=?").run(JSON.stringify(memory), memory.id)
  }
  f.reopen()
  expect(f.store.experience(first.id)?.retracted).toBe(true)
  expect(f.store.experience(last.id)?.retracted).toBe(false)
  expect(f.store.experience(last.id)?.observedAt).toBe(first.observedAt)
  expect(f.store.memory(oldMemory.id)?.status).toBe("invalidated")
  expect(f.store.memories()).toHaveLength(1)
  expect(f.store.memories()[0]!.sourceObservedAt).toBe(first.observedAt)
})

test("legacy upgrade honors privacy tombstones and sealed ingestion policies", () => {
  const f = fixture()
  const task = f.store.createTask("legacy synthetic", "a")
  action(f.store, task.id, "deleted", "v1")
  f.store.sleep()
  const memory = f.store.memories()[0]!
  f.store.forgetMemory(memory.id, memory.revision)
  f.store.setSealed(true)
  const sealed = action(f.store, task.id, "sealed", "v1")
  legacy(f.store)
  f.reopen()
  expect(f.store.actions(task.id).find(item => item.id === "deleted")!.text).toBe("[已按要求删除]")
  expect(f.store.memory(memory.id)?.status).toBe("forgotten")
  expect(f.store.memory(memory.id)?.text).toBe("")
  expect(f.store.db.query("SELECT learning_enabled FROM experience_policy WHERE experience_id=?").get(sealed.id)).toEqual({ learning_enabled: 0 })
  action(f.store, task.id, "deleted", "v2", "failed")
  expect(f.store.experiencesAfter(0).at(-1)!.text).toBe("")
  expect(f.store.experiencesAfter(0).at(-1)!.retracted).toBe(true)
  f.store.setSealed(false)
  expect(f.store.sleep().created).toBe(0)
})

test("pinned constraints overflow explicitly before a partial projection is returned", () => {
  const f = fixture()
  const memory = f.store.explicitMemory({ key: "huge", scope: "a", kind: "commitment", text: "x".repeat(7000) })
  let error: unknown
  try { f.store.projection("a", "unrelated") } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(ProjectionCoverageError)
  expect(error).toMatchObject({ code: "MEMORY_CONSTRAINT_OVERFLOW", memoryIds: [memory.id], limit: 6500 })
  expect((error as ProjectionCoverageError).requiredCharacters).toBeGreaterThan(7000)
  expect(() => f.store.projection("other-scope", "unrelated")).not.toThrow()
  f.store.setSealed(true)
  expect(f.store.projection("a", "unrelated")).toContain("已封存")
})

test("several individually small commitments cannot silently displace each other", () => {
  const f = fixture()
  for (let index = 0; index < 4; index++) f.store.explicitMemory({ key: String(index), scope: "a", kind: "commitment", text: `${index}:` + "x".repeat(1800) })
  expect(() => f.store.projection("a", "0")).toThrow(ProjectionCoverageError)
  expect(f.store.projection("a", "0", 10000).match(/"type":"commitment"/g)).toHaveLength(4)
})
