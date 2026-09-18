/** Drafts are private editing state; they never become knowledge or memories. */
export type WorkspaceDraft = {
  id: string; rootPath: string; path: string; revision: number
  baseSha256: string; text: string; bytes: number; updatedAt: number
}
export type WorkspaceDraftSummary = Omit<WorkspaceDraft, "text">
export type WorkspaceDraftState = { draft: WorkspaceDraft | null; draftRevision: number }
export type WorkspaceDraftInput = { revision: number; key: string; text: string; baseSha256: string }
export type WorkspaceDraftList = { drafts: WorkspaceDraftSummary[]; totalBytes: number; byteLimit: number; countLimit: number }
