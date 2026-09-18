# .9 编辑草稿与恢复验收

日期：2026-09-18（Asia/Shanghai）。本地 `0.1.0-dev.9` 候选通过完整发行门禁。正式身份的已安装版本仍为 `.5`；`.9` 当前以独立演示身份开放体验。本报告不代表完整 V2 架构已完成。

## 可核验制品

候选：`F:/codex/xingyao/dist/xingyao-0.1.0-dev.9`，schema 4。引擎为 `0.0.0-product-dev-20260918-engine.6-source`。

```text
release.json  110787ad8cd8498f1d00f2bc8199fe4aac0541b41a5c47b31194b16286dde1c8
xingyao.exe   05aedfb491b047c1730c1101a2515a0bc121f8242bcf1b297c2d94067238b587
opencode.exe  f02b6bbba598d4f2e9e1c1f75794104b9581129ae199d3130b4bc2e552ee748b
src tree      f57158dfd076d755062612853fee863be71ab13dae942e06084ad4f850e3fad2
```

`bun run script/verify-release.ts` 实际生成 [制品验收报告](../dist/xingyao-0.1.0-dev.9/release-validation.json)：**415 pass、0 fail、0 skip、10,548 个断言，38 个文件，140.28 秒**。类型检查通过。完整证据见 [测试日志](../reports/2026-09-18T01-33-08-487Z-tests.txt)。

浏览器为 Edge 153.0.4234.32，以下验收均通过，页面脚本、CSP 和外部请求异常均为零：

- [图谱与文件界面](../reports/graph-browser-0.1.0-dev.9.json)，绑定上述 EXE。
- [真实引擎对话记忆审阅](../reports/memory-review-browser-check.json)，绑定上述 EXE。
- [编译产品草稿界面](../reports/workspace-draft-browser-0.1.0-dev.9.json)，覆盖产品重启、双窗口 CAS、明确合并、网络失败、并发清理、缺失目录、保存切页，以及桌面/手机布局。
- [源码浏览器并发复审](../reports/draft-browser-check.json)，8 个场景，测试前后源码哈希一致。该组是源码服务器测试，门禁另有前三组编译产品验证。

门禁会同时核对当前源码、制品清单、浏览器报告哈希和旧引擎基准。本轮保留了发现界面并发缺陷时的未合格候选，路径为 `dist/xingyao-0.1.0-dev.9-pre-navigation-fix`；它没有通过报告，不用于安装。

## 此次关键验证

草稿确认后持久保存并进入检查点，源文件和知识库不被自动改写。重复请求、双窗口竞争、丢弃后的迟到保存、明确 rebase、2 MiB 单份/16 MiB 总量限制，以及 schema 3→4 迁移均有回归。

文件恢复使用子进程真实突然退出，在本机 NTFS 和 F 盘 exFAT 隔离目录覆盖 8 个保存中断点及 5 个恢复中断点。F 盘重命名改变文件标识的情况已修正。测试覆盖外部改写、目录替换、伪造日志、第二进程锁及恢复中的再次中断。服务端集成验证恢复后只更新已导入且内容仍可证明的知识快照，保留资料范围与私密属性。

浏览器复审曾发现迟到丢弃响应清除另一文件新输入、迟到合并响应污染另一文件草稿状态，以及保存与切页共同等待导致永久忙碌的问题。当前候选已修复；这些场景已进入持续验收。

## 体验与限制

独立演示项目为 `F:/codex/showcase-09/project`，宿主为 `C:/Users/LT/AppData/Local/Xuanji-Showcase-09`，便携演示根为 `F:/codex/xingyao/.local/showcase-09/portable`。示例资料明确标为演示。当前启动使用离线模式，文件、草稿与图谱可用；模型对话需要另行连接真实模型服务。

草稿随身份检查点备份；项目副本和本机可信保存日志尚不跨机携带。目录授权不持久化，历史恢复记录与草稿墓碑尚无自动清理。实际拔盘/断电、长期容量和模型记忆提取质量尚未得到这些测试证明。完整边界见 [编辑草稿与保存恢复](workspace-recovery.md)。
