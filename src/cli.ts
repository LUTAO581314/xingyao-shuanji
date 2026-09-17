import { main } from "./main"

await main().catch(error => {
  console.error(error instanceof Error ? error.message : "启动失败")
  process.exitCode = 1
})
