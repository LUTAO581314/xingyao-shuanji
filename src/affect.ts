import type { Affect, Experience, Memory } from "./contracts"

// Versioned engineering defaults, not measurements of human psychology.
const EMOTION_TAU_SECONDS = (5 * 60) / Math.LN2
const MOOD_TAU_SECONDS = 3 * 60 * 60
const MEMORY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000
const DIMENSIONS = 3

function finiteTime(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError("时间必须是有限的毫秒时间戳")
  return value
}

function bounded(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value!)) : 0
}

export function initialAffect(now: number): Affect {
  return {
    emotion: [0, 0, 0],
    mood: [0, 0, 0],
    updatedAt: finiteTime(now),
    lastSourceId: null,
    reason: "尚无已核实事件触发情绪变化",
  }
}

/** Exact evolution between events; elapsed time is converted from milliseconds to seconds. */
export function propagateAffect(state: Affect, now: number): Affect {
  const updatedAt = Math.max(finiteTime(state.updatedAt), finiteTime(now))
  const elapsed = (updatedAt - state.updatedAt) / 1000
  const emotionDecay = Math.exp(-elapsed / EMOTION_TAU_SECONDS)
  const moodDecay = Math.exp(-elapsed / MOOD_TAU_SECONDS)
  const transfer = (EMOTION_TAU_SECONDS / (EMOTION_TAU_SECONDS - MOOD_TAU_SECONDS))
    * (emotionDecay - moodDecay)
  const emotion: number[] = []
  const mood: number[] = []
  for (let index = 0; index < DIMENSIONS; index++) {
    const before = bounded(state.emotion[index])
    emotion.push(bounded(before * emotionDecay))
    mood.push(bounded(bounded(state.mood[index]) * moodDecay + before * transfer))
  }
  return { ...state, emotion, mood, updatedAt }
}

/** The store must deduplicate root sources and replay accepted events in time order. */
export function applyExperience(state: Affect, event: Experience, now = event.observedAt): Affect {
  const at = finiteTime(event.observedAt)
  // A late event is retained as evidence by the store. Replaying the ordered ledger is
  // required to change past affect; never revive an old event as a fresh feeling.
  if (event.retracted || at < state.updatedAt) return propagateAffect(state, now)

  let next = propagateAffect(state, at)
  const direct = event.ownership === "experienced" || event.ownership === "observed"
  if (!direct || (event.kind !== "tool_success" && event.kind !== "tool_failure")) {
    return propagateAffect(next, now)
  }

  const success = event.kind === "tool_success"
  const appraisal = success ? [0.7, 0.3, 0.6] : [-0.65, 0.45, -0.5]
  const gain = 0.25
  next = {
    ...next,
    emotion: next.emotion.map((value, index) => bounded((1 - gain) * value + gain * appraisal[index]!)),
    lastSourceId: event.id,
    reason: success ? "记录到工具执行成功的结果" : "记录到工具执行失败的结果；仍需核对原因",
  }
  return propagateAffect(next, now)
}

/** Describe persisted computational state and its actual source, not a claim of consciousness. */
export function affectDescription(state: Affect): string {
  const valence = 0.75 * bounded(state.emotion[0]) + 0.25 * bounded(state.mood[0])
  const arousal = 0.75 * bounded(state.emotion[1]) + 0.25 * bounded(state.mood[1])
  const control = 0.75 * bounded(state.emotion[2]) + 0.25 * bounded(state.mood[2])
  const tone = valence > 0.08 ? "偏轻快" : valence < -0.08 ? "有些挫败" : "平稳"
  const details = arousal > 0.25 ? "，关注度较高" : control < -0.2 ? "，需要先恢复对问题的把握" : ""
  const source = state.lastSourceId === null ? "" : `（经历 #${state.lastSourceId}）`
  return `当前状态${tone}${details}。最近依据：${state.reason}${source}。`
}

function normalized(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("en-US").trim()
}

function terms(text: string): Set<string> {
  const result = new Set<string>()
  for (const run of text.match(/\p{Script=Han}+/gu) ?? []) {
    const characters = Array.from(run)
    if (characters.length === 1) result.add(`h:${characters[0]}`)
    for (let i = 1; i < characters.length; i++) result.add(`h:${characters[i - 1]}${characters[i]}`)
  }
  for (const word of text.match(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g) ?? []) result.add(`w:${word}`)
  return result
}

/** Scope/visibility/status filtering belongs to the store, before calling this scorer. */
export function memoryActivation(memory: Memory, query: string, now: number): number {
  const age = Math.max(0, finiteTime(now) - finiteTime(memory.sourceObservedAt ?? memory.createdAt))
  // Read access, text revisions and summaries do not refresh the source event's age.
  const freshness = memory.pinned ? 1 : 2 ** (-age / MEMORY_HALF_LIFE_MS)
  const needle = normalized(query)
  if (!needle) return freshness
  const haystack = normalized(memory.text)
  let similarity = 0
  if (haystack.includes(needle)) {
    similarity = 1
  } else {
    const wanted = terms(needle)
    const available = terms(haystack)
    let matched = 0
    // A standalone Han query term (e.g. “茶”) must also match inside a longer
    // unsegmented sentence. Keep bigrams for longer queries to limit noise.
    for (const term of wanted) if (available.has(term) || /^h:\p{Script=Han}$/u.test(term) && haystack.includes(term.slice(2))) matched++
    similarity = wanted.size ? matched / wanted.size : 0
  }
  // No lexical evidence means no match: being new or pinned is not relevance.
  // The MVP exposes lexical relevance and recency only; richer goal/emotion
  // weights require additional verified inputs and are intentionally not invented.
  return similarity === 0 ? 0 : 0.9 * similarity + 0.1 * freshness
}
