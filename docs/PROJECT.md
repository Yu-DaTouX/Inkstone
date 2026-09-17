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
| 前后快照 | 写入类工具在执行前后各存一份，差异归属靠这个（`edit` 的参数只是替换片段，不等于 diff） | `main/snapshots.ts`（有单测） |
| 终端窗口 | 工具输出可调大小的窗口 | `chat/Terminal.tsx` |

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
| 主进程控制器 | `main/browser.ts` | 内嵌视图 + 外部 Chrome 代理标签，统一标签栏 / `activeMode` 路由；起一个只监听 127.0.0.1、带 token 的 loopback bridge |
| 底层 | `main/browser/` | `CDPBridge`（Electron 调试器）与 `RawCdp`（外部 Chrome 的 WebSocket）实现**同一个** `CdpChannel` 接口；`Observer` 出可交互元素表、`ElementRegistry` 管 ref、`InputController` 发输入、`BrowserPolicy` 拦高风险动作 |
| 原生视图 | 主进程持有 `WebContentsView` | **不是 iframe**，永远盖在渲染层之上 |
| UI | `components/browser/BrowserSurface.tsx` | 只画工具栏 + 把可见区域坐标同步给主进程 |
| pi 工具 | `resources/pi-extensions/browser.js` | 只访问 bridge，不碰 Electron 对象 |

**改动注意点**

- **坐标必须乘 `win.webContents.getZoomFactor()`**，否则非 100% 缩放下内置浏览器位置会偏。
- 抽 `CdpChannel` 接口的理由：内嵌用 Electron debugger，本机 Chrome 必须走原生 WebSocket，两者对上层必须一样。
- `RawCdp` 之外还有 `main/chrome.ts`（探测/启动本机 Chrome，独立 `--user-data-dir` + 调试端口）和 `main/chrome-profile.ts`（把真实 Chrome 的登录态与历史导入托管 profile）。

### 2.9 子代理

**怎么实现的**：自有的进程管理适配（不装上游扩展）——每个子代理跑一个 `pi --mode rpc`，带并发上限、超时、停止、转录上限，用量不重复计入；**写入隔离**用独立 git worktree（从当前 HEAD 建），差异先汇总、用户确认后再 apply。

**涉及文件**：`main/subagents.ts`、`main/subagent-isolation.ts`（有单测）、`chat/SubagentList.tsx`、`toolbar/SubagentPreview.tsx`。

**改动注意点**：隔离模块只处理文件系统 / Git 边界，**不启动 pi**，也不把差异正文推到渲染端。

### 2.10 凭证、额度与登录

| 做什么 | 怎么实现的 | 涉及文件 |
|---|---|---|
| 写凭证 | 直接读写 pi 的 `auth.json`，让用户在桌面端就能配 key | `main/credentials.ts`（有单测） |
| ChatGPT 登录 | **桌面端自己发起 OAuth**，参数逐字对齐内置 pi（差一点 pi 就不认这个 token） | `main/oauth.ts` |
| 额度 | 取额度必须用 **Electron 的 `net.fetch`**，不能用全局 `fetch` | `main/quota.ts` |

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
| 随包资源 | `extraResources`：`resources/pi-runtime/{dist,node_modules,package.json}` + `resources/pi-extensions` |
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
| 阶段 4 · 生成器（S7，2026-09-17） | 阶段 4 的**执行层**已交付（N21-4 / S2–S6，2026-09-17）：内置扩展 `resources/pi-extensions/context.js` 做 Tool Sweep（旧工具输出 → 墓碑 + `ctx://` 引用）、Task State 前置注入、`context_recall`（预算 / TTL / 审计）、结构化压缩接管闸门（按 **freshness 分档**：完全一致最好、“有效但较早”也接并标 stale、对不上才降级回 pi 摘要；`buildStructuredSummary` 的 `requiredFields` 默认空数组，不再要求六类字段齐备）。**默认清扫 + 可召回墓碑 + 压缩**（`kinds` 默认含 `episode-fold`（2026-09-18 拍板，见方案 §17.5.7），2026-09-17 用户拍板：清理默认开但保留必要引用；墓碑带 `ctx://` 引用可 `context_recall` 取回，本回合正在动的文件不清扫）。**状态生成器（S7）已交付（2026-09-17）**：扩展在 `agent_settled` 上跑一次无工具 completion（`ctx.modelRegistry.complete()`）产出 TaskState 的**语义字段**，`files` / `commandsRun` / `testsRun` 由确定性 reducer 从真实工具调用里抄（落盘前**覆盖**模型返回的同名字段）；`revision` CAS 拦迟到结果；读时按 **freshness 分档**（gap 1–2 标 stale / 3–6 丢语义 / >6 不注入）。**2026-09-18 起在默认接管集里**（用户拍板）—— 但**不是每轮都跑**：会话级门槛与脏判定都还在，短会话照样不花钱；闸内还有 **`state.{generate,inject}` 两条分路**（`inject:false` = shadow 模式，**压缩接手也走这一路**）与一道**会话级 gate**（`foldEligible`：≥4 用户回合且转录 ≥48k，或本会话已经清扫过东西；命中后会话内 sticky）；注入块带 **authority 契约头**（`derived/authoritative/freshness/sourceHead` + 一句固定优先级），生成器输入会**自净掉** synthetic 内容（注入块 / 墓碑 / 召回正文），dirty 的「落后 ≥2」按**回合**而不是条目数算（见[归档 §1.11](archive/2026-09-17-已完成归档.md)）。证据见[方案 §17](design/方案-上下文工具内的自动压缩-2026-09-15.md)。**还缺**：`symbolsTouched`（需语言级解析）、20+ 回合压力测试（§12.11 第 10 条）。~~EpisodeState 的语义生成~~ **已完成（2026-09-18，默认关 + shadow）**：边界用 `episodeWindow` 的**确定性规则**算（`recentTail` 窗口之外 + 上一版 Episode 的终点，扇叠只会向前推进），收束由模型的 `unresolved` 判（非空即不扇叠），生成后**只落盘、不消费**（进不进压缩摘要由 `buildStructuredSummary` 的 `includeEpisodes` 控制）；`state.{episodeGenerate,episodeInject}` 两道门**都默认关**——实测在提示词里多要一个嵌套对象会拉低整次生成（含 TaskState）的成功率；~~增量 delta~~ 已决策不做（方案 §18）；~~三阶段独立 Rearm/Cooldown~~ **已完成（2026-09-18）**：新纯函数模块 `resources/pi-extensions/context-stage-runtime.js`，`sweep` / `fold` 各持一份会话级运行状态（sweep 只留痕、不上锁；fold 在**模型调用之前**判上膛与冷却，成功与失败都上锁，由 5 分钟重试窗口节流）；~~`episode-fold` 是否进默认接管集~~ —— **已拍板进（2026-09-18）**。证据见[方案 §15](design/方案-上下文工具内的自动压缩-2026-09-15.md) |
| 阶段 4 契约 | 提点审核（2026-09-16）把阶段 4 的开工契约定在方案 §12：原子上下文单元与 `recentTail` 切割、`EpisodeState` / `CodingState` 两个 schema、禁止递归摘要、Recall 独立预算与生命周期、每阶段独立的上膛/冷却/收益门槛、失败退回 pi 原生行为 |

**改动注意点**

- 阶段参数已可在设置面板改（N21-7：用户级 + 模型/供应商级），但 **`YAN_CONTEXT_POLICY` 仍是最高优先级的测试通道** —— 它被用户设置盖掉会让 `contexttakeover` / `contextswitchguard` 这类场景静默失效。
- 界面上的工作集数字必须来自主进程推送的那份预算（`SessionState.contextPolicy`）—— 渲染端不许自己再算一遍（这一块出过 D21/D22 那类“界面数字 ≠ 实际生效值”的错）。
- 策略**默认开启**：这意味着 1M 窗口的模型也会在 240k 左右压缩，而不是等到近百万。要关掉就是关「自动压缩」那个开关。

---


## 修改前按需阅读

- 工作区规则：[AGENTS](../AGENTS.md)。
- 测试与证据：[TESTING](dev/TESTING.md)、[HANDOFF](dev/HANDOFF.md)。
- 实现陷阱：[MAINTENANCE](dev/MAINTENANCE.md)。
- 打包与用户数据：[RELEASING](dev/RELEASING.md)。
