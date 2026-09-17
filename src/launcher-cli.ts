import { launcherMain } from "./launcher"

// A dedicated executable entry avoids Bun's compiled import.meta.main behavior.
await launcherMain().catch(() => {
  // Never echo backend output, validation bodies, command environments or tokens.
  console.error("XINGYAO_START_BLOCKED: release verification or recovery validation failed; no unchecked release was started.")
  process.exitCode = 1
})
