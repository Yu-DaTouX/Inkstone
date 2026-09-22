# 砚 · 实现总览

本文按功能定位实现；状态与剩余工作见 [HANDOFF](dev/HANDOFF.md)，文件联动见 [CODE-MAP](dev/CODE-MAP.md)。这里描述已有实现，不等同于完整验收通过。

## 一、骨架：三个进程、一条数据流

```
┌─ 主进程（src/main）───────┐   ┌─ 渲染进程（src/renderer）─┐
│  窗口 / IPC / 运行实例注册表 │   │  React + zustand          │
│  AgentController × N      │←→ │  只订阅 MainPush 补丁       │
└───────────┬───────────────┘   └───────────────────────────┘
            │ spawn（--mode rpc，JSONL）
     ┌──────▼──────┐
     │ pi 子进程 × N │  ← 一个**运行中**的会话 = 一个进程
     └─────────────┘
```

三条不可越过的线：

1. **pi 协议只被三个文件认识**：`main/protocol.ts`（手写 RPC 客户端）+ `main/agent.ts`（事件循环）+ `main/normalize.ts`（归一化）。往外一律是 `MainPush` 补丁。
2. **界面不 import 主进程**，只能经 `preload` 的白名单桥（`window.yan`）。
3. **共享契约只有 `shared/ipc.ts`**，改它 = 跨进程改动。

一次对话的完整往返（定位对话类问题的路径）：

```
Composer.tsx → store 动作 → window.yan.*（preload）→ ipcMain.handle（main/index.ts）
  → RunnerRegistry.select（runners.ts）→ AgentController（agent.ts）→ PiRpc → pi
pi 的事件回来 → protocol → agent → normalize → pushFrom(runnerId, …) 带身份封套
  → store.applyPush（身份闸门）→ session-runtime 归并 → 顶层投影 → 组件重渲染
```

---

## 二、各部分功能与实现方式

### 2.1 对话与流式渲染

| 做什么 | 怎么实现的 | 涉及文件 |
|---|---|---|
| 流式输出 | pi 事件里的 delta 按 `MessagePatch` 增量套用；同一 message id 的多段 delta 合并成一条 | `main/agent.ts`、`main/normalize.ts`、`shared/ipc.ts` 的 `MessagePatch` |
| 一轮一块 | 扁平的 `UIMessage[]` 折成 `Turn[]`（用户轮 / 助手轮 / bash 轮），推理与工具归到所属回合 | `shared/turns.ts`（纯函数，有单测） |
| 长会话不卡 | `virtua` 的 `VList` 虚拟滚动 | `App.tsx` |
| 展开不顶走下方 | 展开/收起前后记录滚动锚点并补偿 | `lib/scrollAnchor.ts` |
| 底部跟随 | 贴底判定 + 用户上滚时不抢滚动位置 | `App.tsx`、`lib/scrollAnchor.ts` |
| 用量条 | 底部条：速度 · **用时** · 输入 · 输出 · 缓存（含命中率）；最右是模型 + 思考强度选择器 | `chat/UsageBar.tsx` |

**改动注意点**

- `turns.ts` 是纯函数、被两处消费（回合视图 + 大纲），改分组规则要跑 `npm run test:unit`。
- 流式 delta 的合并规则有单测（`test-stream-deltas.mjs`）—— 曾经漏合并导致文字重复。
- **用量条上的两个时间不是一回事**：`speed` 是“首 token → 结束”（不含排队与工具往返）；
  **「用时」用 pi 的 `elapsedMs`**（本轮从开始生成到结束的**墙钟**耗时，含工具往返），
  只在回合结束后显示（流式期间那个位置是「生成中 Ns」）；新会话不残留上一轮的用时。
  断言在 `test:live -- tokens`，视觉证据是 `matrix-usageelapsed-{dark,light}`（硬断言 `[data-testid="ub-elapsed"]`）。

### 2.2 会话、项目与分支

| 做什么 | 怎么实现的 | 涉及文件 |
|---|---|---|
| 会话归属 | **pi 继续拥有 JSONL 和目录**；Yan 只在自己数据目录维护 `sessionId → projectId / scope / 最近访问` 的映射 | `main/session-layout.ts`（有单测） |
| 切会话立即有内容 | 不等 pi：直接解析会话 JSONL | `main/session-reader.ts` → `store.switchSession` |
| **界面历史 = 会话文件** | `hydrate()` 用 `readSessionMessages(sessionFile)` 取完整历史；pi 的 `get_messages`（只给**当前上下文**，压缩后只剩尾巴）只做兜底 | `main/agent.ts`、`main/session-reader.ts` |
| 真正切换 | 让 pi 自己 `switch_session` / 跑分支（会话语义、压缩与上下文归属都在 pi）；Yan 只解析 JSONL 把**显示历史**还原出来，不参与运行语义 | `main/agent.ts`、`main/session-reader.ts` |
| 列表 / 删除 / 恢复 | **只读**列目录 + 标题样本；删除走回收站语义 | `main/sessions.ts` |
| 分支（fork） | 从 pi 的 `get_fork_messages` 拿**分支 entryId**（绝不从 DOM 或归一化消息 id 猜） | `lib/fork.ts`、`main/agent.ts` |
| 标题 | **独立短进程**跑一次极短请求做归纳；手动标题粘性优先；候选→采用两段式 | `main/title.ts` |
| **项目 / 分组顺序（N01）** | 左栏拖拽：**合成指针事件走真实路径**（没用 HTML5 `draggable`，所以行为完全由自己的代码决定）；顺序计算是纯函数，落盘走设置：项目顺序存 `AppSettings.projectOrder`（项目 id 数组），分组顺序就是 `projectGroups` 数组本身 | `shared/rail-order.ts`（纯函数，25 条单测）、`components/rail/Rail.tsx` 的拖拽区块、`styles/rail.css` 的 `.is-dragging` / `.drop-before` / `.drop-after`、`main/settings.ts` 的清洗 |

**改动注意点**

- 会话目录按 cwd 编码：`sessions/--C--Users-…-pi-desktop--/<时间戳>_<id>.jsonl`。测试按 **fixture 路径**定位会话，不依赖会被模型重写的标题。
- **别把 `get_messages` 当成“会话历史”**：它是模型当前上下文（压缩过的会话实测只剩 858 → 86 条，首条用户消息都没了）。界面要看的是用户能看到的完整历史。
- **切会话的竞态有两条，都不能把眼前的内容盖掉**（HANDOFF 的 D38）：
  · `sync` 先认人（`runtime.sessionId` vs `peekedSessionId`），旧实例晚到的那条直接丢；
  · 运行时缓存投影先比会话身份（`snapshotForView` / `findRuntimeSnapshot` 的 `run:` 兜底），
     实例被复用到别的会话时它的 `messages` 属于上一条会话。
  回归网：`test:live -- historyswitch`（断言“铺上内容后没被打回 0” + 文件 vs 应用手里的一致）。
- `title.ts` 那次短任务**显式关掉了** context files / skills / 提示词模板（`--no-context-files` 等）：否则每次生成标题都要把 `AGENTS.md` 与技能清单塞进系统提示。
- 分支 entryId 来源只有 `get_fork_messages` 一个，别的地方拿到的 id 不可靠。
- **拖拽排序的三条边界**（N01，别放开）：① 搜索态不允许拖（列表是筛过的，顺序不代表真实排列）；② 项目落点必须**同组**（跨组是归属变更，右键菜单里另有入口，不能让一次误拖悄悄改归属）；③ 松手后浏览器紧跟的那个 `click` 必须被吞掉，否则会顺带切项目。另外「前五项折叠」与拖拽是互斥的 —— 一开始拖就自动展开，否则拖不到看不见的行。
- `projectOrder` 只存**用户拖过的**项目（新打开的项目不在里面也能正常出现在列表尾部）；读盘时会把已删除项目的陈旧 id 清掉。

### 2.3 运行实例：切走不打断后台任务（N12）

| 做什么 | 怎么实现的 | 涉及文件 |
|---|---|---|
| 后台不中断 | **一个运行中的会话 = 一个 pi 子进程**。切换会话不再复用同一个进程 | `main/runners.ts` |
| 找/建实例 | 按 `sessionFile` 命中已有实例（命中就只切视图，不发停止命令）；否则复用空闲实例；预算 3 个 | `main/runners.ts`（`RUNNER_LIMIT = 3`） |
| 到上限 | **明确拒绝并提示**，绝不偷偷停掉旧会话腾位置（那正是用户报过的 bug） | 同上 |
| 事件分拣 | 每个实例有稳定 `runnerId`；推给渲染端时带身份封套 `sessionId / runId / generation` | `main/runners.ts` 的 `runtimeOf()` |
| 渲染端不串台 | `store.applyPush` 做身份闸门：只有 `activeRunnerId === runtime.runId` 才写当前投影，其余进按会话缓存 | `state/store.ts`、`state/session-runtime.ts` |

**改动注意点（最容易静默失效的一处）**

身份这条链有**三个必须一致的落点**：`runners.ts` 产生封套 → `store.applyPush` 判闸门 → `session-runtime.ts` 存缓存。四处里少改一处，事件会被**静默丢弃**（不报错）。

实测证据（`scripts/probe/survey.js`）：同一个实例先后以两个键存在

```
Object.keys(sessionRuntimes) = ["pending:r1", "01a0a42a-0bdc-76ff-8358-0fa2e8527263"]
runners[0] = { id:"r1", runId:"r1", … }        // runId 恒等于实例 id
```

所以 **`sessionId` 不能用来判等值**（启动期是 `pending:<runId>`，就绪后才换成真实 uuid）。

### 2.4 模型与能力探测

| 做什么 | 怎么实现的 | 涉及文件 |
|---|---|---|
| 列模型 | pi 的 `get_available_models` —— 这是**运行实例级**的，与会话无关 | `main/agent.ts` |
| 能力字段 | 归一化时缺失一律记 `unknown`，**绝不因为字段缺失就判成不支持** | `shared/model-capabilities.ts`（有单测） |
| 判响应过期 | 用 `runId` 做主键，没有 runId 才退回 `sessionId` | `state/capability-request.ts`（有单测） |
| 连接恢复后补拉 | `startConnWatch` 在 `starting → ready` 时重拉模型 / 命令 / 会话列表 | `state/store.ts` |
| 模型选择器 | 挂在**用量条内部**（`.usagebar > .picker-wrap`），不是独立控件 | `Composer.tsx` → `UsageBar.tsx` → `Pickers.tsx` |
| pi 未就绪时 | **降级渲染**：保留选择器 + 明确空态，不整条 `return null` | `UsageBar.tsx`、`Pickers.tsx` |

**改动注意点**

- 「启动时拉一次、之后再补」这类链路，要在代码里**找到那个"补"的调用点** —— 这里踩过：两处注释互相担保说会补拉，实际都没做，于是模型菜单永远是 0 条。
- 别用多道「没数据就不渲染」把同一个入口层层拦掉：`UsageBar` 和 `Pickers` 各有一道 `return null`，pi 未就绪时叠加起来整个入口消失，用户连自救的入口都没了。

### 2.5 工具调用的呈现

| 做什么 | 怎么实现的 | 涉及文件 |
|---|---|---|
| 分型渲染 | 按工具种类选壳体（文件改动 / 命令输出 / …），不再一律套终端外壳 | `chat/ToolDetails.tsx` |
| Codex 风格 | 一条条列出的工具行 + 可折叠的组；默认收起，只展开运行中的那条 | `chat/ToolRow.tsx`、`chat/ToolGroup` |
| 来源归属 | `bash` 里敲 `yan tasks apply` 的那条卡标「任务计划 · 砚内置」（`data-origin="yan-task-plan"`）；**仍是 bash 卡**，展开后是原始命令与输出 | `shared/tool-origin.ts`（有单测）、`chat/ToolRow.tsx`、`styles/chat.css`（`.trow-src`） |
| 前后快照 | 写入类工具在执行前后各存一份，差异归属靠这个（`edit` 的参数只是替换片段，不等于 diff） | `main/snapshots.ts`（有单测） |
| 终端窗口 | 工具输出可调大小的窗口 | `chat/Terminal.tsx` |

**任务清单的来源（实施-02 S1–S4，2026-09-18）**：右栏任务分区由**两个来源合并**驱动
（`agent.ts` 的 `refreshTodos` → `main/todo-snapshots.ts` → 右栏任务分区）：
1. **宿主任务日志**（S3 起是主来源）：`YAN_DATA_DIR/task-plans/<sessionId>.jsonl`，
   由模型 `bash` → `yan tasks apply` → 宿主 `main/task-plan-store.ts` 写入（只追加、按会话串行、
   CAS + 幂等、落盘失败不报成功）；
2. 会话文件里的旧条目（`left-panel-tasks`，**只读兼容**，永不回写）。
只认两个**精确标识**（第三方 `my-task-log` 这类不算任务）；同一轮两者都有时**宿主日志优先**。
启动后 `main/extensions-inventory.ts` 把「用户扩展 / 砚薄层」写进日志（诊断样例）——
旧条目只读、两者不会互相覆盖。
⚠️ 宿主日志**不写进会话 JSONL**（pi 的 RPC 没有追加 custom entry 的命令，且 01 §5 禁止外部编辑在用的 JSONL）；
代价是用户拿 pi 终端打开同一会话看不到这些任务（判定过程见 [证据-02-S3 §1](archive/evidence/证据-02-S3-宿主任务服务.md)）。
契约在 `shared/task-plan.ts`；剩余切片见 [实施-02](archive/plan/实施-02-任务工具内置化-已完成.md)，
本轮证据见 [证据-02-S3](archive/evidence/证据-02-S3-宿主任务服务.md) 与 [证据-02-S4](archive/evidence/证据-02-S4-UI与命令接线.md)。

**S4 的界面接线（2026-09-18）**：

| 面 | 现在的做法 | 涉及文件 |
|---|---|---|
| 工具卡归属 | 模型用 `bash` 敲 `yan tasks apply` 时，卡片显示「任务计划 · 砚内置」；判定只看命令文本（`shared/tool-origin.ts`），**不改变写入语义**，也无法伪造原生独立工具事件 | `shared/tool-origin.ts`、`chat/ToolRow.tsx` |
| `/panel` | 从 `/` 补全里**隐藏**（`hiddenInMenu`），但**保留在注册表**（`source=compatibility`）—— 删掉它，用户扩展注册的同名命令就会变成唯一命中项、手打时发给模型；手打时正保留草稿与附件，只推两句话说明为什么没动作 | `main/command-registry.ts`、`chat/Composer.tsx`、`state/store.ts`（`notify`） |
| 插件页 | 「已装的插件」（可卸载）与「砚内置能力」（随包分发、无卸载按钮）分开；内置清单从主进程**实际加载路径**派生（新增只读 IPC `yan:capabilities:builtin`），**不另写一份** | `main/extensions-inventory.ts`、`settings/PackagesTab.tsx` |
| 来源诊断 | 有用户扩展时不再说「砚只读不写」（S3 之后不成立），改为两条写入路径 + 「同一轮以宿主日志为准」 | `main/extensions-inventory.ts`（有单测） |

**S5 的真实运行验收（2026-09-18）**：新场景 `taskplan`（cost 1）让模型**自己写请求文件、自己登记、自己做、自己勾选**，
结果「工具调用 / 界面清单 / 磁盘日志」三处逐条一致；`taskcli`（含取消一节）/ `taskext`（**旧任务扩展 + 无关扩展**共存）/
`slashcmd` / `todos` / `todonew` / `sessions` / `historyswitch` 全绿；打包后启动器写进 `YAN_DIR/bin` 并指向
**解包目录**里的 `yan.mjs`，CLI 在安装目录里真跑 `--help`、无宿主时报可读错误。
证据见 [证据-02-S5](archive/evidence/证据-02-S5-真实运行与验收.md)。

### 2.6 推理内容

**怎么实现的**：上游只返回可展示的思考文本时，按**字素**流式放进主流；**限高省略** —— 固定 `max-height: min(32vh, 260px)`，`overflow: hidden`，裁掉开头、`scrollTop` 贴底显示**最新**内容，顶部加 mask 渐隐，给「展开全部 / 收起」出口。

**涉及文件**：`chat/Reasoning.tsx`、`styles/chat.css`（`.reason-body.clip` / `.is-clipped` / `.expanded`）、`styles/tokens.css`（`--reason-max-h`）。

**改动注意点**

- **不引入第二条滚动条**：早期"不设固定高度、不用内部滚动"的方案已废止；改回嵌套滚动会带回"上滚被拽回底部"的问题。
- 语言：**不注入**"必须用某语言思考"之外的任何语言要求；界面语言只由**一句**话约束，措辞的唯一真源在
  内置扩展 `resources/pi-extensions/language.js`（`languageSystemPrompt()`），**永远保留模型返回的原文**。
  交付方式与位置（改动前先读那段注释与 [MAINTENANCE](dev/MAINTENANCE.md)「提示类改动：位置比措辞更重要」）：
  · 主通道：`before_provider_request` 在**最后一条用户消息前**插一条独立 `developer` 消息（实测的最强位置）；
  · 兜底：`before_agent_start` 把同一句追加到系统提示末尾（payload 结构不认识的 provider 也还有一份）；
  · 每轮读 `YAN_DATA_DIR` 下的 `desktop.json`（便携版是 EXE 同级数据目录），所以**切语言下一轮就生效**；
  · **不重建 pi 实例**（早期为了 `--append-system-prompt` 生效而重建，代价见 HANDOFF 的 D37）；
  · 推理语言是**软约束**：模型可能"用英文想、按界面语言答"，不据此下"功能失效"的结论（`test:live -- language` 只报告）。
- 这条契约被 `scripts/probe/reasoning.js` 钉住了（**44 条断言**），改它探针会红。

### 2.7 文件树、预览与 @ 引用

| 做什么 | 怎么实现的 | 涉及文件 |
|---|---|---|
| 文件树 | 懒加载：一层一次列；带缓存与隐藏项开关 | `main/files.ts`、`toolbar/FileTree.tsx` |
| 预览 | **只读**，明确不是编辑器 | `toolbar/FilePreview.tsx` |
| `@` 补齐 | 主进程按 cwd 列目录；光标范围是纯函数（范围**不含** `@` 本身，便于替换） | `main/credentials.ts` 的 `completePath`、`chat/at-query.ts`（有单测） |
| 拖入文件 | 渲染端拿到的是 `File` 对象，可以是工作区外的**任何**文件 → 必须显式授权 | `main/file-refs.ts` |

**改动注意点**

访问边界是**同一条约束**、分散在**三处**：`main/files.ts`、`main/file-refs.ts`、`main/credentials.ts` 的 `completePath`。三处必须一致是「渲染端只能看见 cwd 以内」，少改一处就等于开了个口子。

`@` 补齐的路径穿越也在这里判，单测在 `test-credentials.mjs`。

### 2.8 内置浏览器与本机 Chrome

四段链路，缺一段都跑不起来：

| 层 | 位置 | 职责 |
|---|---|---|
| 主进程控制器 | `main/browser.ts` | 内嵌视图 + 外部 Chrome 代理标签，统一标签栏 / `activeMode` 路由；**宿主独占**（01-S5d 起不再有 loopback HTTP bridge，模型侧走 `yan browser …`） |
| 底层 | `main/browser/` | `CDPBridge`（Electron 调试器）与 `RawCdp`（外部 Chrome 的 WebSocket）实现**同一个** `CdpChannel` 接口；`Observer` 出可交互元素表、`ElementRegistry` 管 ref、`InputController` 发输入、`BrowserPolicy` 拦高风险动作 |
| 原生视图 | 主进程持有 `WebContentsView` | **不是 iframe**，永远盖在渲染层之上 |
| UI | `components/browser/BrowserSurface.tsx` | 只画工具栏 + 把可见区域坐标同步给主进程 |
| 模型入口 | `yan browser …`（`capability-server.ts` → `AgentController.runBrowserCommand`） | 模型经 `bash` 调 CLI；不直接碰 Electron 对象（旧 `pi-extensions/browser.js` 已于 01-S5 收尾删除） |

**改动注意点**

- **坐标必须乘 `win.webContents.getZoomFactor()`**，否则非 100% 缩放下内置浏览器位置会偏。
- 抽 `CdpChannel` 接口的理由：内嵌用 Electron debugger，本机 Chrome 必须走原生 WebSocket，两者对上层必须一样。
- `RawCdp` 之外还有 `main/chrome.ts`（探测/启动本机 Chrome，独立 `--user-data-dir` + 调试端口）和 `main/chrome-profile.ts`（把真实 Chrome 的登录态与历史导入托管 profile）。

### 2.9 子代理

**怎么实现的**：自有的进程管理适配（不装上游扩展）——每个子代理跑一个 `pi --mode rpc`，带并发上限、超时、停止、转录上限，用量不重复计入；**写入隔离**用独立 git worktree（从当前 HEAD 建），差异先汇总、用户确认后再 apply。

**三种发起方式，同一条运行**（`subagents.ts` 的全局控制器，切换会话不会切走它）：

| 方式 | 入口 | 说明 |
|---|---|---|
| 用户按钮 | 输入区上方的「调用子代理」 | 打开面板填任务 + 「只读检查」开关；启动后自动打开详情 |
| 本地命令 | `/subagent <任务> [--read-only]` | 解析是纯函数 `shared/subagent-command.ts`（前置/尾置开关等价）；命令本身**不进模型** |
| 模型委派 | `yan subagent start / list / get / stop` | 模型用它自己的 `bash` 调随包 CLI；宿主回结构化摘要，不是模型工具 |

**涉及文件**：`main/subagents.ts`、`main/subagent-isolation.ts`（有单测）、`chat/SubagentList.tsx`（入口 + 运行列表）、`toolbar/SubagentPreview.tsx`（详情卡，主工作区内联）+ `chat/SubagentDetails.tsx`（同组件的再导出壳）、`shared/subagent-command.ts`（`/subagent` 解析）、`shared/ipc.ts` 的 `SubagentRun`。

**改动注意点**：

- 隔离模块只处理文件系统 / Git 边界，**不启动 pi**，也不把差异正文推到渲染端。
- **终态要看 `stopReason`**：pi 的**模型失败**也会走到 `agent_settled`（错误只体现在 assistant 消息的 `stopReason === 'error'` 上）。不记它就会把「模型报错了」落成 `status: 'done'`，详情卡显示「已完成」（2026-09-19 修真，证据 `test:live -- subagentfail`）。
- 运行上限可用 `YAN_SUBAGENT_TIMEOUT_MS` 覆盖（只为测试压短；提示文本按**实际**上限拼，不是写死的 10 分钟）。
- 子代理**不是会话级状态**：`session-runtime.ts` 不缓存 `subagent` 事件，它只进全局 store —— 否则切个会话就看不到正在跑的委派任务。
- 任何新 run（包括模型通过 `yan subagent start` 启动的）都会把详情指向它，否则模型委派只能悄悄出现在列表里（能力说明向模型承诺的是「用户能看到实时转录」）。
- `yan subagent …` 与 UI 使用**同一个控制器**：模型启动的任务会推给渲染端，但没有合并 / 放弃入口（worktree 归属仍由用户在详情卡里审阅）。

### 2.10 凭证、额度与登录

| 做什么 | 怎么实现的 | 涉及文件 |
|---|---|---|
| 写凭证 | 直接读写 pi 的 `auth.json`，让用户在桌面端就能配 key | `main/credentials.ts`（有单测） |
| ChatGPT 登录 | **桌面端自己发起 OAuth**，参数逐字对齐内置 pi（差一点 pi 就不认这个 token） | `main/oauth.ts` |
| 额度查询 | 取额度必须用 **Electron 的 `net.fetch`**，不能用全局 `fetch` | `main/quota.ts` |
| Command Code 订阅窗口 | **口径易反**：`windowLimits.*.used` 是「已用」，而 `credits.monthlyCredits` 是「**本月剩余**」—— 已用 = 套餐总额度（`weekly.cap × 2` 反推）− 剩余；月度上限是推算值，界面明标「推算」。反了会显示「本月已用 99.9%」（2026-09-21 修过） | `main/quota-commandcode.ts`（有单测） |
| 额度色阶 | <70% 绿 / 70–95% 黄 / ≥95% 红，窗口与主值共用；与上下文水位的 85 / 95 **不是一套** | `shared/quota-tone.ts`（有单测） |

**改动注意点**

- 全局 `fetch` 请求 chatgpt.com 会被 Cloudflare 拦（同样的头也拦），所以这里不能用 fetch。
- 登录只预留：**本地档案不得显示虚假的「已登录 / 已同步」**。订阅制里只有 `openai-codex` 能在应用内登录，其余必须走终端。
- 凭证路径：便携版是 `<EXE同级>/砚数据/pi-agent/`，否则 `~/.pi/agent/`。

### 2.11 设置、外观与缩放

| 做什么 | 怎么实现的 | 涉及文件 |
|---|---|---|
| 桌面端设置 | 只写自己的数据目录，**刻意不写 pi 的 `settings.json`**（那是 TUI 和扩展的领地，改它会污染用户配置） | `main/settings.ts` |
| 设计令牌 | **先改 `docs/design/DESIGN.md`，再同步** `styles/tokens.css` | `docs/design/DESIGN.md` |
| 缩放 | 纯计算（DPI 取整）与 electron 部分**分开**，前者才能单测 | `main/zoom-math.ts`（有单测）、`main/zoom.ts` |
| 动效 | 尊重 `prefers-reduced-motion` | `styles/motion.css` |
| 版本显示 | 「关于」顶部两行：**正式版本**（`package.json`）+ **构建版本**（构建时注入的时刻与 git 短 hash）。用于确认“现在跑的是哪次构建” | `electron.vite.config.ts`（define）、`shared/build-info.ts`（有单测）、`components/settings/Settings.tsx` |

**改动注意点**

- grid 弹性列一律 `minmax(0, 1fr)`，否则长内容会撑破布局（`lint-css.mjs` 会拦）。
- 版本信息是**构建时注入**的（`__YAN_BUILD__`）：改了它要重新 `npm run build` 才反映到界面（`启动-砚.cmd` 会强制重建）。
- `styles/` 里 `stage1` / `stage2` / `redesign` 这些名字旧**不代表无用**；删除前核对导入顺序与动态类名。
- 改 CSS 后跑 `npm run typecheck`（含 CSS 约定 + 层叠自检）。

### 2.12 打包与分发

| 项 | 实现 |
|---|---|
| asar 内容 | 白名单：`out/**`、`build/icon.png`、`package.json`；排除 `node_modules/**`、`out/test/**`、`**/*.{map,md,ts,tsx,tsbuildinfo}` |
| 随包资源 | `extraResources`：`resources/pi-runtime/{dist,node_modules,package.json}` + `resources/yan-thin`（来源为 `resources/pi-extensions`） |
| 文档 / 源码 / 脚本 | **不进包**（不在白名单） |

**改动注意点**

- `resources/pi-runtime/node_modules` 必须**单独一条 `from`**：electron-builder 的 filter 会跳过被拷目录**顶层**的 `node_modules`，靠父目录带会让内置 pi 静默丢依赖 —— 症状是开发态全绿、装出来的应用连不上 pi。
- `files` 里的 `out/**` 是**全收**的：跑过单测再打包会把 `out/test/*.mjs`（30 文件 / 489K 的业务代码副本）带进 asar。已用 `'!out/test/**'` 排除（实测条目 259 → 235）。
- **打包边界要看产物不要只看配置**：`npx @electron/asar list <解包目录>/resources/app.asar`。
- `release/砚数据/` 是用户真实数据（只读）。它不会被打包，但**若把 `release/` 整个目录分发出去就会被带走** —— 交付时只挑 `砚-*.exe` / `砚-*.zip` / `SHA256SUMS.txt`。

### 2.13 上下文：工作集与压缩（N21）

| 项 | 实现 |
|---|---|
| 什么时候压缩 | **砚自己算工作集**并从回合结束处触发：`min(240k, 窗口×70%, 窗口−预留−余量)`（64k→40k / 128k→88k / 256k→179.2k / 1M→240k）。到线就调 pi 的 `compact()`；窗口小到装不下预留与余量时**没有预算**，退回 pi 原生压缩 |
| pi 原生压缩 | 保留不动（砚不写 pi 的设置文件）。它在工作集之上充当物理兜底；另有一条硬兜底 `emergency = min(90% 窗口, 窗口 − 输出预留)`（**不能突破输出预留**，64k 窗口下是 48k 而不是 57.6k） |
| 决策层 | `shared/context-policy.ts`（纯函数：预算、上膛/冷却、下一步阶段、**四层覆盖解析** `resolveContextPolicy`）；`agent.ts` 的 `evaluateContextPolicy` 只在回合结束时判定，不在流式/工具执行中途动手 |
| 阀值可配（N21-7） | 数值的 lookup 顺序：`YAN_CONTEXT_POLICY`（测试通道）> **模型级**（`provider/model`）> **供应商级**（`provider`）> **用户级**（设置面板）> 默认值。三个数值（工作集上限 / 窗口比例 / 输出预留）在设置面板的**「上下文」tab** 可改，可切“砚默认 / 参考方案（300k/0.75）”预设，并按模型覆盖；界面上直接写出生效层与已覆盖字段（“用户设置 · 已覆盖：工作集上限”）—— 这是“界面数 = 真正在用的数”的另一半。`AppSettings.contextPolicy` / `.contextPolicyByModel` 落盘，写入前过 `sanitizeContextPolicyOverrides`（非法值丢掉、越界值夹住、与默认相同就不落盘） |
| 开关（P2-7） | 设置面板「上下文」tab 有两个开关，**默认方向相反**：**深度上下文**（`ctx-deep`，默认关 —— 每轮同步多跑一次模型调用）与**任务状态记忆**（`ctx-fold`，默认开 —— 对应 `episode-fold`，会话够长且这一回合真改过东西才动手）。两者都写 `desktop.json`、由扩展**每轮读文件**（1 秒缓存），所以改完立即生效、不重建实例；`YAN_CONTEXT_POLICY` 显式给了 `kinds` 时它是测试通道、优先于界面开关。主进程侧与扩展侧读的是同一份默认值，但**生效值的折算分别在两边**（主进程 `resolveContextPolicy` 的 `foldEnabled` 层 / 扩展 `applyFoldSwitch`） |
| 可观测 | `compaction_start/end` → `SessionState.compaction`（进行中，带原因）+ `.lastCompaction`（已结束，带 status/error/前后 token）；发起方由砚盖章，pi 报的 `manual` 不会显示成「手动」 |
| 界面 | 工作集模式下主值是工作集（不是物理窗口），进度条上三条阶段刻度（清理/折叠/压缩，未接管的画虚线）；关掉「自动压缩」开关就整个退回物理窗口视角 |
| 阶段 4 · 生成器（S7，2026-09-17） | 阶段 4 的**执行层**已交付（N21-4 / S2–S6，2026-09-17）：内置扩展 `resources/pi-extensions/context.js` 做 Tool Sweep（旧工具输出 → 墓碑 + `ctx://` 引用）、Task State 前置注入、`context_recall`（预算 / TTL / 审计）、结构化压缩接管闸门（按 **freshness 分档**：完全一致最好、“有效但较早”也接并标 stale、对不上才降级回 pi 摘要；`buildStructuredSummary` 的 `requiredFields` 默认空数组，不再要求六类字段齐备）。**默认清扫 + 可召回墓碑 + 压缩**（`kinds` 默认含 `episode-fold`（2026-09-18 拍板，见方案 §17.5.7），2026-09-17 用户拍板：清理默认开但保留必要引用；墓碑带 `ctx://` 引用可 `context_recall` 取回，本回合正在动的文件不清扫）。**状态生成器（S7）已交付（2026-09-17）**：扩展在 `agent_settled` 上跑一次无工具 completion（`ctx.modelRegistry.complete()`）产出 TaskState 的**语义字段**，`files` / `commandsRun` / `testsRun` 由确定性 reducer 从真实工具调用里抄（落盘前**覆盖**模型返回的同名字段）；`revision` CAS 拦迟到结果；读时按 **freshness 分档**（gap 1–2 标 stale / 3–6 丢语义 / >6 不注入）。**2026-09-18 起在默认接管集里**（用户拍板）—— 但**不是每轮都跑**：会话级门槛与脏判定都还在，短会话照样不花钱；闸内还有 **`state.{generate,inject}` 两条分路**（`inject:false` = shadow 模式，**压缩接手也走这一路**）与一道**会话级 gate**（`foldEligible`：≥4 用户回合且转录 ≥48k，或本会话已经清扫过东西；命中后会话内 sticky）；注入块带 **authority 契约头**（`derived/authoritative/freshness/sourceHead` + 一句固定优先级），生成器输入会**自净掉** synthetic 内容（注入块 / 墓碑 / 召回正文），dirty 的「落后 ≥2」按**回合**而不是条目数算（见[归档 §1.11](archive/2026-09-17-已完成归档.md)）。证据见[方案 §17](design/active/方案-上下文工具内的自动压缩-2026-09-15.md)。**尾项已处置（2026-09-19，实施-06 S3）**：`symbolsTouched` **明确不做**（不为此在薄层引入语言级解析器，字段保留但刻意不填；见方案 §13.1 第 23 条）；**20+ 回合压力测试已做**（`test:live -- contextpressure`，22 个真实回合、压缩 3 次、峰值 1.05×），并据此修掉“策略压缩成功后不重新上膛”的真缺陷、给出 sweep 门槛的实测标定（方案 §12.11 第 10 条 / §12.12 P2）。~~EpisodeState 的语义生成~~ **已完成（2026-09-18，默认关 + shadow）**：边界用 `episodeWindow` 的**确定性规则**算（`recentTail` 窗口之外 + 上一版 Episode 的终点，扇叠只会向前推进），收束由模型的 `unresolved` 判（非空即不扇叠），生成后**只落盘、不消费**（进不进压缩摘要由 `buildStructuredSummary` 的 `includeEpisodes` 控制）；`state.{episodeGenerate,episodeInject}` 两道门**都默认关**——实测在提示词里多要一个嵌套对象会拉低整次生成（含 TaskState）的成功率；~~增量 delta~~ 已决策不做（方案 §18）；~~三阶段独立 Rearm/Cooldown~~ **已完成（2026-09-18）**：新纯函数模块 `resources/pi-extensions/context-stage-runtime.js`，`sweep` / `fold` 各持一份会话级运行状态（sweep 只留痕、不上锁；fold 在**模型调用之前**判上膛与冷却，成功与失败都上锁，由 5 分钟重试窗口节流）；~~`episode-fold` 是否进默认接管集~~ —— **已拍板进（2026-09-18）**。证据见[方案 §15](design/active/方案-上下文工具内的自动压缩-2026-09-15.md) |
| 阶段 4 契约 | 提点审核（2026-09-16）把阶段 4 的开工契约定在方案 §12：原子上下文单元与 `recentTail` 切割、`EpisodeState` / `CodingState` 两个 schema、禁止递归摘要、Recall 独立预算与生命周期、每阶段独立的上膛/冷却/收益门槛、失败退回 pi 原生行为 |

**改动注意点**

- 阶段参数已可在设置面板改（N21-7：用户级 + 模型/供应商级），但 **`YAN_CONTEXT_POLICY` 仍是最高优先级的测试通道** —— 它被用户设置盖掉会让 `contexttakeover` / `contextswitchguard` 这类场景静默失效。
- 界面上的工作集数字必须来自主进程推送的那份预算（`SessionState.contextPolicy`）—— 渲染端不许自己再算一遍（这一块出过 D21/D22 那类“界面数字 ≠ 实际生效值”的错）。
- 策略**默认开启**：这意味着 1M 窗口的模型也会在 240k 左右压缩，而不是等到近百万。要关掉就是关「自动压缩」那个开关。

---

### 2.14 Git 审查与环境菜单（方案 G1）

会话头部的项目胶囊是**环境菜单**的入口（变更 / 本地 / 分支 / Pull Request /
比较分支）；点「变更」在右栏打开**审查面板**。整条链路**只读**。

| 做什么 | 怎么实现的 | 涉及文件 |
|---|---|---|
| 环境菜单 | 项目胶囊变成按钮 + 菜单（点外 / Escape 关闭、打开时焦点落在第一项）。数字全来自真实查询，`gh` 不在就写「无法获取 Pull Request 状态」 | `components/review/EnvironmentMenu.tsx` |
| 仓库发现 | `rev-parse --show-toplevel --absolute-git-dir --git-common-dir`；带 30s 缓存 + `.git` 目录 mtime 失效。非 Git 目录返回 `null`（**不是错误**） | `main/git-service.ts` |
| 变更清单 | `status --porcelain=v2 -z` + `diff --raw -z` + `diff --numstat -z`，合成文件清单（状态 / 行数 / 指纹 / 内容形态） | `main/git-diff.ts`、`shared/git.ts` |
| 单文件 diff | 按文件懒加载 unified diff → 结构化 hunk（行号 + 类型），界面做折叠 / 两列行号 / 「N 行未修改」展开 | `main/git-diff.ts`、`components/review/DiffViewer.tsx` |
| 图片对照 | 两侧各读一次内容：旧侧 `git cat-file blob <rev>:<path>`、新侧读工作区；**必须用 buffer 编码**，`utf8` 会把 PNG 的字节替换成 U+FFFD | `main/git-diff.ts`、`components/review/ImageDiff.tsx` |
| 变更文件树 | 扁平清单折成目录树（纯函数）；文件名筛选、类型筛选、已查看进度 | `components/review/ChangedFileTree.tsx` |
| 已查看 | 用户主动标记；键 = 仓库 + 工作树 + 范围 + 两侧路径 + **两侧内容指纹**，内容一变即失效。存渲染端 localStorage | `components/review/useGitReview.ts` |

**改动注意点**

1. **绝不能调用 `main/subagent-isolation.ts` 的 `collectDiff()`。** 它在隔离 worktree
   里执行 `git add -A` 只为生成归档补丁 —— 主工作区复用一次，用户打开审查就会发现
   自己的暂存区被清空并全部暂存。审查的数据路径是独立的（`git-diff.ts`），
   而且有一条**退出后逐字节比对**的断言盯着它（`test:live -- gitreview` 的
   `afterExit: gitReviewReadonly`）。
2. **渲染端不能传 git 命令**。只传 cwd / 范围 / 路径；命令形状在主进程固定
   （`execFile` + 参数数组）。范围与 ref 走 `normalizeScope` + `refLooksSafe`
   （拒 `-` 开头的选项注入），路径走 `safeRepoPath`（拒绝对路径、`..`、`-` 开头）。
3. **`--no-ext-diff` 与 `--no-textconv` 必须在参数里再给一遍**：用户 gitconfig 里的
   external diff 会让输出完全不是 unified diff，而解析依赖统一格式。
4. **只读查询要加 `--no-optional-locks`**：`git status` 默认会写 `.git/index`
   刷新 stat 缓存。旧 git 不认这个选项时回退重试，而不是把「读不出来」报给用户。
5. **清单不含正文**。一个工程级改动可能有上千个文件；正文按文件懒加载，
   否则每次刷新都在 IPC 上搬几 MB 用户还没看的字节。
6. 图片 / 二进制 / 子模块 / LFS **必须分别标注**，不能都给一个 `+0 -0`
   （用户会以为没改动）或一个空 diff。未跟踪的二进制靠嗅探前 8000 字节的 NUL。


### 2.15 Git 写操作：分支 / 暂存 / 提交 / 推送（方案 G2）

```
渲染端  ReviewPanel（文件行暂存 + 底部提交区）/ EnvironmentMenu（分支 / 拉取 / 推送）
          └── useGitWrite（hook）→ window.yan.git.action
主进程  yan:git:action → main/git-actions.ts（**唯一**会改用户仓库的文件）
          ├── shared/git-actions.ts   纯逻辑：失败分类 / 输入校验 / 版本摘要 / 命令构造
          └── git-service.ts          gitRun / readExpected / 仓库与 ref 校验
```

**请求形状**：`{ requestId, cwd, expected, kind, … }`。`expected` 是用户**看着的**
那份状态（HEAD + index 摘要 + 工作区摘要），来自同一时刻读到的审查快照或
`yan:git:state` —— 不是渲染端自己另读一次。

**四条不能绕过的约束**：

1. **按仓库串行**（`repoId` = `.git` 共同目录，所以多个工作树共享同一把锁）。
   两个写操作并发跑 git 会撞 `index.lock`，而那种失败信息对用户毫无意义。
2. **执行前复核预期版本，但分级**：
   - `commit` 全比三件套 —— 它是唯一会把用户**没看过**的内容写进历史的动作，
     `indexDigest`（`ls-files -s` 的摘要）是唯一拦得住「内容被换了但状态码没变」的判据
   - 未指定起点的 `create-branch` 只看 HEAD（新分支从 HEAD 长出来）
   - 其余**不比**：暂存幂等，切分支 / 推送由 git 自己的检查兜住
     （脏工作区、非快进）。一律全比会造出假冲突（连点两个文件的暂存、
     提交后立刻推送都会被拒），而假冲突的代价是用户学会无视提示
3. **不覆盖用户改动**：不 `stash` / `reset` / `clean` / force push，
   **不跳过 hook**（不传 `--no-verify`）。脏工作区能不能切分支由 git 判，
   我们只把它的拒绝理由**原样转述**（`dirty-blocks-switch`）。
4. **超时后不无条件重试**：被杀之后重新读 HEAD，用实际状态说话
   （`committed` 字段）。推送超时则明说「结果未知，先看待推送数」。

**失败必须分类**（`GitFailureCode`）：身份未配置 / hook 拒绝 / 签名失败 /
lock / 冲突 / 认证失败 / 非快进 / 无上游 / 分支被占用 / 无首提交 / 无可提交 …
每类给人话 + **可执行的下一步** + `retrySafe` + **git 的原始输出**（可折叠）。
分类不中就如实说 `unknown`，**不编原因**。

⚠️ **hook 拒绝只透传 hook 自己的输出**（2026-09-18 实测：hook 里 echo 一句 +
exit 1，git 的 stderr 就是那一句，没有任何前缀）。所以分类不中时要去查
「这个仓库到底有没有 `pre-commit` / `commit-msg` 文件」再下判断 ——
依据是**事实**，message 里也说「很可能是它」。

**切换分支前的运行任务阻断在主进程侧**（`configureWriteContext({ hasRunningTask })`
由 `index.ts` 注入 runner 状态）：界面路径可以被绕过，主进程是最后一道。
判据是「该 cwd 有 `running` 的 runner」——**别的进程**（终端里的 git、编辑器）
不受我们控制，只能由 git 的 lock 与检查兜住。

**「提交并推送」是两个有结果记录的步骤**：提交成功、推送失败时**保留提交**，
重试只重试推送。推送的 `expected` 用的是提交**之后**的 HEAD（继续用提交前的
会被正确地拒成 stale —— 那正是复核在起作用的证据）。

### 2.16 用户工作树（方案 §6.2，W1）

```
环境菜单「工作树」→ yan:git:worktrees / worktreeCreate / worktreeRemove
                     └── main/git-worktree.ts
```

⚠️ **与子代理隔离工作树不是一回事**（改动前先看这一段）：

| | 子代理（`subagent-isolation.ts`） | 用户（`git-worktree.ts`） |
|---|---|---|
| 位置 | 系统临时目录 `mkdtemp` | 仓库旁边的 `<仓库名>-worktrees/<分支 slug>` |
| 分支 | `--detach`（不占分支名） | 新建分支（用户要能提交推送） |
| 清理 | `worktree remove --force` + `rm -rf`（`cleanupWorkspace()`） | 先查三项、`worktree remove` **不带 force** |
| 生命周期 | 一次任务 | 用户长期使用，关掉应用还在 |

**创建**：起点（默认 HEAD，所以**未提交改动不会带过去** —— 这一点会在返回的
notes 里明说）+ 新分支名 + 目标目录（默认在仓库旁边；**不能放在仓库内部**，
那会变成未跟踪文件、还可能被下一次 `git add -A` 收进去）。分支已存在时
**不静默复用**（用户输入的是新分支名）。

**删除的三类拦截**（任一命中就拒绝，并把原因**逐条**列出；我们不替用户
stash / 提交 / 丢弃）：未提交改动（带文件数）、未推送提交（**没有上游时明说
「无法判断」**，不假定已推）、该工作树里有任务在跑。另外主工作树、被 git
`locked` 的、以及**不在 `worktree list` 里的路径**一律拒绝 —— 最后一条是
安全边界，否则这个接口就成了「用任意路径删目录」。

**携带未提交改动（W2a）**：三份内容**分开**带 —— 已暂存的在新工作树里仍然已暂存
（用户是一行行挑出来的，混进工作区等于让他重挑一遍）、未暂存的仍然未暂存、未跟踪的按勾选。
实现是 patch（`git diff --binary` + `git apply`）而不是复制目录：复制会把「哪些改动属于这次
迁移」丢掉，而且带不了可执行位与「已暂存」这种状态。

⚠️ 三个不显然的点（都踩过）：
1. **已暂存的 patch 要应用两次**：`git apply --cached` 只改 index，工作区文件还停在 HEAD 版 ——
   于是目标里凭空多出一个「未暂存改动」（把 index 的新内容改回去）。正确做法是 `--cached`
   之后再不带 `--cached` 应用一次；**顺序不能反**（工作区那条按工作区当前内容匹配前置）。
2. **收集必须在建工作树之前**：源仓库此刻的状态才是用户刚看到的那一份。
3. **起点必须是当前 HEAD**：patch 是相对 HEAD 算的，换基线语义不成立（显式给了起点就拒绝）。
   冲突 / 子模块（gitlink 160000）/ 勾选项已过期 → 拒绝并解释，**不退化成全目录复制**。
   应用失败整个回滚（`worktree remove --force` + `branch -D`）—— 那两处 `--force` 是
   失败路径上清理**我们自己刚建的**东西，别复制到别处。
源仓库全程只有 `git diff` / `ls-files` 三条只读命令 —— 不用 `git stash`（它会改源仓库的
index 与工作区，等于替用户做了决定）。

**在新工作树开新会话（W2b）**：方案 §6.3 明确允许的**降级路径**。完整的「带会话继续」要重绑定
项目权限、相对文件路径、附件授权与上下文派生状态 —— 这些没有一件能靠改一个 `cwd` 字段完成，
所以这里只做「换目录 + 开新会话」，并把「不带走什么」写在按钮 title 与区块说明里。

**`-z` 的坑**：`git worktree list --porcelain -z` 是**每一行**以 NUL 结尾
（字段之间也是 NUL），不是「记录之间 NUL、记录内部换行」。按后者解析会让
`branch` 永远是 null。`parseWorktreeList` 与 `git-service.ts` 的
`busyBranches` 都按「外层 NUL、内层再按换行切」处理，两种写法都能吃。

### 2.17 外部链接（方案 §6.4 / §7）

```
环境菜单 → yan:git:remoteWeb          （只读：remote 地址 → 托管网页地址）
         → yan:browser:open           （在内置浏览器打开）
         → components/review/SourceLinks.tsx（关联外部任务，存 localStorage）
```

**纯解析在 `shared/git.ts`**（`remoteWebUrl` / `compareWebUrl`，能单测）：认 scp、`ssh://`、
https 三种写法；**只认 github / gitlab / bitbucket** —— 自建服务的网页路径各不相同，猜一个
等于给用户一个 404，所以认不出就返回 null、界面**不显示**那一项。三家托管站的 compare
路径也不同（Bitbucket 的顺序与我们相反：`新..旧`）。`C:oo` 长得和 scp 写法一样，要显式排除。

**关联外部任务链接**（§6.4）：只做三件事 —— 存下 URL 与标题、列出来、打开网页。文案是
**硬要求**：「不会上传代码、不会同步会话、不会远程执行」。存本地、按会话隔离（与
「已查看」标记同样的做法）；不做跨设备同步，因为那要先有账号体系，而我们不显示虚假的
登录 / 同步状态。

**额度**（§6.5）：`providerQuota` 只认供应商权威字段，失败时保留上一次成功的快照，切 provider
清掉旧账户的数字，**不用**上下文剩余量推算账户额度。唯一一处**推算**是 Command Code 的月度上限
（接口没有官方月额度字段，用 `weekly.cap × 2` 反推并标 `estimated`，见 §2.10）—— 推算只允许用在
「供应商自己给的窗口上限能推出总量」这种地方，且界面必须如实标出来。

### 2.18 附件与来源（现状，S1 的前置事实）

⚠️ **现有附件链不持久化**：`Attachment`（`shared/ipc.ts`）是**渲染端 store 的临时状态** ——
图片是内存里的 base64（`data` / `preview`），文件引用**只存绝对路径**（`kind: file` +
`path`），没有内容副本、也没有授权记录。

**2026-09-18 更新：持久化已实现（见 §2.20）** —— 图片会写到
`<数据目录>/sources/<会话>/`，文件引用只登记路径 + 指纹。下面这段是当时的核查结论，
保留它是为了说明**为什么**当初要先做这一步：

主进程把附件写到
数据目录（建议 `<数据目录>/sources/<sessionId>/<内容哈希>.<ext>`）并返回引用 + 内容指纹，
否则「来源」列表里的东西在重启后就是一堆死路径。方案对此有明确要求：「不能只保存会被
清理的临时路径」。

### 2.19 pi 插件包管理（方案 §9 的 P2）

```
设置「插件」tab → yan:packages:list / yan:packages:action
                   └── main/packages.ts（唯一会改用户 pi 目录的地方）
```

**机制是实测的，不是猜的**：pi 自己有 `install` / `remove` / `update` / `list` / `config`，
`-l` 是项目作用域；已装包的真源是 **settings.json 的 `packages` 字符串数组**；
agent 目录的环境变量是 **`PI_CODING_AGENT_DIR`**（Yan 已在 `agent.ts` 传它）。

⚠️ **本地路径源不复制**：装 `<root>/my-ext` 得到的是 `"..\\my-ext"` —— 一条**相对
agent 目录**的路径。所以：元信息要按 source 的形状解析（不能一律去
`npm/node_modules/<name>` 找）；**卸载/更新时要把路径形态的 source 转成绝对路径**
（`pi remove` 按 **cwd** 解析，与登记时的基准不是一个）。

三条边界：**不直接改生成的 pi-runtime**（只让 pi 自己的 CLI 动手）；作用域跟着
`PI_AGENT_DIR` 走（不拼 `~/.pi/agent`）；扩展**会执行代码**，界面上说明来源与
实际影响，通用 pi 包**不做 OS 沙箱**。独立 Skill 文件接入另经
`src/shared/skill-security.ts` 做静态恶意内容审查：高风险 fail-closed，中风险保留提醒；
这不是对包 / 服务器的运行时沙箱，也不会因为用户指定来源而跳过。带有
`pi.skills` 的 `pi-package` 还会在离线 smoke 和已安装包 active 复核前走同一审查器；
已知 high 风险或审查截断均 fail-closed。

参数注入：以 `-` 开头的 source 在发起前就被拒（否则渲染端等于间接控制命令行）。
有任务在跑时直接拒绝改包（扩展是启动时加载的，现在动手没有即时效果）。

### 2.20 会话来源（方案 §8 的 S1）

```
yan:sources:list / addImage / verifyFiles / removeImage / readImage / link / webSearch
  └── main/sources.ts      图片副本落在 <YAN_DATA_DIR>/sources/<会话>/
  │                        「来源 ↔ 消息」的关联落在同目录的 links.json
  └── components/review/SourceMenu.tsx   环境菜单里的「来源」
```

**「定位消息」（实施-07 S3）**：来源菜单里能从一条来源跳到它参与过的那条消息。
关联**不在会话 JSONL 里**，而是每会话一张 `links.json`（与图片副本同目录、同生命周期）——
与「任务日志不写进会话 JSONL」同一条理由：pi 写的文件和砚补的字段不能混在一起。

建立时机是**发送之后**：发送时把附件换算成来源 id 排队（图片 = 内容指纹，渲染端自己算；
文件 = 主进程复核时给的 id；网页不进附件流），等 pi 写出那条 user 条目、渲染端收到
`msg-add` 时把队首那批绑上去。之所以要排队：**消息 id 在发送那一刻还不存在**。
绑定幂等（同一对不堆第二条），形状不对的 id 只记进 `skipped` 而不让整批失败。
跳转是命令式的：按 `[data-msg-id="…"]` 找节点 → `scrollIntoView` → 加 1.8 秒的高亮 class
（只回答「跳到了哪」，不留选中态）。

**网页搜索入口（实施-07 S4）**：方案对网页搜索的硬条件是「只在已发现兼容搜索能力时
启用」且**不自造私有搜索后端**。所以这里的产物是**发现 + 如实暴露**：
`shared/web-search.ts` 从能力目录里认一条搜索能力（**只看外部接入的 MCP 工具 / 已装 Skill**
—— 内置的 `knowledge.search` 是项目知识检索，算进来入口会在每台机器上都出现），
`yan:sources:webSearch` 把这个判定结果交给界面，菜单据此**有则出现、无则隐藏**。
命中时那枚入口只把一段草稿**注入输入框**（能力名 + 调用形状 + 关键词），
不代发、也不执行 —— 执行能力是模型的事。往输入框注入走 `store.injectComposerText`：
外部写 `setSessionDraft` 对当前输入框不可见（草稿只在切会话时同步一次）。

**三类来源的存在方式不同，这决定了实现**：

| 类 | 我们持有字节吗 | 所以 |
|---|---|---|
| 图片 | **持有**（写到数据目录） | 能显示缩略图、能真的删掉副本 |
| 文件 | **不持有**（只登记路径 + `size:mtime` 指纹） | 只能报告「还在不在」，**永不删原文件** |
| 网页 | 不持有（URL + 标题） | 只负责打开 |

⚠️ **图片文件名就是内容 sha256 的前 32 位** —— 同内容重复粘贴不会堆第二份，
「这份东西还是原来那份吗」也不需要额外记账。

⚠️ **会话 id 会被当成目录名拼进路径**，所以只取安全字符（挡的是路径穿越，
不是洁癖）。`removeImage` / `readImage` 的 id 形状也要校验，并且拼出来的路径
必须仍在 `sources/` 里 —— 文件引用（`file:` 前缀）一律拒绝，因为那意味着
「删用户的原文件」。

**只显示两态**：「已关联」+ 可核实的「不可用（原因）」。方案 §8 明确
「证据不足时不显示后一状态」，所以「已读取」「本轮已参与上下文」都不显示 ——
宁可少显示一个状态，也不显示一个我们证明不了的状态。

**移除的语义**：图片连副本一起删，文件与网页只删登记；**不改写已发送的历史**。

### 2.21 PR 状态（方案 §7 的 G3）

```
yan:git:prStatus → main/hosting.ts
  ├── 远端地址 → owner/repo（复用 shared/git.ts 的 remoteWebUrl）
  ├── GitHub REST API: /pulls?head={owner}:{branch}&state=all
  └── /commits/{head.sha}/check-runs → 检查三态
```

**为什么不用 gh（GitHub CLI）**：方案原文是「可先采用 GitHub CLI……后续再评估直接 API」。
实测本机没有装 gh，而 Yan 自己能发请求 —— 直接调 API 少一层外部依赖。token 只从
环境变量（GITHUB_TOKEN / GH_TOKEN）读：**不落盘、不进设置**，也不去翻 ~/.config/gh。
没有 token 时匿名读公开仓库（实测余量 60/小时够用），私有仓库会 404/403 —— 那时
显示「需要认证」，**不编状态**。

⚠️ **关联依据是 head/base 的实际信息**（方案 §7 的硬要求）：查询用
`head={远端 owner}:{分支}`，带 owner 才能正确处理 **fork**；再把 PR 的 `head.sha` 与
**本地** head 比一次，不一致就说「本地有未推送的提交」（那正是此刻最该知道的事）。
「不能仅按同名分支猜测」指的是**只看分支名** —— 那样 fork 场景会认错人。

**状态映射里的两个优先级**（都写了断言，因为反过来就是错的）：
`merged_at` 优先于 `closed`（合并的 PR 状态也是 closed）、`draft` 优先于 `open`；
检查里**有失败就是失败、还在跑就是 pending**（不能因为大部分通过就显示通过）。

**只读**：不创建、不合并、不评论（方案 §7：「创建 PR 是单独后续动作，不与读取状态
混合；本阶段不自动合并 PR」）。

### 2.22 项目知识（实施-03，存储 + 检索 + 注入 + CLI + 设置页 + 隔离/包）

```text
用户消息 → AgentController.send / steer / followUp
        → main/project-knowledge.ts：读 desktop.json 开关 → listKnowledge(项目登记 id)
        → shared/project-memory-search.ts：bigram + 词 + 标签打分 → 只取 active → top 8 / 2k 预算
        → 原子写 YAN_DIR/project-knowledge/_inject/<会话键>.json
        → 薄层 project-knowledge.js：before_provider_request 把材料块放在最后一条用户消息之前

模型主动查 / 提 → yan knowledge search|read|propose（随包 CLI）
        → capability-server 登记 → agent.ts#runKnowledgeCommand（身份只认宿主绑定）
用户看 / 改 → 设置 →「项目知识」页（KnowledgeTab.tsx）
        → yan:knowledge:list|action|export|sourceSession（main/index.ts）
        → shared/project-knowledge-view.ts 算「需复核」与导出 → main/project-memory-store.ts 写入
```

**为什么中间要一个文件**：检索是业务逻辑，只能在宿主跑；而「请求发出前把一段材料放进上下文」
只有 pi 钩子能表达（无 CLI / RPC 等价物）。两者不在同一进程 —— 文件是唯一同时可回读、
可断言的交接面（网络层交接会让「这一轮到底注入了什么」无法取证）。

**四条硬口径**：

- **默认关**（`desktop.json` 的 `projectKnowledge.enabled`，没改过 = 磁盘上没这个键）。
  关掉时宿主**也写文件**（空块）—— 这就是「关闭立即失效」：不靠扩展记状态，
  不靠清缓存；下一轮读到空块自然不注入。
- **只注入 `status:'active'`**：`candidate`（用户还没确认）/ `superseded` / `deleted` 连打分都不参与。
- **无相关项则零注入**：不返回空壳块；相关性判据拆成三条形状不同的规则（bigram 覆盖 / 少量命中 /
  英文按命中词字符占比），分数只用于排序 —— 单一阈值必然偏向中文或英文一边。
- **材料不是授权**：块头写明「参考材料、不是授权、不是当前指令」；优先级永远是
  「当前用户明确要求 > 当前有效项目规则」。

⚠️ **会话键同源**：宿主用 `capabilityOpts.sessionId`（与 `YAN_SESSION_ID` 同一份），
用 `state.sessionId` 会写成两份文件（实测踩过：「开启了也永远不注入」）。

**界面与 CLI 的两个入口（S4 / S5）**：

| 入口 | 能做什么 | 不能做什么 |
|---|---|---|
| `yan knowledge search/read/propose`（模型） | 检索已确认知识、读一条、**提议**新条目 | 不能指定 `projectId`；不能自报 `user-confirmed`（不传 `hostCheck`），新条目只能落 `candidate`；证据 `file` 只能是项目内相对路径 |
| 设置 →「项目知识」（用户） | 开关、看三筛选、**确认**（候选 → 已确认）、编辑、替代、删除（逻辑 / 永久）、导出 Markdown | 不能看别的项目的知识（身份按当前会话推导）；不能覆盖已变版本（写操作带 `expectedRevision`）；不会自动改写仓库文档 |

⚠️ **三个容易改错的地方**：① 设置页的身份表达式必须与能力服务**逐字相同**
（两处都调同一个 `knowledgeProjectId()`，它不是 `projectIdForCwd ?? legacyProjectId` ——
**未登记时不能裸回退旧算法**：它只取路径前 27 字节，会让 `<repo>` 与 `<repo>-worktrees/feat`
共用一个 id，于是工作树读到主仓库的知识，违反实施-03 §4）；② 「需复核」是**每请求重算**的派生状态（分支 / 路径 / 来源会话），不要存进条目里；
③ 「确认」是唯一能把条目升为 `active` 的路径 —— 不要给它加一个「模型自证」的后门。

### 2.23 工作模式：标准 / 计划 / 自主（实施-05 S2；2026-09-22 快捷键改成全局 Ctrl+Tab）

```text
用户点菜单 / 按 Ctrl+Tab（可在设置里改键或关掉）→ App 的全局快捷键（window capture）→ Composer 的 WorkModePicker
        → store.setWorkMode → yan:setWorkMode(mode, expectedRevision)（main/index.ts）
        → WorkModeStore（YAN_DIR/work-modes.json）：CAS 提交 → revision+1
        → 写 YAN_DIR/work-mode/<runnerId>.json（扩展读的那份）+ 推 work-mode（带 runtime 封套）

模型侧 → `question.js`：`before_agent_start` 按模式注入提示；真正的交互经 `bash` 调宿主 `yan question ask`，自主模式由宿主返回结构化的“不提问”结果
```

**为什么是会话级、不是全局开关**：旧实现是一个布尔 `desktop.json.autonomous` ——
A 会话切自主会连带改变 B 会话的提问行为。现在按会话存，界面只投影当前会话的那份。
旧布尔仍是**迁移输入**（新字段优先，幂等）：`migrateLegacyAutonomous`。

**存储键是会话文件路径，不是 `state.sessionId`** —— 这是真实验链路抽出来的：
同一份会话文件切走再切回，pi 报回的 sessionId 会变（文件没变），拿它作键会
让用户刚设的模式当场丢回默认值。pi 给出文件名之前用 `pending:<runnerId>` 占位，
拿到后 `adopt()` 迁过去（迁移不算一次用户提交，revision 不变）。

**两份文件各管一段**：`work-modes.json` 是宿主的存储（按会话、带 revision）；
`work-mode/<runnerId>.json` 是给薄层扩展的**每实例快照**（扩展只能从 `YAN_SESSION_ID`
知道自己是哪个实例）。快照在推送 / 切换会话 / 提交时重写，所以「切回标准」下一轮就生效。

**界面与键位**（实施-05 §3）：菜单三档各带一句说明；`Tab` 循环（设置里可关；
补全菜单有候选、IME 组合态、长文模式一律让路）；`Shift+Tab` 仍是思考强度；
无补全时 `Esc` 从输入框把焦点送到模式按钮。自主档才有运行光带。

**S3 待接**：澄清档的「就绪后自动转标准并开工」是宿主验证的原子转移（§4），
当前只有提示与提问行为；「运行中切换只对下一轮生效」的 pending 标记也在那一片。
（→ 已接一部分，见 §2.24）

### 2.24 目标状态与澄清就绪转移（实施-05 S3a）

```text
模型（澄清档）→ bash → `yan goal ready --transition-id … --goal … --mode-revision …`
        → 能力服务（身份校验）→ index.ts 的 goalCapabilityHost
        → 校验（shared/goal.ts 纯函数：五栏 / 置信度 / revision 不过期）
        → GoalStore.commitReady（YAN_DIR/goals.json：**幂等记录先查** → 落盘）
        → WorkModeStore.set('standard') + pushWorkMode（快照 + 推送）
        → 回执里明说「本轮仍只读，下一轮开始执行」

模型（自主档）→ `yan goal report --phase …` → 校验 → 推进
                （completed 要证据、blocked 要原因、同一失败签名连续两次**强制** blocked）
界面（只读）→ yan:getGoal，一次往返拿到「目标 + 当前模式」
```

**门禁顺序**（[证据-05-S1](archive/evidence/证据-05-S1-钩子与安全点.md) 实验 1 定的）：
**工具表（主）→ `tool_call` block（兜底）→ 提示词（说明）**。
执行者是薄层 `resources/pi-extensions/work-mode.js` —— `setActiveTools` 只有扩展 API 有，
pi 的 RPC **没有**工具面（实测 `get_tools` / `set_active_tools` 都回 Unknown command）。
策略真源仍是宿主写的那份模式快照，扩展只执行。

**澄清档不能写文件 → 提交必须支持内联参数**。白名单 = `read/grep/find/ls`，另放行受限的宿主命令 `yan goal …` 与 `yan question ask …`；`question` 不再是模型工具，`context_recall` 仍是待收口的历史例外。
+ **受限的 bash**：只接受 `yan goal status|ready|report` 这一种形状，
且整条命令不得出现 shell 元字符（`;` `&&` `|` `>` 反引号 `$` 换行……）。
把 bash 完全拿掉，澄清档就永远提交不了（CLI 就得用 bash 敲）；完全放开就等于没门禁。

**为什么目标状态要单独一份文件**（`goals.json`，与 `work-modes.json` 分开）：
模式的写者是界面（低频、CAS 抗抢），目标的写者是模型（高频、要幂等记录）。
混在一份里会让模式那份承担两种并发语义。

**「恰好一次」靠什么**：`transitionId` / `reportId` 在 `commitReady` / `report` 里
**先于**校验被查——重放直接返回已提交结果。顺序不能反：重放时模式 revision
已经被**这次转移**改过了，先校验会让重试收到「模式已过期」，看起来像失败。

**跨轮自动续行（S3b）**：就绪转移后宿主写一份「待发续行」快照
（`YAN_DIR/goal-resume/<runnerId>.json`，与转移**同一次落盘**），薄层
`resources/pi-extensions/goal-resume.js` 在回合空闲时把它变成一条 **`custom` 角色**消息并
**触发一次回合**（`pi.sendMessage({customType,content,display},{triggerTurn:true})`）。

为什么这段只能在薄层：只有扩展 API 能发 `custom` 消息并触发回合，
RPC 面没有对应命令 —— 而 `custom` 角色正是「**这不是用户说的话**」的机器可判形式（§4）。

三道防护都落在实现里：① 唯一 `operationId`（就是 `transitionId`）；
② **消费幂等**（发之前先写 `goal-resume/<runnerId>.consumed.json`，崩溃后不盲发两次）；
③ **用户消息优先**（`message_end` 之后 1.8s 二次确认，期间用户又发话或又调工具就放弃）。
用户按停止或把档位改回非标准，则**撤销未发续行**（`yan:abort` / `yan:setWorkMode` 里清）。

**自主档「接着干」（S3c）**：这就是「给 agent 一个非常大的任务，让它自己规划完成」的那条链路 ——
自主档下模型每 `yan goal report` 一次（阶段还在 `planning/executing/verifying`），宿主就
`GoalStore.armContinue` 写一条 **`kind=continue`** 的续行（正文 = 当前阶段 + 未完成步骤 +
「不要问我，接着干」），薄层按 `kind` 发 `yan-goal-continue` 而不是 `yan-goal-ready`。
于是**用户只说一句话**，模型报完进展就能一轮轮被叫起来，直到 `completed` / `blocked`。

四个边界：① 上限 `AUTONOMOUS_CONTINUE_LIMIT = 8`（连续 —— 用户一旦发言 `yan:send` 就归零，
到上限只在 `goal.report` 回执里告知模型停下交代）；② 目标从没被报告过（`revision <= 0`）**不 arm**
—— 否则自主档里任何一场普通对话都会被无限叫醒；③ 目标进终态或用户停止时**同一次落盘**清掉未发续行
（否则它在完成后才发出去）；④ 只有自主档 arm（标准档用户在旁边，不该自己往下跑）。

**请求前预算门（S4）**：`context` 钩子改完消息之后、请求真的发出去之前，
扩展在 `before_provider_request` 里估算**这个请求体**（messages + 工具表 + 顶层 system），
按同一份预算公式判三档：`normal` / `soft`（≥ 工作集线 → `context` 钩子**跳过清扫收益门槛**
再清一次旧工具结果）/ `physical`（估算 + 输出预留 > 窗口 → `ctx.abort()` **不发送**，
并写一条 `yan-budget-abort` 会话留痕 + `request-budget-physical` 诊断）。

三条边界：① 公式的唯一真源仍是 `shared/context-policy.ts`，
扩展侧 `resources/pi-extensions/context-budget.js` 是它的 JS 副本（扩展不能 import TS），
**单测交叉校验两边逐项相等**；② `physical` 与 `emergency` **不是同一条线** ——
前者管「请求能不能发」，后者管「settled 后该不该压」，合并会把 pi 原生自动压缩一起废掉；
③ 判定是**估算**（4 字符/token 口径），physical 线留了完整输出预留当误差缓冲；
真实 usage 只用于校准，不当精确值。

**跨会话交接的计数与资格（S5a）**：`YAN_DIR/handoffs.json`（与模式 / 目标同一套键：会话文件路径）记
「本片段成功自动完整压缩了几次」—— 只计**完成且自动**的（`triggeredBy: policy` 或 pi 原生
`threshold` / `overflow`），手动 / 失败 / 取消 / declined 一律不计；`state` 推送会把 `lastCompaction`
重放很多遍，所以用**稳定键**去重（摘要条目 id，缺了就用「起止时间 + 原因」合成）。
到 2 次之后还要看四个条件（目标在推进 / 自主档 / 不忙）才谈得上交接，不满足时给**可读原因**。
交接包的**形状**（`shared/handoff.ts` 的 `HandoffPackage`）也已定稿：由**模型**写、宿主校验
（两栏必填、列表宽容读法、来源字段一律由宿主覆盖）。
**生成链路（S5b-2）与事务接线（S5b-3b）已完成；只剩界面接线（S5b-4）。**

**会话链：后台多段、前端一条（S5b-1）**：用户 2026-09-19 拍板 —— 后台确实切成两份
（两个 JSONL，各自是 pi 的会话），但砚把它们当**同一条会话**显示：侧栏只列一条
（代表 = 链上最后一段）、历史按段拼成一条连续时间线（不插可见分界）、发送永远发到当前活动段。
关系旁挂在 `YAN_DIR/session-chains.json`（`link(from, to, handoffId)`），**不改写任何 JSONL** ——
pi 的一个会话文件就是一个上下文窗口的账本，交接正是因为这段上下文该换了。
判定函数（`isRepresentative` / `planHistoryRead`）已在 `shared/session-chain.ts` 定下来，
**写侧（S5b-3b）与读侧（S5b-4）都已接线**：交接提交时写链；侧栏只列代表段、
历史由 `main/session-history.ts` 按段拼成一条时间线、删除按链整体处理。
**唯一没接的是导出 / 复制**（pi 的 `export_html` 与 fork 是单文件语义，本阶段如实记为限制）。

**交接包由模型写（S5b-2）**：§8 的包不是机械拼出来的 —— 它要写「用户目标是什么、
接到手先干什么」这类只有读过这段对话才说得清的东西。分工按「能落地宿主的就不留扩展」切：

- **宿主**：判资格（§7 四条；阈值可被测试通道覆盖）→ `renderHandoffPrompt` 渲染提示词
  → 写 `YAN_DIR/handoff-request/<runnerId>.json` → 轮询结果 → **三道闸门**
  （两个 id 对得上 / 原文能解析出 JSON / 清洗过两栏必填）→ 落盘 `handoffs.json`。
- **薄层** `resources/pi-extensions/handoffs.js`：在 `agent_settled` 时读请求，
  调一次 `ctx.modelRegistry.complete(...)`（无工具、60s 上限），把**原文**写回结果文件。
  虽然只有它调模型（RPC 没这个能力），但**提示词与校验都在宿**——
  「交接包该有哪些字段」只有一份真源。

三个实现细节值得记住：① **触发有两个时机**（压缩完成 / 回合结束）—— `goal report` 发生在回合
**中途**，那一刻实例是忙的，只靠压缩事件会让「先报告后压缩」的顺序漏掉；
② **解析要括号平衡扫描**（只取第一个完整对象）—— 「首尾截取」在模型多吐一句时会把两份内容
连起来、整份白白丢掉；③ **失败就是失败**：解析不过 / 缺两栏必填 → 丢掉并告知用户，
**不重试、不降级成半份包**（宁可重做，不要把半个任务交给新会话）。
只读 `yan:getHandoff`（`HandoffView`）给探针与界面用（S5b-3b 起还带 `transaction` / `autoCommit`）。

**交接事务：先写日志再动外部状态（S5b-3a）**：§8 的七个阶段现在是可执行的状态机
（`shared/handoff-transaction.ts`）。它的价值不在「怎么走」，而在**崩了怎么办**：
交接连着两个会话，失败的后果是「两边都在干活」或「两边都不干」——比「干脆没交接」更糟。
三条硬规则：① **不许跳步**（没有包不能 `validated`，没有目的会话不能 `committed`）；
② `resumed` 只能由**磁盘证据**（目的会话 JSONL 里那条 resume）置位，
发送与确认之间正是进程会死的窗口 —— `recoveryAction` 把这一格写成
「有证据 → 补记完成，无证据 → **重发一次**（消费去重挡住重复），更早阶段 → **回源**」；
③ 每一步**先落盘再动作**（`YAN_DIR/handoff-transactions.json`，按 `handoffId` 索引，
未终结的事务一条都不裁）。
接线（建目的会话 / `runners.ts` 同 cwd 租约 / 发 resume / `link` 会话链）是 S5b-3b ——
而 §7 明写「先完成真实长任务验证后再开启默认值」，所以**默认是否自动交接需要用户拍板**。

**前端一条会话的接线（S5b-4）**：口径定下来之后，真正需要改的**不是渲染组件**，
而是三个数据出口：

- **历史拼接**（`main/session-history.ts` 的 `readChainMessages`）：按 `planHistoryRead` 从旧到新读每段，
  拼成一条时间线；链上读不到的段**如实计入 `missing`**（用户少看一段历史必须能被发现），
  全部读不到才回退 `get_messages`。三个落点：`agent.ts` 的新注入口 `readHistory`
  （agent 不认识「链」——那是宿主的关系）、切会话时先铺内容的 `yan:peekSession`、安卓远程历史。
- **侧栏列表**（`yan:listSessions`）：只列代表段（`isRepresentative`），代表段没有标题时用**链首段**标题顶上；
  路径与 id 仍是代表段的（打开 / 发送都落在当前活动段）。
- **删除**（`yan:deleteSession`）：删整条链（多个撤销 token 用 `|` 拼给界面，`restoreSession` 逐个恢复），
  删完调 `SessionChainStore.forget()` —— 链记录留着会指向不存在的文件，侧栏会把另一段也藏起来。

**顺手修掉一条真缺陷（与本片无关）**：切会话时 `runners` 推送会把运行实例的**空缓存**投影上来，
把 `peekSession` 刚铺好的历史打回 0（用户看到闪一下空白，实测 `0→482→0→482`）。
修法是新 `projectSnapshotKeepingPeek`：缓存 `messages` 为空且界面正拿着 peek 内容时不覆盖 `messages`
（stats / todos / queue 照常投影），四处投影共用。**定性靠 A/B 反向验证**：
`YAN_NO_CHAIN_HISTORY=1` 关掉链感知后照样红，证与本片无关；修完 `historyswitch` 全绿。

**交接接线：先停源、再建目的（S5b-3b）**：事务的动作层现在真的跑起来了
（`shared/handoff-resume.ts` + `main/handoff-runner.ts`，依赖全注入所以能单测）。
顺序是与同 cwd 防线对齐的：**停源实例（释放租约）→ 同 cwd 建目的会话 → `setDestination` /
`destination-created` → 写会话链 → `committed` → 发一次 resume（发送**之前**记 attempt）→
等磁盘证据 → `resumed`**。四条不能破：① 两个忙实例不能共用物理 cwd，所以停源必须在建目的之前，
而且走的是与界面切会话**同一条路**（`runners.select`，不绕实例上限与 cwd 重建规则）；
② 链只在目的会话真的建出来之后写（链一写，侧栏就只显示代表段）；
③ `resumed` 只认**磁盘证据**（目的会话 JSONL 里那条 `[yan-handoff-resume:<id>]`）；
④ `resumeAttempts` 防「盲发两遍」（发送前记；恢复时 `>= 2` 次仍无证据就停下等人）。
失败一律**回源**（`failed` + 把视图交还源会话）；发送失败 / 证据未到**不记 failed**
（那样会把「其实已经发出去了」判死），留在 `committed` 等下次启动核对；
启动时 `recoverHandoffs()` 收尾所有未终结事务。
**自动交接默认开**（用户 2026-09-19 拍板；`YAN_HANDOFF_COMMIT=0` 关，解析在 `handoffCommitEnabled` 且有单测钉默认值）：
「打开」只是**允许**交接，实际仍要过四条资格（够数 / 目标在推进 / 自主档 / 不忙）。
恢复**不受开关影响** —— 磁盘上已有的未终结事务必须收尾。
**联调口径（S6）**：交接成功后 `inheritWorkMode` 把工作模式复制到目的段
（模式是「用户对这条会话的意图」，掉回默认档会让自主续接当场失效）；
而 **goal 不迁移**（§8：不能把旧总结升级成事实）——
改为在 resume 正文里要求模型「先 `yan goal status` 再 `yan goal report` 把目标重新登记
（新会话从 rev0 开始，不照搬进度）」。
三个只有在真链路里才会暴露的坑（已修）：事务查询必须**归一化**会话键（pi 给反斜杠、
调用方给正斜杠，不归一化就「刚交接完的会话查不到自己的事务」）；
`yan:getHandoff` 要**沿链回首段**取计数与包（否则交接一完成，界面上的数字当场归零）；
`SessionChainStore.link` 在「目的已属于另一条链」时返回**那条链**，
只看返回值非空会把「拒绝」当成功（前端会出现两条会话）。

**模型出错后的自动继续（S5c）**：用户报「有时候模型会报错」—— 界面停在一行红色的
「模型返回错误」，得自己再敲一句继续。pi 自己会就地重试几次（`auto_retry_start` /
`auto_retry_end`，可用 `yan:setAutoRetry` 关），用尽之后由砚这一层接手：
`agent.ts` 把错误**结构化**推出来（新推送通道 `agent-error`，来自
`auto_retry_end {success:false}` 的 `finalError` 或 assistant 的 `stopReason === 'error'`），
`index.ts` 用 `shared/auto-continue.ts` 分类并决定要不要再起一轮。

**为什么不能无脑重试**：429 重试照样 429（还可能把额度烧在空转上）、401/403 不换凭证永远不行、
上下文超限该走 S4 的预算门、用户已取消更不该自作主张 —— 这四类一律停手并说明原因。
可重试的按 3s / 10s / 30s 退避再起一轮，连续上限 3 次（计数落 `YAN_DIR/auto-continue.json`，
**重启不忘记**；用户发言 / 停止 / 一轮真的产出都归零）。
续行**复用 S3b/S3c 那条通道** —— 只是 `kind` 换成 `retry`、消息标签换成 `yan-auto-continue`，
所以「消费幂等 + 用户消息优先 + 不伪造用户消息」三道防护照旧；
正文里额外要求模型「上一轮可能已经产生副作用，先检查再动手」。

**剩下的尾巴**：控制消息在界面历史里还看不到（`session-reader` 只读 `type:"message"`）、
目标级「停止目标」没有界面入口、真实多轮模糊请求的逐步澄清未做场景、
自主续接（S3c）到上限时只有回执没有界面提示（上限也是常量、不可配置）、
**自动继续（S5c）默认开且没有界面开关**（上限 / 退避是常量，只靠 `YAN_AUTO_CONTINUE` 测试通道调）、
模型正常结束但**内容为空**（免费模型常见）不算错误、
预算档位在界面上看不到（只在诊断与会话留痕里）——
**跨会话交接（S5）全部完成**（S5a–S5b-4 + S6：计数 / 资格 / 模型写包 / 事务 /
建目的会话 / resume 与消费证据 / 侧栏代表段 / 历史拼接 / 删除按链 / 模式继承 / 包验收），
只剩两条如实登记的限制（导出 / 复制仍单段；自动交接没有界面开关）。
在那之前，超长任务仍是同一个会话里续，撞上下文预算由 S4 的硬闸门兜住。

## 修改前按需阅读

- 工作区规则：[AGENTS](../AGENTS.md)。
- 测试与证据：[TESTING](dev/TESTING.md)、[HANDOFF](dev/HANDOFF.md)。
- 实现陷阱：[MAINTENANCE](dev/MAINTENANCE.md)。
- 打包与用户数据：[RELEASING](dev/RELEASING.md)。
