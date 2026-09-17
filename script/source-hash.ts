import { join } from "node:path"

export async function sourceHash(root: string): Promise<string> {
  const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: join(root, "src"), onlyFiles: true }))
  const hash = new Bun.CryptoHasher("sha256")
  for (const file of files.sort()) { hash.update(file.replaceAll("\\", "/")); hash.update("\0"); hash.update(await Bun.file(join(root, "src", file)).arrayBuffer()); hash.update("\0") }
  return hash.digest("hex")
}
