import type { Database } from "bun:sqlite"
import path from "node:path"
import type { Experience, Memory, MemoryKind } from "./contracts"
import type { DocumentSummary } from "./knowledge"

export type GraphOptions = { scope: string; includePrivate?: boolean; maxNodes?: number; maxEdges?: number }
type NodeBase = { id: string; label: string; scope: string; private: boolean }
export type GraphNode =
  | NodeBase & { kind: "document"; documentId: string; path: string; contentHash: string; revision: number }
  | NodeBase & { kind: "memory"; memoryId: string; memoryKind: MemoryKind; revision: number }
  | NodeBase & { kind: "experience"; experienceId: number; experienceKind: Experience["kind"] }
export type DocumentEvidence = {
  kind: "document"; documentId: string; path: string; contentHash: string
  /** One-based line and UTF-16 column in the imported revision, not the live file. */
  line: number; column: number; snippet: string; rawTarget: string; anchor?: string; alias?: string
}
export type MemoryEvidence = {
  kind: "memory_source"; memoryId: string; experienceId: number; sourceKey: string
  field: "sourceIds"; line: null; column: null; snippet: string
}
export type GraphEdge = {
  id: string; from: string; to: string; type: "wikilink" | "markdown_link" | "memory_source"
  evidence: DocumentEvidence | MemoryEvidence
}
export type UnresolvedLink = {
  from: string; type: "wikilink" | "markdown_link"
  reason: "missing" | "ambiguous" | "external" | "unsupported" | "index_limit" | "node_limit"
  evidence: DocumentEvidence
}
export type KnowledgeGraph = {
  scope: string; includePrivate: boolean; nodes: GraphNode[]; edges: GraphEdge[]; unresolved: UnresolvedLink[]
  truncated: boolean
  truncation: { nodes: boolean; edges: boolean; unresolved: boolean; index: boolean; content: boolean }
  limits: { maxNodes: number; maxEdges: number; maxUnresolved: number; maxIndexedDocuments: number; maxContentCharacters: number }
}

const INDEX_LIMIT = 10_000
const CONTENT_LIMIT = 8 * 1024 * 1024
const docID = (id: string) => `document:${id}`
const memoryID = (id: string) => `memory:${id}`
const sourceID = (id: number) => `experience:${id}`
const clip = (text: string, length: number) => Array.from(text).slice(0, length).join("")
const pathname = (value: string) => /^[A-Za-z]:[\\/]|^\\\\/.test(value) ? path.win32 : path.posix
const pathKey = (value: string) => {
  const api = pathname(value), normalized = api.normalize(value)
  return api === path.win32 || process.platform === "win32" ? normalized.toLowerCase() : normalized
}
const nameKey = (value: string) => process.platform === "win32" ? value.toLowerCase() : value

/** Read-only projection of imported snapshots and persisted source relationships.
 * It never opens source files, traverses directories, or derives similarity edges.
 * The explicit file syntax is wiki links and inline Markdown destinations in
 * Markdown/plain-text documents; reference-style and multiline links are omitted.
 */
export class GraphStore {
  constructor(readonly db: Database) {}

  build(options: GraphOptions): KnowledgeGraph {
    if (!options || typeof options.scope !== "string" || !options.scope.trim() || options.scope.length > 256) throw new Error("图谱需要明确的资料范围，且不能超过 256 字符")
    if (options.includePrivate !== undefined && typeof options.includePrivate !== "boolean") throw new Error("图谱私密标记必须是布尔值")
    const maxNodes = limit(options.maxNodes, 300, 1, 2000)
    const maxEdges = limit(options.maxEdges, 1000, 0, 10_000)
    const includePrivate = options.includePrivate === true
    return this.db.transaction(() => {
      const graph: KnowledgeGraph = {
        scope: options.scope, includePrivate, nodes: [], edges: [], unresolved: [], truncated: false,
        truncation: { nodes: false, edges: false, unresolved: false, index: false, content: false },
        limits: { maxNodes, maxEdges, maxUnresolved: maxEdges, maxIndexedDocuments: INDEX_LIMIT, maxContentCharacters: CONTENT_LIMIT },
      }
      const tables = new Set(this.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name))
      // Filter in SQL before materializing metadata or cached source text. Global
      // means globally shared sources; it never means every project's sources.
      const rows = tables.has("knowledge_documents") ? this.db.query<{ id: string; path: string; scope: string; private: number; body: string }, [string, number, number]>(
        "SELECT id,path,scope,private,body FROM knowledge_documents WHERE (scope=? OR scope='global') AND (private=0 OR ?=1) ORDER BY path,id LIMIT ?",
      ).all(options.scope, Number(includePrivate), INDEX_LIMIT + 1) : []
      const documents = rows.slice(0, INDEX_LIMIT).map(row => ({ ...JSON.parse(row.body) as DocumentSummary, id: row.id, path: row.path, scope: row.scope, private: row.private !== 0 }))
      const indexIncomplete = rows.length > INDEX_LIMIT
      graph.truncation.index = indexIncomplete
      const paths = new Map<string, DocumentSummary[]>(), names = new Map<string, DocumentSummary[]>()
      for (const doc of documents) {
        push(paths, pathKey(doc.path), doc)
        const api = pathname(doc.path), name = api.basename(doc.path), stem = api.basename(doc.path, api.extname(doc.path))
        push(names, nameKey(name), doc)
        if (stem !== name) push(names, nameKey(stem), doc)
      }
      const nodeIDs = new Set<string>()
      const addNode = (node: GraphNode) => {
        if (nodeIDs.has(node.id)) return true
        if (graph.nodes.length >= maxNodes) { graph.truncation.nodes = true; return false }
        nodeIDs.add(node.id); graph.nodes.push(node); return true
      }
      for (const doc of documents) addNode({ id: docID(doc.id), kind: "document", label: pathname(doc.path).basename(doc.path), documentId: doc.id, path: doc.path, scope: doc.scope, private: doc.private, contentHash: doc.contentHash, revision: doc.revision })
      if (indexIncomplete) graph.truncation.nodes = true
      const memories = tables.has("memories") ? this.db.query<{ id: string; body: string }, [string, number, number]>(
        "SELECT id,body FROM memories WHERE json_extract(body,'$.status')='active' AND (json_extract(body,'$.scope')=? OR json_extract(body,'$.scope')='global') AND (COALESCE(json_extract(body,'$.private'),0)=0 OR ?=1) ORDER BY id LIMIT ?",
      ).all(options.scope, Number(includePrivate), maxNodes + 1).map(row => ({ ...JSON.parse(row.body) as Memory, id: row.id })) : []
      const selectedMemories = memories.filter(memory => addNode({ id: memoryID(memory.id), kind: "memory", label: clip(memory.text, 120), memoryId: memory.id, memoryKind: memory.kind, scope: memory.scope, private: memory.private, revision: memory.revision }))
      const addEdge = (edge: Omit<GraphEdge, "id">) => {
        if (graph.edges.length >= maxEdges) { graph.truncation.edges = true; return false }
        const id = new Bun.CryptoHasher("sha256").update(JSON.stringify(edge)).digest("hex")
        graph.edges.push({ id: `edge:${id}`, ...edge }); return true
      }
      const unresolved = (item: UnresolvedLink) => {
        if (graph.unresolved.length >= graph.limits.maxUnresolved) { graph.truncation.unresolved = true; return false }
        graph.unresolved.push(item); return true
      }
      let characters = 0
      if (tables.has("knowledge_chunks")) documentsLoop: for (const doc of documents) {
        if (!nodeIDs.has(docID(doc.id))) continue
        const extension = pathname(doc.path).extname(doc.path).toLowerCase()
        if (![".md", ".markdown", ".mdx", ".txt", ""].includes(extension)) continue
        const cachedLines = new Map<number, { pieces: string[]; tail: string }>()
        const chunks = this.db.query<{ start_line: number; end_line: number; text: string }, [string, string, number]>(`
          SELECT c.start_line,c.end_line,c.text FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id
          WHERE d.id=? AND (d.scope=? OR d.scope='global') AND (d.private=0 OR ?=1)
          ORDER BY c.start_line,CAST(substr(c.id,length(c.document_id)+2) AS INTEGER)
        `).iterate(doc.id, options.scope, Number(includePrivate))
        for (const chunk of chunks) {
          characters += chunk.text.length
          if (characters > CONTENT_LIMIT) { graph.truncation.content = true; break documentsLoop }
          for (const [offset, text] of chunk.text.split("\n").entries()) {
            const line = chunk.start_line + offset, previous = cachedLines.get(line), points = Array.from(text)
            if (previous === undefined) cachedLines.set(line, { pieces: [text], tail: points.slice(-120).join("") })
            else {
              // KnowledgeStore's long-line cache uses a 120-code-point overlap.
              // Verify it before joining; never invent a source position from a gap.
              if (previous.tail !== points.slice(0, 120).join("")) { graph.truncation.content = true; break documentsLoop }
              previous.pieces.push(points.slice(120).join("")); previous.tail = points.slice(-120).join("")
            }
          }
        }
        const lines = new Map([...cachedLines].map(([line, cached]) => [line, cached.pieces.join("")]))
        for (const reference of references(lines)) {
          const evidence: DocumentEvidence = { kind: "document", documentId: doc.id, path: doc.path, contentHash: doc.contentHash, line: reference.line, column: reference.column, snippet: reference.snippet, rawTarget: clip(reference.target, 2048), ...(reference.alias !== undefined ? { alias: clip(reference.alias, 120) } : {}) }
          const resolved = resolveTarget(reference, doc, paths, names, indexIncomplete)
          if (resolved.anchor !== undefined) evidence.anchor = resolved.anchor
          if (resolved.reason) {
            if (!unresolved({ from: docID(doc.id), type: reference.type, reason: resolved.reason, evidence })) break documentsLoop
            continue
          }
          if (!nodeIDs.has(docID(resolved.document!.id))) {
            graph.truncation.nodes = true
            if (!unresolved({ from: docID(doc.id), type: reference.type, reason: "node_limit", evidence })) break documentsLoop
            continue
          }
          if (!addEdge({ from: docID(doc.id), to: docID(resolved.document!.id), type: reference.type, evidence })) break documentsLoop
        }
      }
      if (tables.has("memory_sources") && tables.has("experiences")) memoryLoop: for (const memory of selectedMemories) {
        const sources = this.db.query<{ id: number; body: string }, [string, string, number, number]>(`
          SELECT e.id,e.body FROM memory_sources s JOIN experiences e ON e.id=s.source_id
          WHERE s.memory_id=? AND (json_extract(e.body,'$.scope')=? OR json_extract(e.body,'$.scope')='global')
            AND (COALESCE(json_extract(e.body,'$.private'),0)=0 OR ?=1)
            AND COALESCE(json_extract(e.body,'$.retracted'),0)=0 ORDER BY e.id LIMIT ?
        `).all(memory.id, options.scope, Number(includePrivate), maxEdges + 1)
        for (const row of sources) {
          const source: Experience = { ...JSON.parse(row.body), id: row.id }
          // Both persisted representations must name the source; inconsistent
          // domain data cannot create a provenance edge.
          if (!memory.sourceIds.includes(source.id)) continue
          if (graph.edges.length >= maxEdges) { graph.truncation.edges = true; break memoryLoop }
          if (!addNode({ id: sourceID(source.id), kind: "experience", experienceId: source.id, experienceKind: source.kind, label: clip(source.text, 120), scope: source.scope, private: source.private === true })) continue
          addEdge({ from: memoryID(memory.id), to: sourceID(source.id), type: "memory_source", evidence: { kind: "memory_source", memoryId: memory.id, experienceId: source.id, sourceKey: source.sourceKey, field: "sourceIds", line: null, column: null, snippet: clip(source.text, 240) } })
        }
      }
      graph.truncated = Object.values(graph.truncation).some(Boolean)
      return graph
    })()
  }
}

function limit(value: number | undefined, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`图谱数量必须是 ${min} 到 ${max} 之间的整数`)
  return value
}
function push(map: Map<string, DocumentSummary[]>, key: string, value: DocumentSummary) { const items = map.get(key) ?? []; items.push(value); map.set(key, items) }
type Reference = { type: "wikilink" | "markdown_link"; target: string; alias?: string; line: number; column: number; snippet: string }
type Resolution = { document?: DocumentSummary; anchor?: string; reason?: UnresolvedLink["reason"] }

function resolveTarget(reference: Reference, source: DocumentSummary, paths: Map<string, DocumentSummary[]>, names: Map<string, DocumentSummary[]>, indexIncomplete: boolean): Resolution {
  let value = reference.target.trim()
  if (value.length > 2048 || /[\u0000-\u001f]/.test(value)) return { reason: "unsupported" }
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || /^[/\\]{2}/.test(value)) return { reason: "external" }
  const hash = value.indexOf("#"), anchor = hash >= 0 ? value.slice(hash + 1) : undefined
  value = hash >= 0 ? value.slice(0, hash) : value
  if (reference.type === "markdown_link") {
    value = value.split("?")[0]!
    try { value = decodeURIComponent(value).replace(/\\([\\()[\] #])/g, "$1") } catch { return { reason: "unsupported", anchor } }
  }
  if (!value) return reference.type === "wikilink" && anchor === undefined ? { reason: "unsupported" } : { document: source, anchor }
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || /^[/\\]/.test(value)) return { reason: "unsupported", anchor }
  const api = pathname(source.path)
  let matches: DocumentSummary[]
  if (reference.type === "wikilink" && !/[\\/]/.test(value)) {
    if (indexIncomplete) return { reason: "index_limit", anchor }
    matches = names.get(nameKey(value)) ?? []
  } else {
    const target = api.resolve(api.dirname(source.path), value.replaceAll("\\", "/"))
    matches = paths.get(pathKey(target)) ?? []
    if (!matches.length && reference.type === "wikilink" && !api.extname(value)) matches = [".md", ".markdown", ".mdx"].flatMap(extension => paths.get(pathKey(target + extension)) ?? [])
  }
  const unique = [...new Map(matches.map(doc => [doc.id, doc])).values()]
  return unique.length === 1 ? { document: unique[0], anchor } : { reason: unique.length ? "ambiguous" : indexIncomplete ? "index_limit" : "missing", anchor }
}

function escaped(line: string, index: number) { let count = 0; for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor--) count++; return count % 2 === 1 }
function* references(lines: Map<number, string>): Generator<Reference> {
  let fence: { character: string; length: number } | undefined, comment = false
  for (const [lineNumber, original] of lines) {
    const fenced = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(original)
    if (fence) { if (fenced && fenced[1]![0] === fence.character && fenced[1]!.length >= fence.length && !fenced[2]!.trim()) fence = undefined; continue }
    if (fenced && !comment) { fence = { character: fenced[1]![0]!, length: fenced[1]!.length }; continue }
    if (/^(?: {4}|\t)/.test(original)) continue
    const text = original.split("")
    for (let index = 0; index < original.length;) {
      if (comment || original.startsWith("<!--", index)) {
        const end = original.indexOf("-->", index + (comment ? 0 : 4)), next = end < 0 ? original.length : end + 3
        text.fill(" ", index, next); comment = end < 0; index = next; continue
      }
      if (original[index] === "`" && !escaped(original, index)) {
        let length = 1; while (original[index + length] === "`") length++
        const end = original.indexOf("`".repeat(length), index + length)
        if (end >= 0) { text.fill(" ", index, end + length); index = end + length; continue }
      }
      index++
    }
    const visible = text.join(""), lastWikiClose = visible.lastIndexOf("]]"), lastClose = visible.lastIndexOf("]")
    for (let index = 0; index < visible.length; index++) {
      if (visible[index] !== "[" || escaped(visible, index)) continue
      const wiki = visible.startsWith("[[", index)
      if (index > (wiki ? lastWikiClose : lastClose)) continue
      const end = visible.indexOf(wiki ? "]]" : "]", index + (wiki ? 2 : 1))
      if (end < 0) continue
      if (wiki) {
        const body = visible.slice(index + 2, end), pipe = body.indexOf("|")
        yield { type: "wikilink", target: pipe < 0 ? body : body.slice(0, pipe), ...(pipe >= 0 ? { alias: body.slice(pipe + 1) } : {}), line: lineNumber, column: index + 1, snippet: clip(original.slice(Math.max(0, index - 60), Math.min(original.length, end + 62)), 240) }
        index = end + 1; continue
      }
      if (visible[end + 1] !== "(") continue
      const destination = markdownDestination(visible, end + 2)
      if (!destination) continue
      yield { type: "markdown_link", target: destination.target, line: lineNumber, column: index + 1, snippet: clip(original.slice(Math.max(0, index - 60), Math.min(original.length, destination.end + 61)), 240) }
      index = destination.end
    }
  }
}

function markdownDestination(text: string, begin: number): { target: string; end: number } | undefined {
  let start = begin; while (/\s/.test(text[start] ?? "") && start < text.length) start++
  if (text[start] === "<") {
    const close = text.indexOf(">", start + 1)
    if (close < 0) return undefined
    const tail = /^\s*(?:(?:"[^"]*"|'[^']*'|\([^)]*\))\s*)?\)/.exec(text.slice(close + 1))
    return tail ? { target: text.slice(start + 1, close), end: close + tail[0].length } : undefined
  }
  let depth = 0
  for (let cursor = start; cursor < text.length; cursor++) {
    if (escaped(text, cursor)) continue
    const character = text[cursor]
    if (character === "(") depth++
    if (character === ")") { if (!depth) return { target: text.slice(start, cursor), end: cursor }; depth-- }
    if (/\s/.test(character!) && !depth) {
      const tail = /^\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*\)/.exec(text.slice(cursor))
      return tail ? { target: text.slice(start, cursor), end: cursor + tail[0].length - 1 } : undefined
    }
  }
  return undefined
}
