# 代码地图 · 砚（Yan）

> **定位**：文件级的「谁负责什么、和谁联动」。
> **反方向**（功能 → 实现方式 → 涉及文件）见 [docs/PROJECT.md](../PROJECT.md)。
> 目录级导航见 [WORKSPACE.md](../WORKSPACE.md)；当前决定与待办见 [HANDOFF.md](HANDOFF.md)；
> 设计令牌见 [DESIGN.md](../design/DESIGN.md)；测试约定见 [TESTING.md](TESTING.md)。
>
> 规模（2026-09-17，仅用于定位，不作为验收指标）：`src/` 124 文件、`scripts/` 162 文件、
> `resources/pi-extensions/` 5 个扩展源码文件。具体职责以本文各节和当前源码为准。

---

## 0. 五分钟版：一次对话的数据怎么流

```
用户敲字
  └─ Composer.tsx（输入区，四种模式：prompt / bash / 命令 / 引用）
       └─ store 动作（send / setSessionDraft / …）        src/renderer/src/state/store.ts
            └─ window.yan.*（白名单桥）                    src/preload/index.ts
                 └─ ipcMain.handle('yan:*')                 src/main/index.ts
                      └─ RunnerRegistry.select(…)           src/main/runners.ts
                           └─ AgentController              src/main/agent.ts
                                └─ PiRpc.command(...)      src/main/protocol.ts
                                     └─ pi 子进程（--mode rpc，JSONL）

pi 吐事件
  └─ protocol.ts 收行 → agent.ts 事件循环
       └─ normalize.ts 归一化成 MainPush                    src/main/normalize.ts
            └─ pushFrom(runnerId, msg)   ← 附 RuntimeEnvelope 身份（sessionId/runId/generation）
                 └─ store.applyPush(msg) ← 身份闸门：非当前实例只进缓存
                      └─ session-runtime.ts 归并             src/renderer/src/state/session-runtime.ts
                           └─ 顶层投影（session / messages / …）→ 组件订阅渲染
```

**一句话**：pi 的协议只在 `agent.ts` / `normalize.ts` / `protocol.ts` 三个文件里被认识；
往外全是 `MainPush` 补丁；界面只做「订阅 + 投影」。

> **§11 是跑起来实测的数据**（真实窗口 dump），用于核对本章的关系有没有漂移。
> 上面这些字段名/归属关系，凡是与 §11 冲突的，以 §11 为准。

---

## 1. 层次与依赖边界

| 层 | 目录 | 允许依赖 | **禁止** |
|---|---|---|---|
| 契约 | `src/shared/` | 无（纯类型 + 纯函数） | `main` / `renderer` / `electron` |
| 桥 | `src/preload/` | `shared` 的类型 | 不 import 主进程实现，只 `ipcRenderer.invoke/send` |
| 主进程 | `src/main/` | `shared`、`electron`、`node:*` | `renderer` |
| 界面 | `src/renderer/src/` | `shared`、`window.yan` | **直接 import `src/main/*`** |

已校验（2026-09-15）：`shared` 不依赖上层；`renderer` 不 import `main`；`preload` 不 import `renderer`。

`renderer` 对契约层的依赖面（实测次数）：`shared/ipc` 22 次、`shared/turns` 4 次、`shared/links` 1 次、`shared/rail-order` 1 次（N01 侧栏顺序，只被 `Rail.tsx` 用）。

---

## 2. `src/shared/` —— 契约层

两边都 import，所以这里的任何改动都是**跨进程**改动。

| 文件 | 行 | 功能 | 联动 |
|---|---|---|---|
| `ipc.ts` | 2168 | 主进程 ↔ 渲染进程的**全部**共享类型与常量：`MainPush`、`SessionState`、`RuntimeEnvelope`、`YanBridge`、`AppSettings`、工具分区、面板宽度夹取…（Git 审查的类型不在这里，从 `./git` 转发，见下行） | **被 44 个文件 import**，是全仓第一枢纽。改它必然牵动 `preload/index.ts`（桥）与 `store.ts`（消费） |
| `git-actions.ts` | 604 | **Git 写操作的共享契约 + 纯逻辑（方案 G2）**：请求 / 结果类型、失败分类（把 git 的 stderr 变成「身份未配置 / hook / lock / 非快进…」+ 可执行提示 + `retrySafe`）、提交说明与分支名校验、命令参数构造（`--` 终止符、无首提交绕开 `HEAD`）、长度前缀的版本摘要。**零 IO**，所以能被单测直接喂字符串 | `main/git-actions.ts`、`components/review/*`；单测 `test-git-actions.mjs` |
| `git.ts` | 987 | **Git 审查的共享类型 + 纯解析（方案 G1）**：范围 → git 参数的映射、`status --porcelain=v2 -z` / `diff --raw -z` / `--numstat -z` / unified diff 的结构化解析、内容形态判定、未修改区的行号区间、已查看的键。**不做任何 IO**（渲染端也要 import），所以能在没有 Electron 的环境下被单测 | `main/git-service.ts`、`main/git-diff.ts`、`components/review/*`；单测 `test-git-review.mjs`（124 条） |
| `turns.ts` | 357 | 把扁平 `UIMessage[]` 折成「一轮一块」；附带 `cacheHitRate`、段落切分 | `TurnView.tsx`、`UsageBar.tsx`、`ConversationOutline.tsx`；有单测 `test-turns.mjs` |
| `model-capabilities.ts` | 95 | 归一化 pi 的模型描述符：缺失字段一律 `unknown`，**绝不因为字段缺失就判成 unsupported** | `agent.ts`（`setStateFrom`）、`Pickers.tsx`；单测 `test-model-capabilities.mjs` |
| `links.ts` | 123 | 链接路由：内部浏览器打开 / 文件预览 / 拒绝（非法协议、路径穿越、可执行文件） | 安全判断，纯函数；单测 `test-links.mjs` |
| `context-state.ts` | 1280 | **上下文状态的 schema 与校验（N21-4 / S1，纯函数）**：`TaskState`（= 方案 §12.8 的 `CodingState`，`StateEntry` 带 `status` active/resolved/superseded + `source` provenance）、`EpisodeState`（`sourceRange` 指回**原始** entry，§12.7 禁止递归摘要的判据）、`ArchiveEntry`（`recallable` 三态 + TTL + 元数据）、`SourceWatermark`（`entryCount` + `lastEntryId`）、`ContextStateFile` / `ArchiveFile` 信封（`schemaVersion`）、Deep Context artifact 的**注入闸门** `deepContextUsable`（水位/会话/过期三重校验，本切片不产生模型调用）。三条硬约束写在文件头：派生物可丢、provenance 只能指 raw entry identity、禁止递归摘要 | 落盘在 `main/context-state-store.ts`，水位在 `main/context-watermark.ts`；单测 `test-context-state.mjs`（78 条）；[方案 §14](../design/方案-上下文工具内的自动压缩-2026-09-15.md) |

---

## 3. `src/preload/` —— 白名单桥

| 文件 | 行 | 功能 | 联动 |
|---|---|---|---|
| `index.ts` | 284 | 用 `contextBridge` 暴露 `window.yan`；渲染进程全程 `nodeIntegration:false` + `contextIsolation:true`。类型来自 `shared/ipc.ts` 的 `YanBridge` | 每一处 `window.yan.xxx()` 都到这里。**新增 IPC 必须三处同步**：此处、`shared/ipc.ts` 的 `YanBridge`、`main/index.ts` 的 handler |

---

## 4. `src/main/` —— 主进程（50 个 `.ts`，含 `browser/` 子目录）

### 4.1 入口与生命周期

| 文件 | 行 | 功能 | 联动 |
|---|---|---|---|
| `index.ts` | 1947 | 窗口 + **全部 IPC handler** + Runner 生命周期 + 托盘 + 缩放 + 快捷键 + 探针注入（`YAN_PROBE`）。文件树/补全/搜索共用的上下文边界是 `resolveFileContext` | 依赖除 `browser/*` 外几乎所有 main 模块。新增功能通常在此注册 handler |
| `paths.ts` | 49 | 数据路径常量：`YAN_DIR`、`PI_AGENT_DIR`、便携版根… | 被 10 个文件 import。**这里曾经叫 `memory.ts`**（记忆系统），已移除 |
| `settings.ts` | 408 | 桌面端专属设置（窗口、主题、语言、cwd、栏宽、工具顺序、**上下文策略覆盖** `contextPolicy` / `contextPolicyByModel`）。**刻意不写 pi 的 `settings.json`** | `index.ts`、`Rail.tsx`、`Settings.tsx`；项目 id 派生在 `project-id.ts` |
| `project-id.ts` | 45 | 项目 id 派生：沿用旧的 36 字符 base64 前缀（已有归属键不动），**碰撞时**换成整条路径的 sha1（D14：同前缀目录曾共用 id，导致文件树/@ 补全报「项目与工作目录不匹配」） | `settings.ts`（生成项目）、`index.ts` 的 `resolveFileContext`；单测 `test-project-id.mjs` |
| `queue-items.ts` | 54 | 队列快照的消费/回收规则（D9）：`consumeQueuedItem` 按原文摘掉队首匹配项（先 steering 后 followUp、FIFO、trim 比较）、`reclaimedTexts` 把 `clear_queue` 的结果按 steering→followUp 拼回草稿 | `agent.ts`（收到 user 消息、`abort()`）；单测 `test-queue-items.mjs`（18 条） |
| `runners.ts` | 440 | **会话运行实例注册表（N12）**：命中已有实例 / 复用空闲 / 新建；`RUNNER_LIMIT=3`；`stopOne` / `stopByCwd` / `stopAll`；`runtimeOf` 生成事件身份封套。**跨 cwd 复用要换进程**（pi 的 cwd 只在 spawn 时确定）。`busy()` 包含**直执行 shell**（D20：否则切换会复用到正在跑命令的实例，新会话直接报“已有一条命令在跑”） | 被 `index.ts` 全面使用；单测 `test-runners.mjs`（含跨项目换进程、失败回退、直执行 shell 也算忙） |
| `exit-snapshot.ts` | 61 | 退出时只存**运行实例元数据**（不复制消息正文） | `index.ts` 退出流程；单测 `test-exit-snapshot.mjs` |
| `zoom.ts` / `zoom-math.ts` | 105 / 115 | 界面缩放。**计算与 electron 分离**：`zoom-math` 不 import electron，所以能单测 | `index.ts`、`Settings.tsx`；单测 `test-zoom.mjs` |
| `browser/network-boundary.ts` | 60 | 内置浏览器的网络边界判定（纯函数）：内网地址只允许「用户/agent 明确要求的顶层导航」放行（本地预览），DNS 重绑定一律拦，link-local（云 metadata）连明确要求也不放行。**发起方取已提交文档**，不取导航发起时乐观写入的期望值（D24） | `browser.ts` 的 `onBeforeRequest`；单测 `test-network-boundary.mjs`；live `browserboundary` |
| `stdio-guard.ts` | 100 | 主进程 stdio 护栏：EPIPE 只记录不上报（关终端是正常操作），非 EPIPE 最多报一次且**绝不 rethrow**（在流 `'error'` 里 throw 会变成 Electron 的模态错误框 → 事件循环卡死）。与脚本侧 `scripts/lib/stdio-guard.mjs` 的区别见文件头 | `index.ts` 顶部；单测 `test-stdio-guard.mjs` |

### 4.2 pi 协议与归一化（**改 pi 交互只需动这三个**）

| 文件 | 行 | 功能 | 联动 |
|---|---|---|---|
| `protocol.ts` | 534 | **手写** RPC 客户端。只用 LF 分帧（不能用 readline，它会切 U+2028/29）；命令带 `id`；`resolvePi` 决定用内置还是系统 pi | `agent.ts`、`subagents.ts`、`title.ts` 三个 spawn 点 |
| `agent.ts` | 2211 | `AgentController`：**一个会话一个 pi 子进程** —— 协议 → UI 的归一化、事件循环、`pendingUi`、"等待输入"计数、能力/统计刷新 | 被 `runners.ts` 持有；`index.ts` 事件经 `pushFrom` 带身份推出 |
| `normalize.ts` | 211 | pi 原始消息 → `UIMessage`。单独成文件是因为**会话文件解析器也要用**（那不能依赖 `agent.ts`） | `agent.ts`、`session-reader.ts` |
| `compaction.ts` | 297 | 压缩的**两件事**：① 读 pi 的压缩设置（`compactionInfo`，界面用来解释「何时会自动压缩」）；② 把 `compaction_start` / `compaction_end` 归一化成 `CompactionState`（N21-2）。**两个坑写在这里**：用户级设置要跟 `PI_AGENT_DIR`（不是拼 `~/.pi/agent`，D22）；项目级 `.pi/settings.json` 只在 pi 信任该项目时生效，否则整份忽略（D21，靠 `<PI_AGENT_DIR>/trust.json` 判断） | `index.ts` → `RightPanel.tsx`；`agent.ts` 的事件循环；单测 `test-compaction-status.mjs` |
| `shared/ipc.ts` 的 `CompactionRun` | — | 压缩状态快照：`status`（running/completed/declined/failed/cancelled）+ `reason`（manual/threshold/overflow，认不出留 `reasonRaw` 原文）+ `error`（pi 原文，不静默）+ `beforeTokens`/`afterTokens` | `SessionState.compaction`（进行中）/ `.lastCompaction`（已结束，**两者必须分开**：开始新一次时不能擦掉上一次的结果） |
| `shared/context-policy.ts` | 556 | **工作集预算与触发决策 + 四层覆盖解析**（N21-3 / N21-7，纯函数）：① `contextBudget(窗口)` 按 `min(240k, 窗口×70%, 窗口−预留−余量)` 算工作集（参考值 64k→40k / 128k→88k / 256k→179.2k / 1M→240k；**小到装不下预留与余量时返回 null**，不给出 ≤ 0 的压缩线）；② `contextPolicyStep` 回答「现在要不要压」（上膛 `armed` / 冷却 30s / 忙时不插刀 / 兜底不看上膛）；③ `policyFrom` 解析 `YAN_CONTEXT_POLICY`；④ `nextContextStage` 给界面算「下一步」；⑤ 兜底线 `emergency = min(窗口 × 比例, 窗口 − 预留)` —— **物理兜底不能突破输出预留**（D31，方案 §12.1）；⑥ **N21-7** `resolveContextPolicy`（`env > model(provider/model) > provider > user > default`，返回 `source` / `sourceKey` / `overridden`）、`applyOverrides`（夹取唯一真源）、`sanitizeContextPolicyOverrides*`、`CONTEXT_POLICY_PRESETS`。放在 shared 而不是 main：**判定与显示必须同一套规则** | `main/agent.ts` 的 `evaluateContextPolicy`；`main/context-policy.ts`（设置层 + env 入口）；渲染端 `nextContextStage` / `ContextTab.tsx`；单测 `test-context-policy.mjs`；live `contextbudget` / `contextswitchguard`（触发时机，D27 的回归网）/ `contexttakeover` |
| `main/context-policy.ts` | 78 | 两件事：① 记住**设置层**（`setContextPolicySettings`，设置读盘 / 写入时登记，因为 `effectivePolicy()` 要同步）；② `activeContextPolicy(env, modelKey)` 按当前模型解析四层覆盖。纯逻辑在 `shared/context-policy.ts` | `agent.ts` 的 `effectivePolicy()`；`index.ts` 的 `yan:contextBudget` 与 `patchSettings` |
| `main/context-state-store.ts` | 368 | **派生状态的落盘层（N21-4 / S1）**：`YAN_DATA_DIR/context-state/<sessionId>.json`（归档 `<id>.archive.json`）。原子写 = 临时文件 → 回读校验 → `rename`；校验不过**绝不 rename**（失败不覆盖 last-known-good）。读时损坏 / 版本不认识 / 引用不存在的原始条目 → **安全丢弃**（删文件 + 返回原因）。`deleteContextStates` 供 `sessions.ts` 删会话时清派生状态（状态 / 归档 / 召回账本与审计 / 崩溃残留的 `.tmp`）。sessionId 直接进文件名，所以有路径穿越守卫。它也是 electron-vite 的额外入口（live 场景在 Node 侧种/查隔离目录） | `sessions.ts` 的 `deleteSession`；单测 `test-context-state.mjs`；live `contextstate` |
| `main/context-watermark.ts` | 136 | 从**原始会话 JSONL** 读条目身份与水位（S1 的 provenance 入口）：逐行流式读、只从行首取 `type`/`id`（单行可达 4MB，不复用 `session-reader` 的整文件 parse）；半截尾行不计入且标 `incompleteTail`，中间坏行整份作废（返回 null） | `context-state-store` 的 `raw` 索引来源；live 场景的种子；单测 `test-context-state.mjs` |
| `shared/rail-order.ts` | 57 | **侧栏顺序的纯计算（N01）**：`orderAfterDrag`（拖拽结果，四种「原样返回」的早退：movedId 不在列表 / 落点是自己 / 落点不在列表 / 拖回原位）、`beforeFromDrop`（由指针上半⇄下半推出「插到谁之前」）、`rankOf`（排序比较用的名次表）。**为什么不写在 Rail.tsx 里**：拖拽的几何只能在真实窗口验，而顺序计算要能被单测穷举边界（`test-rail-order.mjs` 25 条） | `Rail.tsx` 的拖拽区块；`shared/ipc.ts` 的 `AppSettings.projectOrder`；单测 `test-rail-order.mjs`；live `railreorder`；截图 `matrix-railreorder-*` |
| `shared/ipc-error.ts` | 19 | **IPC 错误消息剥壳**（纯函数）：`Error invoking remote method '…': Error: …` 这层壳是 Electron 的传输细节，提示条上只需要后半句。主进程回包的 `piCall` 与渲染端直接 `try/catch` 的调用点（`store.openBrowser`）共用同一套规则 —— 分叉过一次，同一条错误在两处提示长得不一样。**只剥最外层一次**（消息正文自己的 `Error:` 要留着） | 单测 `test-ipc-error.mjs`（7 条）；live `slashcmd` 第 17 节（失败提示不带 IPC 前缀）；反例：还原 `openBrowser` 的剥壳 → 那条断言立刻变红 |
| `shared/title-samples.ts` | 60 | **会话标题的样本挑选**（N11，纯函数）：首条 + 最近一条用户话；纯图片消息用 `[图片 ×N]` 占位；最多带首图一张。内存路径（`agent.ts`）与磁盘路径（`sessions.ts.readTitleSamples`）共用这套规则 —— 以前是两份实现，"新会话标题与旧会话标题口径不一致"只表现为"标题怪怪的"，很难归因 | 单测 `test-title-samples.mjs`（11 条）；`test:live -- title` |
| `scripts/probe/language.js` | 210 | N16 语言：互换提问对照（每方向最多 3 次）+ **切语言不重建实例** + 同一会话下一轮生效 + 流式期间切语言不打断；推理语言**只报告**（软约束） | `test:live -- language`（cost 1） |
| `scripts/probe/history-switch.js` | 211 | **切换会话不丢历史**（D38 的回归网）：拿历史最长的会话，用 `peekSession` 记条数与首条文本 → 点开 → 等权威 `sync` → 再对一次；期间"曾被打回 0"直接判失败；另外覆盖"切语言"这条路径 | `test:live -- historyswitch`（cost 0） |
| `scripts/probe/context-state.js` | 88 | **删会话清派生状态**（N21-4 / S1 的唯一真实窗口证据）：状态文件由 Node 侧用真实 store 种进隔离 `YAN_DATA_DIR`（探针按设计碰不到），探针只走真实界面删一条会话并把 sessionId 打印出来；`afterExit` 再对文件系统断言"被删的没了、别人的还在" | `test:live -- contextstate`（cost 0，进 `npm run check`） |
| `scripts/probe/context-sweep.js` | 142 | **Tool Sweep 真实回合**（N21-4 / S2）：在真实 pi 里跑三个回合（一：模型用 bash 产生大输出；二：上一次结果落到 `recentTail` 之外并让模型 recall；三：触发召回正文的 TTL 清理），`afterExit` 检查归档元数据、`ctx://` 引用指得回原始条目、诊断里 `swept≥1` 且 0 条 error，并在确有召回时断言 `expiredRecalls≥1` | `test:live -- contextsweep`（cost 1，进 `npm run check`） |
| `scripts/probe/context-produce.js` | 128 | **状态生成器真实回合**（N21-4 / S7）：真实回合 1 让模型调一次 bash（给 evidence reducer 原料）→ 等生成（异步、内部 20s 上限）→ 回合 2 是 `<TASK_STATE>` 注入点；`afterExit` 检查诊断 `stage=producer` / `hook=committed`、状态文件 `revision>=1` + `objective` 非空 + evidence 非空、`injectedTaskState=true`，并让主进程 `loadContextState` 校验一次 | `test:live -- contextproduce`（cost 1，进 `npm run check`） |
| `scripts/probe/context-fold-pref.js` | 138 | **`episode-fold` 的界面关闭路径**（P2-7）：先从设置面板关掉开关（走用户真实那条路），再跑一个真调 `bash` 的回合；`afterExit` 检查 `desktop.json` 真的落了 `contextFold.enabled:false`、诊断里 0 条生成动作但有 1 条 `hook:skipped / reason:kind-off`（带解析后的 `kinds`）、0 次 `<TASK_STATE>` 注入、0 份状态文件。与 `contextfolddefault`（**同 env**、不关开关 → 会生成）构成反向对照：两边合起来才是完整命题 | `test:live -- contextfoldpref`（cost 1，进 `npm run check`） |
| `scripts/probe/context-episode.js` | 132 | **Episode 扇叠的真实回合**（§12.6）：让模型跑一条输出几千字的命令（历史才够长）、等第一次生成、再跑第二/三个回合让第一个回合落到尾部窗口之外；检查里拿两条证据 —— `hook:'episode-window'`（**硬**：确定性边界在真实链路里算得出来）与状态文件里的 Episode（**强**：模型真的给了收束的一段，逐字段验结构 + shadow + 主进程校验）| `test:live -- contextepisode`（cost 1，进 `npm run check`） |
| `scripts/probe/title.js` | 180 | N11 标题：自动生成 / 单次生成锁 / 手动名粘性 / 候选→采用 | `test:live -- title`（cost 1） |
| `agent.ts` 的 `evaluateContextPolicy` | — | **砚接管时机的唯一入口**：`refreshStats` 拿到用量时判定（回合结束才动，不在流式/工具执行中途）；命中后调 `compact({ fromPolicy })`。`policyOrigin`（含基准 `endedAt`）给那次压缩盖上真实发起方 —— pi 对砚发起的压缩一律报 `reason: 'manual'`，界面会写成「手动」 | 单测覆盖决策分支；live `contexttakeover` / `contextemergency`（两条线各一次真实触发） |

### 4.3 会话 / 项目 / 运行实例

| 文件 | 行 | 功能 | 联动 |
|---|---|---|---|
| `sessions.ts` | 465 | 会话索引（**只读**）：列左栏、读标题样本、删除、恢复。真正切换会话是让 pi 自己 `switch_session` | `index.ts`、`Rail.tsx` |
| `session-reader.ts` | 193 | 直接从 JSONL 解析消息：① 让界面**立即**有内容（实测 17MB 会话：文件解析 59ms vs 等 pi 2780ms）；② **也是 UI 历史的权威来源**（`agent.hydrate()` 用它，因为 pi 的 `get_messages` 只给当前上下文 —— 压缩过的会话实测 858 → 86 条）。返回值里带文件头的 `sessionId`，用于把 peek 内容与随后的 pi `sync` 认成同一条会话 | `index.ts` 的 `peekSession` → `store.switchSession` 第一步；`agent.ts` 的 `hydrate()` |
| `session-layout.ts` | 273 | 会话 ↔ 项目的**产品语义映射**（`sessionId → projectId / scope / 最近访问`）。Yan 不搬 pi 的 JSONL | `index.ts`、`Rail.tsx`；单测 `test-session-layout.mjs` |
| `title.ts` | 300 | 会话标题：**独立短进程**跑归纳；手动标题粘性；候选→采用。已显式关闭 context files / skills / 模板 | `index.ts`、`store.regenerateTitle`；缓存 `YAN_DIR/titles.json` |
| `todo-snapshots.ts` | 122 | 扩展写入的任务清单 → 四种状态（带别名表，因为字段名由扩展决定） | `agent.ts` 的 `refreshTodos`；单测 `test-todo-history.mjs` |

### 4.4 浏览器（13 文件）

| 文件 | 行 | 功能 |
|---|---|---|
| `browser.ts` | 1252 | 控制器：内嵌 `WebContentsView` + 外部 Chrome 代理标签，统一标签栏 / `activeMode` 路由；loopback bridge（只监听 127.0.0.1，带 token） |
| `browser/CdpChannel.ts` | 30 | **通道接口** —— 抽这层的理由：内嵌用 Electron debugger，外部 Chrome 必须走原生 WebSocket，两者对上层必须一样（被 8 个文件 import） |
| `browser/CDPBridge.ts` | 48 | Electron `webContents.debugger` 的实现 |
| `browser/RawCdp.ts` | 268 | 原生 WebSocket 版（驱动外部 Chrome）；含 `waitForCdp` / `pickPageTarget` |
| `browser/Observer.ts` | 107 | 页面 → 模型可用的「可交互元素表」（DOM + 无障碍树 + `getBoxModel`，最多 80 个） |
| `browser/ElementRegistry.ts` | 59 | 一次 observe 产生的 ref 表；**只在整篇文档被替换时作废** |
| `browser/InputController.ts` | 135 | 命名键 → `(key, code, windowsVirtualKeyCode)`；修过「空格 → 非法 `Key `」这类 bug |
| `browser/geometry.ts` | 30 | 元素相对视口的包围盒（`getBoxModel` 已扣滚动偏移，必须与 `Input.dispatch*` 的坐标系一致） |
| `browser/BrowserPolicy.ts` | 22 | 风险策略：明显有副作用的点击先拦下来，交给 `browser_request_user_control` |
| `browser/network-policy.ts` | 93 | 私网 / 回环地址判断（防远程页面借道）；域名在请求时重新 lookup |
| `browser/storage-transfer.ts` | 11 | 页面级存储迁移（host-only scope + session 生命周期必须原样保留） |
| `browser/cookie-transfer.ts` | 36 | Cookie 迁移（同上） |
| `chrome.ts` / `chrome-profile.ts` | 124 / 271 | 启动/停止本机 Chrome（独立 profile + 调试端口）；把真实 Chrome 的登录态与历史导入我们托管的那份 profile |

> 浏览器整条链路跨 4 层：主进程（`browser.ts` + `browser/`）↔ 原生视图 ↔ pi 扩展（`resources/pi-extensions/browser.js`）↔ renderer（`BrowserSurface.tsx`）。

### 4.5 子代理

| 文件 | 行 | 功能 | 联动 |
|---|---|---|---|
| `subagents.ts` | 697 | 自有进程管理的子代理：槽位预占、启动期上下文快照、只读模式 `--tools` 白名单、退出归档清理、超时、停止、转录上限、用量不重复计入。**跑完要收进程**（等转录安静 → close → 再读差异/清理，D16）；**toolResult 回填**到原调用，消息编号用 `msgSeq`/`streamingId`（D15） | `index.ts`；`SubagentList.tsx`、`SubagentPreview.tsx`；单测 `test-subagents.mjs`（注入假 RPC，不 spawn 真 pi）；live `subagentpair` |
| `subagent-isolation.ts` | 211 | **写入隔离（L03）**：从 HEAD 建独立 worktree、差异汇总、应用补丁、清理。只处理文件系统/Git 边界，不启动 pi | `subagents.ts`；单测 `test-subagent-isolation.mjs` |

### 4.7 Git 审查（方案 G1，**只读**）

| 文件 | 行 | 功能 | 联动 |
|---|---|---|---|
| `git-service.ts` | 414 | Git 只读查询的底座：`execFile` 封装（参数数组、**不经 shell**、关掉 external diff/textconv 的两道环境变量）、仓库发现（30s 缓存 + `.git` mtime 失效）、`status --porcelain=v2`、refs 列表、worktree 占用分支、ref / 路径校验、未跟踪文件的有界元数据（行数 / 大小 / NUL 嗅探 / LFS） | `git-diff.ts`、`index.ts`；单测 `test-git-review.mjs` / `test-git-repo.mjs`（真实仓库） |
| `git-actions.ts` | 659 | **写操作 —— 唯一会改用户仓库的文件**：按仓库串行、预期版本分级复核、八个动作（暂存 / 取消暂存 / 批量 / 提交 / 切分支 / 新建分支 / 拉取 / 推送）、超时后重读 HEAD、hook 文件探测。「应用会不会改用户的 Git、怎么改」只看这一个文件就能答完 | `shared/git-actions.ts`、`git-service.ts`；单测 `test-git-actions.mjs` / `test-git-repo.mjs`；live `gitwrite` |
| `sources.ts`（main） | 292 | **会话来源的持久化引用（§8 的 S1）**：图片写到数据目录（文件名 = 内容 sha256 前 32，同内容幂等）、文件只登记路径 + `size:mtime` 指纹、移除只删副本（**永不删用户原文件**）、会话 id 当目录名前的字符清洗（挡路径穿越）。**唯一**持有来源字节的地方 | 单测 `test-sources.mjs`（真实文件读写）；live `gitwrite` 第 13 节 |
| `SourceMenu.tsx` | 326 | 环境菜单里的「来源」：三类合并 + 筛选 + 缩略图 + 「已关联 / 文件不在了」两态 + 边界文案。**只显示能证明的状态** | live `gitwrite`；视觉 `envlinks` |
| `packages.ts`（main） | 349 | **pi 包管理（§9 的 P2）**：读 settings.json 的 `packages`、按 source 形状解析包目录、装/卸/更新（调 pi 自己的 CLI，参数注入在发起前就挡下、有任务在跑时拒绝）。**唯一**会改用户 pi 目录的地方 | 单测 `test-packages.mjs`（真实 CLI + 强隔离）；live `pkgs` |
| `PackagesTab.tsx` | 233 | 设置「插件」：目录入口、安装区（支持版本）、已装列表（用户级/项目级、磁盘上找不到的异常态）、详情（来源 / 仓库 / 许可 + **会执行代码的边界声明**）、生效时机 | live `pkgs` + `panels`；视觉 `settingspkg` |
| `SourceLinks.tsx` | 170 | **关联外部任务**（方案 §6.4）：存 URL 与标题 → localStorage、按会话隔离、只收 http/https、在内置浏览器打开；边界文案写在界面上并有 live 断言 | live `gitwrite` 第 13 节 |
| `git-worktree.ts` | 738 | **用户工作树（方案 §6.2，W1+W2）**：默认目录规则、`worktree list --porcelain -z` 解析、创建（五条拒绝路径）、删除前的三类拦截 + 主工作树 / locked / 非登记路径一律拒绝、**携带未提交改动**（`collectCarry` / `applyCarry` / `verifyCarry`：三份分开迁移、patch 全或无、目标侧验证、源仓库只读）。**绝不**复用 `subagent-isolation.cleanupWorkspace()`（那是 `--force` + `rm -rf`） | 单测 G10 / G11；live `gitwrite` |
| `git-diff.ts` | 614 | 审查数据层：变更清单（raw + numstat + status 合成，**按范围过滤 status 条目**）、单文件 patch（结构化 hunk）、两侧内容（图片走 **buffer** 编码）、未跟踪文件合成「全新增」hunk | 同上；live `gitreview` |

⚠️ **不要复用 `subagent-isolation.ts` 的 `collectDiff()`**：它为了生成归档补丁会在隔离 worktree 里 `git add -A`，主工作区调一次就会改用户的暂存区。证据：`test:live -- gitreview` 的 `afterExit: gitReviewReadonly` 逐字节比对 `status` / `ls-files -s` / `diff --cached --numstat` / `HEAD`。

### 4.6 文件、快照、引用

| 文件 | 行 | 功能 | 联动 |
|---|---|---|---|
| `files.ts` | 343 | 文件树数据源：列 cwd 下一层（懒加载）；`searchFiles` 全项目检索 | `FileTree.tsx`；单测 `test-files.mjs` |
| `file-refs.ts` | 294 | 用户**显式引用**的文件（拖入 / 加入上下文）：授权、越界校验、只读预览 | `index.ts`、`Composer.tsx` 附件链路 |
| `snapshots.ts` | 587 | **变更归属（L05）**：写入类工具的**单文件前后快照**（`snapshotBefore/After`，行级 patch 与增删行数）+ shell / 第三方工具的**目录级前后快照**（`captureTree`/`diffTrees`/`beginTreeSnapshot`/`endTreeSnapshot`）。不能只靠工具参数 —— `edit` 的参数只是替换片段，而 `bash` 根本不告诉你要改哪个文件。同步 fs（异步会有“写完才读到 before”的竞态）；跳过依赖/产物目录；文件数 4000 / 深度 12 / 内容预算 12MB 上限定；子目录读不到**不算**截断（否则用户项目里一个无权限目录就会让每条命令都带警告）。归属存疑时返回 `concurrent` / `truncated` / `unreadable`，不把别人的改动记到这次调用头上 | `agent.ts`（`tool_execution_start/end` 的 `bash`、`runBash`/`finishBash`）；单测 `test-snapshots.mjs`、`test-workspace-changes.mjs`（33 条）；live `-- workspacechanges` |
| `credentials.ts` | 453 | 读写 pi 凭证；**`completePath` 是 `@` 补全的主进程侧**（与文件树共用同一条 cwd 边界） | `AuthTab.tsx`、`Composer.tsx`；单测 `test-credentials.mjs` |
| `command-registry.ts` | 144 | Yan 命令注册表（N18）：本地路由 + 扩展/技能来源 + "仅兼容显示"统一成一个可审阅列表 | `agent.ts` 的 `listCommands`；单测 `test-command-registry.mjs` |
| `oauth.ts` | 321 | ChatGPT 订阅（`openai-codex`）**应用内** OAuth；参数逐字对齐内置 pi（差一个 pi 就不认这个 token） | `AuthTab.tsx`；单测 `test-oauth.mjs` |
| `quota.ts` | 298 | 额度查询。**必须用 Electron `net.fetch`**（全局 fetch 会被 Cloudflare 拦） | `RightPanel.tsx` |

---

## 5. `src/renderer/src/` —— 界面（59 个 `.ts/`.tsx`；样式另见 §5.8）

### 5.1 状态层（改这里要最小心）

| 文件 | 行 | 功能 | 联动 |
|---|---|---|---|
| `state/store.ts` | 2076 | **唯一状态源**（zustand）：套用 `MainPush` 补丁、按会话缓存、全部用户动作 | **被 26 个文件订阅**。改 store 的字段/动作要同时查：组件订阅点、probe 里的 `window.__yanStore` 调用 |
| `state/session-runtime.ts` | 261 | 按 sessionId 保存后台运行时状态（消息/草稿/模型/命令/统计）；启动期 `run:<id>` → 稳定 sessionId 的缓存迁移 | `store.ts`；单测 `test-session-runtime.mjs` |
| `state/capability-request.ts` | 43 | 能力列表响应的**过期判定**：有 runId 只认 runId（`sessionId` 的 `pending→uuid` 是正常过渡） | `store.ts` 的 `reloadModels`/`reloadCommands`；单测 `test-capability-request.mjs` |
| `state/project-session.ts` | 56 | 切项目时选「该项目最近访问的会话」（**运行实例优先**，其次会话列表）：选错就会新建会话、把草稿弄丢（草稿按 sessionId 存） | `store.ts` 的 `pickProjectSession` 动作 → `Rail.tsx` 的 `switchProject`；单测 `test-project-session.mjs` |
| `state/compaction-view.ts` | 84 | 压缩状态 → 文案（N21-2）：reason × status 的整张表。**三条边界写在这里**：认不出的 reason 显示上游原文而不是「未知」；`declined`（上游没执行）与 `cancelled`（中断）都不许写成「失败」；两端 token 都有才给「1.6k → 160」。N21-3 起还负责**发起方**：`triggeredBy === 'policy'` 时写「工作集 / 物理兜底」而不是 pi 报的「手动」 | `RightPanel.tsx` 的上下文分区；单测 `test-compaction-status.mjs` |
| `state/context-view.ts` | 50 | 工作集 → 文案（N21-3）：阶段名（tool-sweep → 清理 / episode-fold → 折叠 / compaction → 压缩）与「下一步：…」。**只预报 `kinds` 里真的会执行的阶段** —— 未接管的阶段在界面上是虚线 + 「阶段 4 才生效」的说明，不能写成会触发 | `RightPanel.tsx` 的上下文分区；单测 `test-context-policy.mjs` |

### 5.2 对话区 `components/chat/`

| 文件 | 行 | 功能 | 联动 |
|---|---|---|---|
| `TurnView.tsx` | 303 | **把一轮对话渲染成一块**；决定推理/工具/正文的排列 | `turns.ts` 的分组结果；`Reasoning.tsx`、`ToolRow.tsx`、`MessageParts.tsx` |
| `Composer.tsx` | 1187 | 输入区：普通文本 / bash 模式 / `/` 命令 / `@` 引用 + 附件 + 队列 | `slash-query.ts`、`at-query.ts`、`Pickers.tsx`、`UsageBar.tsx` |
| `Reasoning.tsx` | 403 | 推理流：字素级逐字 + **限高省略**（裁开头、贴底显示最新、顶部渐隐、"展开全部"） | `chat.css` 的 `.reason-body.clip`；`tokens.css` 的 `--reason-max-h` |
| `ToolRow.tsx` | 306 | 工具调用的 Codex 风格行 / 组；默认收起。命令类工具在终端窗口下方多挂一张**改动卡片**（`workspaceChanges`，L05） | `ToolDetails.tsx`、`Terminal.tsx` |
| `ToolDetails.tsx` | 295 | 工具详情**分型**（文件改动 / 命令输出…），不再一律套终端壳。含 `WorkspaceChangesDetail`（目录级改动：文件清单 + 状态 + 能算时给 +N/−N 与 patch）与 `readWorkspaceChanges` | `MessageParts.tsx`、`Terminal.tsx` |
| `Terminal.tsx` | 316 | 终端窗口（工具输出）；可调大小 | `ToolRow.tsx` |
| `MessageParts.tsx` | 254 | 共享渲染件：Markdown / 工具行 / 工具详情（被 4 个文件复用） | `TurnView.tsx`、`SubagentPreview.tsx` |
| `UsageBar.tsx` | 211 | 底部用量条；**模型选择器就住在这里**（无数据时降级为只渲染选择器，不能整条消失） | `Pickers.tsx`、`turns.ts` 的 `cacheHitRate` |
| `ConversationOutline.tsx` | 406 | 消息流左侧导航轨，一格 = 一轮用户发言 | `App.tsx` 注册的 `scrollToTurn` |
| `QuestionPanel.tsx` | 194 | 扩展提问面板（非模态，不打断阅读） | `UiBridge.tsx`、`index.ts` 的 `pendingUi` |
| `SubagentList.tsx` | 97 | 输入区上方的子代理运行列表 | `SubagentPreview.tsx` |
| `ComposerBorder.tsx` | 131 | 输入框顶边的**工作状态动画**（pi TUI 原样实现） | `Composer.tsx`、`motion.css` |
| `SessionHeader.tsx` / `EmptyStream.tsx` / `Continuity.tsx` | 93 / 111 / 8 | 主区顶部信息 / 空状态 / 转发壳 | `App.tsx` |
| `ErrorBoundary.tsx` | 93 | 渲染异常兜底（D8）：抓 App 子树的渲染期异常，给出原因 + 详情 + 「复制详情 / 重新加载界面」；抓不到事件处理器与异步回调里的异常（那些走日志与 notice） | `main.tsx` 包在 `I18nProvider` 内层；`test:live -- crash` |
| `at-query.ts` | 84 | `@` 引用的**光标范围**纯函数（范围不含 `@` 本身，便于替换） | `Composer.tsx`；单测 `test-at-query.mjs` |
| `slash-query.ts` | 43 | `/` 命令的光标范围纯函数（只在首个 token 触发） | `Composer.tsx`；单测 `test-slash-query.mjs` |

### 5.3 左栏 `components/rail/`

| 文件 | 行 | 功能 |
|---|---|---|
| `Rail.tsx` | 1728 | 左栏主体：项目分组、会话树、回收站提示、mini 栏、运行状态槽（N12）、搜索、折叠、**拖拽排序（N01）** |
| `RailUser.tsx` | 276 | 底部用户块（头像 + 名字 + 设置入口） |
| `rail-utils.ts` | 5 | `shortProject` —— 目录名缩写 |
| `sidebar-state.ts` | 30 | 侧栏小偏好（localStorage）。**会话内容不进这里** |

> 侧栏顺序（项目 / 分组）**不走 localStorage**：它要跟着账号级设置走，所以存在 `desktop.json` 的 `projectOrder` 与 `projectGroups` 数组顺序里；计算部分在 `shared/rail-order.ts`。

### 5.4 右栏 `components/toolbar/`

| 文件 | 行 | 功能 |
|---|---|---|
| `RightPanel.tsx` | 1520 | 右栏主体：按用户配置排列上下文 / 任务 / 队列 / 文件 / 扩展 / 日志 / 操作分区；浏览器视图占下方独立区 |
| `FileTree.tsx` | 912 | 文件树（懒加载 + 缓存 + 隐藏项开关）。⚠️ 根层加载的守卫依赖 `loading`（丢弃的旧请求会清标记，见 D19）—— 改这段要保持“能自愈重试” |
| `FilePreview.tsx` | 162 | 只读文件预览（**不是编辑器**） |
| `SubagentPreview.tsx` | 177 | 子代理详情：任务 + 实时转录 + 停止 |
| `ToolSection.tsx` | 88 | 分区外观（可折叠头 + body）；被 3 个文件复用 |
| `ToolLibrary.tsx` | 144 | 工具库：分区**收进库 / 拿到工具栏**、上移 / 下移、恢复默认 —— 全部用按钮；**不提供从库拖出**（浮层里拖动会与「点外面关闭」打架） |
| `Resizer.tsx` | 221 | 栏宽拖拽把手（跨组件监听 window，结束后必须清理） |
| `browser/BrowserSurface.tsx` | 379 | 浏览器工具栏 + 把可见区域坐标同步给主进程（网页本身是原生视图） |

### 5.4b `components/review/` —— Git 审查（5 个文件，方案 G1）

| 文件 | 行 | 功能 |
|---|---|---|
| `EnvironmentMenu.tsx` | 224 | 环境菜单（项目胶囊即入口）：变更 / 本地（信息行 + 打开 / 复制）/ 分支 / PR / 比较分支。**只放已经能用的动作** |
| `ReviewPanel.tsx` | 411 | 审查面板：范围选择、统计、两端比较的基准下拉、逐文件卡片 + 懒加载 patch、关闭 / 刷新 / 全部标记已查看 |
| `ChangedFileTree.tsx` | 232 | 变更文件树：扁平清单折成目录树（`buildFileTree` 纯函数）、文件名 / 类型筛选、已查看进度 |
| `DiffViewer.tsx` | 256 | 结构化 hunk 渲染（两列行号 + 增删底色）与「N 行未修改」的**真展开**；含 `ImageDiff`（前后对照 + 适配 / 原尺寸） |
| `CommitBar.tsx` | 192 | 提交区（方案 §5.2 / §5.3）：说明输入（Ctrl+Enter 提交）、提交 / 提交并推送、仓库与分支、已暂存数、设置上游、失败提示（分类 + 可折叠的原始输出）。**刻意没有「丢弃改动」** | 「提交并推送」在渲染端拆成两步调用，所以提交成功、推送失败时提交被保留 |
| `useGitReview.ts` | 539 | 数据钩子：仓库状态 / 快照（带请求闸门丢弃迟到响应）/ patch 懒加载缓存 / 两侧内容 / 已查看（localStorage） |

### 5.5 设置与外壳

| 文件 | 行 | 功能 |
|---|---|---|
| `App.tsx` | 605 | 应用外壳：三栏布局 + `VList` 虚拟滚动 + 生命周期接线 |
| `main.tsx` | 34 | 把 store 挂到 `window.__yanStore`（探针要用） |
| `components/settings/Settings.tsx` | 835 | 设置面板六 tab：模型接入 / 外观 / **上下文** / 声音 / 状态 / 关于 |
| `components/settings/ContextTab.tsx` | 313 | 上下文策略设置（N21-7）：预设（砚默认 / 参考方案 300k·0.75）+ 三个数值（工作集上限 / 窗口比例 / 输出预留）+ 模型级覆盖 + **生效来源**行。草稿 + 显式保存（逐键写盘会把半成品写进设置文件）；具体校验全在 `shared/context-policy.ts`，这里不重复实现 |
| `components/settings/AuthTab.tsx` | 298 | 凭证管理；只有 `openai-codex` 能在应用内登录 |
| `components/settings/Onboarding.tsx` | 270 | 首次引导（`shouldAutoOnboard` / `markOnboarded`） |
| `components/shell/TitleBar.tsx` | 187 | 自定义标题栏（主题、栏开关、置顶） |
| `components/shell/UiBridge.tsx` | 273 | 把 pi 扩展的 select/confirm/input/editor 映射成真模态框 |
| `components/Pickers.tsx` | 386 | **模型 + 思考强度选择器**；模型未知时降级显示"模型未就绪"而不是消失 |

### 5.6 库 `lib/`

| 文件 | 行 | 功能 |
|---|---|---|
| `modalLayer.ts` | 249 | 模态层统一基座（栈、焦点陷阱） |
| `sound.ts` | 158 | 声音提示：**Web Audio 合成**（不打包 mp3）+ 解锁策略 |
| `usePresence.ts` | 78 | 让浮层有**退场**动画 |
| `scrollAnchor.ts` | 55 | 展开/收起工具详情时的滚动锚点（防下方内容被顶走） |
| `fork.ts` | 34 | 分叉入口（左栏与消息上两处共用） |

### 5.7 图标与 i18n

| 文件 | 行 | 功能 |
|---|---|---|
| `icons/Icon.tsx` | 44 | `<use href="#i-x">` 引用（**被 26 个文件 import**，第二枢纽） |
| `icons/sprite.ts` | 40 | **自动生成**（`npm run icons`）—— 不要手改 |
| `i18n/index.tsx` | 101 | `useT()` / `I18nProvider`；键扁平 + 命名空间 |
| `i18n/zh-CN.json` / `en-US.json` | — | 文案。**两份键必须对齐**；改文案要跑 typecheck 的 i18n 检查 |

### 5.8 样式层 `styles/`（17 文件，按 `main.tsx` 的 import 顺序生效）

| 文件 | 行 | 角色 |
|---|---|---|
| `tokens.css` | 290 | **设计令牌**；唯一真源在 `DESIGN.md §2`（先改文档再改这里） |
| `app.css` | 474 | 应用骨架、标题栏、通用控件 |
| `layout.css` | 167 | 三栏网格（弹性列一律 `minmax(0, 1fr)`，`lint-css.mjs` 会拦） |
| `rail.css` / `chat.css` / `composer.css` / `tools.css` / `browser.css` / `settings.css` | 1542 / 1362 / 1154 / 1535 / 377 / 305 | 各区域样式 |
| `stage1.css` / `redesign.css` | 204 / 1284 | 历史层，**名字旧 ≠ 无用**，删除前核对导入顺序与覆盖 |
| `motion.css` | 1383 | 动效系统（含 `prefers-reduced-motion` 分支） |
| `shell.css` / `dialog.css` / `electron.css` / `highlight.css` | 303 / 79 / 34 / 172 | 外壳 / 对话框 / Electron 适配 / 代码高亮主题 |
| `review.css` | 844 | 环境菜单 + Git 审查面板（G1）；含 diff 的底色 / 行号 / 未修改区与图片对照的棋盘格 |

---

## 6. `resources/pi-extensions/` —— 随包分发的 pi 扩展（源码）

| 文件 | 行 | 功能 | 加载方式 |
|---|---|---|---|
| `browser.js` | 198 | 内置浏览器工具（`browser_open/observe/click/type/press/scroll/…`）。只访问 loopback bridge，**不碰 Electron 对象** | `agent.ts` 用 `--extension` 加载 |
| `question.js` | 167 | 让模型在信息不足时主动问用户；自主模式下不弹窗 | 同上 |
| `response-detail.js` | 67 | 把界面三档"回复详细程度"变成系统提示（standard 不注入） | 同上 |
| `context-safety.js` | 437 | **切片安全规则**（N21-10，纯函数、无 Electron/pi 依赖）：原子上下文单元（user 回合 / bash / orphan tool）、从尾部按单元边界切割（`planTailCut`）、被切掉但必须进状态的 `carryOver`、注入分桶 `routeEntries`、清扫候选 `sweepCandidates`、以及不变式检查 `violations` / `routingViolations`。三条硬约束：正在使用的 diff 不得删、用户约束不得降级、不得从 reasoning/output 中间切。**保护分两档**（硬留 vs 可带走），理由写在文件头 | 阶段 4 扩展（N21-4）接入时调它；现在只有单测 `test-context-safety.mjs`（42 条）与 [方案 §12.4](../design/方案-上下文工具内的自动压缩-2026-09-15.md) |
| `context-producer.js` | 1355 | **状态生成器的纯逻辑**（N21-4 / S7，无 IO / 不读 env）：确定性 evidence reducer（`evidenceFromMessages`：命令 / 退出码 / 测试计数 / 文件，全部带真实 `entryId`）、生成提示词（`buildProducerPrompt`）、模型输出白名单解析（`parseProducerOutput`）、合并与 provenance（`mergeTaskState`：`constraints` 命中用户原话 → `kind: 'user'` + `entryId`，其余老实标 `hypothesis`；确定性字段**覆盖**模型）、裁剪与预算（`clipTaskState` / `clipTaskStateToBudget`，objective / constraints / failedAttempts / unresolved 永不删）、freshness 分档（`freshnessOf` / `applyFreshness`）、dirty 位掩码与刷新判定（`shouldRefresh`）、CAS（`casAllows`）、**输入自净**（`stripSyntheticMessages` / `isSyntheticText`：把注入块 / 墓碑 / 召回正文剔出生成器输入）、**落后回合数**（`turnsSince` / `transcriptStats` —— dirty 的「落后 ≥2」按**回合**而不是条目数）、**陈旊视角**（`pendingUserOnly` / `freshView`：只落后一条未 settled 的 user 不算陈旊；`tailRolesOf` 给角色指纹诊断）、**provenance**（`citableEntries` 造「本轮可引用清单」（**刻意不含上一版状态** → 断语义递归）/ `verifyEntryRefs` 只认清单内的 id / `provenanceCounts` 给诊断分布 / 语义条目支持 `{text, entryIds}` 形态）、**会话级门槛**（`foldEligible` 四档：地板 → `first-sweep` → `long-session` → **`near-window`**（N21-6 State Refresh：`ctx.model.contextWindow × FOLD_REFRESH_RATIO 0.42`，拿不到窗口就跳过））、**生成开销**（`stateOverhead`：把「状态生成 token / 主 agent token」算成比值与档位；输入实际有界，见方案 §18）、**Episode 扇叠**（`episodeCandidate` / `episodeSkipReason`：「能不能扇叠」与「为什么没扇叠」分开，后者把*模型没给*与*给了但未收束*区分开，直接服务于调提示词；`mergeEpisodeState`：确定性 id `ep-<from>--<to>`、同段幂等替换、上限 `MAX_EPISODES`） | `resources/pi-extensions/context.js` 调它；单测 `test-context-producer.mjs`（~150 条，含 fake ctx 真落盘 + TS schema 交叉校验）；[方案 §17](../design/方案-上下文工具内的自动压缩-2026-09-15.md) |
| `context-transform.js` | 962 | **上下文变换的纯逻辑**（N21-4 / S2–S6，无 IO / 无模型）：**token 估算**（`estimateTokens` / `isWideTokenChar`：宽字符按 1 个 = 1 token、其余 UTF-16 ÷ 4 —— 中文曾因此被低估 3.9 倍，N21-11 修正）、pi 消息 ↔ 条目视图适配（`adaptMessages`）、消息 ↔ **原始 entry id** 对齐（`alignEntryIds`，复刻 pi 的 `buildContextEntries`，压缩后从 `firstKeptEntryId` 起；数量 + 角色双校验）、Tool Sweep 规划与提交（`planToolSweep` / `applyToolSweep`，墓碑幂等、只换 toolResult 内容）、`<TASK_STATE>` 渲染与前置注入（`renderTaskState` / `injectTaskState`；`stale` 条目会显式渲染成 `[stale: verify…]`，不静默当有效）、recall 预算与 TTL（`recallBudget` / `wrapRecall` / `stripStaleRecalls`）、结构化摘要装配与降级判据（`buildStructuredSummary`；N21-4 生成器落地后**默认不再要求六类字段齐备**，需要保守判定时传 `requiredFields`）、Episode 引用汇总与递归摘要预检、诊断行 | `resources/pi-extensions/context.js` 调它；`<TASK_STATE>` 头行带 **authority 契约**（`derived="true" authoritative="false" freshness sourceHead`），`buildStructuredSummary` 会过滤有递归风险的 Episode（回报 `episodesDropped`）；单测 `test-context-transform.mjs`（111 条）；[方案 §15](../design/方案-上下文工具内的自动压缩-2026-09-15.md) |
| `context.js` | 1605 | **上下文状态化压缩扩展**（N21-4 / S2–S6，随包分发的源码）：`context` 钩子做 Tool Sweep + Task State 前置注入 + TTL 清理；`session_before_compact` 接管闸门（状态存在且水位可用时接管，只换摘要文本、保留 pi 的 `firstKeptEntryId`；否则 `return undefined` 交回 pi 摘要）；注册 `context_recall` 工具（原文从会话条目读回、超预算拒绝并解释、召回账本 + `.recall.jsonl` 审计）。归档元数据写 `context-state/<id>.archive.json`；**S7 生成器**（`agent_settled` → `produceAndCommit`）经 `ctx.modelRegistry.complete()` 生成 TaskState 并写 `context-state/<id>.json`（元数据由宿主附加；落盘前过 `revision` CAS；schema 的**真源**仍在 TS 层，主进程读路径校验并安全丢弃非法文件）。**默认清扫大块工具输出**（`kinds` 默认含 `episode-fold`（2026-09-18 拍板，见方案 §17.5.7），2026-09-17 拍板：清理默认开、保留可召回引用；本回合正在动的文件不清扫）；生成只在 `kinds` 含 `episode-fold` 时工作（2026-09-18 起**在默认集合里**；短会话受会话级门槛保护，仍不花钱），单飞 + 20s 超时 + 失败保留旧状态；整段钩子在 `try/catch` 里，异常即整轮放弃。**闸内还分两条路**（`YAN_CONTEXT_POLICY.state.{generate,inject}`：`inject:false` 就是 shadow 模式，**压缩接手也走这一路**）与一道**会话级 gate**（`foldEligible`：≥4 用户回合且转录 ≥48k，或本会话清扫过东西，或**接近窗口**（`near-window`，N21-6 State Refresh）；命中后会话内 sticky）；注入那一刻会记 `hook: task-state-injected`（含 freshness / sourceHead / tokens）。**扩展侧其实能自己跑一次无工具推理**（`ctx.modelRegistry.complete(ctx.model, {messages}, {tools: []})`，`agent_settled` 也对扩展分发）—— 状态生成器不必起第二个进程，见方案 §16.1 | `src/main/agent.ts` 的 `--extension`（`index.ts` 的 `contextExtensionPath()`）；单测 `test-context-transform.mjs`（含直调 `execute` 覆盖全部拒绝分支）；live `contextsweep`（cost 1，真实回合里模型真的 recall 取回原文） |
| `context-stage-runtime.js` | 114 | **阶段运行状态**（方案 §12.3，纯函数、无 IO）：`createStageRuntime` / `stageStep`（上膛 → 冷却 → 三条重新上膛路径：本来就没上锁 / 用量回落到「线×0.9」 / 超过重试窗口）/ `recordStageRun`（成功与失败**都** disarm）/ `recordStageObservation`（只留痕、不动上锁）。**运行状态与执行者同生命周期**：`sweep` / `fold` 在本扩展内存（`context.js` 的 `stageRuntimes`，上限 200 防无界），`compaction` 在主进程（`ContextPolicyState`）；两组状态不共享任何东西（连进程都不是同一个），所以「一个阶段 disarm 不影响另一个」是结构上成立的。两个有意的例外在文件头写清楚了：**sweep 不受冷却约束**（幂等、已由收益门槛把关，加冷却只会压住后续清理）、**fold 在扩展侧实际由重试窗口节流**（拿不到工作集 ⇒ 用量回落那条路径不成立）| `context.js` 的 `onContext`（sweep）与 `onAgentSettled` / `produceAndCommit`（fold，**模型调用之前**判定）；单测 `test-context-stage-runtime.mjs`（26 条）+ `test-context-producer.mjs` 的 4 条接线断言 |
| `context-deep.js` | 216 | **Deep Context / N21-8（Pass 1 工作集归纳，默认关）**：`deepSwitches`（策略解析）/ `deepEligible`（四道闸门：开关 → 有新用户消息 → 本轮没跑过 → 转录 ≥ `minTokens`，默认 150k）/ `turnKeyOf`（同一条用户消息的标识，只用文本前 80 字符，不依赖 `ctx.sessionManager`）/ `buildDeepInput`（从尾部装、长内容截头留尾、输入 ≤ 24k token）/ `parseDeepOutput`（去围栏、认「无」、限长）/ `renderWorkingTrace`（`derived="true" authoritative="false"` 契约头）/ `injectWorkingTrace`（幂等，插到消息最前，与 `<TASK_STATE>` 共存）。调用点在 `context.js` 的 `onContext` ④ 与 `runDeepPass`：`ctx.modelRegistry.complete(ctx.model, {systemPrompt, messages}, {maxTokens, signal})` —— 它是**同步阻塞**的（归纳必须在请求发出前完成），失败一律静默降级为不注入 | `context.js` 的 ④；单测 `test-context-deep.mjs`（+36）；live `contextdeep`（cost 1） |
| `ContextTab.tsx` | 341 | 「上下文」设置页（N21-7 + N21-8）：预设 / 用户级三个数值 / 模型级覆盖 / **生效来源**，以及 **Deep Context 开关**（`data-testid="ctx-deep"`）。数值用草稿 + 显式保存（逐键写盘会写进一堆半成品），而 Deep Context 是即时开关（点一下写一次盘）。它的传递链是「渲染端 → 主进程 → `desktop.json` → 扩展读文件」，所以**改完立即生效、不用重建 pi 实例** | `main/settings.ts` 的 `sanitizeContextDeep`；`shared/ipc.ts` 的 `AppSettings.contextDeep`；live `contextdeeppref`（cost 1，验证「界面开的开关扩展真的读到了」）；视觉 `matrix-ctxsettings-*` |
| `language.js` | 119 | 界面语言 → **一句**推理/回复语言要求（每轮读 `desktop.json`）。两个钩子：`before_provider_request` 在**最后一条用户消息前**插一条独立消息（主通道，实测位置最强）、`before_agent_start` 追加到系统提示末尾（兜底）。**不用** `--append-system-prompt`：那是启动参数，切语言必须重建实例（D37/D39/D40，理由与实测数据写在文件头） | 同上；单测 `test-language-extension.mjs`；live `test:live -- language`（注入取证：`YAN_LANG_EXT_LOG`） |

> ⚠️ 与 `resources/pi-runtime/` 的区别：**这里是源码**（可改、随包分发）；
> 那个是生成物（Git 忽略、`npm run upgrade:pi` 重生成、**不手改**）。

---

## 7. `scripts/` —— 测试与工具（183 个文件：入口 + 单测 + 探针 + 工具脚本）

### 7.1 入口

| 文件 | 功能 |
|---|---|
| `test-unit.mjs` | 单测入口：用 esbuild **现场编译**被测模块（不拉 React/Electron），再跑 47 个 `test-*.mjs` |
| `test-live.mjs` | live 场景入口：建隔离 sandbox（`YAN_*` + 复制 `auth.json`/`models.json`），起真应用跑探针。场景表就是 `CASES`。**要能在被 Ctrl+C / 被 kill 时收掉 Electron 子进程树**（否则会留下继续往死管道写日志的孤儿）。另有两个附属设施：合成 fixture 项目树（`buildFixtureProject`）与 **L04 的本地 HTTP 服务**（`startBoundaryServer`，127.0.0.1:39873：下载 / Cookie 哨兵 / 真实权限请求 / 内网目标） |
| `launch.mjs` | 一键启动（检查依赖 → 必要时构建 → 起应用） |
| `probe-pi.mjs` | 只验证「pi 能否被找到并启动」，不开窗口 |
| `lib/stdio-guard.mjs` | 独立 Electron 脚本的 stdio 护栏（导入即生效）：EPIPE 容忍、`uncaughtException` → 退出码 1（不然 Electron 会弹模态框把父进程一起拖死）、`muteMissingHandlerNoise()` 静音预期内的 handler 缺失。理由见 [MAINTENANCE](MAINTENANCE.md) |
| `visual-matrix-run.mjs` | 视觉矩阵分批入口：每组一个 Electron 进程。**超时收整棵树 + 信号转发**（不再用 `spawnSync`：它阻塞事件循环，子进程一卡就永久不返回） |

### 7.2 单测模块（55 个 `test-*.mjs`）

按被测目标分：`at-query` / `build-info` / `capability-request` / `chrome-profile` / `command-registry` / `compaction-status` / `context-deep` / `context-policy` / `context-producer` / `context-safety` / `context-stage-runtime` / `context-state`（S1）/ `context-transform`（S2–S6）/ `credentials` / `exit-snapshot` / `filerefs` / `files` / **`git-review`（G1 纯解析，124 条）** / **`git-repo`（G1+G2 真实 git 仓库，含写操作）** / **`git-actions`（G2 失败分类与命令构造，42 条）** / `ipc-error` / `language-extension` / `links` / `manual-title` / `model-capabilities` / `network-boundary` / `network-policy` / `oauth` / `project-id` / `project-session` / `question` / `queue-items` / `rail-order` / `remote` / `response-detail` / `runners` / `session-layout` / `session-runtime` / `slash-query` / `snapshots` / `stdio-guard` / `stream-deltas` / `stream-width` / `subagent-isolation` / `subagents` / `title-samples` / `todo-history` / `turns` / `workspace-changes` / `zoom`。

> `cookie-transfer` 是**独立**入口（`node scripts/test-cookie-transfer.mjs`），不在 `test-unit.mjs` 的链上；
> `test-live` / `test-packaged` / `test-unit` 是入口本身。数模块数（`test-unit.mjs` 里被 import 的那些）用于
> 对照 HANDOFF 的「单测 N/N 通过」。

### 7.3 live 探针（111 个文件；110 条在 `CASES` 里）

在**真实渲染进程**里执行（`window.__yanStore` 可直接驱动状态）。
按主题分组（新增探针同时要在 `test-live.mjs` 的 `CASES` 注册）：

> **例外（不在 CASES 里，别当孤儿）**：`survey.js` 由手工 `YAN_PROBE` 驱动（结构勘察，不断言，
> 用法见 §11.8）；`packaged.js` 由 `test-packaged.mjs`、`sidebar-review.js` 由 `review-ui.mjs`、
> `chrome-cdp.mjs`（`.mjs`，不是 `*.js`）由 `probe:chrome` 驱动。
> `npm run audit:refs` 的 `probes.orphanCount` 应当**只剩这 4 个** —— 多了就是漏注册，少了是文档该改。

- **会话/运行**：`sessions`、`sessionrunners`、`runnerselect`、`sessionlayout`、`tray`、`rename`、`queuestack`
- **模型/命令/引用**：`modelmenu`、`modelnotready`、`capabilityload`、`slashcmd`、`at-path`、`fileref`
- **对话渲染**：`reasoning`、`toolgroup`、`toolrow`、`tools`、`detail`、`streamwidth`、`virtual`、`outline`
- **布局/视觉**：`layout`、`narrow`、`vheight`、`resize`、`panels`、`symmetry`、`railmini`、`railtitle`、`railsearch`、`railreorder`（N01：合成 PointerEvent 走真实拖拽路径 + 回读 `getSettings` 验落盘）、`projectlimit`、`zoom`、`light`、`density`、`topbar`、`titlebar`、`motion`
- **文件/浏览器**：`fs`、`linkpreview`、`browser`、`external-chrome`（场景名 `externalchrome`）、`browser-boundary`（场景名 `browserboundary`，L04：权限真实请求 / 本地预览边界 / DNS 重绑定 / 两条下载路径 / Cookie 真实复制；**需公网，不进 check**）
- **其他**：`live`（DOM 体检）、`logs`、`perf`、`sound`、`hotkeys`、`working`、`trash`、`contextstate`（S1：删会话清派生状态）、`contextsweep`（S2：真实回合 Tool Sweep + recall）、`onboarding`、`grouprename`、`autonomous`、`subagent`、`terminal`、`todos`、`todonew`
- **勘察（不在 CASES）**：`survey`（§11 的真实窗口 dump，靠手工 `YAN_PROBE` 跑）

### 7.4 构建 / 发布 / 诊断

| 文件 | 功能 |
|---|---|
| `vendor-pi.mjs` | 把已安装的 pi 抽成**可独立运行**的运行时 → `resources/pi-runtime/` |
| `upgrade-pi.mjs` | 对比版本并按需重提取 + 自检（`--check` / `--force`） |
| `test-packaged.mjs` | 验收已有解包产物（包内 pi 能否启动、扩展是否加载） |
| `build-icon.mjs` | 生成 `build/icon.ico` + `icon.png` |
| `shot.mjs` / `shots.mjs` / `shot-fixture.js` | Electron 截图；`shots` 生成 README 用图（注入假数据，不调模型） |
| `live-preview.mjs` / `review-ui.mjs` / `ui-review.js` / `capture-review-window.ps1` | UI 评审辅助（隔离，不碰真凭证） |

### 7.5 CSS 工具链（P0-1 样式收敛的产物）

`css-inventory.mjs`（谁定义/谁覆盖）、`css-tokens.mjs`（令牌清单）、`css-layer-check.mjs`（**层叠等价校验**：迁移后最终生效声明必须一字不变）、`css-consolidate.mjs` / `css-migrate.mjs` / `css-split-check.mjs`（归并/迁移/拆分等价）、`css-dead-rules.mjs`（死规则）、`lint-css.mjs`（守卫：`1fr` 必须写 `minmax(0, 1fr)`）。

---

## 8. 枢纽文件（被 import 次数）

| 次数 | 文件 | 意味 |
|---|---|---|
| 44 | `shared/ipc.ts` | 契约。改它 = 跨进程改动 |
| 26 | `state/store.ts` | 全部 UI 状态与动作 |
| 26 | `icons/Icon.tsx` | 每个组件都在用 |
| 10 | `main/paths.ts` | 数据路径 |
| 8 | `browser/CdpChannel.ts` | 两种 CDP 实现的公共接口 |
| 5 | `lib/modalLayer.ts` | 所有模态框的基座 |
| 4 | `shared/turns.ts`、`main/protocol.ts`、`chat/MessageParts.tsx` | 回合分组 / RPC / 共享渲染件 |

---

## 9. 改动波及面速查

| 你要改… | 必须同时看 |
|---|---|
| 新增/改 IPC | `shared/ipc.ts`（类型 + `YanBridge`）→ `preload/index.ts`（暴露）→ `main/index.ts`（handler）→ `store.ts`（消费）。四处少一处就静默不通 |
| 改 pi 协议交互 | 只动 `protocol.ts` / `agent.ts` / `normalize.ts`（**不要**把协议细节泄漏到别处） |
| 改样式/视觉 | 先改 `docs/design/DESIGN.md`，再同步 `styles/tokens.css`；跑 `npm run typecheck`（含 CSS 守卫 + 层叠自检） |
| 改网格布局 | 弹性列一律 `minmax(0, 1fr)`；`lint-css.mjs` 会拦 |
| 改推理块 | `Reasoning.tsx` + `chat.css` 的 `.clip/.is-clipped/.expanded` + `tokens.css` 的 `--reason-max-h` + `probe/reasoning.js`（探针钉死了契约）+ `DESIGN.md` |
| 改模型/思考档位 | `shared/model-capabilities.ts`（归一化）→ `agent.ts`（能力快照）→ `store.reloadModels` + `state/capability-request.ts`（过期判定）→ `Pickers.tsx` + `RightPanel.tsx` |
| 改会话/项目归属 | `main/session-layout.ts` + `main/sessions.ts` + `store` 的 `switchSession`/`moveSession` + `Rail.tsx`；有单测 |
| 改侧栏项目/分组顺序（拖拽） | 顺序计算在 `shared/rail-order.ts`（纯函数，单测 `test-rail-order.mjs`），指针几何与落点判定在 `Rail.tsx` 的拖拽区块（`.is-dragging` / `.drop-before` / `.drop-after` 三个类在 `rail.css`）。**三条边界不要放开**：① 搜索态不允许拖（顺序被筛过）；② 落点必须同组（跨组是归属变更，走右键菜单）；③ 拖拽结束后那个 click 必须被吞掉（否则顺带切项目）。落盘是 `AppSettings.projectOrder`（项目）+ `projectGroups` 数组顺序（分组），证据 `test:live -- railreorder` + `matrix-railreorder-{dark,light}` |
| 改上下文状态 schema（TaskState / EpisodeState / Archive） | **唯一真源**是 `shared/context-state.ts`：先改 schema + 校验，再同步 `main/context-state-store.ts`（原子写/丢弃）与 `scripts/test-context-state.mjs`。`schemaVersion` 一变，旧文件必须走「不兼容 → 安全丢弃」，不能尽力解析。provenance 只能填**原始 entry id**（`main/context-watermark.ts` 读出来的），不许用数组下标/token/`ctx://`。删会话清理走 `sessions.ts` 的 `deleteContextStates`（含 `.recall.json` / `.recall.jsonl`），回归网是 `test:live -- contextstate`；证据与切片边界见 [方案 §14](../design/方案-上下文工具内的自动压缩-2026-09-15.md) |
| 改「发给模型的消息」（Tool Sweep / Task State / Recall） | 纯逻辑在 `resources/pi-extensions/context-transform.js`（单测 `test-context-transform.mjs`），钩子与工具在 `resources/pi-extensions/context.js`。三条不许绕：① 默认 `kinds` 不含 `tool-sweep`/`episode-fold` 时**不许动消息**；② entry id 对齐失败就整轮放弃；③ 提交前必须过 `context-safety` 的 `violations()`。JS 产出的归档文件要与 TS schema 对得上（单测里有交叉校验）。真实回归是 `test:live -- contextsweep`（cost 1，需一个会调工具的模型；默认免费模型当天返回空文本时用 `YAN_TEST_MODEL` 换）。**语义状态生成已于 2026-09-17 落地**（S7）：纯逻辑在 `resources/pi-extensions/context-producer.js`（单测 `test-context-producer.mjs` ~114 条），触发与落盘在 `context.js` 的 `onAgentSettled` / `produceAndCommit`，真实回归是 `test:live -- contextproduce`（cost 1，需一个会调工具的模型）；模型调用走扩展内的 `ctx.modelRegistry.complete()`（方案 §16.1），**不要**为它起第二个 pi 进程 |
| 改文件树 / `@` 补全 / 搜索 | `main/files.ts`（listDir/searchFiles 边界）+ `main/credentials.ts` 的 `completePath` + `index.ts` 的 `resolveFileContext`（cwd+projectId+generation 校验，D14 在这里兜底）。live 证据：`fs` / `fsedge` / `atPath` / `atpathedge` / `projectswitch`（后三个用 test-live 的合成 fixture 项目） |
| 改工具调用的“改了什么” | `main/snapshots.ts`（写入类工具的单文件快照 + shell 的目录级快照，L05）+ `agent.ts`（`tool_execution_start/end` 与 `runBash/finishBash` 的取/挂）+ `ToolDetails.tsx` 的 `WorkspaceChangesDetail` + `chat.css` 的 `.wsc-*`。注意：`isShellTool` 名单要与渲染端 `detailKind` 的 `'command'` 分支一致，否则会出现“看着是命令却没改动卡片” |
| 改后台会话/身份 | `main/runners.ts`（身份封套）+ `store.applyPush`（身份闸门）+ `state/session-runtime.ts`（缓存）。**三处必须一致**，否则事件会被静默丢弃 |
| 改文件访问边界 | `main/files.ts`、`main/file-refs.ts`、`main/credentials.ts` 的 `completePath` —— 三者是同一条「只能看 cwd 以内」的约束 |
| 改浏览器坐标 | 原生视图永远盖在渲染层之上；坐标必须乘 `win.webContents.getZoomFactor()` |
| 改输入区（发送键提示 / 自主开关 / 模型胶囊） | 三样都在 `Composer.tsx` 的 `.composer-bar` 里；**模型菜单必须 `position: fixed`**（`.composer` 是 `overflow: hidden`，圆角与光带需要它），坐标由 `Pickers.tsx` 按触发器 rect 写进 inline style —— 改回 absolute 会被整块裁掉。档位文字与输入框顶边框共用 `--think-*`（DESIGN §2.6），改档位色要同步 `motion.css` 与 `composer.css` 两处映射。长文模式的高度过渡只开在 `.composer.animating` 那一瞬间（常开会拖慢打字自动长高与拖动跟手）。回归网：`sendkey`（提示条件 + 高度过渡）/ `autonomous`（双光带相位）/ `modelnotready`（档位染色）/ `modelmenu` / `layout` / `vheight`；视觉矩阵 `autonomous` 状态 |
| 改“生成中发送”的投递方式 | 三层：`Composer.submit` 用**回合级**判据（`runners[active].running` **或** `session.isCompacting`）→ `store.holdSend` 挂进 `pendingSends`（只存在渲染端）→ 用户点插话/排队 走 `store.releaseSend(id, mode)` → `yan:send` 的第三个参数 → `agent.ts` 的 `payload.streamingBehavior`。⚠️ 判据里两个“或”都不能掤：`isStreaming` 在工具执行期间是 false，`running` 在**回合之间的自动压缩**期间是 false —— 用错就会把裸 prompt 投给 pi（它报「Agent is already processing」），而 `submit` 已经清空了输入框，消息直接丢。

⚠️ `QueueStack` 里那个**同名但不算 `isCompacting`** 的判据不是写漏：压缩时模型没在生成，“插话”没有意义，卡片只给一个「发送」（内部 `followUp`）。两处职责不同，别“顺手统一”。

改任何一层都要同步“回合结束/压缩结束后自动按 followUp 投递”那个 effect（`Composer` 里，依赖 `[roundRunning, pendingSends]`，靠投递后列表变化自己触发下一条）。回归网：`pending`（cost 0，**已进 check**，第 9 节专钉压缩态）与 `test:live -- queue`（cost 1，真调模型） |
| 改左栏折叠 / 项目会话列表 | 左栏收起 = `--w-rail-collapsed: 0px`（layout.css，**只在那里定义**）+ `.app.rail-off .rail { display: none }`（rail.css）；N14 的 `.rail-compact` mini 轨已被用户要求删除，别再加回来。项目下的会话默认只列 `SESSION_PREVIEW = 5` 条，**当前会话落在折叠段里要自动展开到它那一行**。回归网：`railmini`（**已进 check**）/ `railsearch` / `grouprename` / `railtitle` / `projectlimit`；视觉矩阵 `railmini` / `railsessions` 状态 |
| 改工具组 / 详情的高度上限 | 两套量（DESIGN §3.5）：**工具组** `.tgroup-body` 的单位是“条”—— 用户 2026-09-19 要求「改为 25 条」，所以上限写成 25 行的像素（`min(623px, 80vh)`，行步进实测 ≈ 24.8px），**不要再换成 vh**；**单条详情** `.trow-body > :not(.term)` 与**推理全文** `.reason-body.clip.expanded` 是一段连续文本，用 `min(70vh, 620px)`；选择器必须排除 `.term`（终端窗口自带高度与缩放手柄，套上会出现「终端外面还有一层滚动条」）。三者都靠“头部在 body 外面”成立：`tgroup-head` / `trow-head` / `reason-head` 就是那个「折叠回去的按钮」。回归网：`toolgroup`（第 6 节造 60 条长组，**按实测行步进换算可见条数并要求 ≥ 25**）/ `reasoning` / `toolrow`；视觉矩阵 `toolgroup`（62 条长组）与 `toolterm` |
| 加 live 探针 | 写 `scripts/probe/<scenario>.js` **并且**在 `test-live.mjs` 的 `CASES` 注册；改完源码先 `npm run build`（`test:live` 不会自动构建）。需要在 **Electron 关闭之后**才能看到的结论（退出归档、临时目录、主树最终状态）用 `afterExit` 钩子，由 Node 侧直接查文件系统 |
| 要截图/视觉证据 | `npm run visual:matrix`（`scripts/visual-matrix.mjs`，分批入口 `visual-matrix-run.mjs`）：注入 `shot-fixture.js` 的合成数据，按“尺寸 × 缩放 × 主题”建真实窗口截图到 `docs/design/preview/matrix-*.png`。新增一组就改 `GROUPS` / `STATES` / `MUST_HAVE`（截图前必须核对的关键元素）。写临时图片用 `YAN_SHOT_DIR=…`，否则会**覆盖已有证据文件**（同名同日） |
| 改浏览器网络边界 | 判定住 `main/browser/network-boundary.ts`（纯函数 + 单测），`browser.ts` 只负责落成「放行 / 拦下记账 / 再解析」；**发起方必须用 `tab.committedUrl`**（不是 `state.url`：那是导航发起时的期望值，D24）；拦下的请求要进 `blockedRequests` 并在界面上看得见（D26）。证据：`test-network-boundary.mjs`（21 条）+ `test:live -- browserboundary`（真实 DNS 重绑定 / 302 借道 / 两条下载 / Cookie 复制） |
| 碰子进程 / 日志管道 | 独立 Electron 入口脚本（`visual-matrix` / `shots` / `shot` / `live-preview` / `measure-design`）必须先 `import './lib/stdio-guard.mjs'`：EPIPE 容忍 + `uncaughtException` 变成“退出码 1”。父进程侧（`visual-matrix-run.mjs`、`test-live.mjs`）要留超时并能收整棵进程树。桌面应用侧是 `src/main/stdio-guard.ts`（**不退出**，只上报）。理由与定位方法见 [MAINTENANCE](MAINTENANCE.md) 的「子进程与日志管道」 |
| 改子代理隔离/生命周期 | `subagents.ts`（生命周期、转录、归档）+ `subagent-isolation.ts`（worktree/补丁）+ `SubagentPreview.tsx`；证据：`test-subagents.mjs` + `test:live -- subagentpair`（真起两个以上 pi 子进程） |
| 改会话运行实例/切换 | `runners.ts`（`select` 的命中/复用/拒绝、`RUNNER_LIMIT`、`statuses()`）+ `store.ts` 的 `applyPush` 身份过滤与 `sessionRuntimes` 缓存 + `Composer.tsx`（按钮的 `busy` 取 `isStreaming`，工具执行期间为 false）；证据：`test:live -- sessionrunners`（注入推送，不连 pi）+ `test:live -- sessionab`（真实三会话：切走不停 / 同 cwd 拒绝 / 单独停止 / 退出落盘） |
| 改本地斜杠命令 | `main/command-registry.ts`（`LOCAL_COMMANDS` + 来源分类）→ `Composer.tsx` 的 `localName` 分支（`/new` `/compact` `/browser` `/model` `/login` `/subagent` 真的在这里执行；**参数是契约**：`/new` 必须带 `scope:'global'`、`/browser` 无参必须传 `undefined`）→ `store.ts` 对应动作。兼容来源与 `executable:false` 必须继续被吞掉（不发模型）。证据 `test:live -- slashcmd`（19 节，含三次反向验证） |
| 改 Git **写**操作（暂存 / 提交 / 分支 / 推送） | **全部**在 `main/git-actions.ts` 一个文件里（`git-service.ts` / `git-diff.ts` 里没有 `add`/`commit`/`switch`/`reset`/`stash`）。三条不要放开：① 不碰 `subagent-isolation.collectDiff()`；② 不复核预期版本而一律比三件套会造出假冲突（分级理由见文件头）；③ 不 stash / reset / force / `--no-verify`。回归网：`test:unit`（含 `test-git-repo.mjs` 的 G9 节，真仓库真写）+ `test:live -- gitwrite`（退出后用真 git 核对提交与 bare remote）；视觉 `reviewwrite` / `envbranches` |
| 改 Git 审查（环境菜单 / 审查面板，只读） | 数据层是 `shared/git.ts`（纯解析，零 IO）→ `main/git-service.ts`（命令与边界）→ `main/git-diff.ts`（清单 / patch / 内容）→ `yan:git:*`。**三条不要放开**：① 不碰 `subagent-isolation.collectDiff()`（它会 `git add -A`）；② 渲染端不能传 git 命令，ref 走 `refLooksSafe`、路径走 `safeRepoPath`；③ 只读查询带 `--no-optional-locks`（`status` 默认会写 index）。回归网：`test-git-review.mjs` + `test-git-repo.mjs`（真仓库，含 index 逐字节不变的断言）+ `test:live -- gitreview`（含 `afterExit` 只读比对）；视觉矩阵 `envmenu` / `review` 状态 |
| 加单测 | `scripts/test-<module>.mjs` + 在 `test-unit.mjs` 里用 esbuild 编译被测模块（参考 `at-query` 的写法） |
| 删任何样式/组件 | 先核对导入顺序与动态类名；`stage1`/`stage2`/`redesign` 名字旧不代表无用 |

---

## 10. 不在本图的目录

- `resources/pi-runtime/` —— **生成物**（Git 忽略），`npm run upgrade:pi` 重生成，不手改
- `out/`、`release/` —— 构建与分发产物（Git 忽略）
- `docs/` —— 见 [docs/README.md](../README.md)

---

## 11. 运行时实测（真实窗口 · 2026-09-15）

> 视觉证据（截图）现在由 `npm run visual:matrix` 产出：26 张 `docs/design/preview/matrix-*-2026-09-16.png`，覆盖 1440x900 / 940x620 / 900x520 × 100% / 125% / 150% × 深/浅 + 引导层 + 窄右栏文件树（`fsnarrow`）+ shell 改动卡片（`wschanges` / `wsunknown`），每张都带“横向溢出 ≤ 1px、关键元素在 DOM 里”的硬断言。下面是 2026-09-15 那次逐元素实测的骨架尺寸，仍然有效。

> 本节**不是**读源码推断的，而是把应用跑起来、在渲染端 dump 出来的。
> 用途：核对上面的「关系」是否漂移 —— 字段叫 `sessionId` 还是 `id`、谁渲染谁、
> 空分区到底渲不渲染，只有真跑一次才知道。
> 复现入口：[`scripts/probe/survey.js`](../../scripts/probe/survey.js)（用法见 §11.8）。

### 11.1 骨架尺寸（1440×900 窗口 → 内容区 1251×783）

| 块 | 类名 | 尺寸 |
|---|---|---|
| 标题栏 | `header.titlebar` | 1251×36 |
| 工作区 | `div.workspace` | 1251×747 |
| 左栏槽 | `div.rail-slot` | 260×747 |
| ├ 左栏 | `aside.rail` | 260×747 |
| └ 拖拽把手 | `div.resizer.resizer-rail` | 5×747 |
| 主区 | `section.center` | 727×747 |
| ├ 会话头 | `div.shead` | 727×36 |
| ├ 消息流 | `div.stream` | 727×540 |
| └ 输入区 | `div.composer-wrap` | 727×172 |
| 右栏 | `aside.rightpanel` | 264×747 |
| ├ 拖拽把手 | `div.resizer.resizer-panel` | 5×747 |
| ├ 头 | `div.rp-top` | 263×39 |
| └ 体 | `div.rp-body` | 263×709 |

水平 **260 + 727 + 264 = 1251** ✓（两个 resizer 各 5px 含在各自槽内）。
根节点还带一个状态类：`div.app.rail-pinned`。

### 11.2 输入区内部（`.composer-wrap`）

```
.composer 679×114
 ├ .cborder           678×24   ← ComposerBorder（输入框顶边的工作状态动画）
 ├ .composer-resize    96×12
 ├ textarea           654×43
 └ .composer-bar      654×30
    ├ .composer-tools 616×26 → button.ctool + button.ctool.auto-toggle + span.ctool-hint
    └ button.send      30×30
.usagebar 679×22
 ├ .ub-item（速度） / .ub-turn（输入/输出/缓存）   ← 无数据显示 “—”
 ├ span.spacer
 └ .picker-wrap 157×22                           ← 模型 + 思考档位选择器
    └ button.mt-trigger 157×22
       ├ span.mt-model  “DeepSeek V4.1 Flash”
       ├ span.mt-level  “高”
       └ span.mt-chev   “▾”
```

→ **模型选择器确实挂在用量条里**（`Composer.tsx` → `UsageBar.tsx` → `Pickers.tsx` 的
`ModelThinkingPicker`），模型名与思考档位同一行。没有用量数据时 `.ub-item` 显示 `—`，
**而不是让整条消失** —— 这是「看不到模型选择」那次修复的可见结果。

### 11.3 `store.session` 的真实字段（与直觉不符）

```json
{
  "sessionId": "01a0a42a-…",          // 是 sessionId，没有 id
  "sessionFile": "C:\\…\\<时间戳>_<id>.jsonl",
  "model": { "id": "deepseek/deepseek-v4.1-flash", "provider": "commandcode",
             "reasoning": true, "reasoningStatus": "known", … },
  "thinkingLevel": "medium",
  "availableThinkingLevels": ["off","minimal","low","medium","high"],
  "thinkingLevelsStatus": "known",
  "capabilities": { "modelKey": "commandcode/deepseek/deepseek-v4.1-flash", … }
}
```

### 11.4 身份三件套：同一运行实例以**两个键**存在

```
runners[0]     = { id:"r1", runId:"r1", sessionId:"01a0a42a-…", projectId:"project-Yzovd…",
                   generation:1, cwd:"C:/…", conn:"ready",
                   running:false, waiting:false, failed:false, isActive:true }
statuses       = {}                       ← 没有运行中实例时为空对象
activeRunnerId = "r1"
Object.keys(sessionRuntimes) = ["pending:r1", "01a0a42a-0bdc-76ff-8358-0fa2e8527263"]
```

**最后一行是关键证据**：同一个运行实例先后以 `pending:r1`（启动期）和真实 `sessionId` 为键。
`state/capability-request.ts` 之所以必须用 `runId` 判过期、**不能**拿 `sessionId` 做等值比较，
原因就摆在眼前。

### 11.5 右栏分区的真实渲染顺序

`settings.toolOrder` = `["todo","context","files","quota","queue","ext","log","actions"]`

实测渲染出来的只有：**`context → files → quota → queue → log → actions`**
→ `todo` 与 `ext` 当时没有数据，**完全不渲染**（空分区既不占位也不参与排序）。

每个分区的外壳：
`.rp-slot > section.rp-sec(.open) > [.rp-sec-row(.rp-grip + .rp-sec-head)] + .rp-sec-body`

### 11.6 其余实测事实

| 事实 | 值 |
|---|---|
| `piInfo`（注意**不是** `pi`） | `{ bin, home, version:"0.85.1", source:"bundled", bundled:true, bundledAvailable:true }` |
| 会话目录按 cwd 编码 | `sessions/--C--Users-YuDaTou-Desktop-pi-desktop--/<时间戳>_<id>.jsonl` |
| 模型 provider（去重） | `deepseek` / `openai-codex` / `commandcode` |
| 命令 `source` | `yan`（本地路由）；扩展/技能命令另计 |
| `thinkingLevels` | `["off","minimal","low","medium","high"]` |
| `session.model` 字段 | 带 `reasoningStatus` / `inputStatus` / `contextWindowStatus` 等**成对状态**（见 `shared/model-capabilities.ts`） |

### 11.7 store 的投影面（实测 `Object.keys(state)`，80 个键）

读、写、动作混在同一层，按用途分组（键名照抄实测输出）：

- **连接 / 内核**：`conn` `connDetail` `piInfo` `startupPhase` `startConnWatch` `redetectPi` `log` `logs` `notices` `dismissNotice` `dismissRequest`
- **会话**：`sessions` `session` `peekedPath` `peekNote` `switchSession` `newSession` `deleteSession` `renameSession` `moveSession` `refreshSessions` `fork` `clone` `changeCwd` `titles` `manualTitles` `title` `titleCandidates` `acceptTitleCandidate` `dismissTitleCandidate` `setManualTitle` `regenerateTitle` `exportHtml` `copyLastReply`
- **运行实例（N12）**：`runners` `statuses` `activeRunnerId` `sessionRuntimes` `syncRunners` `stop`
- **对话**：`messages` `send` `abort` `abortBash` `abortRetry` `compact` `stats` `todos` `todoHistory` `queue` `queueRestore` `consumeQueueRestore` `removeQueued` `steerQueued` `setSteeringMode` `setFollowUpMode` `consumeEditorInject` `editorInject` `runBash` `autoRetryEnabled` `setAutoRetry` `setAutoCompaction`
- **模型 / 命令**：`models` `setModel` `cycleModel` `cycleModelBack` `thinkingLevels` `setThinking` `cycleThinking` `reloadModels` `commands` `commandsAt` `reloadCommands` `commandUse` `markCommandUsed`
- **附件 / 文件**：`attachments` `addAttachments` `addFileRefPaths` `addFileRefs` `removeAttachment` `clearAttachments` `pickImages` `filePreview` `previewFile` `closePreview`
- **子代理**：`subagents` `loadSubagents` `openSubagent` `subagentPreviewId` `discardSubagent` `mergeSubagent` `startSubagent` `stopSubagent` `clearSubagents`
- **浏览器**：`browserState` `openBrowser` `closeBrowser` `openExternalChrome` `closeExternalChrome` `syncPageStorage` `syncLocalProfile`
- **设置 / 外观**：`settings` `settingsOpen` `settingsTab` `setSettingsTab` `patchSettings` `setSettings` `patchProfile` `openSettings` `closeSettings` `alwaysOnTop` `toggleAlwaysOnTop` `maximized` `zoom` `loadZoom` `setUiScale` `uiCollapsed` `setUiCollapsed`
- **右栏 / 布局**：`toolDropTarget` `setToolDropTarget` `setPanelWidth` `setToolHeight` `setToolLayout` `toggleRightPanel` `setRightPanelOpen` `railPinned` `setRailPinned` `widgets`
- **UI 草稿 / 扩展 UI**：`uiRequests` `uiDrafts` `setUiDraft` `answerUi` `setSessionDraft`

> 探针与自动化脚本通过 `window.__yanStore` 直接调这些动作（挂载点见 `src/renderer/src/main.tsx`）。

### 11.8 复现方式

```bash
npm run build      # 必须：探针读的是 out/，不是 src/
env -u ELECTRON_RUN_AS_NODE \
  YAN_USER_DATA=<临时目录> YAN_DATA_DIR=<临时目录> \
  YAN_SESSIONS_DIR="$HOME/.pi/agent/sessions" YAN_PI_DIR="$HOME/.pi/agent" \
  YAN_PROBE=scripts/probe/survey.js YAN_PROBE_DELAY=14000 \
  YAN_PROBE_OUT=<输出文件> npx electron .
```

三个坑（都踩过）：

1. 必须 `env -u ELECTRON_RUN_AS_NODE`，否则 Electron 退化成纯 Node（无窗口、静默 exit 0）。
2. 必须用**隔离的** `YAN_USER_DATA` —— 单实例锁按 userData 路径命名，撞上就静默 `app.exit(0)`。
3. 结果要写 `YAN_PROBE_OUT` 文件：Windows 上 GUI 进程的 stdout 不保证可用。

截图同理，用 `YAN_SHOT=<png>`（走真实主进程 + `capturePage`，离屏捕获，不受窗口遮挡影响）。
视觉留档见 [`docs/design/preview/runtime-survey-2026-09-15.png`](../design/preview/runtime-survey-2026-09-15.png)。
