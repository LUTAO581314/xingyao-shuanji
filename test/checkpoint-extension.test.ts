import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SoulStore } from "../src/store"
import { createCheckpoint, listCheckpoints } from "../src/checkpoint"

test("a combined checkpoint is published only after extensions complete and remains bound to their hashes", async () => {
  const root = mkdtempSync(join(tmpdir(), "xingyao-combined-checkpoint-"))
  const store = new SoulStore(join(root, "host", "soul.db"))
  try {
    const vault = join(root, "vault")
    await expect(createCheckpoint(store.db, vault, store.identityId, 0, null, async directory => { mkdirSync(join(directory, "engine")); throw new Error("simulated engine snapshot failure") })).rejects.toThrow("simulated")
    expect(await listCheckpoints(vault)).toHaveLength(0)
    const good = await createCheckpoint(store.db, vault, store.identityId, 0, null, async directory => {
      mkdirSync(join(directory, "engine"))
      writeFileSync(join(directory, "engine", "complete.json"), "verified extension")
      return { "engine/complete.json": new Bun.CryptoHasher("sha256").update("verified extension").digest("hex") }
    })
    expect(await listCheckpoints(vault)).toHaveLength(1)
    writeFileSync(join(vault, "checkpoints", good.generation, "engine", "complete.json"), "changed extension")
    expect(await listCheckpoints(vault)).toHaveLength(0)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
