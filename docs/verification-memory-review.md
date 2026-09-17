# 对话记忆候选验收

2026-09-18（Asia/Shanghai），本地 Windows x64 候选 `0.1.0-dev.8` 通过 `bun run script/verify-release.ts`。产品仍处于开发预览；本次没有安装或迁移正式身份，已安装版本仍为 `.5`。

## 制品与来源

候选目录：`F:/codex/xingyao/dist/xingyao-0.1.0-dev.8`。

| 项目 | SHA-256 / 版本 |
| --- | --- |
| release.json | `0c8e01a008abcb5f1b80406b71c0ff9e3e0d1bd16e6df425ea8ecd7c75458443` |
| xingyao.exe | `b212fa9cb3ab9410577450bc4b735a50aa868c111a116ee294ac27e4d6c49582` |
| src hash | `68ad115371198321ba3f86a2d67d23e378821d0749d78cda5f7d59468ace89b8` |
| OpenCode | `0.0.0-product-dev-20260918-engine.6-source` |
| opencode.exe | `f02b6bbba598d4f2e9e1c1f75794104b9581129ae199d3130b4bc2e552ee748b` |
| 领域数据格式 | schema 3；支持从历史 schema 1/2 工作副本迁移 |
| 浏览器 | Microsoft Edge `153.0.4234.32` |

固定上游公开提交、补丁树和引擎构建来源沿用 `.7`；本次无需新增引擎补丁。源码编译结果与通过报告绑定具体哈希，不声称跨机器构建可逐字节复现。

## 完整门禁

类型检查通过。测试 **368 pass、0 fail、0 skip，10,172 个断言，35 个文件，128.72 秒**。

- 完整日志：`reports/2026-09-17T19-07-20-990Z-tests.txt`。
- 通过报告：候选内 `release-validation.json`，由门禁实际生成。
- 原图谱/文件工作台：`reports/graph-browser-0.1.0-dev.8.json`。
- 对话记忆：`reports/memory-review-browser-check.json`。

本地 `reports/` 与 `dist/` 不提交 Git；公开发布时应把对应报告与制品作为发行或 Actions 附件一起保存，不能仅凭本文宣称远端测试已执行。

## 覆盖的用户行为

领域与 HTTP 回归验证真实原始聊天绑定、精确引文、主体/转述归属、候选不直接写记忆、人工采纳事务、修订冲突、同范围替代、有效期、来源删除、封存再解封、失败不重发、前台抢占、清理重试及退出检查点。schema 2 检查点恢复为 3 后，旧身份与历史检查点字节保持完整。独立汉字混合查询的召回缺陷已修复。

真实 OpenCode 测试核对独立 session、deny-all、模型请求无工具、伪造 write 不执行且整批拒绝、前台历史不变、真实 abort、所有权检查和删除后双 404。

编译产品浏览器验收从真实用户对话开始，经公共 API、固定引擎和 localhost 模型产生候选。验证来源与恶意 HTML 的字面显示、手选有效期、轮询保留 DOM/焦点、真实并发 409、封存和拒绝、长期/日期采纳、同范围替代、到期与未来标记、桌面/手机布局。页面异常、CSP 异常、外部网络请求均为 0。自动整理默认关闭、显式保存限额与开关另在相同编译制品上补充验证。

历史 engine.5→当前候选引擎的真实迁移、旧任务续接、配套恢复与故障分支回归同样执行，无跳过；记录在 `release-validation.json.engineUpgrade`。

## 未由本次验收证明的部分

模型是本地确定性夹具，没有使用公网真实大模型，因此不证明中文提取准确率、长期助理体验或费用。24 项中文人工预期已放入 `evals/`，尚未得到真实模型评分。90 天容量、候选档案分页、孤立创建响应恢复、语义检索、长期气质学习、子智能体工作台和 Infinite Canvas 集成仍有待推进。

GitHub 远端仍以聊天档案为默认分支；源码未发布，hosted runner 未执行，Release 历史引擎基准尚未上传。本地验收不能代替这三个发布条件。
