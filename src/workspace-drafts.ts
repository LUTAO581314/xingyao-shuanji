import { isAbsolute, resolve } from "node:path"
import { SoulStore, ConflictError } from "./store"
import { MAX_WORKSPACE_FILE_BYTES, WorkspaceFileError } from "./workspace-files"
import type { WorkspaceDraft, WorkspaceDraftInput, WorkspaceDraftList, WorkspaceDraftState } from "./workspace-draft-contracts"

export const MAX_DRAFT_BYTES = 16 * 1024 * 1024
export const MAX_DRAFT_COUNT = 32
type Row = { id: string; root_path: string; relative_path: string; revision: number; body: string | null; operation_key: string; operation_hash: string }
const digest = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")
const locationKey = (rootPath: string, path: string) => digest(process.platform === "win32" ? [resolve(rootPath).toLowerCase(), path.toLowerCase()] : [resolve(rootPath), path])

/** Single-writer editing state with compare-and-swap revisions and tombstones.
 * Updating a draft cannot write its source file, import knowledge, or learn it. */
export class WorkspaceDraftStore {
  constructor(readonly store: SoulStore) {}
  private row(rootPath: string, path: string) {
    return this.store.db.query<Row, [string]>("SELECT * FROM workspace_drafts WHERE id=?").get(locationKey(rootPath, path))
  }
  private state(row: Row | null): WorkspaceDraftState { return { draft: row?.body ? JSON.parse(row.body) : null, draftRevision: row?.revision ?? 0 } }
  private changed(id: string) {
    this.store.setMeta("revision", String(this.store.revision + 1))
    this.store.db.query("INSERT INTO outbox(kind,entity_id,created_at) VALUES(?,?,?)").run("workspace_draft", id, this.store.clock())
  }
  get(rootPath: string, path: string): WorkspaceDraftState { path = draftPath(path); return this.state(this.row(rootPath, path)) }
  /** Owner-authenticated recovery of stored text; grants no filesystem access. */
  getById(id: string): WorkspaceDraftState {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new WorkspaceFileError("invalid", "草稿编号无效")
    return this.state(this.store.db.query<Row, [string]>("SELECT * FROM workspace_drafts WHERE id=?").get(id))
  }
  list(rootPath?: string): WorkspaceDraftList {
    const rows = this.store.db.query<Row, []>("SELECT * FROM workspace_drafts WHERE body IS NOT NULL ORDER BY revision DESC").all()
    const drafts = rows.map(row => JSON.parse(row.body!) as WorkspaceDraft)
    return { drafts: drafts.filter(draft => rootPath === undefined || locationKey(draft.rootPath, "") === locationKey(rootPath, "")).map(({ text: _, ...summary }) => summary).sort((a,b) => b.updatedAt - a.updatedAt),
      totalBytes: drafts.reduce((sum, draft) => sum + draft.bytes, 0), byteLimit: MAX_DRAFT_BYTES, countLimit: MAX_DRAFT_COUNT }
  }
  save(rootPath: string, path: string, input: WorkspaceDraftInput, mode: "edit" | "rebase" = "edit", openedSha256?: string): WorkspaceDraftState {
    path = draftPath(path); validateOperation(input.revision, input.key)
    if (!/^[a-f0-9]{64}$/.test(input.baseSha256) || typeof input.text !== "string" || input.text.length > MAX_WORKSPACE_FILE_BYTES) throw new WorkspaceFileError("invalid", "草稿需要有效的原始版本和不超过 2 MiB 的文本")
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(input.text) || Buffer.from(input.text, "utf8").toString("utf8") !== input.text) throw new WorkspaceFileError("invalid", "草稿不是有效的普通 UTF-8 文本")
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(input.text)) throw new WorkspaceFileError("denied", "检测到私钥内容，不能保存到编辑草稿")
    const bytes = Buffer.byteLength(input.text)
    if (bytes > MAX_WORKSPACE_FILE_BYTES) throw new WorkspaceFileError("invalid", "UTF-8 草稿超过 2 MiB 限额")
    return this.store.db.transaction(() => {
      const row = this.row(rootPath, path), previous = this.state(row), operationHash = digest({ mode, text: input.text, baseSha256: input.baseSha256, revision: input.revision })
      if (row?.operation_key === input.key) { if (row.operation_hash !== operationHash) throw new ConflictError("草稿请求标识已用于不同内容"); return previous }
      if (previous.draftRevision !== input.revision) throw new ConflictError("另一窗口更新或删除了草稿；当前编辑保留，请刷新并合并")
      if (mode === "rebase") {
        if (!previous.draft || openedSha256 !== input.baseSha256) throw new ConflictError("请先读取并核对当前磁盘版本，再确认草稿的新基础")
      } else if (previous.draft ? previous.draft.baseSha256 !== input.baseSha256 : openedSha256 !== input.baseSha256) throw new ConflictError("草稿基础版本不一致；磁盘变化需要明确核对后合并")
      const totals = this.list()
      if (!previous.draft && totals.drafts.length >= MAX_DRAFT_COUNT || totals.totalBytes - (previous.draft?.bytes ?? 0) + bytes > MAX_DRAFT_BYTES) throw new WorkspaceFileError("conflict", "编辑草稿容量已满，请先保存或明确丢弃其他草稿；不会自动删除")
      const id = locationKey(rootPath, path), revision = previous.draftRevision + 1
      const draft: WorkspaceDraft = { id, rootPath: resolve(rootPath), path, revision, text: input.text, baseSha256: input.baseSha256, bytes, updatedAt: this.store.clock() }
      this.store.db.query("INSERT INTO workspace_drafts(id,root_path,relative_path,revision,body,operation_key,operation_hash) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body,operation_key=excluded.operation_key,operation_hash=excluded.operation_hash")
        .run(id, draft.rootPath, path, revision, JSON.stringify(draft), input.key, operationHash)
      this.changed(id)
      return { draft, draftRevision: revision }
    })()
  }
  discard(rootPath: string, path: string, revision: number, key: string): WorkspaceDraftState {
    path = draftPath(path); validateOperation(revision, key)
    return this.store.db.transaction(() => {
      const row = this.row(rootPath, path), previous = this.state(row), operationHash = digest({ mode: "discard", revision })
      if (row?.operation_key === key) { if (row.operation_hash !== operationHash) throw new ConflictError("草稿请求标识已用于不同内容"); return previous }
      if (previous.draftRevision !== revision) throw new ConflictError("草稿已在另一窗口变化，请刷新后再决定是否丢弃")
      if (!row || !previous.draft) return previous
      this.store.db.query("UPDATE workspace_drafts SET revision=?,body=NULL,operation_key=?,operation_hash=? WHERE id=?").run(revision + 1, key, operationHash, row.id)
      this.changed(row.id)
      return { draft: null, draftRevision: revision + 1 }
    })()
  }
}

export function draftPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2048 || isAbsolute(value) || /^[A-Za-z]:|^[/\\]/.test(value)) throw new WorkspaceFileError("denied", "草稿路径必须在已选择的目录内")
  const parts = value.split(/[\\/]/)
  if (parts.some(part => !part || part === "." || part === ".." || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part))) throw new WorkspaceFileError("denied", "草稿路径格式无效")
  return parts.join("/")
}
function validateOperation(revision: unknown, key: unknown) {
  if (!Number.isSafeInteger(revision) || (revision as number) < 0 || typeof key !== "string" || !key.trim() || key.length > 200 || key.includes("\0")) throw new WorkspaceFileError("invalid", "草稿需要当前修订号及请求标识")
}
