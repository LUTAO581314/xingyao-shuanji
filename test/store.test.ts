import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SoulStore } from "../src/store"

const resources: { store: SoulStore; dir: string }[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "xingyao-store-"))
  const store = new SoulStore(join(dir, "soul.db"), () => 1000000)
  resources.push({ store, dir })
  return store
}
afterEach(() => { for (const item of resources.splice(0)) { item.store.close(); rmSync(item.dir, { recursive: true, force: true }) } })

describe("independent soul domain", () => {
  test("100 repeated tool results change affect and ledger once", () => {
    const store = fixture()
    const input = { sourceKey: "engine/session/call/success", scope: "project-a", kind: "tool_success" as const, ownership: "experienced" as const, text: "test command exited 0" }
    store.appendExperience(input)
    const emotion = store.affect()
    const revision = store.revision
    for (let n = 0; n < 100; n++) store.appendExperience(input)
    expect(store.experiencesAfter(0)).toHaveLength(1)
    expect(store.affect()).toEqual(emotion)
    expect(store.revision).toBe(revision)
    expect(() => store.appendExperience({ ...input, text: "changed" })).toThrow("不同内容")
  })

  test("correction invalidates every derived memory and excludes old context", () => {
    const store = fixture()
    const old = store.explicitMemory({ key: "a", text: "项目使用 Python 3.12", scope: "a", kind: "fact" })
    const derived = store.remember({ text: "检查 Python 3.12 兼容性", scope: "a", kind: "inference", sourceIds: old.sourceIds })
    const revised = store.correctMemory(old.id, 1, "项目使用 Python 3.13")
    expect(store.memory(derived.id)?.status).toBe("invalidated")
    expect(store.memory(old.id)?.status).toBe("superseded")
    expect(revised.supersedes).toBe(old.id)
    expect(store.projection("a", "Python")).toContain("3.13")
    expect(store.projection("a", "Python")).not.toContain("3.12")
    expect(() => store.correctMemory(old.id, 1, "stale")).toThrow()
  })

  test("private source cannot produce public or cross-project memory", () => {
    const store = fixture()
    const secret = store.explicitMemory({ key: "secret", text: "私密信息", scope: "a", kind: "fact", private: true })
    expect(() => store.remember({ text: "public", scope: "a", kind: "inference", sourceIds: secret.sourceIds })).toThrow("私密")
    expect(() => store.remember({ text: "other", scope: "b", kind: "inference", private: true, sourceIds: secret.sourceIds })).toThrow("范围")
    expect(store.projection("a", "信息")).not.toContain("私密信息")
  })

  test("sleep only archives verified evidence, is resumable, and skips self narrative", () => {
    const store = fixture()
    store.appendExperience({ sourceKey: "said", scope: "a", kind: "assistant_message", ownership: "experienced", text: "我已经修复了全部问题" })
    for (let n = 0; n < 3; n++) store.appendExperience({ sourceKey: `tool:${n}`, scope: "a", kind: "tool_failure", ownership: "experienced", text: `构建失败 ${n}` })
    expect(store.sleep(2)).toMatchObject({ examined: 2, created: 1, toCursor: 2 })
    expect(store.sleep(2)).toMatchObject({ examined: 2, created: 2, toCursor: 4 })
    expect(store.sleep(2)).toMatchObject({ examined: 0, created: 0, toCursor: 4 })
    expect(store.memories()).toHaveLength(3)
    expect(store.memories().some(memory => memory.text.includes("全部"))).toBe(false)
  })

  test("seal removes projections and pauses learning but permits correction", () => {
    const store = fixture()
    const memory = store.explicitMemory({ key: "pref", text: "喜欢简短回答", scope: "global", kind: "preference" })
    store.setSealed(true)
    expect(store.projection("a", "回答")).not.toContain("简短")
    expect(store.sleep()).toMatchObject({ status: "paused", toCursor: 0 })
    expect(() => store.explicitMemory({ key: "b", text: "b", scope: "global", kind: "fact" })).toThrow("封存")
    expect(store.correctMemory(memory.id, 1, "喜欢清楚完整的回答").text).toContain("完整")
  })

  test("forget scrubs source and derived content and leaves no normal recall", () => {
    const store = fixture()
    const task = store.createTask("conversation", "a")
    const chat = store.addChat(task.id, "user", "敏感文本")
    const memory = store.remember({ text: "敏感文本", scope: "a", kind: "fact", sourceIds: [store.experiencesAfter(0)[0].id] })
    store.remember({ text: "从敏感文本推导", scope: "a", kind: "inference", sourceIds: memory.sourceIds })
    store.forgetMemory(memory.id, 1)
    expect(store.experiencesAfter(0).every(event => !event.text.includes("敏感"))).toBe(true)
    expect(store.memories({ history: true, private: true }).every(memory => !memory.text.includes("敏感"))).toBe(true)
    expect(store.chats(task.id).find(message => message.id === chat.id)?.text).toBe("[已按要求删除]")
    expect(store.sleep().created).toBe(0)
  })

  test("restart recovers running work as uncertain without replaying actions", () => {
    const store = fixture()
    const task = store.createTask("repair", "a")
    store.updateTask(task.id, { status: "running", sessionId: "ses_1" })
    store.recordAction({ id: "call_1", taskId: task.id, tool: "bash", status: "running", text: "deploy", revision: "1" })
    store.recoverInterrupted()
    expect(store.task(task.id)?.status).toBe("waiting")
    expect(store.actions(task.id)[0].status).toBe("unknown")
  })

  test("idempotency survives reopen and conflicts are rejected", () => {
    const store = fixture()
    const task = store.once("same", { title: "one" }, () => store.createTask("one", "a"))
    expect(store.once("same", { title: "one" }, () => store.createTask("two", "a"))).toEqual(task)
    expect(store.tasks()).toHaveLength(1)
    expect(() => store.once("same", { title: "other" }, () => null)).toThrow("幂等")
    const item = resources.at(-1)!
    item.store.close()
    item.store = new SoulStore(join(item.dir, "soul.db"))
    expect(item.store.identityId).toBeTruthy()
    expect(item.store.once("same", { title: "one" }, () => task)).toEqual(task)
  })
})
