# OpenCode 网页基底与星杳补丁

本文记录网页端的实现决定。它与 [系统设计](system-design.md) 和 [OpenCode 接缝记录](opencode-patches.md) 一起使用。

## 结论

星杳网页端采用 OpenCode 开源网页应用的 **fork** 作为主线。OpenCode 的页面、会话状态、模型菜单、上下文面板、工具时间线、权限、MCP/LSP、文件与项目界面继续以官方源码为基线；星杳只在 fork 上加入灵魂状态和辅助工具。当前产品仓库中 `src/web/` 的 HTML/CSS/JavaScript 是早期过渡实现，不再作为最终 UI 的开发基底。

这里有两个容易混淆的层次：

- **fork 主线：** 包含完整的 OpenCode 网页源码、依赖、星杳改动和可构建结果。构建发行时使用它，不要求用户临时下载上游或执行补丁。
- **补丁队列：** 只保存星杳相对指定上游 commit 的差异，是同步和审阅材料。它不是用户运行时需要单独安装的半成品。

本机上游源码工作区：

```text
C:/Users/LT/Documents/trae/
├─ packages/app/          # 网页/桌面主应用
├─ packages/session-ui/   # 会话时间线、工具结果、文件与上下文视图
├─ packages/ui/           # 通用 UI、弹窗、主题、图标和交互组件
├─ packages/sdk/          # OpenCode 客户端契约
└─ packages/opencode/     # 服务端、TUI 和原生 HTTP API
```

## 页面承接关系

| OpenCode 原生页面/组件 | 星杳接入方式 |
| --- | --- |
| 会话首页和消息时间线 | 直接保留；在 session metadata、状态卡或消息旁增加来源/记忆标记 |
| 模型/provider 选择 | 直接保留；星杳只增加当前身份的默认模型提示和免费模型状态 |
| 右下角上下文用量入口 | 直接保留；星杳在详情面板附加记忆、知识和灵魂系统占用，不能替换原生 token 统计 |
| 状态 popover | 直接保留；增加星杳情绪、睡眠、检查点、知识索引和降级状态 |
| MCP、LSP、Agent、Skill、Command、Formatter、PTY | 直接保留并随上游更新；星杳显示其产生的事件和来源，不复制功能 |
| 文件树、项目、工作区、diff、权限 | 直接保留；星杳只添加知识导入、经历记录和检查点提示 |
| OpenCode 设置、命令菜单、快捷键 | 直接保留；星杳功能作为命令组或独立入口加入 |
| 知识图谱、Infinite Canvas、睡眠整理、检查点恢复 | 星杳独立路由，使用同一身份和 OpenCode 会话链接 |

## 代码边界

OpenCode 网页源码可以作为星杳前端的上游来源，但星杳领域核心仍不得导入 OpenCode 私有运行模块。网页层通过公开 SDK/HTTP API 调用星杳服务和 OpenCode；领域数据库与 OpenCode 数据库仍分别由各自所有者管理。任何原生能力缺失都要先补齐适配器和公开 API 接缝，再接入页面。

星杳补丁优先使用以下扩展点：

1. 上游已有的 session/sidebar、status popover、command palette、settings、dialog 和 route 扩展点。
2. OpenCode 公开 SDK 的事件、会话 metadata 和可读取的消息/工具结果。
3. 星杳自己的本机 API，用于记忆、知识、情绪、睡眠、检查点和辅助工具。

不得通过复制上游数据库表、修改上游私有组件或在浏览器中直连未经认证的引擎端口来实现补丁。

## 上游同步流程

网页仓库采用“fork 主线 + 上游镜像 + 可重放补丁”方式维护。建议的源码关系如下：

```text
upstream/opencode-web     # 上游只读镜像，固定 commit
Xingyao/web               # 可构建的 fork 主线：上游源码 + 星杳改动
patches/opencode-web/     # Xingyao/web 相对上游的可重放差异
```

每次上游更新按照以下顺序执行：

1. 固定 OpenCode commit 与网页依赖 lockfile，生成新的上游基线清单。
2. 在隔离工作树将新上游基线合并到 `Xingyao/web` fork，并构建 `packages/app`、`packages/session-ui`、`packages/ui` 和必要 SDK。
3. 重新应用并核对星杳网页补丁；补丁按文件记录原因、上游版本、替代路径和退出条件。
4. 执行 OpenCode 原生页面回归：启动、会话、模型切换、上下文面板、工具分段、权限、MCP/LSP、文件/diff、命令菜单和状态 popover。
5. 执行星杳回归：身份、情绪、记忆候选审阅、知识范围、睡眠整理、检查点、恢复、降级和权限边界。
6. 生成网页版本、适配器版本、领域 schema、引擎 SHA-256 和补丁 SHA-256 的发行记录。
7. 新候选失败时继续使用上一版网页和引擎组合，不在用户正式 F 盘上热替换。

## 当前差距

当前 `.15` 使用自制 HTML 页面和 legacy OpenCode 适配器。它可以作为领域服务、便携启动和回归测试的过渡壳，但尚未具备 OpenCode 官方网页的完整功能菜单、上下文详情、原生设置和状态组件。下一阶段的第一项网页工作是把上游网页构建接入星杳发行，而不是继续给 `src/web/` 增加页面。
