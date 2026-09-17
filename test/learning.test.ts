import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SoulStore } from "../src/store"
import { LearningStore } from "../src/learning"
import type { SkillProposal } from "../src/learning"
import type { Experience, Task } from "../src/contracts"

const fixtures: { store: SoulStore; directory: string }[] = []

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "xingyao-learning-test-"))
  const store = new SoulStore(join(directory, "soul.db"))
  fixtures.push({ store, directory })
  return { store, learning: new LearningStore(store.db), task: store.createTask("临时验证任务", "project-a") }
}

afterEach(() => {
  for (const item of fixtures.splice(0)) {
    item.store.close()
    rmSync(item.directory, { recursive: true, force: true })
  }
})

// Use actual local subprocess exit results, then the public action recorder.
// No model narrative or private store helper creates the outcome evidence.
function tool(store: SoulStore, task: Task, call: string, exit = 0, revision = "1"): Experience {
  const result = Bun.spawnSync([process.execPath, "-e", `console.log('temporary verification'); process.exit(${exit})`], { stdout: "pipe", stderr: "pipe" })
  store.recordAction({ id: call, taskId: task.id, tool: "test-process", status: result.exitCode === 0 ? "succeeded" : "failed",
    text: `exit=${result.exitCode}; stdout=${result.stdout.toString().trim()}`, revision })
  return store.experiencesAfter(0, 500).at(-1)!
}

function uncertain(store: SoulStore, task: Task, call: string, revision = "unknown"): Experience {
  store.updateTask(task.id, { status: "running" })
  store.recordAction({ id: call, taskId: task.id, tool: "test-process", status: "running", text: "执行结果尚未获取", revision })
  store.recoverInterrupted()
  return store.experiencesAfter(0, 500).at(-1)!
}

function proposal(sourceIds: number[], overrides: Partial<SkillProposal> = {}): SkillProposal {
  return { title: "中文构建验证", scope: "project-a", when: "修改 TypeScript 代码后验证构建",
    steps: ["运行已有测试命令", "核对真实退出码与测试结果"], avoid: ["没有测试环境时不宣称验证通过"], sourceIds, ...overrides }
}

function three(store: SoulStore, task: Task): number[] {
  return [tool(store, task, "call-a"), tool(store, task, "call-b"), tool(store, task, "call-c")].map(event => event.id)
}

describe("evidence-backed learning candidates", () => {
  test("requires recorded tool outcomes and rejects self narration or fabricated tool labels", () => {
    const { store, learning, task } = setup()
    const chat = store.addChat(task.id, "assistant", "我已经验证了一切")
    const narration = store.experiencesAfter(0).find(event => event.evidence?.chatMessageId === chat.id)!
    expect(() => learning.propose(proposal([narration.id]))).toThrow("工具")
    const label = store.appendExperience({ sourceKey: "bad-label", scope: task.scope, kind: "tool_success", ownership: "experienced", text: "没有动作记录支撑的标签" })
    expect(() => learning.propose(proposal([label.id]))).toThrow("工具")
    expect(() => learning.propose(proposal([99999]))).toThrow("工具")
    const genuine = tool(store, task, "genuine")
    expect(learning.propose(proposal([genuine.id])).status).toBe("draft")
  })

  test("uses Beta(1,1) and counts each tool call once despite multiple revisions", () => {
    const { store, learning, task } = setup()
    const first = tool(store, task, "same-call", 0, "success")
    const latest = tool(store, task, "same-call", 1, "failure")
    const second = tool(store, task, "other-call", 0)
    const pending = uncertain(store, task, "pending-call")
    const skill = learning.propose(proposal([first.id, latest.id, second.id, pending.id, first.id]))
    expect(learning.evaluate(skill.id)).toMatchObject({ alpha: 2, beta: 2, probability: 0.5, independentSources: 2, successes: 1, failures: 1, unknownSources: 1 })
    const count = store.experiencesAfter(0).length
    for (let n = 0; n < 100; n++) store.recordAction({ id: "same-call", taskId: task.id, tool: "test-process", status: "failed", text: latest.text, revision: "failure" })
    expect(store.experiencesAfter(0)).toHaveLength(count)
    expect(learning.evaluate(skill.id).independentSources).toBe(2)
    expect(() => learning.promote(skill.id, skill.revision)).toThrow("3")
  })

  test("proposals and repeated evaluation do not repeatedly strengthen evidence", () => {
    const { store, learning, task } = setup()
    const sources = three(store, task)
    const input = proposal(sources)
    const first = learning.propose(input)
    const revision = store.revision
    for (let count = 0; count < 10; count++) {
      expect(learning.propose(input).id).toBe(first.id)
      expect(learning.evaluate(first.id).probability).toBe(0.8)
      learning.read(first.id)
      learning.list(task.scope)
    }
    expect(store.revision).toBe(revision)
    expect(learning.list()).toHaveLength(1)
  })

  test("promotion needs sufficient evidence and respects candidate revision", () => {
    const { store, learning, task } = setup()
    const ids = three(store, task)
    const insufficient = learning.propose(proposal(ids.slice(0, 2)))
    expect(() => learning.promote(insufficient.id, insufficient.revision, "已核对步骤")).toThrow("3")
    const skill = learning.propose(proposal(ids))
    expect(learning.projection("中文构建", task.scope)).toBe("")
    expect(() => learning.promote(skill.id, skill.revision + 1)).toThrow("版本")
    const active = learning.promote(skill.id, skill.revision, "已核对适用条件、步骤和真实测试结果")
    expect(active.status).toBe("active")
    expect(active.revision).toBe(2)
    const projection = learning.projection("中文构建", task.scope)
    expect(projection).toContain("中文构建验证")
    expect(projection).toContain("sourceIds")
    expect(projection).toContain("不改变当前要求")
    expect(projection).toContain("不是事实可信度")
    expect(store.actions(task.id)).toHaveLength(3)
    const revision = store.revision
    expect(learning.promote(active.id, active.revision).revision).toBe(2)
    expect(store.revision).toBe(revision)
  })

  test("manual verification does not manufacture a success observation", () => {
    const { store, learning, task } = setup()
    const ids = [tool(store, task, "fail-a", 1), tool(store, task, "fail-b", 1), tool(store, task, "fail-c", 1)].map(event => event.id)
    const skill = learning.propose(proposal(ids))
    expect(() => learning.promote(skill.id, skill.revision)).toThrow("人工验证")
    const active = learning.promote(skill.id, skill.revision, "已人工检查条件与步骤；所列失败来自预期负例，执行时仍需重新验证")
    expect(active.status).toBe("active")
    expect(active.evaluation).toMatchObject({ successes: 0, failures: 3, alpha: 1, beta: 4, probability: 0.2 })
    expect(active.manualCheck).toContain("人工")
  })

  test("new call revisions require fresh review and replace, rather than add, sample weight", () => {
    const { store, learning, task } = setup()
    const skill = learning.propose(proposal(three(store, task)))
    const active = learning.promote(skill.id, skill.revision)
    tool(store, task, "call-a", 1, "revised-result")
    expect(learning.evaluate(skill.id)).toMatchObject({ status: "needs_review", successes: 2, failures: 1, independentSources: 3, alpha: 3, beta: 2 })
    expect(learning.projection("构建", task.scope)).toBe("")
    const reviewed = learning.promote(skill.id, active.revision, "已核查最新一次失败的适用条件")
    expect(reviewed.status).toBe("active")
    expect(reviewed.evaluation.independentSources).toBe(3)
    uncertain(store, task, "call-a", "running-after-review")
    expect(learning.evaluate(skill.id)).toMatchObject({ status: "needs_review", independentSources: 2, unknownSources: 1 })
    expect(() => learning.promote(skill.id, reviewed.revision)).toThrow("未知")
  })

  test("withdrawn evidence immediately removes active projections and preserves review text", () => {
    const { store, learning, task } = setup()
    const ids = three(store, task)
    const skill = learning.propose(proposal(ids))
    learning.promote(skill.id, skill.revision)
    const source = store.experience(ids[0]!)!
    const memory = store.remember({ text: source.text, scope: source.scope, kind: "episode", sourceIds: [source.id] })
    store.correctMemory(memory.id, memory.revision, "结果归属有误，撤回这一来源")
    expect(learning.read(skill.id)?.status).toBe("needs_review")
    expect(learning.list(task.scope)[0]?.status).toBe("needs_review")
    expect(learning.read(skill.id)?.steps).toHaveLength(2)
    expect(learning.projection("构建", task.scope)).toBe("")
    expect(() => learning.promote(skill.id, learning.read(skill.id)!.revision)).toThrow("失效")
  })

  test("source privacy erasure atomically scrubs stored skill instructions and notes", () => {
    const { store, learning, task } = setup()
    const ids = three(store, task)
    const skill = learning.propose(proposal(ids, { title: "PRIVATE-SKILL-TEXT", when: "PRIVATE-SKILL-TEXT", steps: ["PRIVATE-SKILL-TEXT"], avoid: ["PRIVATE-SKILL-TEXT"] }))
    const active = learning.promote(skill.id, skill.revision, "PRIVATE-SKILL-TEXT")
    const source = store.experience(ids[0]!)!
    const memory = store.remember({ text: source.text, scope: source.scope, kind: "episode", sourceIds: [source.id] })
    store.forgetMemory(memory.id, memory.revision)
    // Inspect storage before any learning read so lazy invalidation cannot pass.
    const raw = store.db.query<{ body: string }, [string]>("SELECT body FROM skill_candidates WHERE id=?").get(skill.id)!.body
    expect(raw).not.toContain("PRIVATE-SKILL-TEXT")
    const removed = learning.read(skill.id)!
    expect(removed.status).toBe("retracted")
    expect(removed.steps).toEqual([])
    expect(removed.manualCheck).toBeNull()
    expect(removed.revision).toBe(active.revision + 1)
    expect(learning.projection("构建", task.scope)).toBe("")
  })

  test("scope and private evidence are enforced before proposals and projections", () => {
    const { store, learning, task } = setup()
    const publicIds = three(store, task)
    const original = store.experience(publicIds[0]!)!
    const privateSource = store.appendExperience({ sourceKey: "private-proof", scope: task.scope, kind: original.kind, ownership: original.ownership,
      text: original.text, evidence: original.evidence, private: true })
    const ids = [privateSource.id, ...publicIds.slice(1)]
    expect(() => learning.propose(proposal(ids, { private: false }))).toThrow("私密")
    expect(() => learning.propose(proposal(ids, { scope: "global" }))).toThrow("范围")
    const skill = learning.propose(proposal(ids))
    expect(skill.private).toBe(true)
    learning.promote(skill.id, skill.revision)
    expect(learning.list(task.scope)).toEqual([])
    expect(learning.list(task.scope, true)).toHaveLength(1)
    expect(learning.list("project-b", true)).toEqual([])
    expect(learning.projection("构建", task.scope)).toBe("")
    expect(learning.observations(task.scope)).toHaveLength(2)
    expect(learning.observations(task.scope, true)).toHaveLength(3)
    expect(learning.observations("project-b", true)).toHaveLength(0)
  })

  test("global evidence can support a global skill without exposing project-only skills", () => {
    const { store, learning } = setup()
    const globalTask = store.createTask("global test", "global")
    const skill = learning.propose(proposal(three(store, globalTask), { scope: "global" }))
    learning.promote(skill.id, skill.revision)
    expect(learning.list("project-b")).toHaveLength(1)
    expect(learning.projection("构建", "project-b")).toContain("中文构建验证")
  })

  test("a private latest revision cannot be approved through an older public source", () => {
    const { store, learning, task } = setup()
    const ids = [...three(store, task), tool(store, task, "fourth-call").id]
    const skill = learning.propose(proposal(ids))
    const active = learning.promote(skill.id, skill.revision)
    const original = store.experience(ids[0]!)!
    const privateRevision = store.appendExperience({ sourceKey: "new-private-revision", scope: task.scope, kind: original.kind, ownership: original.ownership,
      text: original.text, evidence: original.evidence, private: true })
    expect(learning.evaluate(skill.id)).toMatchObject({ status: "needs_review", independentSources: 3 })
    expect(learning.evaluate(skill.id).evidenceSourceIds).not.toContain(privateRevision.id)
    expect(() => learning.promote(skill.id, active.revision, "复查旧公开来源")).toThrow("失效")
    expect(learning.projection("构建", task.scope)).toBe("")
  })

  test("seal prevents learning and projection, including retrospective sealed-event use", () => {
    const { store, learning, task } = setup()
    const skill = learning.propose(proposal(three(store, task)))
    learning.promote(skill.id, skill.revision)
    store.setSealed(true)
    const duringSeal = tool(store, task, "sealed-call")
    expect(() => learning.propose(proposal([duringSeal.id]))).toThrow("封存")
    expect(learning.projection("构建", task.scope)).toBe("")
    store.setSealed(false)
    expect(() => learning.propose(proposal([duringSeal.id]))).toThrow("来源")
    expect(learning.projection("构建", task.scope)).toContain("中文构建验证")
  })

  test("retraction is idempotent and cannot be undone by repeating a proposal", () => {
    const { store, learning, task } = setup()
    const input = proposal(three(store, task))
    const skill = learning.propose(input)
    learning.promote(skill.id, skill.revision)
    learning.retract(skill.id)
    const revision = store.revision
    learning.retract(skill.id)
    expect(store.revision).toBe(revision)
    expect(learning.propose(input).status).toBe("retracted")
    expect(() => learning.promote(skill.id, learning.read(skill.id)!.revision)).toThrow("撤回")
    expect(learning.projection("构建", task.scope)).toBe("")
  })

  test("projections respect relevance and budget without truncating procedure steps", () => {
    const { store, learning, task } = setup()
    const skill = learning.propose(proposal(three(store, task)))
    learning.promote(skill.id, skill.revision)
    expect(learning.projection("海底火山", task.scope)).toBe("")
    expect(learning.projection("构建", task.scope, 100)).toBe("")
    const projection = learning.projection("构建", task.scope, 1000)
    expect(projection.length).toBeLessThanOrEqual(1000)
    expect(projection).toContain("核对真实退出码与测试结果")
    expect(projection).toContain("没有测试环境时不宣称验证通过")
  })
})
