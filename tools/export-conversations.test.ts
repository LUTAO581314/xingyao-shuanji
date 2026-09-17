import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

test("exports task descendants, visible messages and tools while excluding internal content and credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xingyao-transcript-test-"))
  try {
    const codex = join(dir, "codex"), output = join(dir, "export"), sessions = join(codex, "sessions")
    mkdirSync(sessions, { recursive: true }); mkdirSync(join(codex, "archived_sessions"))
    const root = "01a0aede-90f2-7a73-baf2-0408fa980f18"
    const meta = (id: string, parent?: string) => ({ type: "session_meta", payload: { id, parent_thread_id: parent, agent_path: id === root ? "/root" : `/root/${id}`, base_instructions: "INTERNAL_INSTRUCTIONS_CANARY" } })
    const message = (role: string, text: string, phase?: string) => ({ type: "response_item", timestamp: "2026-09-17T00:00:00Z", payload: { type: "message", role, phase, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] } })
    writeFileSync(join(sessions, "root.jsonl"), [meta(root), message("user", "请归档完整对话"), message("assistant", "已经开始整理", "commentary"), message("developer", "PRIVATE_DEVELOPER_CANARY"), { type: "response_item", payload: { type: "reasoning", encrypted_content: "PRIVATE_REASONING_CANARY" } }, message("assistant", "PRIVATE_ANALYSIS_CANARY", "analysis"), { type: "response_item", payload: { type: "function_call", name: "test", call_id: "test-call", arguments: JSON.stringify({ apiKey: "credential_canary_A", ordinary: "keep this" }) } }, { type: "response_item", payload: { type: "function_call_output", call_id: "test-call", output: [{ type: "text", text: 'url=http://127.0.0.1/#token=credential_canary_B\nAuthorization: Bearer credential_canary_C\n{"apiKey":"credential_canary_D"}' }] } }].map(x => JSON.stringify(x)).join("\n") + "\n")
    writeFileSync(join(sessions, "child.jsonl"), [meta("child", root), message("assistant", "子智能体的可见结果", "final_answer")].map(x => JSON.stringify(x)).join("\n") + "\n")
    writeFileSync(join(sessions, "grandchild.jsonl"), [meta("grandchild", "child"), message("assistant", "二级子智能体的可见结果", "final_answer")].map(x => JSON.stringify(x)).join("\n") + "\n")
    writeFileSync(join(sessions, "unrelated.jsonl"), [meta("other"), message("user", "UNRELATED_TASK_CANARY")].map(x => JSON.stringify(x)).join("\n") + "\n")
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "export-conversations.ts")], { env: { ...process.env, CODEX_HOME: codex, CHAT_ARCHIVE_OUTPUT: output }, stdout: "pipe", stderr: "pipe", windowsHide: true })
    expect(await child.exited).toBe(0)
    const destination = join(output, "conversations", "2026-09-17", root)
    const manifest = JSON.parse(readFileSync(join(destination, "manifest.json"), "utf8"))
    expect(manifest.threads).toBe(3)
    expect(manifest.fragments.length).toBe(3)
    const all = manifest.files.map((file: { path: string }) => readFileSync(join(destination, file.path), "utf8")).join("\n")
    for (const forbidden of ["INTERNAL_INSTRUCTIONS_CANARY", "PRIVATE_DEVELOPER_CANARY", "PRIVATE_REASONING_CANARY", "PRIVATE_ANALYSIS_CANARY", "UNRELATED_TASK_CANARY", "credential_canary_A", "credential_canary_B", "credential_canary_C", "credential_canary_D"]) expect(all).not.toContain(forbidden)
    for (const preserved of ["请归档完整对话", "已经开始整理", "子智能体的可见结果", "二级子智能体的可见结果", "keep this", "test-call"]) expect(all).toContain(preserved)
    for (const file of manifest.files) expect(new Bun.CryptoHasher("sha256").update(readFileSync(join(destination, file.path))).digest("hex")).toBe(file.sha256)
    expect(readFileSync(join(destination, "README.md"), "utf8")).toContain('/root/grandchild')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
