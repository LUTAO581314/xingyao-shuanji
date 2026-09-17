# OpenCode 接缝与发行验证记录

记录日期：2026-09-17。产品通过独立 HTTP 适配器使用 OpenCode，领域状态不写进上游数据库。这里记录本轮新增的两组上游执行补丁及实际验证，不能把当前候选的通过结果推及未来版本。

2026-09-18 补充：下文保留 engine.5 的历史证据。当前源码队列已扩为四份补丁，公共基线已修正为 `e03db9bc6908f75c9334d8aa997deeaac81c0298`；`d0a9…` 是本地产品提交。干净来源、新候选构建和限制以 [引擎源码记录](engine-source.md) 及 manifest 为准。

## 当前合格候选

- 基线仓库：`C:/Users/LT/Documents/trae`，`product-dev`，HEAD `d0a9b965ac3cfbd8a80c636508ab225c3c91f740`。
- 当前工作树还含先前已存在的产品提示词、旧 Soul 与升级保护等未提交修改；本候选基于该工作树构建，不是该 HEAD 的干净重建。
- 路径：`C:/Users/LT/Documents/trae/packages/opencode/dist/opencode-windows-x64/bin/opencode.exe`。
- 实际 `--version` 与 HTTP health：`0.0.0-product-dev-20260917-engine.5`。
- SHA-256：`528277b2ea4178093a192da0fe33ef4768e7ae5514a7b21de006d07212c6df83`。
- 长度：`136180736` 字节。
- 平台：Windows x64，Bun `1.4.2`。
- `F:/bin/opencode-windows-x64.exe` 未被本轮引擎工作覆盖。
- 先前 `0.0.0-product-dev-20260917-soul.1` 的整个 dist 保存在 `C:/Users/LT/Documents/trae/packages/opencode/dist.pre-engine-fix-20260917`。
- `engine.3` 的 dist 保存在 `dist.pre-portable-fix-20260917`，`engine.4` 保存在 `dist.pre-git-portable-fix-20260917`，两者都不能作为通过全部便携验收的版本。

构建在 `C:/Users/LT/Documents/trae/packages/opencode` 执行：

```powershell
$env:OPENCODE_VERSION='0.0.0-product-dev-20260917-engine.5'
$env:OPENCODE_CHANNEL='product-dev'
$env:OPENCODE_RELEASE=''
bun run script/build.ts --single --skip-install --skip-embed-web-ui
```

上游构建脚本会清理其 dist。重新运行前必须保存需保留的候选目录；本次已先保存旧 dist。此构建没有嵌入上游 Web UI，璇玑使用自有界面。MIT 许可与第三方归属由产品发行包继续携带。

`patches/opencode/` 保存两组可重放补丁及 manifest。已在临时目录从记录的 HEAD 提取原始文件，依次 `git apply --check`、实际应用，再逐文件比较实际构建源码，全部一致。该队列不包含此前已有的产品工作树修改；升级门禁与迁移限制见该目录的 README。

## PATCH-001：消除文件系统搜索的运行时导入环

**触发与故障：** 原 F 盘引擎 `0.0.0-product-dev-202609160055` 和原新候选 `0.0.0-product-dev-20260917-soul.1` 都能通过健康检查、创建会话，但第一次真实 prompt 在发出模型请求前返回 HTTP 500。堆栈经过 `SystemPrompt.environment`、`LocationServiceMap`、`LayerNode.hoist`，出现 `undefined ... name`。

**根因：** `packages/core/src/filesystem.ts` 需要 `FileSystemSearch.node`；`packages/core/src/filesystem/search.ts` 为调用 `Entry.make`、`Match.make` 反向运行时导入 `FileSystem`。先初始化 search 时形成循环，文件系统节点的依赖数组捕获尚未初始化的 search 节点。源码模式会抛出 `ReferenceError: Cannot access 'node' before initialization`；当前打包模式表现为后续遍历依赖树时遇到 undefined。

**最小修改：** 仅修改 `packages/core/src/filesystem/search.ts`。保留 `FileSystem` 的 type-only 引用；运行时 `Entry`、`Match` 直接从 `@opencode-ai/schema/filesystem` 导入，替换原 `FileSystem.Entry.make`、`FileSystem.Match.make` 调用。没有跳过服务初始化、吞掉异常或移除项目引用能力。

**新增回归：** `packages/core/test/filesystem-search-import.test.ts` 在独立进程先导入 search，再导入 FileSystem，验证整棵依赖图已经初始化，避免测试进程中其他模块的导入顺序掩盖问题。已实际用原文件运行，测试如预期失败；恢复补丁后通过。原有 `test/location-filesystem.test.ts` 的读取、列目录、越界保护也通过。

**退出条件：** 上游以相同或等效方式消除这条运行时循环，且删除私有补丁后，搜索先导入回归、文件系统回归与编译后的真实 HTTP prompt/工具链全部通过，才可移除此补丁。每次升级都应重新核对，不能仅凭版本号判断。

诊断期间临时增加的 LayerNode 错误提示已撤回，不属于最终补丁。

## PATCH-002：显式便携模式保持固定盘符与 Git 根目录

**触发与故障：** 即使启动器以 `X:\projects\default` 启动 OpenCode 并通过公共 directory 参数请求，未补丁的 FSUtil.resolve 仍会把 SUBST 盘符还原为宿主的 `C:\...\portable-a\projects\default`，进而写入会话执行位置。实际模型环境上下文确认了这一点。只修复会话目录后，Git 返回的 workspace root 仍是物理根，虽能继续 read，但迁移后的其他操作会继续面对过时目录。

**最小修改：** `packages/core/src/fs-util.ts` 新增显式 `OPENCODE_PORTABLE_ROOT` 处理，只有 Windows 下启动器设置固定盘符根时启用。同步解析仍先规范化真实路径，再把该映射内的物理路径转换回逻辑盘符；解析到映射外的符号链接目标继续保留真实路径。Effect resolve 同样转换结果。`packages/core/src/git.ts` 在 Git 输出路径归一化后调用相同映射，覆盖工作树和 Git 元数据目录。没有修改上游私有数据库，也没有全局关闭符号链接解析。未设置开关时保持上游行为。

产品 `src/engine.ts` 先确认 projectDir 真实存在，再保留调用方的逻辑路径。当项目盘符的真实根与逻辑盘符不同，才向自有引擎设置此开关。固定映射在引擎运行期间必须保持；停止引擎后方可卸载或改绑。`src/portable.ts` 持久化已选盘符，后续被占用时明确失败，避免偷偷改盘符破坏旧会话。

**新增回归：** `packages/core/test/portable-path.test.ts` 创建真实 SUBST 与 junction，在隔离子进程比较未启用/启用时的同步、Effect 与 Git 解析，并验证映射外目标和同名前缀的邻居目录不会被错映。产品 `test/real-engine.test.ts` 分别测试普通目录和已有提交的 Git 仓库：A 物理根创建会话并读到 A 内容；停止、备份、卸载；移动到 B；同盘符重挂载；恢复到新 hostDir；原 sessionId 历史一致；再次授权 read 并读到 B 内容。恢复后发送给模型的 Working directory 和 Git Workspace root folder 均确认是固定盘符。

**退出条件：** 上游提供能稳定保留便携工作区身份的公共机制，且去掉补丁后上述普通/Git 搬迁、模型环境、权限与实际读文件测试全部通过，才可移除此补丁。仅健康检查或初次 read 通过不够。

## 产品引擎边界

`src/engine.ts` 启动自有子进程，通过 `serve --hostname 127.0.0.1 --port 0 --mdns=false --pure` 让操作系统分配端口；从限定格式的监听行读取实际地址，然后执行带随机 Basic auth 的 health 与 API 文档能力握手。不会使用伪造版本号或现成外部服务。stdout 仅内部消费，stderr 丢弃，不向 UI 回显子进程日志。

`hostDir/opencode/` 保存独立 XDG 数据、缓存、配置、状态和临时目录。只继承必要系统环境，不继承父进程模型密钥、认证和代理配置。设置禁用项目配置、外部技能扫描、Claude 技能扫描与自动更新的环境开关。

`configPath` 只能指向 hostDir 内显式选定的新 JSON。接受模型与 provider 配置，不读取旧 OpenCode 配置或凭据；拒绝外部文件和环境变量替换。最终强制 `soul.enabled=false`、`permission="ask"`、`plugin=[]`、`autoupdate=false`、`share="disabled"`。当前 fork 接受自定义 soul 配置字段；未来上游若拒绝该字段，需要版本适配，并验证不会重新启用旧学习器。

权限配置语法已根据上游 `ConfigPermissionV1` 核实：`"ask"` 归一为 `{"*":"ask"}`。真实工具测试同时放入 `permission="allow"` 的项目配置，仍然收到了 read 权限请求，验证项目配置没有覆盖产品设置。

启动超时会终止本次创建的进程。stop 幂等，只操作持有的进程对象；调用方应先处理会话和持久化任务，stop 不代表外部动作已撤销。双实例测试确认停止第一实例不会结束第二实例。基础服务能启动，不等于模型凭据有效，实际模型连接另行报告。

## 实际执行验证

在 `F:/codex/xingyao` 执行：

```powershell
$env:XINGYAO_TEST_OPENCODE='C:/Users/LT/Documents/trae/packages/opencode/dist/opencode-windows-x64/bin/opencode.exe'
bun test test/adapter.test.ts test/engine.test.ts test/real-engine.test.ts test/engine-backup.test.ts
bun run typecheck
```

本轮 engine.5 结果：**28 通过、0 失败、0 skip、166 个断言**，涵盖适配器、启动器、真实模型协议链路与引擎备份四个测试文件。产品 TypeScript 检查通过。`XINGYAO_TEST_OPENCODE` 优先指定待测引擎；未指定时，从项目 `dist/xingyao-${PRODUCT_VERSION}/opencode.exe` 读取实际产品引擎。构建前若该文件不存在，真实测试显示 skipped，不构成发布验收；发行门禁必须检查无 skip。原 F 盘 exe 无法通过完整真实 prompt 测试，不应回退为当前合格引擎。

真实模型服务是测试在随机回环端口启动的 OpenAI Chat Completions/SSE 协议模拟器。配置使用 `npm: "@ai-sdk/openai-compatible"`、本地 `/v1` 地址、合成测试 key；`model` 与 `small_model` 都固定到这个本地 provider，enabled_providers 仅包含测试 provider。未使用真实模型密钥，未调用公网模型。

已验证：

- 真二进制启动、版本/路由握手、独立 provider 配置、创建会话、读取持久会话、取消。
- `system` 有限投影确实出现在发送给模型的 system/developer 消息中。
- 模型正常文本响应经过 OpenCode 执行并保存，适配器读取结果一致。
- 模型发起真实 read 工具；产品收到权限请求，明确 once 回复后读取测试文件。
- 工具 output 包含文件实际内容，标准化证据保留 session/message/part/call 来源。
- 另一个会话 reject read 权限，持久工具记录被规范化为失败，未伪装成功。
- 旧 Soul 没有生成领域目录，测试文件保持原内容。
- 超时、非 JSON 响应、结构变化、来源不匹配、重定向与凭据输出保护由本地 HTTP 边界测试覆盖。
- 普通与 Git 项目在 SUBST 固定盘符下移动物理根，并把引擎数据库恢复到另一个 hostDir 后，继续同一会话且读到新内容；模型环境也反映稳定工作区。

上游 `packages/core` 与 `packages/opencode` 的 `bun typecheck` 均通过；core 搜索导入与现有文件系统回归共 **4 通过、0 失败**，便携路径与原有 Project.resolve 回归共 **11 通过、0 失败**。

## 尚未被这些测试证明的能力

本适配器支持 legacy `/session` HTTP；OpenCode `/api` V2 接口单独标记不支持。没有验证任意 MCP、其他模型供应商、完整 bash 执行、ACP/终端客户端记忆接入、另一台实体电脑的差异、故障断电或任意未来版本。当前迁移测试在本机使用不同物理目录和全新宿主数据目录；不能等同于所有 Windows 版本、设备与文件系统的兼容性认证。公共 Hook 不作为完整证据总线，模型输出文本也不作为外部任务成功证明。

配置修改当前采用停止旧自有引擎、写入新产品 JSON、重新启动并握手的方式。一次启动从 configPath 读取配置快照，运行中改文件不会自动重载；调用方应等待会话空闲再重启。

## OpenCode 数据检查点与路径恢复

`src/engine-backup.ts` 提供 `backupEngine(hostDir,generationDir,engineVersion)`、`verifyEngineCheckpoint(generationDir)`、`restoreEngine(hostDir,generationDir,expectedVersion)`。在既有 generation 下创建 `engine/`，只允许 `opencode.db` 与 `opencode-product-dev.db`；当前候选使用后者。auth.json 和非数据库资料不复制。遇到未知库文件名或没有主库的 WAL 等旁文件会拒绝备份，避免发布缺会话的空快照。

每个库通过只读 SQLite 连接执行 `VACUUM INTO`，捕获已提交数据（包括 WAL）；再把快照转换为独立 DELETE journal 文件。记录文件名、长度、SHA-256、SQLite user_version/schema_version，验证 integrity_check 后最后写 engine/complete.json。没有读取或改写上游私有表。外层必须暂停任务并协调领域库与引擎快照；各库分别一致不等于跨库同时提交。

恢复仅接受完全相同的 engineVersion，验证哈希与完整性后，使用宿主文件系统的独占硬链接安装已校验副本，不覆盖已有数据库或 WAL/SHM/journal。需要 NTFS 等支持硬链接的宿主文件系统；不在 exFAT 上假装完成这种原子安装。已有目的数据、不同引擎版本、缺完成清单或损坏文件均拒绝恢复。

新增 8 个备份测试覆盖提交与未提交 WAL、凭据排除、损坏且重新计算哈希的伪快照、非法路径、未知文件、版本不符、已有状态与目录重定向。真实 engine.5 测试还验证：在新 hostDir 恢复数据库后，以**同一稳定 projectDir 路径**读取相同 sessionId 的历史并继续 prompt，新的 read 权限与工具证据正常。

**实际限制：** legacy OpenCode 将执行位置保存在会话中。仅把 adapter.directory 改成新物理路径不会迁移已有会话；原路径不存在时，继续 prompt 返回 HTTP 500，发生于构建环境上下文时，模型尚未调用。这也有真实回归验证。产品通过已验证的固定挂载路径和 PATCH-002 保持会话身份；这不会修复旧版本已经保存为绝对物理目录的会话。不能把 SQLite 完整性通过解释成任意盘符与路径变化都能继续。
