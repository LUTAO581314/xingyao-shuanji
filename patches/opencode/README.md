# OpenCode 补丁队列

这两组补丁已经从 `d0a9b965ac3cfbd8a80c636508ab225c3c91f740` 的原始文件在临时目录重放，并逐文件核对与实际构建源码一致。基线、补丁哈希、合格引擎版本与哈希见 `manifest.json`。

1. `001-filesystem-search-import-cycle.patch`：解除文件系统搜索导入环，包含独立导入顺序回归。
2. `002-portable-workspace-paths.patch`：显式便携模式保留固定盘符和 Git 根目录，包含真实 SUBST、junction 与 Git 回归。

补丁队列只包含本次新增的两组修复。当前候选还基于原有产品工作树修改构建，这些旧 Soul、提示词、界面与升级保护修改没有混入本队列。因此这份队列不是整个既有 fork 的完整源码发布清单。

升级时在新的隔离 checkout 中，先核对上游是否已解决每个问题。若仍需补丁，按上面的顺序 `git apply --check <patch>`，检查通过后再 `git apply <patch>`。发生冲突应重新审查对应接口和根因，不能因为补丁能机械套用就标记兼容。

应用之后至少运行：

- 上游 core 的导入顺序、文件系统、portable-path 与 Project.resolve 回归，以及 core/opencode 的类型检查。
- 编译待测引擎，并设置 `XINGYAO_TEST_OPENCODE` 指向实际二进制，运行产品 adapter、engine、real-engine、engine-backup 四套测试。真实测试必须执行，不能以 skipped 作为通过。
- 产品完整测试、编译后产品测试、发布文件完整性检查。成功后才更新产品引擎版本与哈希；测试失败保留现有合格版本。

当前备份恢复要求引擎版本完全一致，不自动假定新版本可读取旧数据库。真正切换引擎版本之前，还需在隔离的宿主状态副本上验证上游迁移、原会话继续执行，以及使用旧引擎和旧完整检查点回退。不要让旧引擎打开已被新版迁移的数据库来试探能否回退。

补丁动机、退出条件、已测事实和测试范围限制详见 `docs/opencode-patches.md`。
