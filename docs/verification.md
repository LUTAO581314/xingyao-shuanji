# 星杳 · 璇玑首个可用开发预览验收

最新已安装最低可用版本为 `0.1.0-dev.15`，使用 OpenCode `1.18.31`，保留 `.14` 的委派闭环并修复真实免费模型连接。`.5` 的证据与恢复历史见 [证据与恢复发行验收](verification-evidence.md)，图谱历史验收见 [图谱工作台验收](verification-graph.md)。下面继续保留早期发行证据。

`.15` 保持 schema 5 和 `.14` 的产品能力，只修复引擎版本兼容及对应升级基准。完整门禁为 424 项通过、0 失败、0 skip，并通过编译产品图谱、对话记忆、协作闭环、草稿及并发浏览器验收。此前 `.9` 的编辑恢复依据见 [编辑恢复候选验收](verification-workspace-recovery.md)，`.8` 与 `.7` 的依据分别见 [对话记忆候选验收](verification-memory-review.md) 和 [引擎迁移候选验收](verification-upgrade.md)。

## `.15` 最低可用正式版

记录与安装日期：2026-09-18（Asia/Shanghai）。候选 `F:/codex/xingyao/dist/xingyao-0.1.0-dev.15` 通过发行门禁后安装到 `F:/Xuanji`，并从 `F:/启动星杳.cmd` 实际启动。正式身份保持 `487fe2aa-0a93-4186-ac4e-3d331fc286bd`，安装选择为 `000000000007-8c8f3278-b240-4bc5-b517-1ae57f53e669`，发行目录为 `F:/Xuanji/system/releases/r-mu6itutq-82739ab6-19c7-4527-a56a-c147a9830c1b`。

```text
release.json  aa8b0e881da479d4f7b7c29057201c45474d8da25ab57d46d7400cc6a4ae430a
xingyao.exe   52c8fd4f680ed74b8aa888ce229d5379a1a82f5e62759bae61be54e219dcd613
opencode.exe  f638ddeeaeb30881d075654de3a51fb0893a93cbc5926f1d8e0cbda30cd872a7
```

- [绑定 `.15` manifest 的通过报告](../dist/xingyao-0.1.0-dev.15/release-validation.json)
- [424 项零跳过测试日志](../reports/2026-09-18T05-26-39-710Z-tests.txt)
- [正式安装验证记录](../reports/installed-0.1.0-dev.15.json)

真实连接验收先暴露了 `.14` 的缺陷：定制引擎报告 `0.0.0-product-dev-20260918-engine.6-source`，OpenCode 免费服务要求至少 `1.18.0`，两次请求均以 `APIError` 失败。固定源码的 `packages/opencode/package.json` 实际版本为 `1.18.31`；`.15` 恢复该版本，同时保留 `product-dev` 通道、禁用自动更新和二进制哈希绑定。隔离身份随后收到准确回复 `XINGYAO_FREE_TIER_OK`。

正式升级前保存 `.14` 代次 `mu6it124-e701547e-2a8e-4f6d-82ac-1a567de08941`。离线迁移逐项核对一个产品绑定会话的 4 条公开消息，生成配套代次 `mu6ithx0-41c64c3d-dbd2-4585-90fa-7c74425ad8dd`；原发行和原代次未覆盖。安装 `.15` 后，同一任务和同一 OpenCode 会话从 `failed` 继续，真实免费模型回复“星杳最低版本正式连接正常。”并进入验收。任务确认完成后保存代次 `mu6ivs5v-ff7290bd-1b0a-43b6-a7ea-648d64d1e0b3`，再次从根目录入口启动，身份、任务、回复和完成状态均恢复，engine health 为成功，未同步状态为 false。

`.15` 是可日用的最低版本，不表示长期人格学习、语义人物关系、自动遗忘质量、产品 OpenCode 会话 GitHub 归档或 Infinite Canvas 已完成。

## `.14` 本地候选验收

记录日期：2026-09-18（Asia/Shanghai）。候选目录为 `F:/codex/xingyao/dist/xingyao-0.1.0-dev.14`，引擎为 `0.0.0-product-dev-20260918-engine.6-source`，数据库 schema 为 5。失败的 `.11`、`.12` 和 `.13` 浏览器前置候选没有通过报告，也没有覆盖或替代 `.14`。

```text
release.json  d6e30934f7885d60c548db66cea98180a5a044c5b8f6e4a0377432808d9c46f9
xingyao.exe   8ae4e46724b2f9e7ed31d7b6d01ff432decde39a47a94d15dce0509301654b22
opencode.exe  f02b6bbba598d4f2e9e1c1f75794104b9581129ae199d3130b4bc2e552ee748b
```

- [绑定候选 manifest 的通过报告](../dist/xingyao-0.1.0-dev.14/release-validation.json)
- [424 项零跳过测试日志](../reports/2026-09-18T02-56-47-578Z-tests.txt)
- [协作闭环浏览器报告](../reports/collaboration-browser-0.1.0-dev.14.json)
- [桌面协作截图](../reports/collaboration-browser-0.1.0-dev.14-desktop.png)
- [390px 手机协作截图](../reports/collaboration-browser-0.1.0-dev.14-mobile.png)

协作浏览器验收实际从编译产品创建 1 项委派，使父子树达到 4 个子会话；第二条说明复用同一个受控子会话，随后选择已完成来源交回根任务，根任务产生新的汇总并进入普通验收。页面错误、CSP 错误、外部请求和手机横向溢出均为 0。固定 engine.6-source 还在隔离运行中验证了实际 `explore`/`general` 角色、所有权 metadata、父子会话查找和完整空历史读取。

记录日期：2026-09-17（Asia/Shanghai）。结论：`0.1.0-dev.2` 已通过最终制品验收，安装到 `F:/Xuanji`，并通过 F 盘根目录的真实启动入口启动。本记录证明下列具体能力，不表示完整 V2 设计已经全部完成。

## 制品与安装

| 项目 | 实际值 |
| --- | --- |
| 产品 | `0.1.0-dev.2`，Windows x64 |
| 引擎 | `0.0.0-product-dev-20260917-engine.5` |
| Bun | `1.4.2` |
| 源码 | `F:/codex/xingyao`，本地 `product-v2` 分支 |
| 启动入口 | `F:/启动星杳.cmd` |
| 安装根 | `F:/Xuanji` |
| 当前发行 | `F:/Xuanji/system/releases/r-mu5l3ktm-3119aed2-2b49-4b2b-97ea-80f56ffc3dea` |
| 便携稳定工作路径 | `X:/`，实际映射到 `F:/Xuanji` |
| 宿主活动目录 | `C:/Users/LT/AppData/Local/Xuanji/58c7da30-1594-4275-b11b-8816f9494e15` |
| 首个检查点 | `mu5l57rj-063ccb54-7874-4a7f-b480-2a699119906b` |

制品 SHA-256：

```text
release.json  1d228f3b658063e9742519eee1eb8ea0a6bf103d2a53eaf52e6672a7ac3597b4
xingyao.exe   1787072c68948872f278f2a53fcdbbc843a27af0840e35b7068de12525f5ebe2
opencode.exe  528277b2ea4178093a192da0fe33ef4768e7ae5514a7b21de006d07212c6df83
src tree      88f2d41b834d04d9e86fdfded1ca34d5b3d57077dc5c1060abbc41c74348d93a
```

安装后再次通过 `resolveCurrent` 校验发行文件与选择记录，并确认工作树 `src` 的哈希与构建记录相同。旧 `F:/bin/opencode-windows-x64.exe`、旧启动器和旧用户数据保持原状。测试数据使用隔离身份与目录，没有写入正式身份；正式首次启动时任务数为 0。

## 最终自动验收

命令：`bun run script/verify-release.ts`。类型检查通过；**185 项通过、0 失败、0 skip、8002 个断言，21 个测试文件**。实际测试耗时 70.61 秒。

- [完整测试日志](../reports/2026-09-17T13-45-30-543Z-tests.txt)
- [类型检查日志](../reports/2026-09-17T13-45-30-543Z-typecheck.txt)
- [绑定制品哈希的通过报告](../dist/xingyao-0.1.0-dev.2/release-validation.json)
- [构建清单](../dist/xingyao-0.1.0-dev.2/release.json)

报告由实际门禁生成，没有手写通过状态。安装器要求后端契约、恢复、产品集成三类真实测试证据。安装选择日志的 `validation` 字段保存相同报告，`current.json` 是便捷镜像，启动器读取完整选择日志。

验证范围包括：

- 记忆来源、项目范围、私密过滤、纠正和删除传播；删除后保留幂等标识与同源删除标记。
- 情绪随实际工具事件变化、时间恢复、重复事件去重，以及确定性睡眠游标与归档事务。
- 中文知识检索、原文行号、刷新、文件整理及撤销后稳定资料 ID。
- 经验独立证据计数、验证启用、证据撤回后的重审。
- SQLite/WAL 一致快照、代次哈希和完整性、单写者锁、分叉拒绝、配套领域库与引擎库恢复、恢复中断续接。
- 真实 OpenCode 二进制、公开 HTTP 接口、本地确定性模型、真实 read 工具、允许一次与拒绝、结果入账、同会话恢复。
- 普通和 Git 项目改变物理目录、同一稳定盘符重挂载后继续旧会话并读取新的文件内容。
- 编译后的 Windows 主程序和加载器；中文、空格、`&`、单引号路径；重复打开；API 保存退出；子程序失败退出码传播与输出隔离。

## 浏览器与实际入口

对最终 `.2` 编译制品执行 `script/browser-check.mjs`，Microsoft Edge 通过：记忆新增与纠正、资料导入与中文检索、经验表单与空态、睡眠整理、文件预览/执行/撤销、保存检查点、模型设置页面，以及 390 像素宽度的布局。JavaScript 页面异常为 0，页面没有水平溢出。

测试宿主为 `C:/Users/LT/AppData/Local/Xuanji-Preview-2`，便携测试根为 `F:/codex/xingyao/.local/preview-2`，测试结束后通过保存退出关闭。

- [桌面截图](../../design/xingyao-first-build.png)
- [窄屏截图](../../design/xingyao-mobile-check.png)

随后从 `F:/启动星杳.cmd` 实际启动正式安装：工作台 `/api/state` 返回 `0.1.0-dev.2`，执行引擎 health 为成功且版本匹配；生成并校验首个便携检查点。浏览器已由正式入口打开，运行时保留供用户配置与试用。

`.1` 在最终实际入口检查中发现 Windows/Bun 的 `child.unref()` 使启动器提前退出并连带终止主程序，因此不作为最终交付版本。`.2` 通过等待主程序退出修复此问题，并采用独立加载器入口。额外实测发现 SUBST 输出中文路径受系统代码页影响；现仅解析输出中的 ASCII 盘符，使用 `realpathSync.native` 核实 Unicode 物理路径，失败时回收本次创建的映射。上述问题均有新增真实回归覆盖。

## 使用与证据边界

1. 模型服务需要在「系统中心」由用户填写 OpenAI 兼容接口、模型名称与密钥。保存成功只证明本地引擎接受配置，首次简短任务成功后才能确认远端服务可用。本轮未使用真实密钥或调用公网大模型，不能据此宣称实际生成质量已验收。
2. 安全携盘需要「保存并退出」，确认程序结束后在 Windows 弹出。关闭浏览器标签页不等于退出程序。工作中的最新数据与明文模型配置位于宿主用户目录；意外拔盘前未同步的变化可能仅保留在该电脑。
3. 换机目标为 Windows x64，宿主活动库需要 NTFS，记录的稳定盘符需可用。本次验证是在同一实体电脑上使用不同物理目录和宿主目录；真实第二台电脑、实际拔盘/断电尚未测试。
4. 导入资料的文本缓存与索引进入检查点；原始文件、原电脑绝对路径、附件和项目依赖没有自动全量迁移。
5. 当前遗忘体现为检索新鲜度衰减与显式管理，不等于自动删除。删除独立记忆不会清除已有备份、OpenCode 原生会话或原始文件。
6. 当前气质固定为温暖、有主见、稳定；情绪按已核实事件计算并随时间恢复。睡眠采用确定性归档，复杂人物关系、模型自动记忆提取、自动技能提案及长期气质成长仍在后续清单。
7. OpenCode 兼容性只覆盖固定并通过测试的 legacy HTTP 候选；新版本需重新构建、验证契约与恢复再切换。V2 API、Docker、PDF/OCR、语音、视觉、Linux 启动和大规模长期使用尚未验收。

完整目标见 [系统设计](system-design.md)，已实现与待推进项见 [实施状态](implementation-status.md)，引擎补丁与源码基线见 [补丁记录](opencode-patches.md)。

辅助审查的元信息探针目录 `C:/Users/LT/AppData/Local/Temp/xingyao-launcher-meta-57fe23bb443243fbbc72b97c261a9af3` 清理被自动审批以 `blocked by policy` 拒绝，未提供具体原因。该测试目录保留，不影响产品安装或运行。
