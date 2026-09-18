# 引擎源码来源与隔离重放

核查日期：2026-09-18。本记录补齐过去只保存两份执行修复补丁的来源缺口；不改变现有合格发行的引擎选择。

## 固定来源

| 对象 | 值 |
| --- | --- |
| 公开仓库 | `https://github.com/anomalyco/opencode.git` |
| 可公开取得的上游提交 | `e03db9bc6908f75c9334d8aa997deeaac81c0298` |
| 上游 Git tree | `ff780efb02c97af08045ebc7857684bc39e06d5d` |
| 原工作区产品 HEAD | `d0a9b965ac3cfbd8a80c636508ab225c3c91f740`，本地自有提交 |
| 更早产品提交 | `a6436daed8c2c28b23fb7bdf8b889d3c1d57e632` |
| 完整补丁重放后的 Git tree | `1a4d9ee6b75e5f7de5938c5e3483f970fbab55fe` |
| 依赖锁文件 | `bun.lock`，1,117,822 字节 |
| 锁文件 SHA-256 | `1f34d506fd6dc250b74cfeb59af43647dee0b31cd0dc7cf58339f4a2caa2e9fe` |

公开上游 commit API 确认了基线提交及 tree。上游和产品仓库的同一 API 均无法取得旧记录中的 `d0a9…`，因此它不能作为公共 CI 的下载前提。`000` 补丁保存从公开基线到历史产品代码的实际差异，构建不再需要两个本地提交本身。

`patches/opencode/manifest.json` 保存四份补丁的完整 SHA-256、涉及文件和最终内容 SHA-256。最终 tree 同时绑定所有未修改的上游文件，避免仅校验补丁文件却忽略其余源代码。原工作区启用 `core.autocrlf=true`；来源比较采用 Git 的 LF 文本形式，隔离目录固定 `core.autocrlf=false`。

队列收录全部引擎相关的历史 `packages/` 改动、依赖锁、当前所有已跟踪 `packages/` 工作区差异，以及三个必要未跟踪测试：搜索导入、便携路径、旧 Soul 运行时。总共 55 个变更路径，其中包含删除状态。旧二进制、用户文件、任务设计资料、可选 Docker 插件与旧启动器的排除项和理由逐项列在 manifest 中。独立产品仍通过自有启动器运行引擎，并关闭项目配置、外部插件与旧 Soul。

## 源码准备与校验

使用 Bun `1.4.2` 和 Git，从产品仓库运行：

```powershell
# C:/xingyao-build 由调用者预先创建；engine-source 必须尚不存在。
bun run script/engine-source.ts prepare C:/xingyao-build/engine-source
bun run script/engine-source.ts verify C:/xingyao-build/engine-source
```

如本机已有上游对象库，可使用：

```powershell
bun run script/engine-source.ts prepare C:/xingyao-build/engine-source --reference C:/Users/LT/Documents/trae
```

`prepare` 在全新目录初始化独立 Git 仓库，从固定公开地址获取固定提交，核对基线 tree，依次执行每份补丁的 `git apply --check --index` 与 `git apply --index`，核对最终 tree 和文件清单，最后在新仓库 `.git/` 写入来源收据。补丁保留在暂存区，没有创建提交。可选 reference 只加速对象获取，旧工作区始终只读，公开上游获取仍然执行。

脚本只接受绝对路径，拒绝已有目标目录、重定向目录、错误基线、补丁内容变化、树或文件哈希不符、额外未跟踪文件，以及源码/构建脚本目录中的额外被忽略文件。来源校验直接读取全部 6,646 个受跟踪文件并比较 Git blob（含 60 个链接条目），不依赖 Git stat cache；拒绝 assume-unchanged、skip-worktree、fsmonitor-valid 等可掩盖变化的索引标记。Git 子进程不继承用户 Git 配置、凭据助手或 Git 环境覆盖，也不修改全局 Git 配置。失败后保留新目录，便于排查；不自动删除、重置或覆盖已有工作。

`verify` 校验完整树、工作区内容与准备收据，不把安装依赖或执行编译标为通过。它会向隔离 Git 对象库写入不可变的 tree 对象供哈希校验，不修改源码。manifest 变化后需要重新准备全新目录，避免旧收据掩盖来源变化。

## 新候选的构建输入

历史 `engine.5` 使用运行时下载的 `https://models.dev/api.json`，并以 `--skip-install` 使用当时已存在的依赖。它没有保存模型快照与依赖安装证明。此次可以核对当前源码集合，不能反向证明旧快照内容或声称旧二进制可逐字节重建。

新的来源候选使用独立版本，避免与旧合格二进制混淆。由构建流程另行保存 models.dev JSON 及 SHA-256，将其放在源码检出目录外，固定依赖锁并记录安装结果：

实际建议在产品仓库运行 `bun run script/build-engine.ts <准备好的绝对源码目录>`。它要求全新依赖目录、Bun 1.4.2、Python、Node 和 Visual Studio C++ tools；记录实际工具版本。`build-inputs/models.dev.json` 是已保存的公共目录快照，SHA-256 为 `4a0e55bf8ef5bb91f50e80c267f8c630af1428db2e9fcd3e4b60c839463dfd61`。脚本把校验后的字节写入本次构建独立输入文件，编译后再次核对，并归档相同字节；不会把后来编辑的工作区快照误标为编译输入。

构建子进程只保留列明的 Windows、路径和工具变量，覆盖 npm 用户配置；模型密钥、NODE_OPTIONS、上游发行开关不从父进程继承。仍会使用本机依赖缓存与系统工具，未声称完全密封环境或字节相同产物。下面是底层步骤说明，通常交给脚本执行：

```powershell
# 在准备好的隔离源码根目录执行。
bun install --frozen-lockfile

# 在产品仓库再次校验，确保安装没有改写跟踪源码或锁文件。
bun run script/engine-source.ts verify C:/xingyao-build/engine-source

# 然后在 C:/xingyao-build/engine-source/packages/opencode 执行。
$env:OPENCODE_VERSION='1.18.31'
$env:OPENCODE_CHANNEL='product-dev'
$env:OPENCODE_RELEASE=''
$env:MODELS_DEV_API_JSON='C:/xingyao-build/inputs/models.dev.json'
bun run script/build.ts --single --skip-install --skip-embed-web-ui
```

`OPENCODE_RELEASE` 必须为空，防止上游脚本执行远程发行上传。`MODELS_DEV_API_JSON` 必须指向已验证的固定输入，禁止默默回退到构建时实时下载。输出应位于隔离源码的 `packages/opencode/dist/opencode-windows-x64/bin/opencode.exe`。上游构建会清理这个隔离目录内的 dist，绝不能把命令的工作目录改回旧工作区。

构建后记录引擎版本、二进制 SHA-256、完整源码 tree、manifest SHA-256、模型快照 SHA-256、Bun 版本及锁文件哈希，交给产品实际引擎与发行验证。源码一致不代表编译产物字节一致，也不代表运行验收成功。测试通过前不要覆盖已安装引擎。

## 此次已经验证的范围

已在全新独立 Git 目录提取固定基线，四份补丁检查与应用全部成功，最终 tree 为上表值。全部 55 个变更路径与原源码工作区的 LF 规范文本或删除状态一致，原两份补丁内容与哈希保持不变。原工作区没有被修改、提交或安装依赖。

随后使用正式 `prepare` 脚本在另一个全新目录实际执行了本地对象加速、公开上游网络获取、全部补丁应用和来源检查，退出码为 0；独立 `verify` 也为 0。已有目录、相对路径、直接拿旧改装工作区验证、准备后改写源码这四个负向场景都以退出码 1 拒绝；恢复隔离目录测试改动后再次通过。产品 TypeScript 检查通过。

随后在 NTFS 全新目录成功执行完整构建：冻结依赖安装、core/opencode 类型检查、12 项核心回归、编译、全部源码再次核验及实际版本检查。第一次安装在缺少可执行 Python 时中断，随后继续安装没有补齐 OpenAI SDK 文件；官方压缩包的 SHA-512 与锁文件一致。在全新源码目录从头安装后通过。构建入口因此拒绝已有 node_modules，保留失败目录排查，避免复用不完整依赖。

采用独立模型快照和受限环境的新候选为上游真实版本 `1.18.31`，SHA-256 `f638ddeeaeb30881d075654de3a51fb0893a93cbc5926f1d8e0cbda30cd872a7`。本机工具为 Bun 1.4.2、Node v26.8.1、Python 3.12.14、VS 17.14.37628.2 / MSVC 14.44.35207；构建目录包含 exe、许可证、模型快照与 `engine-build.json`。源码提交与补丁 tree 没有变化；版本恢复解决免费服务拒绝低于 `1.18.0` 客户端的问题。隔离身份的真实免费模型短对话已通过，最终制品仍按自己的哈希进入完整产品门禁。

源码校验有 7 项独立回归，包括索引隐藏标记、实际字节篡改、相同时间戳、暂存树变化和重定向；对实际完整检出目录也复现了拒绝并恢复原始状态。GitHub workflow 已编写但未在 hosted runner 执行。`engine.6-source → 1.18.31` 的配套迁移必须由目标发行的准确二进制和完整门禁重新验证。
