import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SoulStore } from "../src/store"
import { KnowledgeStore } from "../src/knowledge"
import { FileOrganizer } from "../src/files"

test("file moves and undo preserve document identity, refreshed content and references", async () => {
  const root = mkdtempSync(join(tmpdir(), "xingyao-file-reference-"))
  const store = new SoulStore(join(root, "host", "soul.db"))
  try {
    const knowledge = new KnowledgeStore(store.db)
    const organizer = new FileOrganizer(store.db)
    const source = join(root, "notes.md")
    writeFileSync(source, "星杳资料引用测试")
    const document = await knowledge.importFile(source, "global")
    writeFileSync(source, "星杳资料引用已经更新")
    const plan = await organizer.plan(root)
    const moved = await organizer.apply(plan.id)
    const item = moved.items.find(item => item.source === source)!
    await knowledge.relocate(item.source, item.target, item.sha256)
    expect(knowledge.documents()).toHaveLength(1)
    expect(knowledge.documents()[0].id).toBe(document.id)
    expect(knowledge.search("引用已经更新", "global")[0].path).toBe(item.target)
    await organizer.undo(plan.id)
    await knowledge.relocate(item.target, item.source, item.sha256)
    expect(knowledge.documents()[0].id).toBe(document.id)
    expect(knowledge.search("引用已经更新", "global")[0].path).toBe(source)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
