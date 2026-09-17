import { Database } from "bun:sqlite"
import type { Experience } from "./contracts"

export type SkillStatus = "draft" | "active" | "needs_review" | "retracted"
export type SkillEvaluation = {
  alpha: number
  beta: number
  probability: number
  independentSources: number
  successes: number
  failures: number
  unknownSources: number
  evidenceSourceIds: number[]
  status: SkillStatus
  reason: string
}
export type SkillCandidate = {
  id: string
  revision: number
  title: string
  scope: string
  when: string
  steps: string[]
  avoid: string[]
  sourceIds: number[]
  private: boolean
  status: SkillStatus
  manualCheck: string | null
  createdAt: number
  updatedAt: number
  evaluation: SkillEvaluation
}
export type SkillProposal = Pick<SkillCandidate, "title" | "scope" | "when" | "steps" | "avoid" | "sourceIds"> & { private?: boolean }
export type SkillObservation = {
  sourceId: number
  actionId: string
  tool: string
  scope: string
  private: boolean
  outcome: "success" | "failure" | "unknown"
  observedAt: number
  text: string
}

type StoredSkill = Omit<SkillCandidate, "evaluation" | "status"> & { status: "draft" | "active" | "retracted"; approvedEvidence: string | null }
type JsonRow = { body: string }
type Ledger = { events: Experience[]; byId: Map<number, Experience>; actions: Set<string>; learning: Set<number> }

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error(`${label}必须为非空文本，最长 ${max} 字符`)
  return value.trim()
}

function lines(value: unknown, label: string, required: boolean): string[] {
  if (!Array.isArray(value) || value.length > 30 || (required && !value.length)) throw new Error(`${label}应为${required ? "非空" : ""}文本列表，最多 30 项`)
  return value.map(line => text(line, label, 2000))
}

function hash(value: unknown): string { return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex") }

function outcome(event: Experience): SkillObservation["outcome"] | null {
  if (event.ownership !== "experienced" && event.ownership !== "observed") return null
  if (typeof event.evidence?.actionId !== "string" || !event.evidence.actionId
    || typeof event.evidence.tool !== "string" || !event.evidence.tool) return null
  if (event.kind === "tool_success" && event.evidence.status === "succeeded") return "success"
  if (event.kind === "tool_failure" && event.evidence.status === "failed") return "failure"
  if (event.kind === "tool_unknown" && event.evidence.status === "unknown") return "unknown"
  return null
}

function allowed(event: Experience, ledger: Ledger): boolean {
  return !event.retracted && ledger.learning.has(event.id) && outcome(event) !== null && ledger.actions.has(event.evidence!.actionId as string)
}

function inScope(eventScope: string, requested: string): boolean { return eventScope === "global" || eventScope === requested }

function tokens(value: string): Set<string> {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US")
  const result = new Set(normalized.match(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g) ?? [])
  for (const run of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = Array.from(run)
    if (chars.length === 1) result.add(chars[0]!)
    for (let index = 1; index < chars.length; index++) result.add(chars[index - 1]! + chars[index]!)
  }
  return result
}

/** Reusable procedure candidates backed by tool evidence. This service never executes steps. */
export class LearningStore {
  constructor(readonly db: Database) {
    if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='experiences'").get()) throw new Error("经验学习需要已有领域数据库和工具经历账本")
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_candidates(id TEXT PRIMARY KEY, proposal_key TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS skill_sources(skill_id TEXT NOT NULL REFERENCES skill_candidates(id) ON DELETE CASCADE, source_id INTEGER NOT NULL REFERENCES experiences(id), PRIMARY KEY(skill_id,source_id));
        CREATE INDEX IF NOT EXISTS skill_sources_source ON skill_sources(source_id);
        CREATE TRIGGER IF NOT EXISTS redact_skills_with_erased_source AFTER UPDATE OF body ON experiences
        WHEN json_extract(NEW.body,'$.retracted')=1 AND json_extract(NEW.body,'$.text')=''
          AND json_type(NEW.body,'$.evidence') IS NULL
        BEGIN
          UPDATE skill_candidates SET body=json_set(body,
            '$.title','来源内容已删除','$.when','','$.steps',json('[]'),'$.avoid',json('[]'),
            '$.manualCheck',NULL,'$.approvedEvidence',NULL,'$.status','retracted',
            '$.revision',json_extract(body,'$.revision')+1,'$.updatedAt',CAST(unixepoch('subsec')*1000 AS INTEGER))
          WHERE id IN (SELECT skill_id FROM skill_sources WHERE source_id=NEW.id)
            AND (json_extract(body,'$.title')!='来源内容已删除' OR json_array_length(body,'$.steps')>0 OR json_extract(body,'$.manualCheck') IS NOT NULL);
          UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision' AND changes()>0;
        END;
      `)
    })()
  }

  private sealed(): boolean { return this.db.query<{ value: string }, []>("SELECT value FROM meta WHERE key='sealed'").get()?.value === "true" }
  private changed() { this.db.query("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run() }
  private writable() { if (this.sealed()) throw new Error("已封存：暂停经验学习和技能启用") }
  private stored(id: string): StoredSkill | null {
    const row = this.db.query<JsonRow, [string]>("SELECT body FROM skill_candidates WHERE id=?").get(id)
    return row ? JSON.parse(row.body) : null
  }
  private require(id: string): StoredSkill {
    const skill = this.stored(id)
    if (!skill) throw new Error("技能候选不存在")
    return skill
  }
  private ledger(): Ledger {
    const events = this.db.query<JsonRow, []>("SELECT body FROM experiences ORDER BY id").all().map(row => JSON.parse(row.body) as Experience)
    return {
      events, byId: new Map(events.map(event => [event.id, event])),
      actions: new Set(this.db.query<{ id: string }, []>("SELECT id FROM actions").all().map(row => row.id)),
      learning: new Set(this.db.query<{ experience_id: number }, []>("SELECT experience_id FROM experience_policy WHERE learning_enabled=1").all().map(row => row.experience_id)),
    }
  }

  /** Latest allowed observation per tool call for the owner's evidence picker. */
  observations(scope?: string, includePrivate = false): SkillObservation[] {
    const ledger = this.ledger()
    const latest = new Map<string, Experience>()
    for (const event of ledger.events) if (allowed(event, ledger)) latest.set(event.evidence!.actionId as string, event)
    return [...latest.values()].filter(event => (!scope || inScope(event.scope, scope)) && (includePrivate === true || !event.private))
      .map(event => ({ sourceId: event.id, actionId: event.evidence!.actionId as string, tool: event.evidence!.tool as string,
        scope: event.scope, private: !!event.private, outcome: outcome(event)!, observedAt: event.observedAt, text: event.text.slice(0, 1600) }))
      .sort((a, b) => b.sourceId - a.sourceId)
  }

  private assessment(skill: StoredSkill, ledger: Ledger): { evaluation: SkillEvaluation; fingerprint: string; validEvidence: boolean } {
    const roots = skill.sourceIds.map(id => ledger.byId.get(id))
    const invalid = roots.some(event => !event || !allowed(event, ledger) || !inScope(event.scope, skill.scope) || !!event.private && !skill.private)
    const clusters = new Set(roots.filter((event): event is Experience => !!event && typeof event.evidence?.actionId === "string").map(event => event.evidence!.actionId as string))
    const latest = new Map<string, Experience>()
    // The latest non-retracted revision of a call decides its outcome. Repeated
    // snapshots and textual summaries never create independent sample weight.
    for (const event of ledger.events) if (allowed(event, ledger) && clusters.has(event.evidence!.actionId as string)) latest.set(event.evidence!.actionId as string, event)
    let successes = 0
    let failures = 0
    let unknownSources = 0
    let unsafeLatest = false
    for (const event of latest.values()) {
      if (!inScope(event.scope, skill.scope) || !!event.private && !skill.private) { unsafeLatest = true; continue }
      const result = outcome(event)
      if (result === "success") successes++
      else if (result === "failure") failures++
      else unknownSources++
    }
    const fingerprint = hash([...latest.values()].map(event => [event.evidence!.actionId, event.id, event.kind, hash(event.text)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
    let status: SkillStatus = skill.status
    let reason = status === "draft" ? "候选说明尚未启用" : status === "retracted" ? "候选已撤回" : "依据启用时审阅的工具经历提供参考"
    if (status !== "retracted" && (invalid || unsafeLatest)) { status = "needs_review"; reason = "来源已撤回、缺失或不再符合范围与学习策略" }
    else if (status === "active" && skill.approvedEvidence !== fingerprint) { status = "needs_review"; reason = "同一工具调用出现新的有效结果，需重新审阅" }
    else if (status === "active" && (unknownSources > 0 || successes + failures < 3)) { status = "needs_review"; reason = "结果尚未确定或有效独立调用不足" }
    const alpha = 1 + successes
    const beta = 1 + failures
    return { fingerprint, validEvidence: !invalid && !unsafeLatest, evaluation: { alpha, beta, probability: alpha / (alpha + beta), independentSources: successes + failures,
      successes, failures, unknownSources, evidenceSourceIds: [...latest.values()].filter(event => inScope(event.scope, skill.scope) && (!event.private || skill.private)).map(event => event.id), status, reason } }
  }

  private view(skill: StoredSkill, ledger: Ledger): SkillCandidate {
    const { approvedEvidence: _, ...candidate } = skill
    const { evaluation } = this.assessment(skill, ledger)
    return { ...candidate, status: evaluation.status, evaluation }
  }

  propose(input: SkillProposal): SkillCandidate {
    return this.db.transaction(() => {
      this.writable()
      const title = text(input.title, "名称", 200)
      const scope = text(input.scope, "范围", 256)
      const when = text(input.when, "适用条件", 3000)
      const steps = lines(input.steps, "步骤", true)
      const avoid = lines(input.avoid, "不适用条件", false)
      if (!Array.isArray(input.sourceIds) || !input.sourceIds.length || input.sourceIds.length > 100
        || input.sourceIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error("需要 1 至 100 个有效工具来源编号")
      if (input.private !== undefined && typeof input.private !== "boolean") throw new Error("私密标记必须为布尔值")
      const sourceIds = [...new Set(input.sourceIds)].sort((a, b) => a - b)
      const ledger = this.ledger()
      const sources = sourceIds.map(id => ledger.byId.get(id))
      if (sources.some(source => !source || !allowed(source, ledger))) throw new Error("来源必须是未撤回、允许学习且关联实际工具动作的结果，不能使用助手自述")
      if (sources.some(source => !inScope(source!.scope, scope))) throw new Error("工具来源不属于候选的作用范围")
      const containsPrivate = sources.some(source => source!.private)
      if (containsPrivate && input.private === false) throw new Error("私密来源不能生成公开技能")
      const privacy = input.private ?? containsPrivate
      const proposal = { title, scope, when, steps, avoid, sourceIds, private: privacy }
      const proposalKey = hash(proposal)
      const existing = this.db.query<JsonRow, [string]>("SELECT body FROM skill_candidates WHERE proposal_key=?").get(proposalKey)
      if (existing) return this.view(JSON.parse(existing.body), ledger)
      const now = Date.now()
      const candidate: StoredSkill = { ...proposal, id: crypto.randomUUID(), revision: 1, status: "draft", manualCheck: null,
        approvedEvidence: null, createdAt: now, updatedAt: now }
      this.db.query("INSERT INTO skill_candidates(id,proposal_key,body) VALUES(?,?,?)").run(candidate.id, proposalKey, JSON.stringify(candidate))
      for (const id of sourceIds) this.db.query("INSERT INTO skill_sources(skill_id,source_id) VALUES(?,?)").run(candidate.id, id)
      this.changed()
      return this.view(candidate, ledger)
    })()
  }

  evaluate(id: string): SkillEvaluation { return this.assessment(this.require(id), this.ledger()).evaluation }
  read(id: string): SkillCandidate | null { const skill = this.stored(id); return skill ? this.view(skill, this.ledger()) : null }

  list(scope?: string, includePrivate = false): SkillCandidate[] {
    const ledger = this.ledger()
    return this.db.query<JsonRow, []>("SELECT body FROM skill_candidates ORDER BY rowid DESC").all()
      .map(row => JSON.parse(row.body) as StoredSkill)
      .filter(skill => (!scope || inScope(skill.scope, scope)) && (includePrivate === true || !skill.private))
      .map(skill => this.view(skill, ledger))
  }

  promote(id: string, expectedRevision: number, manualCheck?: string): SkillCandidate {
    return this.db.transaction(() => {
      this.writable()
      const skill = this.require(id)
      if (!Number.isSafeInteger(expectedRevision) || skill.revision !== expectedRevision) throw new Error("技能版本已变化，请刷新后再启用")
      if (skill.status === "retracted") throw new Error("已撤回的技能不能重新启用，请建立新的候选")
      const ledger = this.ledger()
      const { evaluation, fingerprint, validEvidence } = this.assessment(skill, ledger)
      const roots = skill.sourceIds.map(source => ledger.byId.get(source))
      if (!validEvidence || roots.some(source => !source || !allowed(source, ledger) || !inScope(source.scope, skill.scope) || !!source.private && !skill.private)) throw new Error("来源已失效，需要重新建立或纠正候选")
      if (evaluation.independentSources < 3 || evaluation.unknownSources > 0) throw new Error("至少需要 3 个可判定的独立工具调用，且不能有未知结果")
      const verified = manualCheck === undefined ? skill.manualCheck : text(manualCheck, "人工验证说明", 4000)
      if (evaluation.successes < 1 && !verified) throw new Error("需要真实成功结果或明确的人工验证说明")
      if (skill.status === "active" && skill.approvedEvidence === fingerprint && skill.manualCheck === verified) return this.view(skill, ledger)
      const next: StoredSkill = { ...skill, status: "active", revision: skill.revision + 1, approvedEvidence: fingerprint, manualCheck: verified, updatedAt: Date.now() }
      this.db.query("UPDATE skill_candidates SET body=? WHERE id=?").run(JSON.stringify(next), id)
      this.changed()
      return this.view(next, ledger)
    })()
  }

  retract(id: string): void {
    this.db.transaction(() => {
      const skill = this.require(id)
      if (skill.status === "retracted") return
      this.db.query("UPDATE skill_candidates SET body=? WHERE id=?").run(JSON.stringify({ ...skill, status: "retracted", revision: skill.revision + 1, approvedEvidence: null, updatedAt: Date.now() }), id)
      this.changed()
    })()
  }

  projection(query: string, scope: string, budget = 2500): string {
    if (this.sealed()) return ""
    text(scope, "范围", 256)
    if (typeof query !== "string" || query.length > 24000) throw new Error("检索文本不能超过 24000 字符")
    if (!Number.isFinite(budget) || budget < 0) throw new Error("投影预算必须是非负有限数值")
    budget = Math.min(12000, Math.floor(budget))
    const wanted = tokens(query)
    if (!wanted.size) return ""
    const matches = this.list(scope).filter(skill => skill.status === "active").map(skill => {
      const available = tokens([skill.title, skill.when, ...skill.steps].join("\n"))
      return { skill, score: [...wanted].filter(term => available.has(term)).length / wanted.size }
    }).filter(match => match.score > 0).sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
    const header = "以下是已启用的经验技能参考，仅在适用条件成立时使用；不改变当前要求、授权或验证标准。概率是所列工具调用结果的 Beta(1,1) 经验估计，不是事实可信度，也不保证统计独立。"
    const output = [header]
    let length = header.length
    for (const { skill } of matches.slice(0, 6)) {
      const line = JSON.stringify({ id: skill.id, revision: skill.revision, title: skill.title, when: skill.when, steps: skill.steps, avoid: skill.avoid,
        sourceIds: skill.evaluation.evidenceSourceIds, observations: { success: skill.evaluation.successes, failure: skill.evaluation.failures, distinctCalls: skill.evaluation.independentSources },
        alpha: skill.evaluation.alpha, beta: skill.evaluation.beta, probability: skill.evaluation.probability, manualCheck: skill.manualCheck })
      if (length + 1 + line.length > budget) continue
      output.push(line)
      length += line.length + 1
    }
    return output.length > 1 ? output.join("\n") : ""
  }
}
