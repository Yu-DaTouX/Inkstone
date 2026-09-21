# 测试指南（含「测试用哪个模型」）

> 本文是**测试约定**的单一真源。每次加/改测试场景前先读一读，
> 尤其是「测试模型」一节 —— 它决定真实调用会不会花钱。

## 三层测试

| 层 | 命令 | 特点 |
|---|---|---|
| 纯逻辑 | `npm run test:unit`（node） | 快、确定、能断言边界。不启动 Electron、不碰 pi、不花 token |
| UI + 接线 | `npm run test:live -- <场景>`（真实 Electron） | 完整主进程 / preload / IPC / pi 子进程。默认不调模型 |
| 真行为 | 带 `cost: 1` 的场景（见下） | 真模型、真工具、真图片 |

源码改动后先 `npm run build`，再跑 test:unit / test:live；live 不自动构建。运行 Electron 前，在 PowerShell 执行 `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`。

完整门槛为 `npm run check`，具体执行链以 [package.json](../../package.json) 为准；纯文档改动只核对内容、链接和命令，不必构建应用。
完整场景清单在 [`scripts/test-live.mjs`](../../scripts/test-live.mjs) 的 `CASES`。

**能跑的东西不要在单测里只“读它的文本”。** 随包 CLI（`resources/yan-cli/yan.mjs`）曾经
因为 help 文案里嵌了一对反引号而整个语法报错，而单测只断言了**启动器文件内容**
包含 `ELECTRON_RUN_AS_NODE=1` 与 `yan.mjs` 路径 —— 全部照绿，直到 cost 1 的 `taskcli`
才暴露（证据-02-S4 §2）。现在门槛里有：`node --check` + 真跑一次 `--help`。
同类地方（脚本 / 模板 / 生成物）优先“真跑一次”，而不是比对字符串。

**证据链自身的前提也要钉住。** 有的文件被删/被改之后**没有任何测试会报错**，
只是静默地少报几条 —— 例如少一个 fixture 扩展、少一个 live 场景接线、
打包配置里少一行 `extraResources`。 `test-unit.mjs` 里为此有一节「证据链前提」：
查 fixture 文件在不在、场景是否已接线、`electron-builder.yml` 里 `yan-cli` 的 from/to 还在不在。
新增这种「只影响证据数量、不影响其它断言」的前提时，一并补一条。

## 测试不得打扰用户（默认后台运行）

**用户明确要求：跑测试不要在前台弹窗。** 据此分三层：

| 模式 | 什么时候用 | 怎么开 |
|---|---|---|
| **不上屏**（默认） | 所有自动化回归、由 agent 代跑 | 默认 —— `test:live` 自动给子进程加 `YAN_PROBE_HIDDEN=1` |
| 不抢焦点但可见 | 需要人眼看窗口，但不想被抢焦点 | `YAN_SHOW_WINDOW=1 npm run test:live -- <场景>` |
| 正常显示 | 手动 `npm run launch` / `launch:dev` | 不带 `YAN_PROBE` |

实现：`YAN_PROBE_HIDDEN=1` 时主窗口**保持 `show: false`** 并 `setSkipTaskbar(true)`，
但**渲染与布局照常** —— 因为 `YAN_PROBE` 下已经关掉了 Chromium 的后台节流
（`disable-background-timer-throttling` / `disable-renderer-backgrounding` /
`disable-backgrounding-occluded-windows`，见 `src/main/index.ts`）。

**这个模式不能替代的东西**：

- **人工视觉验收**（`visual:matrix`、`shot`、`docs/design/preview/` 的截图）必须看真实窗口；
  它们本来就是显式的人工动作，**不要**为了「省事」而顺手跑，也不要用隐藏模式代替。
- 依赖**真实窗口是否上屏**的观察（例如「测试把焦点从另一个桌面抢走」这类回归）
  在隐藏模式下测不出来。

**纯逻辑与 pi 层验证天然无窗口**：`test:unit`、`probe-pi`、`vendor:pi:check`
都不启动 Electron 窗口，属于最安全的跑法。**要验证 pi 本身时优先用它们**，
不要为了「顺手看看界面」去起 `test:live`。

## 测试模型（重要）

### 默认模型（以脚本配置为准）

所有**真实调用模型**的测试场景默认使用：

| 项 | 值 |
|---|---|
| 供应商 provider | `commandcode` |
| 模型 id | `longcat-2.0:free` |
| 传给 pi 的 `--model` | `commandcode/longcat-2.0:free` |
| 费用 | 脚本默认选择带 free 标识的模型；实际供应商计费与可用性需在调用前确认 |

默认配置用于避免跟随用户日常模型误耗额度；配置名不保证供应商长期免费或模型能力不变。

**免费模型有日配额**：免费模型触顶或供应商暂时不可用时，pi 可能收到 429，
而子代理/会话只会看到“assistant 消息内容为空 + `stopReason=error`”——看上去像事件流掉了，
其实是配额或供应商状态问题。确认方法：`YAN_DEBUG_SUBAGENT=1`（见
[MAINTENANCE](MAINTENANCE.md)）会把子代理事件落到临时文件。当前备用顺序是：
先用 `commandcode/longcat-2.0:free`，不可用或触顶时改用
`commandcode/laguna-s-2.1-free`。

### 覆盖方式

```powershell
$env:YAN_TEST_MODEL = "provider/modelId"
npm run test:live -- e2e
Remove-Item Env:YAN_TEST_MODEL
```

- 变量：`YAN_TEST_MODEL`（默认见上）。
- 凭证与模型配置从真实目录只读复制到隔离 sandbox，测试仅修改副本；详见“隔离与安全”。
- 注入点：[`src/main/agent.ts`](../../src/main/agent.ts) 在启动 pi 时把 `YAN_TEST_MODEL`
  变成 `--model <值>`。正常运行时该变量为空，不影响用户。

### 例外：需要视觉的场景

LongCat 2.0 free 是**纯文本**测试模型（`input: ["text"]`），发图会失败。
需要视觉的场景在 `CASES` 里用 `model:` 单独覆盖，默认用：

| 项 | 值 |
|---|---|
| 场景 | `image`（把图片真的发给模型） |
| provider | `commandcode` |
| 模型 id | `deepseek/deepseek-v4.1-flash`（`input: ["text", "image"]`） |
| 覆盖变量 | `YAN_TEST_VISION_MODEL` |

**以后加需要视觉的新场景**：在 `CASES` 对应项里写 `model: TEST_VISION_MODEL`。

### 例外：需要工具调用的场景（默认免费档不调工具）

2026-09-19 实测：默认的 `commandcode/longcat-2.0:free` **不会调用工具** ——
场景里那句「你必须先调用 bash 工具执行 seq 1 2000」会被它忽视，于是
`回合已发出=true｜真的跑起来=true｜消息数=4` 但 `工具输出长度=[]`，
断言「模型真的调用了工具」必红。**换能力模型即绿**（实测）：

```bash
YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash npm run check
```

受影响的场景（都要求模型真的动工具）：`contextsweep` / `contextproduce` /
`contextepisode` / `contextfoldpref` / `subagent` 等。
**跑全量门槛时统一带上这个变量**，否则会把“模型不干”当成“代码坏了”。

### 本地 llama.cpp 模型（用户环境的 `local/qwen3-local`）

`127.0.0.1:8081`（pi 的 `models.json` 里已注册 provider `local`），GGUF 在
`E:\AI\opencode\models\Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp\`，二进制是
`E:\AI\opencode\llama.cpp\llama-server.exe`。启动（与用户 `llama-webui/launcher.py` 同参数，
端口按 `models.json` 取 8081）：

```bash
llama-server.exe -m <gguf> --alias qwen3-local -c 65536 \
  --cache-type-k q4_0 --cache-type-v q4_0 --flash-attn on -ngl 99 \
  --jinja --parallel 1 --host 127.0.0.1 --port 8081
```

2026-09-22 实测（实施-11 H-1）：

- **它调工具，但对上下文长度敏感**：在仓库根（含 `AGENTS.md`，system + 工具约 6.8–8.6K）
  连续 9 次“必须调工具”都不调、只回话；换到 `fixture: true` / `fixtureSub: 'repo'` 的
  沙盒（~3K）后一次就调。**写 cost 1 工具场景时用 fixture 沙盒**，别拿仓库根当 cwd。
- **任务要不可猜**：“执行 `echo hi` 并回报输出”会被直接回答；要读一个模型不知道内容的文件。
- 先用一条 curl / fetch 单独验工具调用形状（应回 `finish_reason=tool_calls`，1–2 秒）。

判读探针里的工具调用时：**工具挂在回合较早的 assistant 消息上**，最后一条往往只是纯文本
回复。要按“最后一个 user 消息之后”汇总整轮，并用 DOM 的 `data-tools` / `.trow` 交叉验证，
否则会误判成“模型没调工具”（H-1 第一版就这样白查了三轮）。

### 例外：需要真实可见窗口的场景（`visible: true`）

隐藏窗口（`YAN_PROBE_HIDDEN=1`，测试的默认）里 Chromium 会把定时器**节流到 1 秒**，
于是量出来的耗时会是 `1000.1ms` / `1000.2ms` / `1000.4ms` 这种**整数秒**，
而性能断言的阈值是 250ms（左/右栏收放）、400ms（最坏一次）——必红。

所以 `scripts/test-live.mjs` 的场景配置支持 `visible: true`：
**只给这一个场景**要求可见窗口，其他场景仍然默认不上屏。
当前用它的是 `perf` / `virtual` / `outlinepos`（都是性能或几何量）。

加新场景时：**断言里出现毫秒阈值、或依赖“元素真的被渲染出来”时，就加 `visible: true`**；
反过来，不要为了让它过而把阈值放宽到 1000ms —— 那会让真实的性能回归失去哨兵。

## 哪些场景会真的调模型（花钱/耗额度）

在 `CASES` 里标了 `cost: 1` 的场景：

| 场景 | 做什么 | 用哪个模型 |
|---|---|---|
| `tokens` | 用量 / 速度 | 默认（LongCat），不可用时 Laguna |
| `conn` | 连接状态竞态 | 默认（LongCat），不可用时 Laguna |
| `e2e` | 真发一条消息（流式 + 工具） | 默认（LongCat），不可用时 Laguna |
| `queue` | 排队 + Esc 回收 + **N09 边界**（四路并发入队 / 相同文本两条 / 对同文本撤回） | 默认（LongCat），不可用时 Laguna |
| `ask` | **问答功能**：模型主动提问 → 弹窗 → 回答 → 回填；含自主模式不弹窗 | 默认（LongCat），不可用时 Laguna |
| `image` | 图片真的发给模型 | **视觉模型** |
| `subagentpair` | **两个并发写入子代理**：worktree 隔离 / 合并 / 放弃 / 同一行冲突 / 只读封堵 / 退出归档 | `commandcode/deepseek/deepseek-v4.1-flash`（要求模型真的写文件） |
| `askbackground` | **后台会话「等待输入」**（实施-09 S2，N12）：A 触发真实 `question` → 主进程 `waiting=true` → 左栏 A 行 `?` → **切到 B 后 A 行仍在等**，B 行没有该槽 | `commandcode/deepseek/deepseek-v4.1-flash`（要求模型真的调用 question 工具）。⚠️ 必须先 `setWorkMode('standard')`；探针里 `waitFor` 的谓词是 async，必须 `await fn()` |
| `sessionab` | **A/B/C 三会话**：切走不停 / 切回不串 / 同 cwd 拒绝 / 单独停止 / **未读（实施-09 S2）** —— A 在后台**自然跑完**之后左栏出现未读点，点回去后消失 | `commandcode/deepseek/deepseek-v4.1-flash`（要求模型真的执行那个耗时工具）。⚠️ 未读那节**不能**用 `stopRunner` 制造（实例会被移出注册表，`runnersSeen` 不比较）；也**不要**在退出后检查里写死 `sleep <秒数>`（那是可调参数） |
| `atrefsend` | **`@` 引用的真实发送**：补全选中 → 发送 → 退出后查会话 JSONL 确认引用到达（且模型能按路径读到文件） | `commandcode/longcat-2.0:free`（不可用时 Laguna） |
| `goal` | **澄清档就绪转移 + 跨轮续行**（实施-05 S3a/S3b）：切澄清档 → 模型用内联参数敲 `yan goal ready` → 宿主校验 / 幂等 / 落盘 → **模式自动切标准** + 目标 `executing` + 工具卡「目标 · 砚内置」→ **续行自动起一个新回合**；退出后核对 `goals.json`（转移只记一条、五栏完整）、`goal-resume/` 快照与消费证据、会话文件里的 `yan-goal-resume` / `yan-goal-ready` 条目。**探针判空闲必须用 `session.isAgentRunning`**（顶层没有这个字段，读错会在两次请求的空档就判收尾） | 默认（LongCat），不可用时 Laguna |
| `taskcli` | **宿主任务服务**（实施-02 S3）：模型 `bash` → `yan tasks apply` → 界面清单 → `complete` → 切会话读回；退出后核对日志文件与会话 JSONL | `commandcode/laguna-s-2.1-free`（不可用或空回复时 `deepseek/deepseek-v4.1-flash`） |
| `goalloop` | **自主档持续续接**（实施-05 S3c）：切自主档 → 探针**只发一条**用户消息（要求模型跑一次 `yan goal report` 就收尾）→ 回合空闲后宿主续行**自动叫醒**（全程无第二条用户消息）→ 目标被继续推进；退出后核对 `goals.json` 的 `autoContinues`、会话文件里的 `yan-goal-continue`、`goal-resume/` 快照 + consumed 证据、扩展日志的 `kind=continue` | **固定 `deepseek/deepseek-v4.1-flash`**：默认 LongCat 实测只回文本不调工具（假红） |
| `sourcelinklive` | **来源「定位消息」的发送链路**（实施-07 S3）：附件进输入区 → 发送 → 渲染端把附件对应的来源 id 绑到 pi 刚写出的那条 user 条目上；断言关联的表里 sourceId 对得上、**而且指向的那条消息文本就是刚发的那条**（不是历史里的旧消息）。退出后从 Node 侧读沙箱里的 `links.json`（渲染端伪造不了那一层） | **固定 `deepseek/deepseek-v4.1-flash`**（默认免费档已退役 403）；不进 `check`（要额度） |
| `budgetgate` | **请求前预算门的真实冒烟**（实施-05 S4）：工作集线压到 3000（`YAN_CONTEXT_POLICY`）→ 只发一句话 → 这一轮必须正常跑完，磁盘诊断必须有 `request-budget-soft`（说明窗口读到了、钩子活着），而 `request-budget-physical` 与 `budget-abort` **必须为 0**（真实窗口下误拦是灾难性回归）。**不拿模型文本判红**（模型可能空回复） | **固定 `deepseek/deepseek-v4.1-flash`**：默认 LongCat 免费档已退役（403） |
| `handoffpack` | **交接包由模型写**（实施-05 S5b-2）：自主档 + `yan goal report`（让「目标在推进」成立）+ `YAN_HANDOFF_THRESHOLD=0`（真实要攒两次真实压缩，太贵）→ 回合结束后宿主判资格、写请求 → 薄层在 `agent_settled` 调**一次额外 completion** → 宿主三道闸门（id 对 / 能解析 / 清洗过）后落盘。探针经只读 `yan:getHandoff` 断言两栏必填 / `generator=model` / 水位有值 / 来源字段由宿主填；退出后核对包已落盘、**计数仍为 0**、请求与结果目录**已清空**，扩展日志有 `produced`（真调过模型）。**不拿包的内容好坏判红** | **固定 `deepseek/deepseek-v4.1-flash`**（默认免费档已退役 403）；**`handoffExtLog: true`**（诊断写沙箱，afterExit 读它） |
| `contextsweep` | **Tool Sweep 真实回合**（N21-4 / S2–S6）：三个回合，末轮确认上一轮的召回正文被清成存根；退出后查归档元数据与 `ctx://` 指得回原始条目 | `commandcode/longcat-2.0:free`（不可用时 Laguna） |
| `contextproduce` | **状态生成器真实回合**（N21-4 / S7）：回合 1 让模型调一次 bash → 生成并落盘（`revision` CAS）→ 回合 2 是 `<TASK_STATE>` 注入点；退出后查状态文件 + 诊断 + 主进程读路径校验（含「注入的契约档位」与「`episodes` 为空」） | `commandcode/longcat-2.0:free`（不可用时 Laguna） |
| `contextgate` | **会话级 gate 真实回合**（N21-5 前置硬化，与 `contextproduce` 是反向对照）：kinds 开 `episode-fold` 但门槛保持**默认**（≥4 回合且转录 ≥48k）→ 一个真实回合后断言 gate 被评估、判为 `too-early`、**0 次 committed、0 份状态文件**（短会话不花钱） | 同上 |
| `contextpressure` | **20+ 回合压力测试**（N21-4 尾，实施-06 S3）：`YAN_CONTEXT_POLICY` 把工作集压到 20000 + pi `keepRecentTokens=1`，跑 **22 个真实回合**（每轮 `seq 1 2000` ≈ 3k token）→ 探针读 pi 的 `contextUsage.tokens` 断言**峰值 ≤ 工作集 × 1.6** 且**压缩 ≥ 2 次**；退出后查请求诊断（物理线 / abort 都为 0、最小余量 > 0）与会话文件未被破坏。**cost 1、单场约 2.5 分钟 → 不进 `npm run check`** | **固定 `deepseek/deepseek-v4.1-flash`**（默认免费档已退役） |
| `contextpressurelow` | 同上 probe，但工作集压到 **6000**（低于 pi 的基线开销约 10k）→ 专测 `rearmAfterCompaction`：修复前 22 回合只压 1 次、峰值 7.8×，修复后压 5 次（A/B 反向验证就是这么做的）；该场景**不判峰值比率**（工作集低于基线时压无可压） | 同上 |
| `browserboundary` | **L04 浏览器边界**（9 节，cost 0，**需公网 → 不进 check**）：真实权限请求的拒绝/授权/撤销、本地预览放行、远程 302 借道本机被拦、DNS 重绑定被拦 + 负对照、内置与本机 Chrome 两条下载（带来源、不自动打开）、Cookie 真实复制到 Chrome（只比哈希）、拦截明细几何可见 | 不需要模型（只起 pi） |

浏览器边界场景 `browserboundary`（**cost 0，不进 `npm run check`**）要**公网**：
它用真实站点（example.com）当远程页面、用真实 302 服务（httpbin.org）构造「远程页面借道访问本机服务」、
用 `sslip.io` 的通配 DNS 构造「域名解析到 127.0.0.1」。拿不到公网时对应小节会**显式跳过并打印原因**，
不写成通过（所以它不该进 check，否则网络抖动会变成红灯）。它还需要一个 Node 侧的本地 HTTP 服务
（127.0.0.1:39873，见 `test-live.mjs` 的 `startBoundaryServer`）：探针跑在渲染端起不了服务，
端口只能约定 —— 端口被占用时场景直接失败，不自动换端口。

### `quota` 场景（cost 0）为什么也不进 `check`

额度口径那条（**月度已用 = 套餐总额度 − 剩余**）只有真实账号能复现：`/alpha/billing/credits`
把「已用」和「本月剩余」放在同一响应里，而 `monthlyCredits` 是**剩余**。
所以探针直接读真实 commandcode 接口（只读、不花钱）。代价是：

- 需要本机 pi 的 `commandcode` 凭证 —— 没有时探针打印 `~` 跳过真实数据断言（**不算失败**），
  颜色断言也会一并跳过；
- 「本月已用不到一半」这条方向判据依赖当月真实用量 —— 放进 `check` 会变成靠环境碰运气的红灯。

两类边界的覆盖面分开看：**口径**由 `test:unit` 的 `test-quota.mjs`（真实快照）与 live 探针钉住；
**色阶边界（70 / 95）不依赖网络**，由 `test-quota.mjs` 的 `quotaTone` 单测与视觉矩阵组 7 / 8 的
`quotatone` 状态覆盖（后者连 `getComputedStyle` 的计算色都比对 `--ok` / `--warn` / `--err`）。

队列的**失败与并发边界**另有一个不花额度的场景 `queueretract`（**进 `npm run check`**）：
撤回一个 pi 里不存在的 id（= “刚被消费”走的是同一条分支）、连续撤回同一 id、两条并发撤回。
它只依赖「pi 在跑」——`Agent.removeQueued` 在找不到 id 时直接返回明确错误，不需要真实队列项。
⚠️ store 的 `removeQueued` 声明是 `Promise<void>`（不返回结果），断言要看通知与 `queueRestore`，
并且注意 `pushNotice` 对 8 秒内的同文案会去重（第二次不弹不一定代表什么也没发生）。

不标 `cost`（或 `cost: 0`）的场景按设计不主动调用模型；新增或改动探针时需核对实际调用链。
`subagent` 虽然标 `cost: 0`，但它真的起子代理并调一次模型（只是用免费模型）；配额耗尽时它会失败。

反过来，下面这些 `cost: 0` 场景会**真的起 pi**（但不发消息、不调模型），它们验的是真实状态而不是注入数据：

- `modelswitch`（N02）：真实模型列表上做切换、快速连切、无档位清空、图像输入与用量归属；已进 `npm run check`。
- `railreorder`（N01）：侧栏项目 / 分组**拖拽排序** —— 合成 PointerEvent 走真实拖拽路径
 （实现里没用 HTML5 `draggable`，所以探针与用户手拖是同一条代码），并**回读 `yan.getSettings()`**
 证明顺序真的过了 IPC 写盘；已进 `npm run check`。要点：要造到 7 个项目才能覆盖
 「折叠成前五项时开始拖→自动展开」；落点必须**同组**（跨组不接受落点，拿不到插入线）。见 [MAINTENANCE](MAINTENANCE.md) 的「指针拖拽怎么验」。
- `thinkinglevels` / `capabilityload`：真实档位与能力补拉（同上，只切换不发消息）。
- `contextbudget`（N21-3）：工作集预算的参考值（64k/128k/256k/1M）与**兜底线**
  （`min(窗口 × 比例, 窗口 − 预留)`，每个窗口都断言"不吃预留 / 仍高于压缩线"）、界面上的数
  与主进程算出来的数一致、三阶段刻度、关掉开关后退回物理窗口。
  三条兜底不变式（对所有窗口成立）放在**单测**里逐点扫窗口（`test-context-policy.mjs` 第 3b 节）——
  这种"对所有输入成立"的性质用 live 探针只能抽几个点，扫边界要靠纯函数。
  撤销这类公式改动时要注意：**探针 fixture 里有手写的预算对象**（`probe/context.js`），
  它跟着公式改，否则会出现"fixture 合法但生产公式已经不这么算"的错觉。
- `contextswitchguard`（N21-3）：**触发时机**的回归网 —— 把工作集线和物理兜底线压到极低，
  再切到一个确实超线的旧会话，断言切换本身不触发压缩、不把实例标忙，也不阻挡新会话；
  探针会跳过几乎空的合成会话，避免前提不成立造成假失败（D36）。
- `language`（N16，cost 1）：界面语言 → 模型输出语言（**回复**）。**对照必须"互换提问"**：
  英文界面用中文问、中文界面用英文问 —— 同语言提问验不出"跟着界面走"还是"跟着用户消息走"。
  语言是**软约束**：判据是"多次尝试里出现过符合语言的那次"（每方向最多 3 次、出现即结束），
  并把每次的 CJK 占比打出来。另外两条：
  · **注入取证**：case 里设 `YAN_LANG_EXT_LOG=<文件>`，扩展每轮写一行 `{hook,lang,injected}`
    （比问模型可靠 —— 用来区分"没注入"和"注入了但模型没服从"）；
  · **推理语言只报告不硬断言**：模型可能"用英文想、按界面语言答"（实测 deepseek-v4.1-flash 就会），
    那是模型内部行为。
  注入**机制**的确定性不看这条 live 场景，而是 `scripts/test-language-extension.mjs`（单测）+
  `createdAt` 不变（切语言**不该**重建实例；不能看 `runId` —— stopAll 后从 r1 重新编号）。
- `historyswitch`（N16/D38，cost 0）：**切换会话不丢历史**。拿左栏里历史最长的一条会话，用
  `peekSession` 记下条数与**首条消息文本**，点开 → 等 pi 的权威 `sync` 落定 → 再对一次；
  期间全程监听 `messages` 变化，"铺上内容后曾被打回 0"直接判失败（用户看到的是"闪一下又没了"）。
  判据必须是**文件 vs 应用手里的历史**，只看"屏幕上有消息"抓不到"只剩压缩后那一截"。
- `taskext`（实施-02 S1 / S5，cost 0，**已进 `check`**）：**旧任务扩展、无关扩展与砚同时存在**。
  专属 `YAN_PI_DIR` 里放两份 fixture：
  [`left-info-panel.ts`](../../scripts/fixtures/task-ext/left-info-panel.ts)
  （注册同名 `panel_todos`、写旧标识 `left-panel-tasks`、注册 `/panel`、`session_start` 发 info 通知）
  与 [`notes-panel.ts`](../../scripts/fixtures/task-ext/notes-panel.ts)
  （**与任务无关**：只注册 `/notes` + 发一条通知，**不写任何 custom entry**）。
  验：启动通知降级进日志、来源诊断三行、任务清单读自**会话文件**（探针不调任何任务工具）、切走清空；
  外加硬断言「`/panel` 不得被当自然语言发出去」（S4 已兑现：两条同名命令并存时，
  命中的是 `source=compatibility` 那条 —— 界面只给提示，不动草稿与附件）。
  **S5 又加 4 条**：诊断数的是**全部**用户扩展（2 项）、无关扩展也在清单里、
  它的 `session_start` 通知真的进日志、它注册的 `/notes` 照常出现（`source=extension`）——
  防的是「按关键词过滤扩展」那类错（无关扩展会静默消失，而场景仍然绿）。
  `afterExit: taskFixtureReadonly`（`todos` 也挂同一道）再比会话文件：
  **前缀逐字节不变 + 只允许追加 + 追加里不得有任务类 custom entry** ——
  为什么不是比整文件 sha：pi 载入会话时会自己追加 `thinking_level_change`（证据-02-S1 §4.3）。
- `workmode`（实施-05 S2，cost 0，**已进 `check`**）：**会话级工作模式 + 旧配置迁移 + 菜单键盘**。
  case 预置一份**只有旧布尔**的 `desktop.json`（`legacyAutonomous: true`），验：「旧 `autonomous=true`
  → 新字段 `defaultWorkMode=autonomous`」（新字段优先、幂等），以及新会话按默认值启动。
  菜单与键盘：三档各带一句说明、方向键移动高亮、`Esc` 关闭并把焦点送回触发按钮。
  **Tab 快切用真按键**（`keys: 'tab,tab'` + `keysDelay: 15000`）—— 它在**渲染端**消费，
  合成事件验不到「焦点真的没被移走」；探针得先把首次引导关掉、把焦点放进输入框，
  所以第一枚按键用 `YAN_PROBE_KEYS_DELAY` 推到 15s（默认 1800ms 只够挂监听器）。
  **A/B 隔离**：两个真会话各自切档，互相切回后各自的值还在（旧实现是一个全局布尔，这条就是它的反例）。
  **光带“真的在跑”（实施-09 S2 第三批）**：不只断言 `animation-name` —— 还断言两条伪元素动画
  `playState === 'running'`，并隔 450ms 两次采样 `currentTime` 都在增长。名字对不代表在动：
  `paused` / 祖先 `display:none` / media query 拦掉都会让名字还在、画面不动。
- `runnerfailed`（实施-09 S2 第四批，**cost 0，已进 `check`**）：**pi 起不来时的失败态**。
  场景把 `YAN_PI_BIN` 指向一个**存在但立即 `exit(3)`** 的文件（写进沙箱，见 `brokenPi` 字段）。
  ⚠️ 两点别踩：① 必须**真写文件** —— `resolvePi` 对 `YAN_PI_BIN` 只做 `existsSync`，
  不存在的路径会被静默忽略并回落到内置 pi；② 启动时的主实例挂在一条**空会话**上，
  而空会话不进 `listSessions`，所以**左栏没有可画失败槽的那一行**（探针显式跳过并打印原因，
  不伪造断言）—— 用户看到的是「模型未就绪」+ 发消息时的错误提示。
  **第 4 节（实施-09 S2 第六批）**：同一条坏入口下启动**子代理** —— 断言它也走到终态、
  `status=error`、错误文本可读（实测 `pi 子进程提前退出`）、隔离工作区定态（`review=none` / `diff=0`）。
- `subagentfail`（实施-09 S2 第六批，**cost 0，已进 `check`**）：**子代理「模型自己失败」的恢复**（L03 尾巴）。
  用**坏模型名**（`deepseek/deepseek-nonexistent`，与 `autocontinue` 同一手法）：pi 接受这个名称
  （只 warn），失败发生在上游请求 —— 回 400 且**不产生用量**，所以是 cost 0。
  修前实测的形状：子代理显示 `status=done` / `latestActivity="已完成"` / `error=null`，
  只有转录里那条 assistant 自己带着 `error="模型返回错误"`（pi 的 `stopReason==='error'` 被 settled 吃掉了）。
  修法：`message_*` 时记住 `stopReason`，`agent_settled` 时据此落 `status=error`。
  断言：终态 error + `error` 可读 + `latestActivity` 不是「已完成」+ 转录里 assistant 真的带 error；
  等 `diff` 出现（不是等 `review`，它初始就是 `none`）再断言 `review=none` / `diff.files=0`，
  `afterExit: subagentFail` 再核对归档元数据（`status=error` / `review=none` / 有起止时间）
  与临时目录无残留。**反向验证**：把 `modelFailed` 写死 `false` → 前三条断言红、
  「转录里 assistant 带 error」仍绿（pi 侧证据与宿主判定是两回事）。
  同批单测（假 Rpc，不花额度）：模型失败 / `stopReason=stop` 对照 / pi 起不来（启动超时 + 进程被 close）/
  运行超时（`YAN_SUBAGENT_TIMEOUT_MS=200` 压短，断言提示报的是**实际**上限）。
- `exitsave` / `exitinterrupt`（实施-09 S2 第五批，**cost 0，已进 `check`**）：**N12 退出变体**。
  托盘退出四个分支里 `tray` 覆盖「取消」（两次都留在托盘），这两条覆盖**保存并退出 / 中断退出**
  与**退出进行中重复请求**。场景用 `YAN_EXIT_CHOICE=save|interrupt` —— 那是主进程里原生对话框的
  **probe 替身**（`probeExitChoice()` 只在 `YAN_PROBE` 下生效），只跳过「选哪个」这一步，
  写快照 / 收实例 / 退出的链路完全相同。探针断言 `requestExit()` 返回 `save-and-exit` / `interrupt-exit`、
  重复请求返回 `already-exiting`，并打印 `expect-mode=` / `probe-at=` / `runners=` 供 Node 侧核对；
  `afterExit: exitSnapshot` 读沙箱 `data/exit-snapshot.json`：`version=1`、`mode` 与本次请求一致、
  `at` 落在探针时刻之后 120s 内（沙箱整批共用，必须能分辨陈留文件）、`runners` 条数与窗口里一致、
  条目带 `cwd/conn/running` 且**不含消息正文**、没有写一半的 `.tmp`。
  **两次反向验证**：① 重复请求改回返回 `interrupt-exit` → 只有那条断言红；② `mode` 写死成 `save` →
  `exitinterrupt` 的 mode 断言红。⚠️ 探针做不到的一维如实登记：真实 **busy + 原生对话框**期间
  重复点托盘（`exitRequestInFlight` 去重那一支）在探针里不可达（probe 替身不 `await` 对话框），
  只能靠代码审阅；「中断退出真的掐断正在跑的回合」同理，由全局孤儿进程检查 + `stopAll` 的既有证据兜。
- `sourcecap`（实施-07 S4，**cost 0，已进 `check`**）：**来源搜索入口「有则出现」**。
  方案对网页搜索的硬条件是「**只在已发现兼容搜索能力时启用**」且不自造搜索后端，
  所以这条验的是**发现 + 如实暴露**：场景给一份真实 MCP 配置（同一个 stdio fixture，
  工具表里新增了 `web_search`），宿主真的把它接进能力目录 —— 断言
  `window.yan.sources.webSearch()` 报 `available:true` 且带可执行的 `location`、
  环境菜单里出现 `[data-testid="src-websearch"]`、没输词时按钮禁用、
  输词点击后**只把草稿注入输入框**（含关键词 + 能力名 + 调用形状）而**不代发消息**、写完菜单自己关。
  **反向验证**：把 fixture 里那个工具的**名字与描述**都去掉搜索语义（`web_lookup` + 「查本地索引」）
  → `available:false`、菜单里只剩手工添加网址那几项 —— 「无则隐藏」因此也是实测过的。
  ⚠️ 只改工具名不改描述**验不出来**：判定里有一条弱证据规则（描述同时含「搜索 + 网页/联网」）。
- `mcpregister`（实施-04 S6b-1，**cost 0，已进 `check`**）：**远程 MCP 自动登记闭环**。
  从「确认未配置」开始，不调模型：真目录 fixture（`YAN_MCP_REGISTRY_URL` 指向本地）→ `discover`
  拿到候选 → `prepare` 停在 `needs-authorization` → 未授权 `acquire` **不登记** → `--authorize`
  后真连核验（官方 SDK 的 Streamable HTTP MCP fixture）并 `resumed` → `capabilities search`
  **当场可见** → `yan mcp call` 返回值真的来自 fixture → 同一计划重放 `replayed:true`。
  配置与授权都落沙箱（`YAN_MCP_SERVERS_FILE`），不碰用户真实配置；npm 源同样指向本地，
  所以这条 cost 0 场景**不需要公网**。**反向验证**：去掉授权门槛 → 恰好 4 条断言红。
  逐条实现见 [HANDOFF](HANDOFF.md) 的「本轮（2026-09-20）实施-04 S6b-1」。
- `remoteroutes`（实施-08 S0，**cost 0，已进 `check`**）：真实隔离 Electron HTTP 服务，经 Node 客户端覆盖 health / 鉴权 / 新建会话 / 按 sessionId 定向发送 / 按 runId 中止。目标是合成沙箱会话；本机 OpenAI 兼容 provider 故意保持流式不结束，退出后确认**目标消息对应的流**被 abort 关闭，桌面当前会话未因发送或中止而切换。场景使用独立临时 `YAN_PI_DIR`、虚构凭证与本机 fixture provider，不读取真实 `auth.json` / `models.json`，不连外网 / 云模型。
- `contextbench`（实施-06 S2 前半，**不启场景，只单测**）：N21-9 的 A/B 口径 —— 四组策略（A 原始长上下文 / B 传统摘要 / C State-First / D State-First + Trace）**只用 `kinds` 区分**、规则式判分（`must-include` / `must-exclude` / `must-match` / `must-not-match`，带 `flags`）、主判据（LCR 相对下降 ≥ 25% 且成功率不低于基线 −3pp）与副指标（`stateOverhead > 25%`、矛盾率三档）。**两条关键自检**：① D 的 `kinds` 必须等于产品默认集、B ⊂ C ⊂ D（否则四组之间的差异不是一个变量）；② 任务集里**每条约束自带 `kept` / `violated` 两个样例**，单测拿它们跑判分规则 —— 2026-09-19 首次跑就抓出 **4 条写错的约束**（3 条用了 JS 不认的 `(?m)` / `(?i)` 内联标志、1 条禁止项样例自己命中）。**真实跑批（四策略 × 3 任务 × 多回合）必须真实额度，未做** —— 跑批器要另做一片，不要拿这套单测当“跑过对照”。
- `autocontinue`（实施-05 S5c，**cost 0，已进 `check`**）：**模型出错后的自动继续**。
  模型名故意写坏（`deepseek/deepseek-s5c-nonexistent`）—— pi 不拒启动（只 warn）、上游回 **400**、
  **请求被拒所以不产生用量** → 错误文本不含额度 / 认证 / 上下文关键词 → 判「可重试」。
  探针先 `setAutoRetry(false)` **关掉 pi 自带重试**（这一片验的是砚这一层），然后**只发一条**消息：
  期望 3 条标错助手（初次 1 + 自动 2）、全程用户消息 **1** 条、收尾后不在流式中。
  `afterExit: autoContinuePersisted` 再核对磁盘：`auto-continue.json` 计数**停在上限**
  （没有无限重试）、会话里有 `yan-auto-continue` 且**没有**混入 `yan-goal-ready` / `yan-goal-continue`
  （触发源没搞错）、`goal-resume/` 消费证据 + 扩展日志的 `kind=retry`。
  **退避由 `YAN_AUTO_CONTINUE` 压到 1.2s**（真实默认 3s/10s/30s 等不起）。
  `afterExit: workModePersisted` 再核对磁盘：`work-modes.json` 两条不同会话的值、
  `work-mode/<runnerId>.json` 快照真的写了、旧 `autonomous` 未被抹掉、关掉再开的开关不在磁盘留键。
  ⚠️ 这把会话键钉在**会话文件路径**上：实测切走再切回同一份文件时 pi 会报新的 `sessionId`，
  拿它作键会让模式当场丢回默认值（首次跑这个场景就抽到了，已修 + 反向验证）。
- `taskcli`（实施-02 S3，cost 1，**不进 `check`**）：**宿主任务服务的真实链路**。
  模型 → `bash` → `yan tasks apply --request-file tasks/task-set.json` → 界面出现清单 →
  第二条 `complete` → 切走清空 → **切回从磁盘读回**（这是「重启后读得回」的等价物）。
  request 文件由 Node 侧预置在 fixture 项目的 `tasks/` 下（`fixture: true`）——
  **不让模型自己写 JSON**：那多一次工具往返，而模型可能换目录或改内容，
  而本场景验的是宿主写入链。`afterExit: taskCliLog` 再核对磁盘：日志按**会话 id** 命名、
  两行、`revision` 1→2、每行带 `schemaVersion` / `round` / `at`，
  且**会话 JSONL 里没有任务条目**（宿主日志写在 `YAN_DATA_DIR/task-plans/`，不写会话文件，
  判定过程见 [证据-02-S3 §1](../archive/evidence/证据-02-S3-宿主任务服务.md)）。
  免费模型本轮实测会空回复或不调工具（日志里是 `[错误] 重试失败，本轮结束。`），
  建议直接 `YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash`。
  **S4 又加 4 条**：工具行被标为砚内置任务计划、标记的仍是 `bash` 卡、徐标写「任务计划」、
  展开后能看到原始命令。**两个探针上的坑**（写在探针注释里）：
  ① 工具组默认收起且**收起时内部的行不在 DOM 里**（`tgroup-body` 不渲染），
  不展开就数 `.trow` 只会得到 0；② 展开要**幂等**（只点没开的），再点一次就是收起。
  探针还会把 `tasks apply` 最近两条调用的 `status` 与 `output` 尾部打进日志 ——
  没有这段诊断时，`yan.mjs` 的语法错误会被误读成「模型不配合」（证据-02-S4 §2）。
  **S5 又加第 4 节（取消）**：发一条会让模型跑一会儿的消息 → 等回合真的起来 →
  点同一个按钮（此时文案是「中止」）→ 断言取消后清单没变、没有卡住的 `running` 行、输入框仍可用。
  退出后那半边的保护也在：日志仍然必须是**两行** —— 取消如果多写或写坏，这条会红。
- `taskplan`（实施-02 S5，cost 1，**不进 `check`**）：**整条链全由模型驱动**。
  与 `taskcli` 的分工是「谁决定请求」：`taskcli` 的请求文件由 Node 侧预置（验写入链，
  不受模型随机性干扰），`taskplan` 要模型**自己写请求文件、自己登记、自己做、自己勾选**——
  这正是 S5「不能仅造 fixture」的那一条。任务本身是真动作（在 fixture 里建三个文件），
  所以退出后能拆穿「只登记计划、文件没建」。
  三处一致在 `afterExit: taskPlanMultiStep` 里落地：探针把渲染端看到的清单打成
  `taskplan.todos=…`，Node 侧拿它与宿主日志最后一行**逐条比对文字与勾选状态**，
  外加 `tasks/step-*.txt` 真的存在且非空、会话 JSONL 里没有任务条目。
  建议 `YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash`（实测一次通过：5 次 `apply`、`revision` 1→4）。
  ⚠️ 它可能因模型不照做而红 —— 判据全部落在工具调用 / 界面 / 磁盘上，
  **不拿模型的自然语言当证据**（实测助手最后一条回复是空白）。
- `slashcmd`（N18，cost 0，**已进 `check`**，20 节）：本地命令路由 + 菜单行为 + 来源分布。
- `projectopened`（实施-09 S3，cost 0，**已进 `check`**）：验「每个项目最后一个会话」恢复哪一个。fixture 造两条同项目会话 —— `hot`（消息时间更新、从没被打开过）与 `opened`（消息旧，探针会真的打开一次）。断言链：前提成立（hot 活动更新）→ 打开后主进程回读出现 `lastOpenedAt` → **决策输入里真的带着它**（必须先 `refreshSessions()`，否则读的是旧快照 → 反向验证会假绿）→ 停掉全部实例 → `pickProjectSession` 选 `opened` 而不是 `hot`；退出后读 `data/session-layout.json` 核对落盘（opened 有、hot 没有）。⚠️ fixture 的 `skew` 是**加到偏移上**的（`TS(690 - skew)` ⇒ skew 越大消息越新），与直觉相反。
- `gitwrite`（实施-07 S2a，cost 0，**已进 `check`**）第 12 节新增一段：点「开新会话」后主进程必须多出一条工作树来源关系（来源会话 = **点按钮之前**那个），环境菜单工作树区要显示来源行；退出后再从 Node 侧读 `data/worktree-links.json` 核对（会话 id / 工作树 / 源会话不同 / 时间戳）。⚠️ 源会话 id 必须在点按钮**之前**取。
- `sourcelink`（实施-07 S3，cost 0，**已进 `check`**）：验「关联已存在」之后的链路 —— 写一张图 + 登记关联（幂等）→ 主进程 `list` 回读 → 菜单里出现「定位消息」→ 点下去**按 `data-msg-id` 精确高亮那一条**、1.8 秒后自己掉。退出后从 Node 侧读 `links.json` 核对。⚠️ cwd 必须是 fixture 的 **git** 子目录（来源区只在「这是 git 项目」那个分支里渲染），会话要选 `yan-ab-a`（cwd=fixture/repo 且带 user 消息）—— 所以场景要开 `abSessions`。
  **S4 改了两处**：第 3 节从「`/panel` 或 `/footer` 可见但禁用」改成
  「`/footer` 可见且禁用 + `/panel` **不**在候选里 + 注册表里仍 `hiddenInMenu`」；
  新增第 20 节：手打 `/panel` → 逐字符断言草稿未变、合成附件仍在、给出可读原因、没发给模型。
- `title`（N11，cost 1）：标题的自动生成 / 并发单次生成锁 / 手动名粘性 / 候选→采用。
  标题会另起一个 `--no-session` 的 pi 进程，所以这条链路只有真机能验。
  285k tokens 的旧会话，断言“看一眼不会触发压缩、实例不变忙、新对话不被挡”（D27，反向验证过）。

### 阶段 4 的安全规则在**单测**里钉住（N21-10）

"正在使用的 diff 不得删 / 用户约束不得降级 / 不从 reasoning 中间切"这几条没有 live 场景：
它们要验的是**切割方案本身**合不合法，而不是某个界面现象。做法是纯函数 + 不变式
（`resources/pi-extensions/context-safety.js` + `scripts/test-context-safety.mjs`，42 条）：
构造三组输入（正在使用的 diff / 已解决的旧错误 / 用户约束），既断言合法的方案通过，
也断言**人为做坏的方案**（切成半条、回收系统提示、保留/丢弃不互补）会被 `violations()` 报出来 ——
后者才是"这个检查器真的在工作"的证据。改这几条规则时同时跑：撤销保护逻辑必须让 6 条断言变红。

### 阶段 4 的状态 / 归档基础设施（N21-4 / S1）

S1 只做「状态长什么样、怎么存、怎么丢」：schema、水位、provenance、原子写、安全丢弃、
删会话清理，以及 Deep Context 的**注入闸门**（不产生模型调用）。验证分两层：

- **纯逻辑（单测）**：`scripts/test-context-state.mjs`（76 条，进 `npm run test:unit`）。
  被 esbuild 编译后直接测三个模块：`shared/context-state.ts`（schema / provenance /
  §12.7 递归摘要判据 / 水位 / Deep Context 判据）、`main/context-state-store.ts`
  （原子写、**写入失败不覆盖 last-known-good**、损坏 JSON 与版本不匹配的丢弃、
  会话清理、路径穿越守卫）、`main/context-watermark.ts`（真实 JSONL 读条目身份；
  超长行只读前缀、半截尾行不计入、中间坏行整份作废）。store 的 `dir` 全部指向
  临时目录，**不碰真实用户目录**。
- **真实窗口**：`npm run test:live -- contextstate`（cost 0，**进 `npm run check`**）。
  状态文件由 Node 侧用**真实 store** 种进隔离的 `YAN_DATA_DIR`（renderer 按设计碰不到
  那个目录），探针只走真实界面删一条会话；`afterExit` 再对文件系统断言
  「被删会话的状态没了、其余一个没少、无 `.tmp` 残留」。
  删会话的**回归网**除了它还有 `trash`（真删 + 撤销恢复）：改 `deleteSession` 两件都要跑。

还没接上的部分：S1 没有生产读调用点（谁生成状态由后续切片定），所以「损坏丢弃」
在真实运行中暂时只由删除清理触发，读路径只有单测覆盖。

### 阶段 4 的扩展执行层（N21-4 / S2–S6）

这一层会**真的改写发给模型的消息**，所以判据必须落在两层：纯逻辑与
「扩展钩子 + 假 sessionManager」，再加一条真回合。

- **纯逻辑 + 钩子集成（单测）**：`scripts/test-context-transform.mjs`（104 条，进 `npm run test:unit`），
  覆盖 `resources/pi-extensions/context-transform.js`（entry 身份对齐的数量 + 角色双校验、
  Tool Sweep 只在 `recentTail` 之外且幂等、墓碑文本与 `ctx://` 引用、Task State 只注入 active、
  recall 预算 / TTL 存根、结构化摘要缺字段不接管、Episode 递归摘要预检）
  与 `context.js`（用假 `sessionManager` 直调 `context` / `session_before_compact` 钩子，
  并直调 `context_recall.execute` 覆盖成功与全部拒绝分支）。
  另外两条是**跨语言交叉验证**：JS 产出的归档条目 / 整份归档文件要能过 S1 的 TS schema；
  以及“把保护逻辑抓掉就应该变红”的反向断言。
- **真实回合**：`npm run test:live -- contextsweep`（cost 1，**进 `npm run check`**）。
  在真实 pi 里跑三个回合（第一回合用 bash 产生大输出，第二回合使上一次结果落到
  `recentTail` 之外并让模型 recall，第三回合触发召回正文的 TTL 清理），退出后检查归档元数据、
  `ctx://` 引用指得回原始条目、诊断里 `swept≥1` 且 0 条 error，并在确有召回时断言
  `expiredRecalls≥1`。当前已用 `YAN_TEST_MODEL=commandcode/longcat-2.0:free` 真实通过；
  该模型不可用或触顶时改用 `YAN_TEST_MODEL=commandcode/laguna-s-2.1-free`。
- **真实回合（gate 反向对照）**：`npm run test:live -- contextgate`（cost 1，**进 `npm run check`**）。
  它和 `contextproduce` 是一对：后者用 `state.gate:{minTurns:1,minTokens:1}` 证「够了就生成」，
  前者保持默认门槛证「不够就不生成、不花模型调用」。两者都靠诊断行判定
  （`stage: producer, hook: gate` 的 `reason` / `activated`）—— gate 本身是纯逻辑、单测已覆盖，
  但「真实 pi 在 `agent_settled` 时数得出用户回合」只有真实回合能证。
- **分路开关与压缩**：`YAN_CONTEXT_POLICY.state.{generate,inject}` 是 `kinds` 闸内的两条分路。
  `inject:false` 的含义是「**允许 TaskState 参与任何模型可见的上下文**」的反面 —— 所以
  **压缩接手也走这一路**；单测里「inject:false → 不接管压缩（状态文件仍在）」钉的就是它。
  写断言时注意：**默认 `kinds` 下压缩本来就不接管**（因为没有状态文件），要测这条必须显式给状态文件。
- **gate 的地板是全局的**：“清扫过东西”只能是**替代 token 条件**，不能替代最低回合数
  （否则早期一回合生成了一个肥工具输出就能让会话永久 eligible）。断言：「清扫过但回合数不够 → 仍不激活」。
- **freshness 的「新陈」定义**：只落后**一条尚未 settled 的 user 消息**算 fresh（`freshView`）——
  否则 `fresh` 在稳态下永远不可达，模型每轮都会看到 `[stale: verify…]`。
  判据用**反向**表达（新增里恰好一条 user，且其余条目没有一条是 message 类）：
  **不要白名单枚举 pi 的条目类型** —— 线上就是被 `session_info` 卡住的（诊断字段 `tail` 会告诉你是谁）。

默认策略（`kinds` = `tool-sweep` + `recall` + `compaction`，见 `src/shared/context-policy.ts`）下
扩展会清理旧的工具输出（墓碑 + `ctx://` 引用，会话文件一行不改）、并接管压缩；
若显式把 `kinds` 配成只有 `compaction`，则消息不被清理 —— 单测里“显式只 compaction 时不动消息”
这条断言钉的就是后者。默认开启 `tool-sweep` 是产品决定，见方案 §15.5。

### 用小额度走完整触发路径（N21-3）

`contexttakeover` / `contextemergency`（都是 `cost: 1`）要在真实模型上验「砚按工作集
真的让 pi 压了一次」。默认工作集是 240k，填到那里是几十万 token 的额度，所以用
`YAN_CONTEXT_POLICY` 把触发点挪近：

```powershell
$env:YAN_CONTEXT_POLICY = '{"workingSetCap":1500}'   # 命中工作集线
npm run test:live -- contexttakeover
Remove-Item Env:YAN_CONTEXT_POLICY
```

- 这个变量只影响**阈值参数**，触发路径（决策 → `compact()` RPC → 事件归一化 →
  界面文案）全是真的；与 N21-2 把 `reserveTokens` 调到比窗口还大是同一个手法。
- 非法字段一律忽略并退回生产默认值（写错参数不会变成 NaN 预算）。
- `contexttakeover` 退出后还会顺带核对**交接计数**（实施-05 S5a）：这一次压缩是「完成 + 自动」的，
  所以 `data/handoffs.json` 里必须有该会话的 `count ≥ 1` 与去重键 —— 计数是「同一个片段压够两次
  就换会话」的唯一依据，而真实的压缩事件只有这个场景能拿到（不为它再烧一次额度）。
- 两个场景都不进 `npm run check`（要额度）。
- **接管档位可达性**（实施-06 S4 前半）：`npm run test:live -- contexttakeovergap`（cost 1，不进 `check`）试两种构造去命中 `fresh` / `stale-soft`（让 pi 用 `reserveTokens = 窗口 − 25k` 在回合中途压；回合 2 明确禁止工具调用），**两次实测都是 `tier=stale-hard`、`gap=3`** —— 压缩总在回合结束之后，水位后至少已有 `user + assistant + compaction` 三条。所以真实链路只会落到 `stale-hard`；另两档的判定由 `test-context-producer.mjs` 的单测钉住。场景会把会话条目序列一并打印（诊断辅助）。

## 隔离与安全

`test:live` 每个批次建一个临时 sandbox，把：

- `YAN_USER_DATA`（localStorage / cache）
- `YAN_SESSIONS_DIR`（会话文件）
- `YAN_DATA_DIR`（`desktop.json` 设置）
- `YAN_PI_DIR`（设置面板读写的凭证目录）
- `YAN_DOWNLOADS_DIR`（浏览器下载落盘目录 —— 内置浏览器与本机 Chrome 都读
  `app.getPath('downloads')`，默认是用户真实下载目录，不能让测试往里丢文件）
- `YAN_CONTEXT_POLICY`（工作集策略参数覆盖，JSON；见上一节 —— 只在需要
  “用小额度走完整触发路径”的场景里给，不是日常隔离变量）
- `YAN_AUTO_CONTINUE`（自动继续的上限与退避覆盖，JSON `{limit, delays}`；只在 `autocontinue`
  场景用 —— 真实默认是 **3 次 / 3s、10s、30s**，测试里等不起）
- `YAN_HANDOFF_THRESHOLD`（交接阈值覆盖；`0` = 「够数」这一条先成立 ——
  真实链路要攒够两次真实自动压缩，那是全项目最贵的场景之一。**只在 `handoffpack` 场景里设**，不改任何生产判定）

指到临时目录，**不碰真实数据**。

### 从砚自己的 pi 子进程里跑测试时，还要剥掉宿主能力变量

`test-live.mjs` / `test-packaged.mjs` 都会先删掉这几个**继承来的**变量：
`ELECTRON_RUN_AS_NODE`（否则 GUI 退化成纯 Node，无窗口、静默退出）与
`YAN_CLI_URL` / `YAN_CLI_TOKEN` / `YAN_SESSION_ID` / `YAN_PROJECT_ID`
（它们指向**外层那个真实实例**的能力服务）。

后者不是理论风险：pi 子进程的环境本来由主进程覆盖，但当能力服务没起来时就是
「没有覆盖」，于是一个随手跑的 `yan tasks apply` 会打到真实实例、
在真实 `~/.pi` 里留下操作回执（本轮真撞到过一次，已清理）。
**在别处 spawn 子进程跑 `yan` 时也要注意同一件事。**

### pi 的凭证与模型目录（只读复制）

隔离让 pi 读不到 `~/.pi/agent`，直接后果是 **pi 起不来** —— 所有依赖「pi 就绪」的
场景（`runnerselect`、任何 `cost: 1`）都会失败或跳过。所以启动前会把这三个文件
**只读复制**进 sandbox：

| 文件 | 作用 | 少了会怎样 |
|---|---|---|
| `auth.json` | 凭证 | pi 只能起一个 `{id:'unknown'}` 空模型 |
| `models.json` | 自定义 provider 定义 | 本机的 `commandcode`（69 个模型）来自这里，**不在** pi 内置目录中；少了它 pi 解析 `--model commandcode/...` 会 `Model not found` **并直接退出**，表现为 conn 一直卡在 `starting` |
| `models-store.json` | 目录缓存 | 多一次网络拉取（不致命） |

安全边界（用户要求：测试可以用，**打包切勿放进去**）：

- 只**读**源文件；sandbox 在系统临时目录，跑完（含 Ctrl+C / SIGTERM）自动删除；
- `auth` 场景改写/删除的也只是副本；
- **不会进发布包**：`electron-builder.yml` 的 `files` / `extraResources` 只收
  `out/`、`build/icon.png`、`package.json` 和 `resources/pi-runtime`，临时目录不在其中；
- `.gitignore` 已忽略 `auth.json`。

不要关闭隔离来绕过测试失败；优先检查 sandbox 的配置、凭证副本与连接状态。

### 合成 fixture 项目（`fixture: true` 的场景）

文件树 / `@` 补全的边界需要一个**内容已知、可穷举**的项目：源码树里既造不出空目录，
也不能保证里面有哪些文件，断言只能写成“看起来像”。`test-live.mjs` 的
`buildFixtureProject()` 会在 sandbox 里造一棵固定的树，`CASES` 里标了
`fixture: true` 的场景把它当 `cwd`：

| 项 | 验什么 |
|---|---|
| `empty/` | 空目录（`status='empty'`，界面显示「（空目录）」） |
| `deep/a/b/c/d/e/f.txt` | 五级目录缩进与逐层展开 |
| `dup/one\|two/same.ts` | 同名文件按完整路径区分（加入上下文互不覆盖） |
| `big/`（60 项） | 文件树 50 一批分页 +「显示更多」；`@` 补全 30 条 + `truncated` |
| `uni/中文 目录/文件 名.ts` | 中文 + 空格路径（预览、补全、自动引用） |
| `notadir.txt` | 把文件当目录打开 → `missing`（不是空列表） |
| `junction-dir` / `junction-file` | 链接不进树/补全，但列在「已隐藏」名单里 |
| `noperm/` | 真实无权限目录（ACL 拒读）：`permission`，不是「空目录」 || `一个非常长的文件名…中文结尾.md` | 窄右栏（`PANEL_MIN=220`）下必须省略显示，但 `title` 能给全文 |

`noperm/` 用**真实 ACL** 造：`icacls <dir> /deny <当前用户>:(RD)` —— 只拒**读取/列举**，
不拒改 DACL，所以退出清理前能 `/remove:d` 复位（deny 全权限会让 `rmSync` 也 EPERM，
沙箱就删不掉了）。Windows 上 Node 的 `readdir` 在这里报 `EPERM`，主进程统一映射成
`permission`；非 NTFS 或改不了 DACL 的机器上造不出来，探针把对应断言降级为「跳过」
（既不假通过也不假失败）。清理钩子里会先复位 ACL 再删沙箱。

场景：`fsedge`、`atpathedge`（都进 `npm run check`）。树建在临时目录里，
批次结束随 sandbox 一起删除；**不要**往项目根塞测试数据。

### 直执行 shell 的变更归属（`workspacechanges`，进 check）

`workspacechanges` 是 L05 的真实窗口证据，而且**不花额度**：它走砚的
**直执行 shell 通道**（`window.yan.runBash` → pi 的 `bash` RPC），在隔离的
fixture 项目里真的建 / 改 / 删文件，然后断言工具行上的改动卡片。
八节分别盯一个新 / 改 / 无改 / 依赖目录 / 删 / 大文件（只能 `unknown`）/ UI 渲染 /
**同 cwd 第二个实例被拒**（L03 并发防线，见 `D20`）。

它必须用 `fixture: true`（会真改文件）；不需要真实模型 —— 这也是为什么不把它
归在 `cost: 1` 那批。另：fixture 的 `noperm/` 是不可读的，所以快照扫描器**不**因为
它把结果标成 `truncated`（见 `snapshots.ts` 里 `unreadableDirs` 的注释）。

fixture 里还有一个最小的 **Git 仓库** `repo/`（`git init` + 一次提交，README 里留了一行
`LINE-BASE:` 供“两个子代理改同一行”的冲突场景用）。写入型子代理要建 worktree，
所以 `subagentpair` 的 cwd 是 `fixtureSub: 'repo'`。

还有两个**已落盘**的合成会话（`writeProjectSwitchSessions`，`CASES` 里标
`projectSessions: true`）：cwd 分别是 fixture 项目根与它的 `other/`，标题为
`YAN-N05-A` / `YAN-N05-B`。“切回项目草稿还在”靠的就是它们 —— 草稿按 `sessionId`
存在运行时缓存里，换成新会话就回不来了，而刚 `new_session` 出来的会话还没有
消息、`listSessions` 解析不出 head，根本不在列表里。

`projectPeers: true` 时会**另外**在 `repo/` 里造 `YAN-N05-D` / `YAN-N05-E`：
`workspacechanges` 第 8 节要有**两条同 cwd 的会话**，才能验“同 cwd 已有实例在跑
时切换会被拒绝”。它们必须造在另一个子目录：摆在 A 旁边就会参与 N05 的
“该项目最近访问的会话”挑选（实测让 `projectswitch` 选到了新造的那条，
断言直接挂了）。同理，fixture 文件的 mtime 也按 `skew` 显式拨开 —— `listSessions`
的排序键是**文件 mtime**，而几个文件往往在同一毫秒内写出来。

### 退出之后才能看到的结论：`afterExit`

有些结论只在 **Electron 已经退出**之后才成立：退出归档（`review` 从 `pending` 变 `archived`）、
临时 worktree 有没有残留、主工作树的最终内容。这类场景在 `CASES` 里写
`afterExit: '检查名'`（注册在 `AFTER_EXIT`），探针跑完、进程退出后由 Node 侧直接查文件系统。

探针与 Node 侧靠**任务描述里的固定标记**对齐（如 `YAN-ALPHA`），不需要额外通道。
现有两个：`subagentArchive`（`subagentpair`）、`sessionabArchive`（`sessionab`）。

`subagentpair` 不进 `npm run check`：它要排队跑好几个真实的模型任务（实测约 1 分钟）、
消耗用户额度，按需手动跑。

### `delay` 与 `budget` 不是一回事（踩过）

- `delay`：窗口 `ready-to-show` 之后**等多久才执行探针**，用来给应用启动并连上 pi。
  普通场景 9～16 秒。不要为了“给长场景留时间”把它调大 —— 那只是让应用先白等。
- `budget`：**探针自己能跑多久**（kill 兜底 = `delay + budget`，默认 90 秒），
  探针跑完就退出，不用等满。
- 两者混在一起会让总时长虚高：`subagentpair` 曾经把 `delay` 设成 300 秒，
  于是总时长 275 秒里有 300 秒是白等；拆开后同一个场景 51 秒跑完。
- **探针内部的等待上限必须小于 `budget`**。`e2e` 的探针最多等 150s，而默认预算只有 90s ——
  它被杀死在打印 `---PROBE-START---` 之前，报出来的是"没抓到 PROBE 输出 —— 应用可能启动失败"
  （D41）。看到那条提示先怀疑预算，再怀疑启动：探针里搜 `deadline = Date.now() +`。

## 问答功能怎么测

- **纯逻辑**（`npm run test:unit`）：`scripts/test-question.mjs` 直接 import
  内置扩展 `resources/pi-extensions/question.js`，喂假 `pi` API，断言
  系统提示随自主模式切换、自主模式不弹 UI、select/自定义/取消的回填。
- **端到端**（会调模型）：`npm run test:live -- ask`。流程：
  发一条要求提问的消息 → 等 UiBridge 弹窗 → 选答案 → 断言
  `question` 工具行完成、答案回填进模型回复；最后开自主模式，断言**不再弹窗**。

## 内置 pi 功能怎么核

- `npm run vendor:pi:check`：内置运行时能不能启动、RPC 握手是否正常。
- `npm run probe-pi`：单独验证「pi 能不能被找到并启动」。

## 不用真模型也能验 pi 的行为：假 provider + 钩子实测

有一类问题**真实模型答不了**：预算门、压缩时序、模式切换的判据都是
「**第几个请求到底发出去了**」「请求体里有什么」「钩子按什么顺序跑」。
这类问题用 `scripts/hook-probe.mjs`：它起一个假 provider（本机 127.0.0.1，不联网、不花钱），
跑一次 `pi --print`，把收到的请求清单 / 钩子时序 / 会话 JSONL 全部打印出来。

```bash
node scripts/hook-probe.mjs plain     # 对照
node scripts/hook-probe.mjs block     # tool_call 返回 {block:true}
node scripts/hook-probe.mjs abort     # 请求前调 ctx.abort()
node scripts/hook-probe.mjs compact   # 钩子里调 ctx.compact()
node scripts/hook-probe.mjs payload   # 返回改过的 payload
node scripts/hook-probe.mjs workmode          # 05-S3a：clarify + 写文件命令 → 应被拦
node scripts/hook-probe.mjs workmode-standard # 05-S3a：standard + 同一条命令 → 应执行（对照）
node scripts/hook-probe.mjs workmode-allow    # 05-S3a：clarify + \`yan goal status\` → 应放行
node scripts/hook-probe.mjs budget            # 05-S4：输出预留拉到 195k → 第 2 个请求应当**不发**
node scripts/hook-probe.mjs budget-soft       # 05-S4 对照：同一份消息 + 同一个大结果 → 2 个请求全发、0 abort
```

它**不进 `check`**：不进三层里的任何一层（不启 Electron、不用真实模型），
但它比断言更难伪造 —— 「第 2 个请求没发出」是假 provider 侧的计数。
改钩子相关行为（预算门 / 压缩 / 工具门禁）时重跑并把结论写回
[证据-05-S1](../archive/evidence/证据-05-S1-钩子与安全点.md)（钩子能力边界）与
[证据-05-S4](../archive/evidence/证据-05-S4-请求前预算门.md)（预算门）。
两个必知的坑：spawn pi 时 **stdin 必须断开**（否则 `--print` 等 stdin，表现为卡死）；
假 provider 的工具命令里**只能用相对路径**（反斜杠会被当转义吃掉）。

## 视觉矩阵（截图证据）

不属于上面三层，但补的是同一类缺口（真实窗口证据）：

覆盖状态里与"用户报的缺陷"直接对应的两张：`usageelapsed`（用量条上的「用时 Ns」，
硬断言 `[data-testid="ub-elapsed"]`）与 `ctxnarrow` / `contextbudget`（右栏工作集）。

| 命令 | 作用 |
|---|---|
| `npm run visual:matrix` | 跑全部 9 组，每组一个 Electron 进程 |
| `npm run visual:matrix -- 0 2` | 只跑指定组（组号看 `GROUPS`；`onboarding` 是名字） |

覆盖：3 尺寸（1440x900 / 940x620 / 900x520）× 3 缩放（100/125/150%）× 深浅，状态包括主界面、模型菜单、推理块、设置面板、迷你项目栏、窄右栏文件树（`fsnarrow`：`PANEL_MIN=220` 下的超长名省略、缩进收敛、无权限目录提示）、shell 改动卡片（`wschanges` 正常归属 / `wsunknown` 同目录并发时的“无法归属”提示）、额度三档色阶（`quotatone`，**单开组 7 / 8**）与引导层。输出 26 张
`docs/design/preview/matrix-<state>-<尺寸>-<缩放>-<主题>-2026-09-16.png`（**新名，不覆盖任何已有预览图**）。

`quotatone` 为什么要单独成组：它得把会话的 provider 换成 `commandcode`（额度桩只在这个
provider 下返回三档受控数据），塞进组 0 会让同一进程里后面的状态带着这个假 provider 继续截图；
单独一组就只影响这一张图。该状态脚本除了类名，还要比 `getComputedStyle` 的计算色是否等于
`--ok` / `--warn` / `--err` —— 真实额度落不到 70 / 95 这两个点上，边界配色只能这样截。
这条断言的第一次运行就抓出了一个真缺陷：`ok` 档当时被写成空类名，低用量显示的是默认前景色
（`rgb(180,180,172)`）而不是绿色。

数据一律来自 `scripts/shot-fixture.js`（合成）：截图会进仓库，**绝不要**把真实会话截进去。

**真实模型的截图**（少见的例外）：N04 的「长中英混排推理流」必须真调模型 —— 合成 fixture
只能证明渲染，而那一项缺的正是「真的有一段推理在流」。用法是
`YAN_SHOT=<png> YAN_SHOT_SETUP=scripts/shot-setup/reasoning-live.js`（隔离三件套 + `YAN_TEST_MODEL`
见 [实施-09 §2 N04](../plan/active/实施-09-交付与验收收尾.md)）；前置脚本会在**推理仍在流式**时返回，
因为回合结束后推理块按契约自动折叠，截晚了就没有流。⚠️ 这类图带真实会话内容（虽然只有一条提问）
并消耗额度，只用于一次性人工验收，**不要**接进 `check`。

它不进 `npm run check`：依赖真实窗口与合成器，而且在部分环境上跑满会崩（见 [MAINTENANCE](MAINTENANCE.md)），属于人工/按需验收。

## 相关文件

| 文件 | 作用 |
|---|---|
| `scripts/test-live.mjs` | live 场景注册表（`CASES`）+ 隔离 + 测试模型注入 |
| `scripts/test-unit.mjs` | 单元测试入口（纯逻辑） |
| `scripts/hook-probe.mjs` | 假 provider 下的钩子 / 请求时序实测（不联网、不花钱，见上一节） |
| `scripts/probe/*.js` | 各 live 场景的探针脚本（在真实渲染进程里执行）；`subagentpair.js` 是唯一带退出后检查的场景 |
| `scripts/visual-matrix.mjs` + `scripts/visual-matrix-run.mjs` | 视觉矩阵：真实窗口截图（分组跑批，每组一个进程） |
| `scripts/shot-setup/reasoning-live.js` | 真实思考模型的推理流截图前置（N04；配合 `YAN_SHOT_SETUP`） |
| `src/shared/web-search.ts` | 「兼容搜索能力」判定（实施-07 S4）：纯函数，决定来源菜单里那枚搜索入口出不出现 |
| `scripts/bench/context-tasks.mjs` | N21-9 的合成任务集（数据，**不随包分发**）：3 个任务 / 13 条约束，每条自带 `kept` / `violated` 样例供单测自检 |
| `scripts/bench/context-bench.mjs` | N21-9 跑批器：`npm run bench:context -- --mock|--live`（mock cost 0 只验装置；**live 要额度**，第一次跑先 `--mock` 再 `--live --tasks=1 --strategies=A`）。⚠️ 它不自己做判分 —— 口径全部来自 `src/shared/context-bench.ts`，它只负责编排与出报告 |
| `scripts/probe/upgrade-read.js` | 升级读取验证的探针（配合 `scripts/test-upgrade-read.mjs`；`npm run test:upgrade`） |
| `scripts/test-*.mjs` | 各模块的单测（在 `test-unit.mjs` 里用 esbuild 现场编译源码后跑） |
| `resources/pi-extensions/question.js` | 内置「提问」扩展（问答功能的模型侧） |
