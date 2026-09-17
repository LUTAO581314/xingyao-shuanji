# /root/upstream_compat/launcher_entry_review

导出时间：2026-09-17T18:28:16.018Z

来源片段：`sessions/2026/09/17/rollout-2026-09-17T21-34-52-01a0af93-c57f-74c2-92d5-649e0932411f.jsonl`

此文件展示对话与协作消息。完整工具调用和结果位于同名 JSONL。凭据已脱敏；子任务中保留的继承上下文可能与主任务重复。

## 2026-09-17T13:34:52.289Z · 助理

OpenCode 兼容适配与便携恢复已经完成，最终可用候选是 **`0.0.0-product-dev-20260917-engine.5`**。

- 引擎路径：[opencode.exe](/C:/Users/LT/Documents/trae/packages/opencode/dist/opencode-windows-x64/bin/opencode.exe)
- SHA-256：`528277b2ea4178093a192da0fe33ef4768e7ae5514a7b21de006d07212c6df83`
- 长度：`136180736` 字节。
- 原 `F:/bin/opencode-windows-x64.exe` 未覆盖。

本次处理了两组真实故障：

1. **文件系统搜索的运行时导入环。** 原候选健康检查正常，但真实 prompt 在模型请求前 HTTP 500。改为直接引用 schema 构造器，并加入独立进程导入顺序回归。
2. **便携项目路径被还原为宿主物理路径。** 固定 SUBST 盘符原本仍会被 OpenCode 写成旧物理目录；Git 还会单独返回旧 worktree。通过显式 `OPENCODE_PORTABLE_ROOT` 保持固定盘符，并统一处理 Git 输出。同步路径解析仍先解析真实目标，映射外的 junction 目标不会被伪装成映射内文件。

**验证结果：**

- 产品适配器、引擎启动器、真实引擎协议链路、引擎备份：**28 通过，0 失败，0 skip，166 个断言**。
- 上游搜索导入与文件系统回归：4 通过。
- 上游便携路径与原有 Project.resolve 回归：11 通过。
- 产品、上游 core、上游 opencode 类型检查均通过。
- 实际 exe + 本地模型协议模拟器验证了 system 投影、持久回复、真实 read、权限 once/reject、工具成功与失败证据。
- 普通项目和已有提交的 Git 仓库都通过：物理根 A → B、同盘符重新映射、数据库恢复到新 hostDir、原 sessionId 历史一致、继续原会话并读到 B 的新内容。**恢复后**发送给模型的 Working directory 与 Git Workspace root folder 均保持固定盘符。
- 全程未使用真实模型凭据或公网付费模型。

主要产品文件已经就位：

- [adapter.ts](/F:/codex/xingyao/src/adapter.ts)：公共 legacy HTTP 适配与证据归一化。
- [engine.ts](/F:/codex/xingyao/src/engine.ts)：隔离配置、自有进程、随机认证、固定路径传递。
- [engine-backup.ts](/F:/codex/xingyao/src/engine-backup.ts)：SQLite 一致快照、完整性校验与同版本恢复。
- [real-engine.test.ts](/F:/codex/xingyao/test/real-engine.test.ts)：真实引擎与搬迁验收。
- [opencode-patches.md](/F:/codex/xingyao/docs/opencode-patches.md)：候选信息、两组补丁、退出条件、实际验证与范围限制。
- [补丁队列说明](/F:/codex/xingyao/patches/opencode/README.md)：两份可重放 patch 与 manifest。已从记录的基线提取原始文件，实际应用并逐文件核对通过。

仍需保留的限制：支持的是 legacy `/session`，没有宣称支持 `/api` V2；备份恢复要求引擎版本一致；这次迁移在同一电脑的不同物理目录与全新宿主数据目录完成，尚未替代另一台实体电脑的验收。旧版本已经保存为物理绝对路径的会话不会被这项补丁自动修复。未来引擎版本仍应通过编译后二进制验收及隔离数据库迁移测试，再进入发行包。

## 2026-09-17T13:34:52.437Z · /root/upstream_compat → /root/upstream_compat/launcher_entry_review

Message Type: NEW_TASK
Task name: /root/upstream_compat/launcher_entry_review
Sender: /root/upstream_compat
Payload:


{"type":"encrypted_content"}

## 2026-09-17T13:35:00.244Z · 助理

我会只读检查启动入口与安装脚本，确认编译后的 Windows 路径判断是否可能跳过启动，并给出最小改动建议。

## 2026-09-17T13:36:06.096Z · 助理

入口代码有一个明确的脆弱点：路径比较不匹配时会直接正常退出，错误日志也不会出现。现有测试验证了临时编译文件，却没有验证安装后的完整路径和工作目录组合；专用 CLI 入口可以消除这类路径判断。

## 2026-09-17T13:36:35.391Z · /root/upstream_compat → /root/upstream_compat/launcher_entry_review

Message Type: MESSAGE
Task name: /root/upstream_compat/launcher_entry_review
Sender: /root/upstream_compat
Payload:


{"type":"encrypted_content"}

## 2026-09-17T13:38:45.089Z · 助理

探针实测显示：编译时使用正式文件名、运行时移动或重命名文件，以及切换工作目录，都没有造成入口路径比较失败。因此目前不能把静默退出归因于这项比较；主任务正在验证子进程生命周期。

自动执行审查拒绝了临时探针目录的删除操作，工具仅返回“blocked by policy”，未提供更具体原因；该临时目录已保留。

## 2026-09-17T13:39:25.067Z · 助理

只读审查和临时元信息探针完成。**目前没有证据表明正式安装路径与临时 fixture 的差异导致入口 guard 失效。** 子进程 `unref()` 的生命周期仍应由你正在运行的真实复现决定。

实测 Windows 编译结果如下：

| 情况 | `import.meta.main` | 规范化后 `Bun.main` 与模块 URL 是否相等 |
|---|---:|---:|
| 临时目录内编译并运行 `compiled-loader.exe` | `false` | `true` |
| 同一 exe 复制并重命名为完整安装层级中的 `xuanji-launcher.exe`，以便携根为 cwd | `false` | `true` |
| 上述文件以 `F:/codex/xingyao` 为 cwd | `false` | `true` |
| 编译时直接输出到安装层级中的 `xuanji-launcher.exe`，以便携根为 cwd | `false` | `true` |
| 上述文件以 `F:/codex/xingyao` 为 cwd | `false` | `true` |

正式文件名探针中的实际值是：

```text
Bun.main:        B:/~BUN/root/xuanji-launcher
import.meta.url: file:///B:/%7EBUN/root/xuanji-launcher
fileURLToPath:   B:\~BUN\root\xuanji-launcher
```

现有 `pathKey` 的确能把这些值变成相同路径。

仍然存在两个代码层面的风险：

- [launcher.ts](/F:/codex/xingyao/src/launcher.ts:93) 的 guard 一旦两个条件都为 false，会完全跳过 `launcherMain()` 和错误处理，正常退出且没有日志。这是结构上的失败模式，但本轮探针未触发。
- [install.ts](/F:/codex/xingyao/script/install.ts:56) 的 `Start-Process` 没有等待子进程。PowerShell 的 `catch` 只覆盖创建进程失败，无法判断 loader 是否实际执行或随后失败。当前编译测试也只验证“缺少参数时退出 1”，没有验证 loader 启动成功后产品进程能持续存活。

最小专用入口方案可以直接沿用现有 [cli.ts](/F:/codex/xingyao/src/cli.ts)：

```ts
// src/launcher-cli.ts
import { launcherMain } from "./launcher"

await launcherMain().catch(() => {
  console.error(
    "XINGYAO_START_BLOCKED: release verification or recovery validation failed; no unchecked release was started.",
  )
  process.exitCode = 1
})
```

对应变动仅需：

1. 从 `launcher.ts` 删除自动执行 guard 和不再需要的 `fileURLToPath` 导入，保留导出的 `launch` / `launcherMain`。
2. 安装器编译入口改成 `launcher-cli.ts`，启动器源码哈希列表加入该文件。
3. 编译测试也使用 `launcher-cli.ts`。
4. 增加使用临时完整安装目录、真实编译 loader 与无害实际子程序的成功启动测试，明确验证子程序 marker 和存活状态；这一项才能覆盖你正在调查的生命周期问题。

没有编辑项目文件，没有运行正式 `F:/Xuanji` 或整套测试。

自动执行审查拒绝了临时探针目录的删除操作，工具仅返回“blocked by policy”，未提供更具体原因。目录 `C:/Users/LT/AppData/Local/Temp/xingyao-launcher-meta-57fe23bb443243fbbc72b97c261a9af3` 已保留，未尝试绕过拒绝。
