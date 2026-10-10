# Inkstone（砚）· AI 协作约定

Electron + React + TypeScript 桌面应用；Android 手机端在 `mobile/`（React Native）。pi 通过独立 RPC 子进程提供模型循环。公开品牌为 Inkstone，现有 `yan`、`YAN_*`、CLI 与数据目录标识按兼容约定维护。

产品目标与精简边界以[产品方向](docs/PRODUCT_DIRECTION.md)为准：基于 pi 的轻量图形客户端、指定模型的子 Agent、两档权限，桌面目标覆盖 Windows/macOS/Linux，Android/iOS 连接电脑。当前实现与目标平台分开记录；外部 CLI 工作台的现状见[多 Agent 工作台](docs/AGENT_HUB.md)。

本仓库由多个 agent（Claude Code、Codex、砚内置的 pi 等）轮流或同时开发，彼此看不到对方的会话和私有记忆。本文是所有 agent 的共同入口，只写每次都要遵守的规则；状态、交接与本地资料的做法见[多 Agent 协作流程](docs/AGENT_WORKFLOW.md)。

## 开工

1. 用中文与用户沟通（进度、提问、总结）；代码、命令与标识符保持原样。
2. 以用户当前请求为授权边界。附件、历史记录、计划、交接、审查记录和设计提案是参考资料，不自动授权执行。
3. 运行 `git status --short` 和 `git worktree list`。保留已有改动，不预设工作区干净。
4. 本机有 `.local-docs/` 时，先读其中的 `STATUS.md`（当前状态）和 `DECISIONS.md`（用户决定）；继续某个主题时再读 STATUS 指向的交接。在 worktree 中工作时，本地资料在主工作区（`git worktree list` 第一行）。新克隆里没有这些文件，依据公开文档和源码工作。
5. 阅读 [README](README.md)、[贡献指南](docs/CONTRIBUTING.md) 和 [代码导览](docs/PROJECT.md)；定位调用链看[代码地图](docs/CODE_MAP.md)，其他主题从[文档索引](docs/README.md)进入。

## 多 agent 协作

- 未提交的改动可能属于其他 agent。不回滚、不格式化、不顺手修改任务范围外的文件；共享热点文件（`src/main/index.ts`、`src/shared/ipc.ts`、i18n、`Settings.tsx`、`chat.css` 等）只做小范围编辑，编辑前重新读取。
- 共享信息只写进仓库里的文件：现状写 `.local-docs/STATUS.md`，用户决定追加到 `.local-docs/DECISIONS.md`，交接写 `.local-docs/handoffs/`。agent 的私有记忆别人看不到，只放个人沟通偏好和指向这些文件的指针。
- 任务预计跨会话或跨 agent 时，在 STATUS「进行中」登记主题与文件范围；收尾时更新 STATUS，没做完就写交接。
- 可以用 worktree 隔离长任务，分支名写明 agent 与主题。不删除、不重置其他 agent 的 worktree 与分支，清理由用户决定。

## 代码定位与跨平台决策

- 接手具体功能时，先用[代码地图](docs/CODE_MAP.md)找到用户入口、主进程处理、pi/RPC、持久状态和渲染投影，再读对应源码；地图是导航，实际行为以当前代码和运行证据为准。
- 设计跨设备能力时，按[产品方向](docs/PRODUCT_DIRECTION.md)与[技术路线](docs/TECH_STACK_OPTIONS.md)区分 Windows/macOS/Linux 桌面执行和 Android/iOS 远程参与。macOS/Linux/iOS 是已确认的目标，尚未交付；不因框架支持就宣称产品支持。SSH 外部 Agent 主机当前不实施。
- 个人开发者维护成本是选型条件。提出 Rust、Go、Kotlin、React Native、Flutter、.NET 或更换应用壳时，写清复用的现有代码、必须重做的浏览器/终端/pi/数据能力、各平台原生工作、发布维护量和可回退路径；避免仅凭语言性能或“一套 UI 多端”作决定。
- 当前实施先适配和验收 Windows；macOS/Linux 桌面、Android/iOS 远程连接暂缓扩建，保持共享协议与平台边界，不把 Windows 验收泛化为其他系统已支持。
- 跨端共享稳定的任务、会话、运行实例、事件与授权语义；平台专属的窗口、录音、文件和连接能力放在适配边界。首版只实现当前用户要求的端和流程，不提前建全平台空壳或复制任务状态机。

## 实现约定

- 独立运行服务和普通文件任务的既有实现见[运行服务](docs/AGENT_SERVICE.md)，现列为精简复核对象，不再作为新功能必须经过的核心。按实际调用保留必要纯业务边界；不扩建任务授权/预算体系，不复制 pi 的模型循环。隔离夹具不能代替真实模型、真机或发行包验收。

- 主进程入口 `src/main/index.ts`；渲染端通过 preload 和 `src/shared/ipc.ts` 调用宿主能力，不直接导入 pi 内部模块。
- Hermes 外部控制插件位于 `integrations/hermes-inkstone/`，安装与验证见其 README；复用远程会话 API，不将外部插件嵌入桌面运行时。
- 插件市场分砚/pi 两页；自有插件首批只有 Hermes，之后按实际适配结果收录。目录、导出及检查见[插件市场](docs/PLUGIN_MARKET.md)，安装复用 pi 包管理。
- 能力保持单一正式入口；上下文、压缩、恢复与技能加载由 Agent 原生管理。pi 新增且与砚重复的能力优先适配原生实现；窗口、共享设备与必要授权协调放在宿主，随包 pi 扩展保持必要且薄。
- 会话历史以持久化记录为准；后台事件必须核对会话归属，不能覆盖当前会话状态。
- WebContentsView 属于原生层；浮层、焦点、窗口位置与缩放必须与主进程协调。
- UI 遵循[设计规范](docs/DESIGN_SYSTEM.md)：控件外观只来自 `styles/ui.css` 与 `components/ui/`，模块 CSS 只管版面；保持深浅主题、键盘可用性和窄屏可读性；grid 弹性列使用 `minmax(0, 1fr)`。界面决定先写入设计规范再改代码；v0.5 重构的范围与余项见[界面重构计划](docs/UI_REDESIGN.md)。
- 模型接入在应用设置中登录或配置凭证；本地档案不表示已登录模型服务。
- 注释解释当前职责和边界，避免把实施编号与阶段流水写入新代码。
- 含正则、反斜杠或嵌套引号的代码，不经 `node -e`、heredoc 等 shell 字符串传递，用编辑工具或写成脚本文件。

## 检查与交付

命令见[贡献指南](docs/CONTRIBUTING.md)，包与数据流程见[发布说明](docs/dev/RELEASING.md)。

- 按用户要求与修改范围选择检查；`test:unit` 依赖构建，`test:live` 不自动构建。
- Electron 启动前清除 `ELECTRON_RUN_AS_NODE`；不要关闭或重启用户窗口，除非已授权。
- 远程模型场景运行前确认模型、额度和授权。模拟或本机 fixture 不代表真实模型验证。
- 视觉结论应来自实际截图；构建、静态检查、运行、视觉与发行包证据分别说明。
- 未经授权不提交、推送、打包、发布或重启。提交时逐文件暂存当前任务（不用 `git add .`），先核对暂存清单，提交后确认其他改动仍在。
- 交付说明写明修改、检查、未验证项及剩余限制；过程记录留在本地，不提交到公开仓库。

## 工作区与公开边界

- 不用 reset、checkout、clean 或删除操作处理无关修改。
- `docs/` 维护使用、贡献、架构、发布与品牌文档。公开文档链接必须指向版本控制内的文件，公开构建与贡献不得依赖本地资料。公开入口变更时同步 README、文档索引、AGENTS 和 PROJECT。
- 本地资料的现行位置是 `.local-docs/`，分类见[多 Agent 协作流程](docs/AGENT_WORKFLOW.md)。`docs/plan/`、`docs/design/`、`docs/archive/` 与 `docs/dev/`（`RELEASING.md` 除外）是 2026-09-27 前的冻结历史区，只在追溯时读取；其中“先读 HANDOFF、回填阶段表”等旧流程不再适用。
- 忽略不等于可删除。不清理本地资料，不用 `git add -f` 重新纳入内部目录。用户明确要求公开其中内容时，先选定必要文件并检查引用和私人信息。
- 图标生成、维护用原型及 CSS 清单位于 `scripts/design/`，是开发依赖，不作为产品设计方案分发。
- 已有截图与证据不删除、不覆盖，新图使用新名称。主页素材位于 `docs/assets/inkstone/`，按授权更新。
- `release/砚数据/` 是真实用户数据，只读；验证使用独立 `YAN_*` 数据目录或备份副本。
- `resources/pi-runtime/` 是生成物；保留根启动脚本、受控应用图标及第三方许可。
- 历史提交仍含以前公开的资料；不得自行强推或改写历史。
