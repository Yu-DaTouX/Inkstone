# Inkstone 代码地图

[文档索引](README.md) · [代码导览](PROJECT.md) · [架构简介](ARCHITECTURE.md) · [技术路线](TECH_STACK_OPTIONS.md)

面向维护者与接手任务的 Agent。本页按**要改什么**定位源码；目录所有权与更多功能文件见 [PROJECT.md](PROJECT.md)。以当前源码为准，修改前先看 `git status --short` 和目标文件；不要把生成物、发行目录或本机内部资料当作源码。以下是 2026-09-28 的静态导航，不代表各功能已完成运行验证。

接手任务时按这条顺序查：**用户操作 → preload/IPC 或远程入口 → 宿主服务与 pi RPC → 持久记录 → 运行事件与渲染投影**。先确认当前请求需要哪个平台、在哪台设备执行；跨端方案同时看 [技术路线](TECH_STACK_OPTIONS.md)，按个人开发者可维护的首版范围收敛。未在地图中列出的文件用 `rg --files` / `rg` 定位，不能因地图没有列出就断言能力不存在。

## 一条消息经过哪里

```mermaid
flowchart LR
  UI[React App / Zustand] --> Preload[preload 白名单]
  Preload --> IPC[main/index IPC]
  IPC --> Runners[runners / AgentController]
  Runners --> RPC[protocol JSONL RPC]
  RPC --> Pi[pi 独立子进程]
  Pi --> Provider[模型服务和工具]
  Pi --> RPC --> Runners
  Runners --> Push[MainPush + runtime 身份]
  Push --> Store[renderer store / session-runtime]
  Store --> UI
```

| 环节 | 先读文件 | 改动时留意 |
| --- | --- | --- |
| 桌面启动与装配 | `src/main/index.ts`、`src/main/paths.ts`、`src/main/settings.ts` | `index.ts` 负责装配与生命周期：建存储与服务、启动 pi、创建窗口，并在启动前把宿主能力接到各服务（`configureGoalCoordinator` / `configureHandoffCoordinator` / `configureRemoteHost`）；发送 / 中止等运行控制与窗口类 IPC 仍在入口，不要把业务判断再复制到新入口 |
| pi 进程与协议 | `src/main/protocol.ts`、`src/main/agent.ts` | pi 通过独立 JSONL RPC 子进程运行；`protocol.ts` 使用 Electron 自带 Node 和 `--mode rpc` |
| 并发会话 | `src/main/runners.ts`、`src/main/agent.ts`、`src/main/index.ts` | `runnerId/runId`、`sessionId`、`generation` 含义不同；切换视图不能停掉仍在跑的会话 |
| 宿主接口 | `src/shared/ipc.ts` → `src/preload/index.ts` → `src/main/ipc/<领域>-ipc.ts`（经 `ipc/registrar.ts` 注册） | 按领域的注册器：会话、目标 / 模式 / 交接、空间与档案、资料、成果、来源、文件、Git、插件包、能力、长期记忆、任务收件箱、持续关注、上下文预算、子代理、砚对砚、同意记录、模型接入等；依赖经参数显式传入。新增能力核对类型、白名单与处理器；注册器统一校验调用者是主窗口 |
| 推送到界面 | `src/main/index.ts` 的 `pushFrom`、`src/shared/ipc.ts` 的 `MainPush`、`src/renderer/src/state/store.ts` 的 `applyPush` | 身份与归属判定在 `state/push-routing.ts`（纯函数，`scripts/test-push-routing.mjs`）：旧代次丢弃、后台会话只进 `state/session-runtime.ts` 缓存；窗口 / 提问与通知 / 子代理 / 任务状态由 `state/push-consumers.ts` 分别消费，会话与消息的核心投影在 store |
| 用户看到的对话 | `src/renderer/src/App.tsx`、`components/chat/TurnView.tsx`、`MessageParts.tsx`、`Composer.tsx` | 消息是历史与运行事件的投影；草稿、队列和流式状态另有归属 |

## 按问题找代码

| 任务或症状 | 主要入口 | 相邻契约与状态 |
| --- | --- | --- |
| 会话创建、切换、历史或标题 | `src/main/runners.ts`、`sessions.ts`、`session-reader.ts`、`session-history.ts`、`title.ts` | `src/main/agent.ts`、`src/renderer/src/state/store.ts`、`src/shared/ipc.ts`；持久会话记录以 pi JSONL 为准 |
| 后台 Agent、队列、停止与继续 | `src/main/session-work-scheduler.ts`（入口的 `scheduleSessionWork`）、`goal-coordinator.ts`（工作模式、活动档案、目标与自主续跑）、`src/main/runners.ts`、`auto-continue-service.ts`、`goal-service.ts` | `src/main/agent.ts` 的事件、发送和队列方法；`src/shared/goal.ts`、`auto-continue.ts`、`src/renderer/src/state/session-runtime.ts` |
| 子 Agent、隔离工作区与交接 | `src/main/subagent-service.ts`（界面与 `yan subagent` 共用的控制器）、`subagents.ts`、`subagent-isolation.ts`、`session-isolation.ts`、`handoff-coordinator.ts`（自动交接的判资格、收集、复核与提交）、`handoff-service.ts`、`handoff-transaction-service.ts` | `src/shared/subagent-brief.ts`、`handoff.ts`、`handoff-transaction.ts`；`scripts/test-handoff-host-regression.mjs` 从 `handoff-coordinator.ts` 取函数驱动 |
| 上下文预算、整理与召回 | `src/shared/context-budget-v1.ts`、`src/main/context-budget-store.ts`、`context-watermark.ts`、`context-recall.ts` | `resources/pi-extensions/context-budget-observer.js`、整理事务 `context-budget-maintenance.js`（落盘与版本 `context-budget-store.js`、滚动笔记与归档 `context-budget-projection.js`、续跑与恢复 `context-budget-resume.js`）、`context-budget.js`、工具输出清扫与任务状态注入 `context.js`（注入块放在最新用户消息之前、同一回合内冻结；改写历史前缀会让服务商缓存失效、按全价重发）、后台调用用量账 `context-background-usage.js` + `src/shared/context-background-usage.ts` / `src/main/context-background-usage.ts`（扩展写整理摘要 / 深度归纳 / 任务状态 / 交接，主进程写标题；宿主只读，界面读数在设置 → 上下文）、`src/main/context-budget-commands.ts`（`yan context budget` 与回合边界记账）、`src/main/agent.ts` 的整理入口（失败后自动重试一次；失败停下时新消息被拦下，出口 `yan:contextBudgetMaintenanceExitV1` 临时抬软线 / 降档并作废那笔整理）；归档检索 `src/main/context-recall.ts`（`yan context recall` / `find`）；`scripts/build-context-budget.mjs` 生成 `resources/pi-extensions/generated/context-budget-v1.mjs` |
| 扩展命令、模型能力与工具接入 | `resources/pi-extensions/`、`src/main/capabilities/`（`acquisition-commands.ts`：`yan capabilities` 检索 / 发现 / 计划 / 接入）、`src/main/mcp/` | `src/main/agent.ts` 的 `runCapabilityCommand` 分派，其余宿主工具在 `browser-commands.ts`、`lookup-commands.ts`（`yan search` / `yan knowledge`）；`src/main/extensions-inventory.ts`、`resources/yan-cli/yan.mjs`；宿主能力优先放宿主，pi 扩展保持薄 |
| 本机远程管理入口 | `src/main/remote-server.ts`、`src/main/remote-host.ts`（会话摘要、历史、有限会话操作与砚对砚开放数据；与桌面会话 IPC 共用 `session-host.ts`）、`src/main/index.ts` 的 `startRemoteServer` | 显式命令白名单与事件筛选；手机设备配对即可访问 |
| 砚对砚互通 | 所有者侧：`src/main/peer-grants.ts`（本次连接授权）、`remote-server.ts` 的 `handlePeer`、`remote-host.ts` 的 `peerHostHandlers`、`ipc/peer-host-ipc.ts`、`components/shell/PeerApprovalDialog.tsx`；连接者侧：`src/main/peer-client.ts`、`ipc/peer-ipc.ts`、`components/settings/PeerTab.tsx` | `src/shared/peer-protocol.ts`；peer 令牌只进 `/remote/v1/peer/*`，授权绑定事件流、断开即失效；`scripts/test-peer.mjs` 钉住门禁 |
| 项目、工作树、Git 审查 | `src/main/session-layout.ts`、`project-id.ts`、`git-service.ts`、`git-worktree.ts`、`git-actions.ts` | `src/renderer/src/components/rail/`、`components/review/`、`src/shared/git.ts` |
| 内置浏览器与 Chrome | `src/main/browser.ts`、`src/main/browser/`、`src/main/chrome.ts` | `components/browser/BrowserSurface.tsx`；网页是原生 `WebContentsView`，位置、缩放与焦点由主进程协调 |
| 终端、文件与附件 | `src/main/terminal.ts`、`files.ts`、`attachments.ts`、`file-refs.ts` | `components/chat/Terminal.tsx`、`components/terminal/TerminalSurface.tsx`、`components/toolbar/FilePreview.tsx`；终端依赖 `node-pty` |
| 随包技能（领域做法按需加载） | `resources/skills/<名称>/SKILL.md`（现有 office、research、subagent、playbook、tutor、capabilities、doc-sync、writing、organize、follow、memory）；用户技能在 `YAN_DIR/skills`（`src/main/user-skills.ts`）（打包到 resources/yan-skills）、`src/main/index.ts` 的 `bundledSkillPaths` | `AgentController` 以 `--skill` 显式传入（pi 仍 `--no-skills`）；领域流程优先写成技能，宿主只保留技能做不到的部分（真实文件预览、授权、持久数据） |
| 办公文件预览与对比（docx / xlsx / pptx / pdf） | `src/main/office/`（`zip.ts`、`extract.ts`、`office-service.ts`）、`src/main/ipc/office-ipc.ts` | `src/shared/office.ts`（类型与逐行对比）、`components/review/OfficeContent.tsx`（文件预览与审查面板共用）、`yan office read`（`src/main/agent.ts` 的 `office.read`）；只提取文字，不还原版式；对比基准是 Git 的 HEAD |
| 电脑本地语音输入（whisper.cpp） | `src/main/voice/voice-service.ts`、`src/main/ipc/voice-ipc.ts` | `src/shared/voice-input.ts`（模型目录、按配置推荐、WAV 编码、输出解析）、`components/chat/VoiceInputButton.tsx`（录音 → 转写 → 插入输入框）、`components/settings/VoiceTab.tsx`；下载先 `plan` 核实大小与位置，用户确认后才 `download`；录音只存临时文件 |
| 普通工具的自动调用依据 | `src/shared/tool-consent.ts`（键、危险类别、衰减与 Wilson 下界判定）、`src/main/consent-store.ts` | `src/main/agent.ts` 的 `consent.request`（`yan consent request`）、`index.ts` 的确认框、`ipc/consent-ipc.ts`、`components/settings/ConsentSection.tsx`；只记录确认框里的真实答复，危险类别与远程场景永远询问 |
| 模型登录、凭证、设置 | `src/main/oauth.ts`、`credentials.ts`、`custom-providers.ts`、`settings.ts` | `components/settings/`、`src/shared/model-capabilities.ts`；本地档案不代表模型账号已登录 |
| 主题空间、资料与成果 | `src/main/space-store.ts`、`library-*`、`artifact-doc-store.ts`；旧学习记录导出在 `learning-export.ts` | 对应 `src/shared/space.ts`、`library.ts`、`artifact-doc.ts` 与 `components/workbench/`；学习做法在 `resources/skills/tutor` |
| 项目知识、个人记忆与长期记录 | `src/main/project-memory-store.ts`、`project-knowledge.ts`、`personal-memory.ts`（个人范围、外部工具收件箱与导出）、`ipc/knowledge-ipc.ts` | `src/shared/project-memory.ts`；按来源、归属与版本处理，避免与会话原文混同 |
| 联网搜索与能力获取 | `src/main/search/`、`src/shared/search.ts`、`src/main/capabilities/` | `scripts/probe/search.mjs` 与 `search-electron.mjs` 区分普通 Node 与 Electron 环境 |
| 底部状态栏与右栏检查器 | `components/shell/StatusBar.tsx`（模式、分支、pi、手机、本轮用量与花费）；`components/toolbar/RightPanel.tsx`（分区注册、布局与浮出磁贴）及各分区文件 `ContextSection.tsx`、`QuotaSection.tsx`、`TodoSection.tsx`、`PanelSections.tsx` | 状态都从 store 快照推导，不自己计时；用量口径在 `components/chat/UsageBar.tsx`，窄窗隐藏顺序见[设计规范](DESIGN_SYSTEM.md) §4 |
| 手机端界面（Android） | `mobile/src/App.tsx`（路由与折叠屏双栏）、`mobile/src/screens/`、统一控件 `mobile/src/ui.tsx`、令牌 `theme.ts`、动效 `motion.tsx` | 色值与 `tokens.css` 同源（`npm run check:mobile-tokens`）；接口是 `src/shared/remote-protocol.ts`，桌面侧在 `src/main/remote-host.ts`；规则见[设计规范](DESIGN_SYSTEM.md) §7 |
| 样式、图标、动效与多语言 | `src/renderer/src/styles/`（控件外观在 `ui.css`）、`components/ui/`、`icons/`、`i18n/` | [设计规范](DESIGN_SYSTEM.md)、`scripts/design/icons/` 和生成清单；改界面时同时检查深浅主题、键盘与窄窗口 |

## 数据与构建边界

- `src/main/paths.ts` 定义 `PI_AGENT_DIR`、`YAN_DIR`、Electron 用户目录及便携版路径。真实用户会话、凭证和发行版 `release/砚数据/` 只读；验证用独立 `YAN_*` 目录。
- pi 会话本体为 JSONL；砚的设置、任务与投影由各自 store 保存在 `YAN_DIR`。不要把界面缓存当作历史事实源。
- `resources/pi-runtime/`、`out/`、`release/` 是生成物或分发内容。上下文预算生成模块要改 `src/shared/context-budget-v1.ts` 等源文件，再按 `package.json` 的 `build:context-budget` 生成并核对。
- 常用检查见 [贡献指南](CONTRIBUTING.md)。`test:unit` 依赖构建；`test:live` 不自动构建。运行、构建、实际界面和发行包分别说明证据。

## 下一轮代码整理从哪里下手

主进程的任务调度（目标续跑、自动交接、会话调度）、按领域的 IPC 注册器、远程宿主，`AgentController` 的宿主工具、上下文预算、界面请求与回合计时，以及渲染端的推送归属判定已经拆出。`AgentController.handleEvent`（pi 事件 → 界面状态）仍集中在 `agent.ts`，与 pi RPC 执行核心一起保留；再拆时沿已有边界小步迁移，`runners.ts`、`session-runtime.ts` 等先复用。行数本身不证明性能问题。语言或应用壳的取舍见 [技术路线](TECH_STACK_OPTIONS.md)。
