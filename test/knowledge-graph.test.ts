import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { SoulStore } from "../src/store"
import { KnowledgeStore } from "../src/knowledge"
import { GraphStore, type DocumentEvidence, type KnowledgeGraph } from "../src/knowledge-graph"

let root: string, soul: SoulStore, knowledge: KnowledgeStore, graph: GraphStore
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "xingyao-graph-test-"))
  soul = new SoulStore(join(root, "host", "soul.db"))
  knowledge = new KnowledgeStore(soul.db)
  graph = new GraphStore(soul.db)
})
afterEach(async () => { soul.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
async function document(name: string, text: string, scope = "project-a", privateValue = false) {
  const file = join(root, "notes", name)
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, text)
  return knowledge.importFile(file, scope, { private: privateValue })
}
function endpoints(result: KnowledgeGraph) { const ids = new Set(result.nodes.map(node => node.id)); expect(result.edges.every(edge => ids.has(edge.from) && ids.has(edge.to))).toBe(true) }

describe("knowledge graph from imported evidence", () => {
  test("links wiki names, aliases, headings and relative Markdown with exact imported provenance", async () => {
    const target = await document("目标.md", "# 标题\n已经导入的正文")
    const code = await document("code.ts", "export const x = 1")
    const source = await document("sub/source.md", [
      "[[目标]]", "[[目标|显示别名]]", "[[目标#标题]]", "[说明](../%E7%9B%AE%E6%A0%87.md#标题 \"title\")", "[源码](../code.ts)", "[[../目标]]", "[[#本页标题]]",
    ].join("\r\n"))
    const result = graph.build({ scope: "project-a" })
    expect(result.truncated).toBe(false)
    expect(result.unresolved).toEqual([])
    expect(result.edges).toHaveLength(7)
    expect(result.edges.filter(edge => edge.to === `document:${target.id}`)).toHaveLength(5)
    expect(result.edges.find(edge => edge.to === `document:${code.id}`)?.type).toBe("markdown_link")
    const alias = result.edges.find(edge => edge.evidence.kind === "document" && edge.evidence.alias)
    expect(alias?.evidence).toMatchObject({ kind: "document", documentId: source.id, path: source.path, contentHash: source.contentHash, line: 2, column: 1, alias: "显示别名", snippet: "[[目标|显示别名]]", rawTarget: "目标" })
    expect(result.edges.some(edge => edge.from === edge.to && edge.evidence.kind === "document" && edge.evidence.anchor === "本页标题")).toBe(true)
    expect(result.edges.map(edge => (edge.evidence as DocumentEvidence).line)).toEqual([1, 2, 3, 4, 5, 6, 7])
    endpoints(result)
  })

  test("bare-name ambiguity is reported while explicit relative paths resolve", async () => {
    const a = await document("a/同名.md", "a"), b = await document("b/同名.md", "b")
    await document("a/source.md", "[[同名]]\n[[同名.md]]\n[[./同名]]\n[明确](../b/同名.md)")
    const result = graph.build({ scope: "project-a" })
    expect(result.unresolved.map(link => link.reason)).toEqual(["ambiguous", "ambiguous"])
    expect(result.edges.map(edge => edge.to)).toEqual([`document:${a.id}`, `document:${b.id}`])
    expect(result.unresolved.every(item => !Object.hasOwn(item, "candidates"))).toBe(true)
  })

  test("scope/private filtering precedes matching, content parsing and ambiguity detection", async () => {
    const allowed = await document("public/同名.md", "PUBLIC")
    const secret = await document("private/同名.md", "PRIVATE_CONTENT\n[[PRIVATE_LINK_TARGET]]", "project-a", true)
    const other = await document("other/同名.md", "OTHER_PROJECT_CONTENT\n[[OTHER_LINK_TARGET]]", "project-b")
    const shared = await document("shared.md", "GLOBAL", "global")
    await document("source.md", "[[同名]]\n[[shared]]\n[无法公开](private/同名.md)")
    const publicMemory = soul.explicitMemory({ key: "public", text: "PUBLIC_MEMORY", scope: "project-a", kind: "fact" })
    const privateMemory = soul.explicitMemory({ key: "private", text: "PRIVATE_MEMORY", scope: "project-a", kind: "fact", private: true })
    const otherMemory = soul.explicitMemory({ key: "other", text: "OTHER_MEMORY", scope: "project-b", kind: "fact" })
    const result = graph.build({ scope: "project-a" }), serialized = JSON.stringify(result)
    for (const hidden of [secret.id, other.id, privateMemory.id, otherMemory.id, "PRIVATE_CONTENT", "OTHER_PROJECT_CONTENT", "PRIVATE_LINK_TARGET", "OTHER_LINK_TARGET", "PRIVATE_MEMORY", "OTHER_MEMORY"]) expect(serialized).not.toContain(hidden)
    expect(result.nodes.some(node => node.kind === "memory" && node.memoryId === publicMemory.id)).toBe(true)
    expect(result.edges.filter(edge => edge.type === "wikilink").map(edge => edge.to)).toEqual([`document:${allowed.id}`, `document:${shared.id}`])
    expect(result.unresolved.map(item => item.reason)).toEqual(["missing"])
    const expanded = graph.build({ scope: "project-a", includePrivate: true })
    expect(expanded.nodes.some(node => node.kind === "document" && node.documentId === secret.id)).toBe(true)
    expect(expanded.nodes.some(node => node.kind === "memory" && node.memoryId === privateMemory.id)).toBe(true)
    expect(JSON.stringify(expanded)).not.toContain(other.id)
    expect(expanded.unresolved.some(item => item.reason === "ambiguous")).toBe(true)
    expect(graph.build({ scope: "global", includePrivate: true }).nodes.map(node => node.id)).toEqual([`document:${shared.id}`])
  })

  test("missing imports and external URLs remain unresolved without reading live files", async () => {
    const target = await document("target.md", "IMPORTED_TARGET")
    const source = await document("source.md", "[[target]]\n[外部](https://example.test/info)\n[未导入](not-imported.md)\n[邮件](mailto:test@example.test)\n[坏编码](%ZZ.md)")
    await writeFile(join(root, "notes", "not-imported.md"), "SHOULD_NOT_BE_READ [[target]]")
    const before = graph.build({ scope: "project-a" }), revision = soul.revision
    await unlink(target.path); await writeFile(source.path, "LIVE_CHANGED [[unknown]]")
    const after = graph.build({ scope: "project-a" })
    expect(after).toEqual(before)
    expect(after.unresolved.map(item => item.reason)).toEqual(["external", "missing", "external", "unsupported"])
    expect(JSON.stringify(after)).not.toContain("SHOULD_NOT_BE_READ")
    expect(JSON.stringify(after)).not.toContain("LIVE_CHANGED")
    expect(soul.revision).toBe(revision)
  })

  test("fenced code, inline code, comments, escapes and source-code strings do not become references", async () => {
    await document("target.md", "target")
    await document("code.ts", "const string = '[[target]]';")
    await document("source.md", [
      "```md", "[[target]]", "```", "~~~", "[x](target.md)", "~~~", "`[[target]]` and ``[x](target.md)``", "<!--", "[[target]]", "-->", "    [[target]]", "\\[[target]]", "[[target]] and [yes](target.md)",
    ].join("\n"))
    const result = graph.build({ scope: "project-a" })
    expect(result.edges).toHaveLength(2)
    expect(result.edges.every(edge => edge.evidence.line === 13)).toBe(true)
    expect(result.unresolved).toEqual([])
  })

  test("parentheses, angle-bracket destinations, encoded spaces and duplicate line occurrences retain evidence", async () => {
    const target = await document("目标 (第二版).md", "target")
    await document("source.md", "[括号](目标%20(第二版).md) [空格](<目标 (第二版).md> \"title\")\n[[目标 (第二版)]] [[目标 (第二版)]]")
    const result = graph.build({ scope: "project-a" })
    expect(result.edges).toHaveLength(4)
    expect(result.edges.every(edge => edge.to === `document:${target.id}`)).toBe(true)
    expect(new Set(result.edges.map(edge => edge.id)).size).toBe(4)
    expect(result.edges[2]!.evidence.column).not.toBe(result.edges[3]!.evidence.column)
  })

  test("overlapping long-line cache chunks reconstruct crossing links without duplicate edges", async () => {
    const target = await document("target.md", "target")
    const text = "🙂".repeat(2398) + "[[target]]" + "🙂".repeat(2400)
    const source = await document("source.md", text)
    expect(source.chunkCount).toBeGreaterThan(1)
    const result = graph.build({ scope: "project-a" })
    expect(result.truncated).toBe(false)
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0]).toMatchObject({ to: `document:${target.id}`, evidence: { line: 1, column: 2398 * 2 + 1, rawTarget: "target" } })
    expect(result.edges[0]!.evidence.snippet).not.toContain("�")
  })

  test("memory edges use actual sources, exclude revoked history, and never invent similarity links", async () => {
    const event = soul.appendExperience({ sourceKey: "actual:observation", scope: "project-a", text: "实际观察到的来源", kind: "observation", ownership: "observed" })
    const first = soul.remember({ scope: "project-a", text: "相同关键词", kind: "fact", sourceIds: [event.id] })
    const inferred = soul.remember({ scope: "project-a", text: "相同关键词也可能推断", kind: "inference", sourceIds: [event.id] })
    const deleted = soul.explicitMemory({ key: "gone", scope: "project-a", text: "已删除的来源", kind: "fact" })
    soul.forgetMemory(deleted.id, deleted.revision)
    const result = graph.build({ scope: "project-a" })
    expect(result.nodes).toHaveLength(3)
    expect(result.edges.map(edge => edge.type)).toEqual(["memory_source", "memory_source"])
    expect(new Set(result.edges.map(edge => edge.from))).toEqual(new Set([`memory:${first.id}`, `memory:${inferred.id}`]))
    expect(result.edges.every(edge => edge.to === `experience:${event.id}`)).toBe(true)
    expect(result.edges[0]!.evidence).toMatchObject({ kind: "memory_source", experienceId: event.id, sourceKey: "actual:observation", field: "sourceIds", line: null, column: null, snippet: event.text })
    expect(JSON.stringify(result)).not.toContain(deleted.id)
    endpoints(result)
  })

  test("private, foreign and retracted legacy source rows cannot leak through public memory references", () => {
    const memory = soul.explicitMemory({ key: "visible", scope: "project-a", text: "visible memory", kind: "fact" })
    const hidden = [
      soul.appendExperience({ sourceKey: "hidden:private", scope: "project-a", text: "HIDDEN_PRIVATE", kind: "observation", ownership: "observed", private: true }),
      soul.appendExperience({ sourceKey: "hidden:foreign", scope: "project-b", text: "HIDDEN_FOREIGN", kind: "observation", ownership: "observed" }),
      soul.appendExperience({ sourceKey: "hidden:retracted", scope: "project-a", text: "HIDDEN_RETRACTED", kind: "observation", ownership: "observed" }),
    ]
    // Model a legacy inconsistency that newer SoulStore refuses to create.
    for (const event of hidden) soul.db.query("INSERT INTO memory_sources(memory_id,source_id) VALUES(?,?)").run(memory.id, event.id)
    const retracted = hidden[2]!
    soul.db.query("UPDATE experiences SET body=? WHERE id=?").run(JSON.stringify({ ...retracted, retracted: true }), retracted.id)
    soul.db.query("UPDATE memories SET body=? WHERE id=?").run(JSON.stringify({ ...memory, sourceIds: [...memory.sourceIds, ...hidden.map(event => event.id)] }), memory.id)
    const result = graph.build({ scope: "project-a" })
    expect(result.edges).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain("HIDDEN_")
    expect(JSON.stringify(result)).not.toContain("hidden:")
  })

  test("hidden document metadata is filtered before parsing and resolving links", async () => {
    const secret = await document("personal.md", "SECRET", "project-a", true)
    const foreign = await document("foreign.md", "FOREIGN", "project-b")
    soul.db.query("UPDATE knowledge_documents SET body='invalid cached metadata' WHERE id IN (?,?)").run(secret.id, foreign.id)
    expect(graph.build({ scope: "project-a" }).nodes).toEqual([])
    expect(graph.build({ scope: "other", includePrivate: true }).nodes).toEqual([])
  })

  test("an incomplete document index cannot turn a potentially ambiguous bare name into a certain edge", async () => {
    await document("000-source.md", "[[same]]")
    await document("001/same.md", "first")
    const insert = soul.db.query("INSERT INTO knowledge_documents(id,path,scope,private,body) VALUES(?,?,?,?,?)")
    soul.db.transaction(() => {
      for (let i = 0; i < 9999; i++) {
        const id = `synthetic:${i}`, name = i === 9998 ? "zzz/same.md" : `filler-${String(i).padStart(5, "0")}.md`, file = join(root, "notes", name)
        insert.run(id, file, "project-a", 0, JSON.stringify({ id, path: file, name, scope: "project-a", private: false, contentHash: "fixture", revision: 1 }))
      }
    })()
    const result = graph.build({ scope: "project-a", maxNodes: 2, maxEdges: 3 })
    expect(result.truncation.index).toBe(true)
    expect(result.edges).toEqual([])
    expect(result.unresolved[0]?.reason).toBe("index_limit")
    endpoints(result)
  })

  test("cached content budget stops projection explicitly without reading source files", async () => {
    const source = await document("source.md", "placeholder")
    soul.db.query("UPDATE knowledge_chunks SET text=? WHERE document_id=?").run("x".repeat(8 * 1024 * 1024 + 1), source.id)
    const result = graph.build({ scope: "project-a" })
    expect(result.truncation.content).toBe(true)
    expect(result.truncated).toBe(true)
    expect(result.edges).toEqual([])
  })

  test("limits are deterministic, bound unresolved reports too, and never leave dangling edges", async () => {
    await document("a.md", "[[b]]\n[[b]]\n[[b]]\n[[unknown]]\n[[unknown2]]")
    await document("b.md", "target")
    soul.explicitMemory({ key: "bounded", scope: "project-a", text: "memory", kind: "fact" })
    const tiny = graph.build({ scope: "project-a", maxNodes: 1, maxEdges: 2 })
    expect(tiny.nodes).toHaveLength(1)
    expect(tiny.edges).toHaveLength(0)
    expect(tiny.unresolved).toHaveLength(2)
    expect(tiny.truncation).toMatchObject({ nodes: true, unresolved: true })
    expect(tiny.truncated).toBe(true)
    endpoints(tiny)
    const limited = graph.build({ scope: "project-a", maxNodes: 10, maxEdges: 2 })
    expect(limited.edges).toHaveLength(2)
    expect(limited.truncation.edges).toBe(true)
    expect(graph.build({ scope: "project-a", maxNodes: 10, maxEdges: 2 })).toEqual(limited)
    const none = graph.build({ scope: "project-a", maxEdges: 0 })
    expect(none.edges).toEqual([])
    expect(none.truncation.edges).toBe(true)
    endpoints(limited)
  })

  test("invalid runtime options fail closed and empty databases are not initialized", () => {
    for (const scope of ["", " ", "x".repeat(257)]) expect(() => graph.build({ scope })).toThrow("范围")
    expect(() => graph.build({ scope: "project-a", includePrivate: "true" as unknown as boolean })).toThrow("布尔")
    for (const maxNodes of [0, -1, 1.5, NaN, Infinity, 2001]) expect(() => graph.build({ scope: "project-a", maxNodes })).toThrow("整数")
    for (const maxEdges of [-1, 1.5, NaN, Infinity, 10001]) expect(() => graph.build({ scope: "project-a", maxEdges })).toThrow("整数")
    const empty = new Database(":memory:", { strict: true })
    try {
      expect(new GraphStore(empty).build({ scope: "global" }).nodes).toEqual([])
      expect(empty.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([])
    } finally { empty.close() }
  })
})
