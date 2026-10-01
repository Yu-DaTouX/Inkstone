# 代码导览

[架构简介](ARCHITECTURE.md) · [按功能查找的代码地图](CODE_MAP.md) · [技术路线](TECH_STACK_OPTIONS.md) · [贡献指南](CONTRIBUTING.md)

Android 手机接入的用户流程见[手机接入说明](MOBILE_ACCESS.md)；长期记忆的范围与外部工具读写约定见[记忆互通说明](MEMORY_INTEROP.md)；两台砚之间的本次连接授权见[砚互联说明](PEER_ACCESS.md)。

完整目录归属、图片与零散文件的处理见 [文件归属与长期维护规范](REPOSITORY_GUIDE.md)。本文维护目录导航；遇到具体任务，先看[代码地图](CODE_MAP.md)中的调用链、状态和相邻文件，不记录阶段完成状态。

| 路径 | 职责 |
| --- | --- |
| `src/main/index.ts` | Electron 主进程入口：装配、生命周期、运行控制与窗口 |
| `src/main/ipc/` | 按领域的 IPC 注册器（`registrar.ts` 统一校验调用者是主窗口） |
| `src/main/goal-coordinator.ts` / `handoff-coordinator.ts` / `session-work-scheduler.ts` | 工作模式与目标状态、历史交接兼容、回合收尾观察；宿主自动续跑与自动交接已停用 |
| `src/main/session-host.ts` / `remote-host.ts` | 桌面会话的宿主能力（桌面 IPC 与远程共用）；手机与砚对砚所有者一侧的处理 |
| `src/main/agent.ts` | 模型运行与 pi 交互：进程、事件转换、发送与队列 |
| `src/main/agent-hub/` + `src/shared/agent-hub.ts` | 多 Agent 任务、运行适配、共享交互资源与固定版本成果；桌面/手机用同一宿主服务，见[多 Agent 工作台](AGENT_HUB.md) |
| `src/shared/agent-workspace.ts` / `components/workbench/AgentWorkspacePanel.tsx` | 统一 Agent 入口：子 pi 与 Hub 运行的只读投影、运行标签与详情；原始状态仍由各自后端保存 |
| `src/main/pi-runtime-location.ts` / `scripts/lib/pi-runtime-location.mjs` / `scripts/lib/pi-upgrade-policy.mjs` | 开发与打包共用 runtime generation 选择；升级保留旧进程的目录、禁止隐式降级 |
| `src/main/capabilities/acquisition-commands.ts` / `browser-commands.ts` / `lookup-commands.ts` | `yan` 宿主工具：能力接入、浏览器、搜索与长期记忆；旧上下文预算命令已退役 |
| `src/shared/agent-context.ts` / `src/main/agent.ts` | Agent 原生上下文边界与 pi 版本适配；过滤宿主上下文改写扩展，加载原生 MCP / codemode / 工具搜索，投影 `parentToolCallId` 与历史 `nestedCalls`，树状工具显示由 `src/shared/tool-call-tree.ts` 支持 |
| `src/main/ui-requests.ts` / `turn-timing-tracker.ts` | 界面请求（扩展对话框与宿主提问）；回合计时与落盘 |
| `src/main/storage-move.ts` / `storage-move-boot.ts` | 数据位置迁移：设置 → 关于 → 数据位置 登记目标，下次启动整体搬迁并在原处留目录联接，核对文件数与字节后才删原目录，失败撤回 |
| `src/main/app-update.ts` + `src/shared/app-update.ts` | 应用更新：GitHub Release 检查；安装版经 electron-updater 下载、确认后重启安装，有任务运行时拒绝；便携版与开发版只给发布页入口 |
| `src/main/computer-use.ts` | 电脑操作：检测 / 安装 uv，开关时改宿主 `mcp-servers.json` 里的 `windows-mcp` 条目，只开放界面操作工具；Python 与 windows-mcp 由用户的 uv 下载，不随包 |
| `src/main/oauth-providers.ts` | Claude / Copilot / xAI / OpenRouter 的订阅登录：驱动随包 pi 的登录模块，把提问与授权事件转发给界面 |
| `src/main/session-entries-lite.ts` | 会话文件里任务与自定义条目的增量读取，不经 pi 的 `get_entries` 搬运整份会话 |
| `src/preload/index.ts` | 渲染端可用的宿主接口 |
| `src/shared/ipc.ts` | IPC 契约与类型 |
| `src/renderer/src/components/` | React 界面组件 |
| `src/renderer/src/components/workbench/` | 日常模式的中栏视图：工作台首页、空间工作台（概览 / 资料）与会话地图（`WorkbenchHome.tsx` / `SpaceWorkbench.tsx` / `SpaceOverview.tsx` / `LibraryView.tsx` / `FollowPanel.tsx`（持续关注）/ `SessionMap.tsx`（会话地图：当前会话家族、问答轮次与持久化分支）） |
| `src/shared/space.ts` + `src/main/space-store.ts` | 主题空间：非 Git 的会话归属与项目关联 |
| `src/shared/library.ts` + `src/main/library-store.ts` / `library-parser.ts` / `library-service.ts` | 资料库：唯一事实源、版本绑定与解析 |
| `src/shared/activity-flow.ts` + `src/shared/context-assembly.ts` / `src/main/context-assembler.ts` | 建任务阈值与历史资料装配的数据结构；自动装配和请求注入已停用，资料引用仍可回原文 |
| `src/shared/research.ts` | 资料引用：引用状态（旧版本按版本保留、**只提示不改引用**）与按版本读片段；对照做法在 `resources/skills/research` |
| `src/shared/user-skill.ts` + `src/main/user-skills.ts` | 用户技能：`YAN_DIR/skills/<名称>/SKILL.md` 的校验、保存（`yan skill save`）与按 `--skill` 加载；旧办事模板（`playbooks.json`）启动时一次性导出成技能，原文件保留。写法与执行约定见 `resources/skills/playbook` |
| `src/shared/learning-export.ts` + `src/main/learning-export.ts` | 学习记录导出：学习功能已改由 `tutor` 技能在对话中进行；启动时把旧版留下的 courses / study-sessions / exercises / learning-memory 四个原始 JSON 整理成 `YAN_DIR/learning-export/` 下按课程分的 Markdown 与完整副本；只读原文件，不依赖各 store。讲解与出题做法见 `resources/skills/tutor` |
| `src/shared/subagent-brief.ts` | 内部 agent 分工：任务输入（目标 / 交付物 / 来源 / 边界）不猜、结果汇总如实标来源（**未决问题不自动抽取**）；何时拆分见 `resources/skills/subagent` |
| `src/shared/follow.ts` + `src/main/follow-store.ts` | 持续关注与提醒：**应用没开就不跟进**（状态里没有「后台在跑」）、未启用的关注不自行建立、没变化不打扰、一次性关注看完就结束 |
| `src/shared/activity-model.ts` | 按活动配置模型：优先级（活动 → 默认 → 跟随会话）可解释、回退如实标注、**不改任务身份与学习状态** |
| `src/shared/conversation-turns.ts` | 轮次投影（一轮问答 = 一个块），会话地图的轮次级基础 |
| `src/shared/session-map.ts` | 历史会话地图投影工具；当前地图使用持久化会话家族与轮次投影 |
| `src/shared/search.ts` + `src/main/search/` | 联网搜索：来源白名单（首批 wikipedia / arxiv / hackernews，HTTP 直连不需要浏览器扩展）、归一化与 URL 去重、逐来源状态（`ok` / `empty` / `timeout` / `unavailable` / `error` 分开）、`spawn` 参数数组不经 shell；JS 入口**用真实 node 跑**（Electron 自带的 Node 会让 commander 的参数切分错位，子命令全部失效、而 `--version` 仍成功 → 假绿），PATH 里没有 node 时可用 `YAN_NODE_BIN` 显式指定；`scripts/probe/search.mjs` 是不依赖宿主的探针，`scripts/probe/search-electron.mjs` 专测 **Electron 运行时**（钉住上面那条假绿回归） |
| `src/shared/task-inbox.ts` + `src/main/task-inbox-service.ts` | 任务收件箱：七态投影（`needs_review` 无精确来源，只能近似并标 `approximate`）、排序与筛选、注入式只读聚合（TTL 缓存 + 分页；某个来源坏了只丢那一项） |
| `src/renderer/src/icons/` + `scripts/design/icons/` | 图标体系：`catalog.json` 是语义 → 图标的唯一真源（55 个语义），`npm run icons` 生成 sprite；界面只用语义名，不写库里的原名 |
| `src/renderer/src/styles/ui.css`、`src/renderer/src/components/ui/` | 统一控件（按钮、分段、开关、徽标、空状态）的唯一外观来源，规则见[设计规范](DESIGN_SYSTEM.md)，重构路线见[界面重构计划](UI_REDESIGN.md) |
| `src/renderer/src/styles/motion.css` | 动效唯一真源（37 个关键帧）；时长 / 曲线令牌在 `tokens.css`，模块 CSS 只引用不定义 |
| `src/renderer/src/state/` | 会话状态与事件投影 |
| `src/renderer/src/styles/` | 样式、令牌与主题；入口 `index.css` 用级联层决定覆盖关系 |
| `resources/pi-extensions/` | 随包 pi 薄层：语言、身份、工具权限、UI 桥接与高危确认；宿主上下文、预算、知识自动注入及自动交接实现已移除 |
| `src/main/ipc/context-budget-ipc.ts` / `context-recall.ts` / `context-background-usage.ts` | 旧预算 IPC 返回停用或拒绝修改；主动归档检索与召回、历史用量读取及标题计费保留 |
| `resources/yan-cli/` | 本机能力 CLI |
| `scripts/` | 启动、构建、检查与截图工具 |
| `scripts/check-icons.mjs` · `scripts/check-motion.mjs` | 图标与动效的强制检查：属性一致 / 引用零缺失 / 语义唯一 / 生成物不漂移；关键帧归口 / 裸时长 / 裸曲线 / 悬空引用 |
| `scripts/design/` | 图标生成、原型检查及 CSS 生成清单 |
| `scripts/audit/` | 仓库审计工具 |
| `scripts/audit/workspace.mjs` | 公开文档链接检查与本地文件分类清单；不搬动或删除文件 |
| `build/` | 应用图标与打包资源 |
| `docs/assets/inkstone/` | 公开品牌与主页图片 |

`resources/pi-runtime/`、`out/`、`release/` 是运行时或构建产物目录，按生成流程维护。`Yan`、`yan` 与 `YAN_*` 是现有工程标识；公开品牌名为 Inkstone（砚）。

## 协作与本地资料

协作规则见根目录 [AGENTS.md](../AGENTS.md)；多个 agent 之间的状态、交接和本地资料位置见[多 Agent 协作流程](AGENT_WORKFLOW.md)。本文只维护源码导航，不记录任务状态。
