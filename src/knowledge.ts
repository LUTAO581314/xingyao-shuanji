import { Database } from "bun:sqlite"
import { open, realpath } from "node:fs/promises"
import { basename, extname, isAbsolute, normalize, resolve } from "node:path"

export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024

export type DocumentSummary = {
  id: string
  path: string
  name: string
  scope: string
  private: boolean
  contentHash: string
  bytes: number
  lineCount: number
  chunkCount: number
  revision: number
  createdAt: number
  updatedAt: number
}

export type KnowledgeHit = {
  documentId: string
  path: string
  name: string
  scope: string
  private: boolean
  contentHash: string
  startLine: number
  endLine: number
  text: string
  score: number
}

type DocumentRow = { body: string }
type Chunk = { startLine: number; endLine: number; text: string }
type SearchRow = { body: string; start_line: number; end_line: number; text: string; matched: number }

const EXTENSIONS = new Set([
  ".txt", ".md", ".mdx", ".markdown", ".json", ".jsonc", ".csv", ".tsv",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go",
  ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".css", ".scss", ".html",
  ".xml", ".sql", ".sh", ".ps1", ".bat", ".cmd", ".yaml", ".yml", ".toml",
  ".ini", ".rb", ".php", ".swift", ".kt", ".lua", ".vue", ".svelte",
])
const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".git", ".ssh", ".aws", ".gnupg"])
const SENSITIVE_NAMES = new Set(["auth.json", "opencode.json", "opencode.jsonc", ".npmrc", ".pypirc", ".netrc", "id_rsa", "id_ed25519", "id_ecdsa"])

function hash(value: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function checkPath(path: string) {
  if (!path || path.includes("\0") || !isAbsolute(path)) throw new Error("请选择绝对路径的单个本地文件")
  // Device/stream paths bypass ordinary filename checks and are not document imports.
  if (/^\\\\[?.]\\/.test(path) || (process.platform === "win32" && path.slice(2).includes(":"))) {
    throw new Error("不支持设备路径或备用数据流")
  }
  const pieces = normalize(path).split(/[\\/]/).filter(Boolean).map(piece => piece.toLowerCase())
  if (pieces.some(piece => EXCLUDED_DIRECTORIES.has(piece))) throw new Error("该目录不参与知识导入")
  const name = basename(path).toLowerCase()
  if (name === ".env" || name.startsWith(".env.") || SENSITIVE_NAMES.has(name)
    || /(?:^|[._-])(?:credentials?|secrets?|tokens?)(?:[._-]|$)/.test(name)
    || /\.(?:pem|key|pfx|p12|keystore)$/.test(name)) throw new Error("凭据或敏感配置文件不能导入知识库")
  if (!EXTENSIONS.has(extname(name)) && !["readme", "license", "dockerfile", "makefile"].includes(name)) {
    throw new Error("仅支持 UTF-8 文本、Markdown、JSON、CSV 和代码文件；PDF/OCR 暂不支持")
  }
}

function searchable(text: string): string { return text.normalize("NFKC").toLocaleLowerCase("en-US") }

function keywords(text: string): Set<string> {
  const found = new Set<string>()
  const source = searchable(text)
  for (const run of source.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = Array.from(run)
    for (let index = 0; index < chars.length; index++) {
      found.add(`h:${chars[index]}`)
      if (index) found.add(`h:${chars[index - 1]}${chars[index]}`)
    }
  }
  for (const word of source.match(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g) ?? []) found.add(`w:${word}`)
  return found
}

function queryKeywords(text: string): string[] {
  const normalized = searchable(text)
  const all = keywords(normalized)
  // Single characters are useful for single-character requests. For phrases,
  // prefer bigrams so unrelated documents do not match only common characters.
  for (const run of normalized.match(/\p{Script=Han}{2,}/gu) ?? []) {
    for (const character of Array.from(run)) all.delete(`h:${character}`)
  }
  return [...all].slice(0, 64)
}

function splitChunks(text: string): { chunks: Chunk[]; lineCount: number } {
  if (!text) return { chunks: [], lineCount: 0 }
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const chunks: Chunk[] = []
  let pending: string[] = []
  let size = 0
  let start = 1
  let end = 1
  const flush = () => {
    if (pending.length) chunks.push({ startLine: start, endLine: end, text: pending.join("\n") })
    pending = []
    size = 0
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (line.length > 2400) {
      flush()
      // Unicode code points prevent splitting a surrogate pair in long source lines.
      const points = Array.from(line)
      for (let offset = 0; offset < points.length; offset += 2280) {
        chunks.push({ startLine: index + 1, endLine: index + 1, text: points.slice(offset, offset + 2400).join("") })
        if (offset + 2400 >= points.length) break
      }
      continue
    }
    if (pending.length && (size + line.length + 1 > 2400 || pending.length >= 60)) flush()
    if (!pending.length) start = index + 1
    pending.push(line)
    end = index + 1
    size += line.length + 1
  }
  flush()
  return { chunks, lineCount: lines.length }
}

async function readText(path: string): Promise<{ bytes: Uint8Array; text: string }> {
  const handle = await open(path, "r")
  try {
    const before = await handle.stat()
    if (!before.isFile()) throw new Error("请指定单个普通文件；不会递归扫描目录")
    if (before.size > MAX_DOCUMENT_BYTES) throw new Error("文件超过 2 MiB 导入上限")
    const buffer = Buffer.alloc(MAX_DOCUMENT_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    if (length > MAX_DOCUMENT_BYTES) throw new Error("文件超过 2 MiB 导入上限")
    const after = await handle.stat()
    if (before.size !== length || after.size !== length || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("文件在读取期间发生变化，请重试")
    }
    const bytes = buffer.subarray(0, length)
    let text: string
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes) }
    catch { throw new Error("文件不是有效的 UTF-8 文本") }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) throw new Error("文件包含二进制控制字符，不能作为文本导入")
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) throw new Error("检测到私钥内容，不能导入知识库")
    return { bytes, text }
  } finally { await handle.close() }
}

/** Single-writer domain service. File I/O finishes before the synchronous commit. */
export class KnowledgeStore {
  constructor(readonly db: Database) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT OR IGNORE INTO meta(key,value) VALUES('revision','0');
        CREATE TABLE IF NOT EXISTS knowledge_documents(id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, private INTEGER NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS knowledge_chunks(id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, text TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS knowledge_chunks_document ON knowledge_chunks(document_id);
        CREATE TABLE IF NOT EXISTS knowledge_terms(term TEXT NOT NULL, chunk_id TEXT NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE, PRIMARY KEY(term,chunk_id));
        CREATE INDEX IF NOT EXISTS knowledge_terms_chunk ON knowledge_terms(chunk_id);
      `)
    })()
  }

  private document(id: string): DocumentSummary | null {
    const row = this.db.query<DocumentRow, [string]>("SELECT body FROM knowledge_documents WHERE id=?").get(id)
    return row ? JSON.parse(row.body) : null
  }

  /** Metadata for the owner's management interface; search has separate privacy filtering. */
  documents(): DocumentSummary[] {
    return this.db.query<DocumentRow, []>("SELECT body FROM knowledge_documents ORDER BY path").all().map(row => JSON.parse(row.body))
  }

  private changed() { this.db.query("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'").run() }

  private clearChunks(id: string) {
    this.db.query("DELETE FROM knowledge_terms WHERE chunk_id IN (SELECT id FROM knowledge_chunks WHERE document_id=?)").run(id)
    this.db.query("DELETE FROM knowledge_chunks WHERE document_id=?").run(id)
  }

  async importFile(path: string, scope: string, options: { private?: boolean } = {}): Promise<DocumentSummary> {
    if (typeof scope !== "string" || !scope.trim() || scope.length > 256) throw new Error("资料范围不能为空，且不能超过 256 字符")
    if (typeof path !== "string") throw new Error("请选择单个文件路径")
    if (options.private !== undefined && typeof options.private !== "boolean") throw new Error("私密标记必须是布尔值")
    checkPath(path)
    const canonical = normalize(await realpath(resolve(path)))
    checkPath(canonical)
    const known = this.db.query<DocumentRow, [string]>("SELECT body FROM knowledge_documents WHERE path=? COLLATE NOCASE").get(canonical)
    const id = known ? (JSON.parse(known.body) as DocumentSummary).id : hash(process.platform === "win32" ? canonical.toLowerCase() : canonical)
    const baseline = this.document(id)
    const { bytes, text } = await readText(canonical)
    const contentHash = hash(bytes)
    const { chunks, lineCount } = splitChunks(text)
    const chunkTerms = chunks.map(chunk => [...keywords(chunk.text)])
    const privacy = options.private ?? baseline?.private ?? false
    return this.db.transaction(() => {
      const previous = this.document(id)
      if (previous?.contentHash === contentHash && previous.scope === scope && previous.private === privacy) return previous
      if (previous?.revision !== baseline?.revision) throw new Error("资料在导入期间已被更新，请刷新后重试")
      const now = Date.now()
      const result: DocumentSummary = {
        id, path: canonical, name: basename(canonical), scope, private: privacy, contentHash,
        bytes: bytes.byteLength, lineCount, chunkCount: chunks.length,
        revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now,
      }
      this.db.query("INSERT INTO knowledge_documents(id,path,scope,private,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,scope=excluded.scope,private=excluded.private,body=excluded.body")
        .run(id, canonical, scope, Number(privacy), JSON.stringify(result))
      this.clearChunks(id)
      const insertChunk = this.db.query("INSERT INTO knowledge_chunks(id,document_id,start_line,end_line,text) VALUES(?,?,?,?,?)")
      const insertTerm = this.db.query("INSERT INTO knowledge_terms(term,chunk_id) VALUES(?,?)")
      chunks.forEach((chunk, index) => {
        const chunkId = `${id}:${index}`
        insertChunk.run(chunkId, id, chunk.startLine, chunk.endLine, chunk.text)
        for (const term of chunkTerms[index]!) insertTerm.run(term, chunkId)
      })
      this.changed()
      return result
    })()
  }

  async refresh(id: string): Promise<DocumentSummary> {
    const doc = this.document(id)
    if (!doc) throw new Error("资料不存在")
    return this.importFile(doc.path, doc.scope, { private: doc.private })
  }

  /** Apply only a verified file-manager move; content and stable document ID stay linked. */
  async relocate(source: string, destination: string, expectedHash: string): Promise<void> {
    const row = this.db.query<DocumentRow, [string]>("SELECT body FROM knowledge_documents WHERE path=? COLLATE NOCASE").get(normalize(resolve(source)))
    if (!row) return
    const previous = JSON.parse(row.body) as DocumentSummary
    checkPath(destination)
    const canonical = normalize(await realpath(destination))
    checkPath(canonical)
    const read = await readText(canonical)
    if (hash(read.bytes) !== expectedHash) throw new Error("整理后文件内容已变化，资料引用未自动更新")
    const conflicting = this.db.query<{ id: string }, [string]>("SELECT id FROM knowledge_documents WHERE path=? COLLATE NOCASE").get(canonical)
    if (conflicting && conflicting.id !== previous.id) throw new Error("目标已关联另一份资料，请检查引用")
    this.db.transaction(() => {
      const current = this.document(previous.id)
      if (!current || current.revision !== previous.revision) throw new Error("资料已变化，请重新核对文件引用")
      const next = { ...current, path: canonical, name: basename(canonical), revision: current.revision + 1, updatedAt: Date.now() }
      this.db.query("UPDATE knowledge_documents SET path=?,body=? WHERE id=?").run(canonical, JSON.stringify(next), current.id)
      this.changed()
    })()
    if (previous.contentHash !== expectedHash) await this.refresh(previous.id)
  }

  search(query: string, scope: string, options: { includePrivate?: boolean; limit?: number } = {}): KnowledgeHit[] {
    if (typeof query !== "string" || query.length > 2000) throw new Error("检索文本不能超过 2000 字符")
    if (typeof scope !== "string" || !scope.trim()) throw new Error("检索需要明确的资料范围")
    const wanted = queryKeywords(query)
    if (!wanted.length) return []
    if (options.limit !== undefined && (typeof options.limit !== "number" || !Number.isFinite(options.limit))) throw new Error("检索数量必须是有限数值")
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 8)))
    const rows = this.db.query<SearchRow, (string | number)[]>(`
      SELECT d.body,c.start_line,c.end_line,c.text,COUNT(*) AS matched
      FROM knowledge_terms t JOIN knowledge_chunks c ON c.id=t.chunk_id
      JOIN knowledge_documents d ON d.id=c.document_id
      WHERE t.term IN (${wanted.map(() => "?").join(",")})
        AND (d.scope=? OR d.scope='global') AND (d.private=0 OR ?=1)
      GROUP BY c.id ORDER BY matched DESC,c.id LIMIT 200
    `).all(...wanted, scope, Number(options.includePrivate === true))
    const phrase = searchable(query).trim()
    return rows.map(row => {
      const doc: DocumentSummary = JSON.parse(row.body)
      return {
        documentId: doc.id, path: doc.path, name: doc.name, scope: doc.scope, private: doc.private,
        contentHash: doc.contentHash, startLine: row.start_line, endLine: row.end_line, text: row.text,
        score: searchable(row.text).includes(phrase) ? 1 : row.matched / wanted.length,
      }
    }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine).slice(0, limit)
  }

  remove(id: string): void {
    this.db.transaction(() => {
      if (!this.document(id)) return
      this.clearChunks(id)
      this.db.query("DELETE FROM knowledge_documents WHERE id=?").run(id)
      this.changed()
    })()
  }
}
