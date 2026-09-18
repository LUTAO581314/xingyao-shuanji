# OpenCode 完整引擎源码队列

`manifest.json` 格式 2 固定公开上游 `anomalyco/opencode` 的提交 `e03db9bc6908f75c9334d8aa997deeaac81c0298`、原始 Git tree、四份补丁的 SHA-256、重放后的完整 Git tree，以及全部 55 个变更路径的内容哈希或删除状态。

以前记录的 `d0a9b965ac3cfbd8a80c636508ab225c3c91f740` 是本地产品提交，不是公开上游基线。GitHub 上游与产品仓库的 commit API 均无法取得它。现在不再要求构建机器能取得这个本地提交。

队列顺序不可交换：

1. `000-legacy-product-source.patch`：从公开基线补齐两个历史产品提交中引擎需要的 `bun.lock` 与 `packages/` 变更，包括旧 Soul、产品提示词及 TUI 国际化。它保存现有引擎来源，不表示这些旧设计是独立产品今后的架构；独立产品继续强制关闭旧 Soul。
2. `001-filesystem-search-import-cycle.patch`：文件系统搜索导入环修复及回归。文件内容和原 SHA-256 保持不变。
3. `002-portable-workspace-paths.patch`：便携盘符与 Git 根目录修复及回归。文件内容和原 SHA-256 保持不变。
4. `003-legacy-runtime-and-upgrade-guards.patch`：旧 Soul 运行时修复、专属版本升级保护、主页文案，以及原工作区中遗漏的运行时测试。

三个必要的未跟踪回归测试已全部收录。旧 dist、备份二进制、依赖安装目录、用户数据、`.trae` 任务资料不进入补丁。历史可选 Docker 工作区插件、容器文件和旧便携启动器不参与本产品使用的单平台引擎编译，也不纳入引擎补丁；逐项理由见 manifest。

在产品源码目录执行：

```powershell
bun run script/engine-source.ts prepare C:/xingyao-build/engine-source
bun run script/engine-source.ts verify C:/xingyao-build/engine-source
```

父目录必须已经存在，目标目录必须全新。`prepare` 从固定公开 URL 获取固定提交并校验 tree；可追加 `--reference C:/path/to/existing-opencode`，先从已有本地对象库加速取对象，仍会向公开上游确认提交。引用库只读，不复制它的未提交文件，不把它当作验证结果。脚本不清理或复用已有目录，不提交，不推送，不安装依赖，不编译。中途失败保留现场，下次使用另一个新目录。

`verify` 只接受此脚本准备的独立 Git 目录，核对准备收据、基线、完整暂存树、未暂存修改、全部变更文件、额外源码和补丁完整性。依赖安装结果及二进制验收另行进行，不由源码校验代替。

依赖通过 `bun install --frozen-lockfile` 安装。候选构建固定 Bun `1.4.2`、Windows x64、`product-dev`，必须提供固定的 `MODELS_DEV_API_JSON`，并使用固定上游源码的真实版本 `1.18.31`。产品通道和二进制哈希负责区分专属构建，避免虚构低版本导致模型服务拒绝。完整命令和来源限制见 `docs/engine-source.md`。

历史 `engine.5` 的源码集合已重放并逐文件与原工作区核对，但当时下载的 models.dev 快照及已安装依赖实际内容没有归档。不得声称已重建原二进制，或声称能逐字节重建它。新候选必须重新通过产品真实引擎、迁移恢复和完整发行门禁后才可替换合格版本。

升级时在新的隔离 checkout 中，优先剥离旧产品逻辑，并核对上游是否已解决每个执行问题。若仍需补丁，先 `git apply --check <patch>`，检查通过后再应用。发生冲突应重新审查对应接口和根因，不能因为补丁能机械套用就标记兼容。

应用之后至少运行：

- 上游 core 的导入顺序、文件系统、portable-path 与 Project.resolve 回归，以及 core/opencode 的类型检查。
- 编译待测引擎，并设置 `XINGYAO_TEST_OPENCODE` 指向实际二进制，运行产品 adapter、engine、real-engine、engine-backup 四套测试。真实测试必须执行，不能以 skipped 作为通过。
- 产品完整测试、编译后产品测试、发布文件完整性检查。成功后才更新产品引擎版本与哈希；测试失败保留现有合格版本。

当前备份恢复要求引擎版本完全一致，不自动假定新版本可读取旧数据库。真正切换引擎版本之前，还需在隔离的宿主状态副本上验证上游迁移、原会话继续执行，以及使用旧引擎和旧完整检查点回退。不要让旧引擎打开已被新版迁移的数据库来试探能否回退。

补丁动机、退出条件、已测事实和测试范围限制详见 `docs/opencode-patches.md`。
