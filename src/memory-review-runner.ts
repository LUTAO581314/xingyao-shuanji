import type { OpenCodeAdapter } from "./adapter"
import { ConflictError, SoulStore } from "./store"
import { MEMORY_EXTRACTION_SYSTEM, MemoryReviewStore } from "./memory-review"

type Model = { providerID: string; modelID: string }
export type MemoryReviewSettings = { automatic: boolean; model: Model | null; dailyBatchLimit: number }

/** Background model work has its own durable ledger and never imports engine
 * messages into foreground conversations, tool evidence, affect or skills. */
export class MemoryReviewRunner {
  readonly review: MemoryReviewStore
  readonly jobs = new Map<string, Promise<void>>()
  private cancelled = new Set<string>()
  constructor(readonly store: SoulStore, readonly adapter: () => OpenCodeAdapter) {
    this.review = new MemoryReviewStore(store)
    this.review.recoverInterrupted()
  }
  settings(): MemoryReviewSettings {
    return JSON.parse(this.store.meta("memory_review_settings") || '{"automatic":false,"model":null,"dailyBatchLimit":4}')
  }
  configure(input: MemoryReviewSettings) {
    if (typeof input.automatic !== "boolean" || !Number.isSafeInteger(input.dailyBatchLimit) || input.dailyBatchLimit < 1 || input.dailyBatchLimit > 12) throw new Error("请选择自动整理状态及每天 1–12 批的限额")
    if (input.model !== null && (!input.model || ![input.model.providerID, input.model.modelID].every(value => typeof value === "string" && value.trim() && value.length <= 200 && !value.includes("\0")))) throw new Error("整理模型配置无效")
    this.store.db.transaction(() => {
      this.store.setMeta("memory_review_settings", JSON.stringify({ automatic: input.automatic, dailyBatchLimit: input.dailyBatchLimit,
        model: input.model ? { providerID: input.model.providerID.trim(), modelID: input.model.modelID.trim() } : null }))
      this.store.setMeta("revision", String(this.store.revision + 1))
    })()
    return this.settings()
  }
  start(taskId: string, key: string, model?: Model) {
    const { batch, fresh, input } = this.review.begin(taskId, key, model)
    if (fresh) {
      // Schedule after admission, so the map always contains work before it can
      // finish or fail synchronously.
      const work = Promise.resolve().then(() => this.run(batch.id, input, model)).finally(() => { this.jobs.delete(batch.id); this.cancelled.delete(batch.id) })
      this.jobs.set(batch.id, work)
    }
    return { batchId: batch.id }
  }
  private async run(id: string, input: string, model?: Model) {
    const adapter = this.adapter()
    let sessionID: string | null = null
    try {
      this.review.assertDeliverable(id)
      const session = await adapter.createMemoryExtractionSession(id)
      sessionID = session.id
      this.review.attachSession(id, sessionID)
      if (this.cancelled.has(id)) return
      this.review.assertDeliverable(id)
      const result = await adapter.promptMemoryExtraction(sessionID, input, { system: MEMORY_EXTRACTION_SYSTEM, model, jobID: id })
      if (this.cancelled.has(id)) return
      if (result.status !== "completed" || !result.messageID) throw new Error("模型提取没有完成；不会自动重发本次请求")
      this.review.finish(id, result.text, result.messageID)
    } catch (error) {
      // Adapter errors are fixed contract messages. Parser failures can contain
      // model output in SyntaxError text, so persist only our own bounded label.
      this.review.fail(id, error instanceof ConflictError ? error.message : "本次提取未通过完成或来源检查；可核对对话后重新提取")
    } finally {
      if (sessionID) {
        try { if (await adapter.deleteMemoryExtractionSession(sessionID, id)) this.review.cleaned(id) } catch { /* Durable cleanup state is retried without inference. */ }
      }
    }
  }
  async cancel(reason: string) {
    const active = [...this.jobs.keys()]
    for (const id of active) { this.cancelled.add(id); this.review.fail(id, reason, true) }
    await Promise.allSettled(active.map(async id => {
      const sessionID = this.review.batch(id)?.sessionId
      if (sessionID) await this.adapter().abort(sessionID)
    }))
    await Promise.allSettled(active.map(id => this.jobs.get(id)))
  }
  cleanup() {
    for (const batch of this.review.cleanupPending()) {
      if (!batch.sessionId || this.jobs.has(batch.id)) continue
      const work = Promise.resolve().then(async () => {
        try { if (await this.adapter().deleteMemoryExtractionSession(batch.sessionId!, batch.id)) this.review.cleaned(batch.id) } catch { /* Retry only at a later idle cycle. */ }
      }).finally(() => this.jobs.delete(batch.id))
      this.jobs.set(batch.id, work)
    }
  }
  automatic() {
    const settings = this.settings()
    if (!settings.automatic || this.store.sealed || this.jobs.size) return null
    // Rolling 24-hour admission count includes failed and manual batches. This
    // limits automatic work, not the engine's internal inference loop or price.
    const recent = this.store.db.query<{ count: number }, [number]>("SELECT COUNT(*) AS count FROM memory_review_batches WHERE json_extract(body,'$.createdAt')>=?").get(this.store.clock() - 86400000)!.count
    const pending = this.store.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_review_candidates WHERE json_extract(body,'$.status')='pending'").get()!.count
    if (recent >= settings.dailyBatchLimit || pending >= 64) return null
    const taskId = this.review.nextTask()
    return taskId ? this.start(taskId, `idle:${crypto.randomUUID()}`, settings.model ?? undefined) : null
  }
}
