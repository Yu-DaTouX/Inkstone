# 代码导览

[架构简介](ARCHITECTURE.md) · [按功能查找的代码地图](CODE_MAP.md) · [技术路线](TECH_STACK_OPTIONS.md) · [贡献指南](CONTRIBUTING.md)

Android 手机接入的用户流程见[手机接入说明](MOBILE_ACCESS.md)；长期记忆的范围与外部工具读写约定见[记忆互通说明](MEMORY_INTEROP.md)；两台砚之间的本次连接授权见[砚互联说明](PEER_ACCESS.md)。

完整目录归属、图片与零散文件的处理见 [文件归属与长期维护规范](REPOSITORY_GUIDE.md)。本文维护目录导航；遇到具体任务，先看[代码地图](CODE_MAP.md)中的调用链、状态和相邻文件，不记录阶段完成状态。

| 路径 | 职责 |
| --- | --- |
| `src/main/index.ts` | Electron 主进程入口：装配、生命周期、运行控制与窗口 |
| `src/main/ipc/` | 按领域的 IPC 注册器（`registrar.ts` 统一校验调用者是主窗口） |
| `src/main/goal-coordinator.ts` / `handoff-coordinator.ts` / `session-work-scheduler.ts` | 会话后台调度：工作模式与目标续跑、自动交接、回合收尾的下一步 |
| `src/main/session-host.ts` / `remote-host.ts` | 桌面会话的宿主能力（桌面 IPC 与远程共用）；手机与砚对砚所有者一侧的处理 |
| `src/main/agent.ts` | 模型运行与 pi 交互：进程、事件转换、发送与队列 |
| `src/main/capabilities/acquisition-commands.ts` / `browser-commands.ts` / `lookup-commands.ts` / `context-budget-commands.ts` | `yan` 宿主工具：能力接入、浏览器、搜索与长期记忆、上下文预算 |
| `src/main/ui-requests.ts` / `turn-timing-tracker.ts` | 界面请求（扩展对话框与宿主提问）；回合计时与落盘 |
| `src/preload/index.ts` | 渲染端可用的宿主接口 |
| `src/shared/ipc.ts` | IPC 契约与类型 |
| `src/renderer/src/components/` | React 界面组件 |
| `src/renderer/src/components/workbench/` | 日常模式的中栏视图：工作台首页、空间工作台（概览 / 资料 / 成果）与会话地图（`WorkbenchHome.tsx` / `SpaceWorkbench.tsx` / `SpaceOverview.tsx` / `LibraryView.tsx` / `ArtifactView.tsx`/ `FollowPanel.tsx`（持续关注）/ `SessionMap.tsx`（会话地图：会话层 + 可展开的轮次层）/ `SessionPreview.tsx`） |
| `src/shared/space.ts` + `src/main/space-store.ts` | 主题空间：非 Git 的会话归属与项目关联 |
| `src/shared/library.ts` + `src/main/library-store.ts` / `library-parser.ts` / `library-service.ts` | 资料库：唯一事实源、版本绑定与解析 |
| `src/shared/activity-flow.ts` + `src/shared/context-assembly.ts` / `src/main/context-assembler.ts` | 建任务阈值（简单问答不建任务清单；各活动的做法在随包技能里）、按活动的上下文装配（引用可回原文） |
| `src/shared/artifact-doc.ts` + `src/main/artifact-doc-store.ts` | 可编辑成果：版本推进、「用户改过的段落不被 agent 整篇覆盖」、结构化清单（Markdown 任务列表）、引用回原文与导出 Markdown |
| `src/shared/research.ts` | 资料引用：引用状态（旧版本按版本保留、**只提示不改引用**）与按版本读片段；对照做法在 `resources/skills/research` |
| `src/shared/user-skill.ts` + `src/main/user-skills.ts` | 用户技能：`YAN_DIR/skills/<名称>/SKILL.md` 的校验、保存（`yan skill save`）与按 `--skill` 加载；旧办事模板（`playbooks.json`）启动时一次性导出成技能，原文件保留。写法与执行约定见 `resources/skills/playbook` |
| `src/shared/learning-export.ts` + `src/main/learning-export.ts` | 学习记录导出：学习功能已改由 `tutor` 技能在对话中进行；启动时把旧版留下的 courses / study-sessions / exercises / learning-memory 四个原始 JSON 整理成 `YAN_DIR/learning-export/` 下按课程分的 Markdown 与完整副本；只读原文件，不依赖各 store。讲解与出题做法见 `resources/skills/tutor` |
| `src/shared/subagent-brief.ts` | 内部 agent 分工：任务输入（目标 / 交付物 / 来源 / 边界）不猜、结果汇总如实标来源（**未决问题不自动抽取**）；何时拆分见 `resources/skills/subagent` |
| `src/shared/follow.ts` + `src/main/follow-store.ts` | 持续关注与提醒：**应用没开就不跟进**（状态里没有「后台在跑」）、未启用的关注不自行建立、没变化不打扰、一次性关注看完就结束 |
| `src/shared/activity-model.ts` | 按活动配置模型：优先级（活动 → 默认 → 跟随会话）可解释、回退如实标注、**不改任务身份与学习状态** |
| `src/shared/conversation-turns.ts` | 轮次投影（一轮问答 = 一个块），会话地图的轮次级基础 |
| `src/shared/session-map.ts` | 会话地图纯投影（泳道 / 深度 / 边 / 折叠） |
| `src/shared/turn-layer.ts` | 画布轮次层的几何与分支对齐：一层一轮一张卡、子会话首轮对上父会话那一轮（对不上不猜、会撞就退回） |
| `src/shared/search.ts` + `src/main/search/` | 联网搜索：来源白名单（首批 wikipedia / arxiv / hackernews，HTTP 直连不需要浏览器扩展）、归一化与 URL 去重、逐来源状态（`ok` / `empty` / `timeout` / `unavailable` / `error` 分开）、`spawn` 参数数组不经 shell；JS 入口**用真实 node 跑**（Electron 自带的 Node 会让 commander 的参数切分错位，子命令全部失效、而 `--version` 仍成功 → 假绿），PATH 里没有 node 时可用 `YAN_NODE_BIN` 显式指定；`scripts/probe/search.mjs` 是不依赖宿主的探针，`scripts/probe/search-electron.mjs` 专测 **Electron 运行时**（钉住上面那条假绿回归） |
| `src/shared/task-inbox.ts` + `src/main/task-inbox-service.ts` | 任务收件箱：七态投影（`needs_review` 无精确来源，只能近似并标 `approximate`）、排序与筛选、注入式只读聚合（TTL 缓存 + 分页；某个来源坏了只丢那一项） |
| `src/renderer/src/icons/` + `scripts/design/icons/` | 图标体系：`catalog.json` 是语义 → 图标的唯一真源（55 个语义），`npm run icons` 生成 sprite；界面只用语义名，不写库里的原名 |
| `src/renderer/src/styles/ui.css`、`src/renderer/src/components/ui/` | 统一控件（按钮、分段、开关、徽标、空状态）的唯一外观来源，规则见[设计规范](DESIGN_SYSTEM.md)，重构路线见[界面重构计划](UI_REDESIGN.md) |
| `src/renderer/src/styles/motion.css` | 动效唯一真源（37 个关键帧）；时长 / 曲线令牌在 `tokens.css`，模块 CSS 只引用不定义 |
| `src/renderer/src/state/` | 会话状态与事件投影 |
| `src/renderer/src/styles/` | 样式、令牌与主题；入口 `index.css` 用级联层决定覆盖关系 |
| `resources/pi-extensions/` | 随包 pi 适配 |
| `resources/yan-cli/` | 本机能力 CLI |
| `scripts/` | 启动、构建、检查与截图工具 |
| `scripts/check-icons.mjs` · `scripts/check-motion.mjs` | 图标与动效的强制检查：属性一致 / 引用零缺失 / 语义唯一 / 生成物不漂移；关键帧归口 / 裸时长 / 裸曲线 / 悬空引用 |
| `scripts/design/` | 图标生成、原型检查及 CSS 生成清单 |
| `scripts/audit/` | 仓库审计工具 |
| `scripts/audit/workspace.mjs` | 公开文档链接检查与本地文件分类清单；不搬动或删除文件 |
| `build/` | 应用图标与打包资源 |
| `docs/assets/inkstone/` | 公开品牌与主页图片 |

`resources/pi-runtime/`、`out/`、`release/` 是运行时或构建产物目录，按生成流程维护。`Yan`、`yan` 与 `YAN_*` 是现有工程标识；公开品牌名为 Inkstone（砚）。

## 后续 agent 的资料入口与操作边界

1. 先读根目录 [AGENTS.md](../AGENTS.md)，再读 [贡献指南](CONTRIBUTING.md) 和当前任务涉及的源码；公开文档入口是 [docs/README.md](README.md)。
2. 维护者本地的 `docs/plan/`、`docs/design/`、`docs/archive/` 与大部分 `docs/dev/` 是已忽略的内部资料。它们可能存在，也可能在新克隆中缺失；不作为构建、贡献或理解当前实现的前置依赖。
3. 内部资料按需只读参考，不能把旧计划当作当前执行授权。旧文档的“先读 HANDOFF / 实施计划 / 回填阶段表”不再覆盖根 AGENTS 的新规则。
4. 已忽略不等于允许删除。保留本地原文、截图与用户数据；不要重新跟踪内部目录、不要强制添加或改写 Git 历史。
5. 本轮原文备份与移出索引清单位于本地 `.local-docs/public-cleanup-2026-09-24/`；完整的内部资料仍在原目录。新的过程记录放在本地忽略目录中。
6. 对外提交只包含用户授权的相关改动；先查看工作区与暂存区，保留其他任务的未提交代码。目录或文档边界变更时同步 AGENTS、PROJECT、文档索引与 README。
