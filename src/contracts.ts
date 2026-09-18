export const PROTOCOL_VERSION = 1
export const SCHEMA_VERSION = 4
/** Versions with an explicit, tested forward migration into this runtime. */
export function isSupportedSchema(version: unknown): version is number { return version === 1 || version === 2 || version === 3 || version === SCHEMA_VERSION }
export const PRODUCT_VERSION = "0.1.0-dev.9"

export type Ownership = "experienced" | "told" | "observed"
export type ExperienceKind = "user_message" | "assistant_message" | "tool_success" | "tool_failure" | "tool_unknown" | "preference" | "correction" | "observation"
export type ExperienceInput = {
  sourceKey: string
  scope: string
  kind: ExperienceKind
  ownership: Ownership
  text: string
  observedAt?: number
  evidence?: Record<string, unknown>
  private?: boolean
}
export type Experience = ExperienceInput & { id: number; observedAt: number; recordedAt: number; retracted: boolean }
export type MemoryKind = "preference" | "fact" | "inference" | "episode" | "commitment"
export type MemoryClaim = {
  subject: string
  attribution: "user_statement" | "reported" | "inference"
  validFrom: number | null
  validUntil: number | null
  reviewedAt: number
  extractionId: string
}
export type Memory = {
  id: string
  revision: number
  scope: string
  kind: MemoryKind
  text: string
  sourceIds: number[]
  status: "active" | "superseded" | "forgotten" | "invalidated"
  pinned: boolean
  private: boolean
  createdAt: number
  /** Earliest root observation supporting this memory; archival time is not event age. */
  sourceObservedAt?: number
  updatedAt: number
  supersedes: string | null
  claim?: MemoryClaim
}
export type Affect = { emotion: number[]; mood: number[]; updatedAt: number; lastSourceId: number | null; reason: string }
export type TaskStatus = "ready" | "running" | "waiting" | "verifying" | "completed" | "failed" | "cancelled"
export type Task = { id: string; title: string; scope: string; status: TaskStatus; sessionId: string | null; createdAt: number; updatedAt: number; error: string | null }
/** Tool/process outcome evidence. It never asserts that a user's task was achieved. */
export type ActionExecution = {
  version: 1
  lifecycle: "completed" | "failed" | "unknown"
  outcome: "succeeded" | "failed" | "unknown"
  basis: string
  exitCode?: number | null
  startedAt?: number
  finishedAt?: number
}
export type Action = { id: string; taskId: string; tool: string; status: "running" | "succeeded" | "failed" | "unknown"; text: string; revision: string; updatedAt: number; execution?: ActionExecution }
export type ChatMessage = { id: string; taskId: string; role: "user" | "assistant" | "system"; text: string; createdAt: number }
export type SleepReport = { id: string; status: "completed" | "paused" | "failed"; fromCursor: number; toCursor: number; examined: number; created: number; startedAt: number; finishedAt: number; detail: string }
export type CheckpointInfo = { generation: string; identityId: string; createdAt: number; schemaVersion: number; sha256: string; revision: number; parent: string | null }
