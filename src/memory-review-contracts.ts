import type { Memory, MemoryClaim, MemoryKind } from "./contracts"

export type MemoryProposal = {
  text: string; subject: string; kind: MemoryKind; attribution: MemoryClaim["attribution"]; timeNote: string
  evidence: Array<{ sourceId: number; quote: string }>; relatedMemoryIds: string[]
}
export type MemoryCandidate = MemoryProposal & {
  id: string; batchId: string; taskId: string; scope: string; revision: number
  status: "pending" | "accepted" | "rejected" | "invalidated" | "erased"
  memoryId: string | null; createdAt: number
}
export type MemoryReviewBatch = {
  id: string; taskId: string; scope: string; status: "running" | "completed" | "failed" | "interrupted" | "redacted"
  policy: "conversation-memory-v1"; sealEpoch: string; sourceIds: number[]; sourceHashes: Record<string, string>; inputHash: string
  related: Array<{ id: string; revision: number }>; sessionId: string | null; messageId: string | null
  cleanup: "not_created" | "pending" | "deleted"
  model: { providerID: string; modelID: string } | null; createdAt: number; finishedAt: number | null; error: string | null
}
export type MemoryReviewView = { revision: number; batches: MemoryReviewBatch[]; candidates: MemoryCandidate[]; memories: Memory[] }
export type AcceptMemoryCandidate = {
  revision: number; reviewRevision: number; text: string; subject: string; kind: MemoryKind
  attribution: MemoryClaim["attribution"]; validFrom: number | null; validUntil: number | null
  private: boolean; pinned: boolean
  resolution: { type: "add" } | { type: "replace"; memoryId: string; revision: number }
}
