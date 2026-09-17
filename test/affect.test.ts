import { describe, expect, test } from "bun:test"
import { affectDescription, applyExperience, initialAffect, memoryActivation, propagateAffect } from "../src/affect"
import type { Affect, Experience, Memory } from "../src/contracts"

const START = Date.UTC(2026, 8, 17, 12)
const DAY = 24 * 60 * 60 * 1000

function event(overrides: Partial<Experience> = {}): Experience {
  return {
    id: 1, sourceKey: "test/tool/1/result", scope: "test-project", kind: "tool_success",
    ownership: "experienced", text: "测试通过", observedAt: START, recordedAt: START,
    retracted: false, ...overrides,
  }
}

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "test-memory", revision: 1, scope: "test-project", kind: "fact",
    text: "星杳项目需要中文记忆检索，并使用 Python 3.12。", sourceIds: [1],
    status: "active", pinned: false, private: false, createdAt: START,
    updatedAt: START, supersedes: null, ...overrides,
  }
}

function expectSameState(actual: Affect, expected: Affect) {
  expect(actual.updatedAt).toBe(expected.updatedAt)
  for (let index = 0; index < 3; index++) {
    expect(actual.emotion[index]!).toBeCloseTo(expected.emotion[index]!, 12)
    expect(actual.mood[index]!).toBeCloseTo(expected.mood[index]!, 12)
  }
}

describe("affect dynamics", () => {
  test("uses milliseconds and an exact five-minute emotion half-life", () => {
    const state = { ...initialAffect(START), emotion: [1, -0.6, 0.4] }
    const after = propagateAffect(state, START + 5 * 60 * 1000)
    expect(after.emotion[0]).toBeCloseTo(0.5, 12)
    expect(after.emotion[1]).toBeCloseTo(-0.3, 12)
    expect(after.emotion[2]).toBeCloseTo(0.2, 12)
    expect(after.mood[0]!).toBeGreaterThan(0)
    expect(after.mood[1]!).toBeLessThan(0)
  })

  test("changing polling intervals does not change the state", () => {
    const before = { ...initialAffect(START), emotion: [0.8, -0.6, 0.4], mood: [-0.5, 0.3, 0.9] }
    for (const duration of [1, 100, 60_000, 300_000, 10_800_000, 7 * DAY]) {
      const direct = propagateAffect(before, START + duration)
      let segmented = before
      for (let part = 1; part <= 137; part++) {
        segmented = propagateAffect(segmented, START + duration * part / 137)
      }
      expectSameState(segmented, direct)
    }
  })

  test("clock reversal cannot amplify state or move its timestamp backward", () => {
    const state = { ...initialAffect(START), emotion: [0.3, -0.8, 0.1], mood: [0.2, 0, -0.1] }
    const reversed = propagateAffect(state, START - DAY)
    expectSameState(reversed, state)
    expectSameState(propagateAffect(reversed, START + DAY), propagateAffect(state, START + DAY))
  })

  test("all valid corner states stay bounded over long and short elapsed times", () => {
    for (const emotion of [-1, 0, 1]) for (const mood of [-1, 0, 1]) {
      for (const duration of [0, 1, 10_000, 300_000, 10_800_000, 365 * DAY]) {
        const after = propagateAffect({ ...initialAffect(START), emotion: [emotion, emotion, emotion], mood: [mood, mood, mood] }, START + duration)
        for (const value of [...after.emotion, ...after.mood]) {
          expect(Number.isFinite(value)).toBe(true)
          expect(value).toBeGreaterThanOrEqual(-1)
          expect(value).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  test("offline time adds no relationship event and returns state to baseline", () => {
    const neutral = initialAffect(START)
    expect(propagateAffect(neutral, START + 7 * DAY)).toEqual({ ...neutral, updatedAt: START + 7 * DAY })
    const success = applyExperience(neutral, event())
    const returned = propagateAffect(success, START + 7 * DAY)
    for (const value of [...returned.emotion, ...returned.mood]) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeCloseTo(0, 12)
    }
    expect(returned.lastSourceId).toBe(success.lastSourceId)
    expect(returned.reason).toBe(success.reason)
  })

  test("verified success and failure yield modest, appropriately directed responses", () => {
    const success = applyExperience(initialAffect(START), event())
    const failure = applyExperience(initialAffect(START), event({ kind: "tool_failure", text: "退出码 1" }))
    expect(success.emotion[0]!).toBeGreaterThan(0)
    expect(success.emotion[2]!).toBeGreaterThan(0)
    expect(failure.emotion[0]!).toBeLessThan(0)
    expect(failure.emotion[2]!).toBeLessThan(0)
    for (const state of [success, failure]) {
      expect(state.lastSourceId).toBe(1)
      for (const value of state.emotion) expect(Math.abs(value)).toBeLessThanOrEqual(0.25)
      expect(state.mood).toEqual([0, 0, 0])
    }
    expect(affectDescription(success)).toContain("偏轻快")
    expect(affectDescription(failure)).toContain("挫败")
    expect(affectDescription(failure)).toContain("经历 #1")
  })

  test("unknown, narrative, hearsay and retracted results do not become emotional proof", () => {
    const state = initialAffect(START)
    for (const sample of [
      event({ kind: "tool_unknown", text: "也许成功了" }),
      event({ kind: "assistant_message", text: "我已经全部成功完成了" }),
      event({ kind: "user_message", text: "我一个月不来了" }),
      event({ ownership: "told", text: "别人说测试通过了" }),
      event({ retracted: true }),
    ]) expect(applyExperience(state, sample)).toEqual(state)
  })

  test("delayed display decays from the actual event time; stale events are not revived", () => {
    const state = initialAffect(START)
    const later = START + DAY
    expectSameState(applyExperience(state, event(), later), propagateAffect(applyExperience(state, event()), later))
    const advanced = propagateAffect(state, later)
    expect(applyExperience(advanced, event(), later)).toEqual(advanced)
  })

  test("repeated distinct result events cannot escape bounded state", () => {
    let state = initialAffect(START)
    for (let index = 0; index < 1000; index++) {
      const now = START + index * 30_000
      state = applyExperience(state, event({ id: index + 1, sourceKey: `test/${index}`, kind: index % 7 ? "tool_success" : "tool_failure", observedAt: now }))
      for (const value of [...state.emotion, ...state.mood]) expect(Math.abs(value)).toBeLessThanOrEqual(1)
    }
  })

  test("non-finite timestamps fail explicitly", () => {
    expect(() => initialAffect(Number.NaN)).toThrow(RangeError)
    expect(() => propagateAffect(initialAffect(START), Infinity)).toThrow(RangeError)
  })
})

describe("memory activation", () => {
  test("matches Chinese terms inside unsegmented text and ranks relevant memories first", () => {
    const related = memoryActivation(memory(), "中文项目检索", START)
    const unrelated = memoryActivation(memory({ text: "天气晴朗，明天准备出门。" }), "中文项目检索", START)
    expect(related).toBeGreaterThan(0.4)
    expect(unrelated).toBe(0)
    expect(memoryActivation(memory(), "记忆检索", START)).toBe(1)
  })

  test("supports mixed Chinese/ASCII, case and compatibility normalization", () => {
    expect(memoryActivation(memory(), "ＰＹＴＨＯＮ ３.１２", START)).toBe(1)
    expect(memoryActivation(memory(), "Python项目", START)).toBe(1)
    expect(memoryActivation(memory(), "3.11", START)).toBe(0)
  })

  test("a standalone Han query term matches inside a sentence without weakening longer terms", () => {
    const item = memory({ text: "主人现在改喝茶。" })
    expect(memoryActivation(item, "咖啡 茶", START)).toBeGreaterThan(0)
    expect(memoryActivation(item, "咖啡 酒", START)).toBe(0)
    expect(memoryActivation(item, "茶叶", START)).toBe(0)
  })

  test("fourteen-day recency half-life lowers ranking without rewriting truth", () => {
    const item = memory()
    expect(memoryActivation(item, "", START + 14 * DAY)).toBeCloseTo(0.5, 12)
    expect(memoryActivation(item, "", START + 28 * DAY)).toBeCloseTo(0.25, 12)
    expect(memoryActivation(item, "记忆", START + 14 * DAY)).toBeLessThan(memoryActivation(item, "记忆", START))
    expect(item.status).toBe("active")
    expect(memoryActivation({ ...item, updatedAt: START + 14 * DAY }, "", START + 14 * DAY)).toBe(0.5)
  })

  test("pinned memories do not decay, but unrelated pinned memories do not match", () => {
    const item = memory({ pinned: true })
    expect(memoryActivation(item, "记忆", START + 365 * DAY)).toBe(memoryActivation(item, "记忆", START))
    expect(memoryActivation(item, "海洋动物", START)).toBe(0)
    expect(memoryActivation(item, "", START + 365 * DAY)).toBe(1)
  })

  test("future timestamps cannot amplify ranking", () => {
    expect(memoryActivation(memory(), "记忆", START - DAY)).toBe(1)
    expect(memoryActivation(memory(), "", START - DAY)).toBe(1)
  })
})
