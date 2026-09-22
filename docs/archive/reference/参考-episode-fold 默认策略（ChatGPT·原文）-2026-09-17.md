# 参考 · episode-fold 默认策略（ChatGPT 原文）· 2026-09-17

> **这是外部意见，不是本项目的决定。**
> 本轮只问一个决策：`episode-fold`（状态生成 + `<TASK_STATE>` 注入）要不要进默认 kinds。
> 我方对这份意见的**源码核查**在 §核查（哪些前提在我们代码里成立、哪些不成立），
> 是否采纳仍待**用户拍板** —— 见[方案 §17.5](../../design/active/方案-上下文工具内的自动压缩-2026-09-15.md)。
>
> - 提问方：砚（本项目）｜作答：ChatGPT 网页版
> - 会话：`https://chatgpt.com/c/6aabaad6-37c4-83ec-9887-5b96bbca4301`（标题「Episode fold默认策略」）
>   —— **新开**的会话（不是第三轮那个 thread），所以提问里重述了已落地的事实；
>   思考 47s，回复约 1.1 万字
> - 同主题的前几轮见[《上下文管理外部评审（ChatGPT 原文）》](../reference/参考-上下文管理外部评审（ChatGPT·原文）-2026-09-17.md)
> - **格式说明**：由内置浏览器无障碍树文本重排。文字未改动（个别空行被合并）；
>   代码块原本带 `TypeScript` / `JavaScript` / `JSON` / `XML` 语言标签，此处保留为普通代码块。
>   原文末尾那句 `ChatGPT 也可能会犯错。请核查重要信息。` 是 ChatGPT 自己加的。

## 一、我们提的问题

> 接手一个已经三轮评审过的设计，只问一个决策，请给明确立场。
>
> 【项目】砚：Electron + React 桌面端，pi（编码 agent）作为 `--mode rpc` 子进程，界面只订阅；
> pi 扩展是 JS 钩子（context / session_before_compact / before_provider_request / agent_settled），
> 扩展内可用 `ctx.modelRegistry.complete()` 自调模型；TaskState 是会话 JSONL 的可重建
> materialized view（schema 真源在主进程 TS）。
>
> 【已落地并真实跑通】① 确定性 Tool Sweep：过期工具结果换墓碑 + `ctx://` 引用，先归档再写墓碑。
> ② context_recall：按引用取回原文，带预算/TTL/审计。③ 混合式语义生成器：确定性 reducer 产出
> files/commandsRun/testsRun（真实 entryId 与退出码），一次无工具 completion 只产出语义字段
> （objective/currentPhase/assumptions/hypothesis/decisions/nextActions），落盘前 reducer 覆盖
> 模型同名字段。④ CAS：状态带 revision，落盘要求磁盘 revision 等于生成开始时的值，
> 迟到/超时/解析失败一律保留旧状态（实测：生成期间被人改过则 CAS 拒绝、文件保持对方版本）。
> ⑤ freshness 分档：gap 1–2 标 stale、3–6 只留 objective 与约束、>6 不注入（不再要求 head 完全一致）。
> ⑥ dirty 闸门：硬触发 / 权重累计 ≥6 / 落后 ≥2 回合 / 净增 ≥6000 token 才刷新，纯只读不触发。
> ⑦ 状态自身预算：hard cap = min(6000, max(2500, workingSet×0.025))，裁剪顺序明确，
> objective / constraints / failedAttempts / unresolved 永不删。
> ⑧ 默认 kinds = `['tool-sweep','recall','compaction']`，即 episode-fold 默认关。
>
> 【要决策的事】默认 kinds 要不要包含 episode-fold。默认关不是少一次优化，而是整条状态层空转：
> 没有状态文件 → TASK_STATE 永不注入 → `session_before_compact` 永远降级回 pi 原生摘要，
> 只有 tool-sweep 与 compaction 生效。默认开的代价：每命中一次 dirty 多一次无工具 completion
> （20s 超时、6000 token 硬上限、长编码会话约每 1–3 个 settled turn 一次）。
> 用户已明确接受多一次无工具 completion 的额度与延迟。
>
> 【已知风险】① 语义字段可能不准，且它通过注入进入后续回合（自我强化/漂移）；
> ② EpisodeState 语义生成还没做（沿用上一版）；③ 增量 delta 还没做（每次全量快照，输入更大）；
> ④ 还没有 A/B 基线 —— N21-9（四策略对照 + Lost Constraint Rate + 任务成功率）没跑，
> 所以「开了更好」目前只有机制论证、没有量化证据。
>
> 【请回答】① 明确立场：默认开 / 默认关 / 分条件开（条件必须具体可判定），把理由与代价讲透，
> 不要两可。② 若主张先等 A/B 数据，那么在数据出来之前的当下应默认关还是默认开？
> 默认关是否会让这功能实际永远没人用（用户不会去设置里找一个他不知道存在的东西）？
> ③ 若主张默认开，按必要性排序给出前置硬化项：哪些必须上线前完成、哪些可上线后补。
> ④ 有没有比二元开关更好的第三方案（只对长会话/特定阈值生效、首次命中给用户一次可见提示
> 并可一键关闭、按模型成本分级、默认开但注入时带可见标记）—— 逐个评估可实现性与副作用。
> ⑤ 这个决策的判据应该是什么：哪几个指标到什么水平就该开、什么水平就该关。

## 二、ChatGPT 的回答（原文）

### 结论

我的明确立场：默认 kinds 应该包含 `episode-fold`，但采用「默认启用 + 长会话条件激活」，
而不是从第一个 turn 就运行。

也就是配置层：

```
kinds = ['tool-sweep', 'episode-fold', 'recall', 'compaction']
```

但增加一个独立的、会话内 sticky 的 eligibility gate：

```
episodeFoldEligible =
  (
    settledTurns >= 4 &&
    rawTranscriptTokens >= Math.min(48_000, workingSet * 0.35)
  )
  || firstToolSweepOccurred
  || contextUsage >= workingSet * 0.60
  || compactionIsImminent
```

一旦命中：

```
episodeFoldActivated = true // 本会话后续不再退回 false
```

然后仍然由你现在的 dirty gate 决定什么时候刷新。

所以严格对应你给的三个选项，我选：**分条件开，而且产品默认值是开。**
不是「设置里默认关等用户自己发现」。

### ① 为什么这样选

你现在这个设计有一个很关键的结构事实：**episode-fold 不是一个可有可无的优化器，
而是整个 TaskState 状态层的启动器。**

关闭后不是「有 TaskState，只是少做了一点优化」，而是：

```
无 TaskState
→ 无 TASK_STATE injection
→ structured compaction 没有状态输入
→ session_before_compact 退回 native summary
→ freshness / CAS / reducer / semantic generator / dirty gate / state budget
  大量机制基本没有生产价值
```

所以把它默认关，实际上相当于：N21-4 的主体架构默认不参与正常运行。

而用户通常不会进入设置页面寻找一个不知道存在的内部上下文策略。

因此我不支持「先默认关，等 N21-9 证明有效，再考虑默认开」——
这会产生很严重的 feature invisibility。

但我也不支持「第一轮就无条件开」。因为你的主要风险并不是 completion 成本。
用户既然已经接受额外一次无工具 completion，那么真正需要控制的是：
**semantic state 成为后续 inference input 后形成的闭环误差。**

链路是：

```
transcript → semantic generator → TaskState → TASK_STATE injection
→ 下一轮模型行为 → 新的 transcript → 下一次 semantic generator
```

这与普通摘要不同。错误状态可能从「一个错误 hypothesis」变成：
错误 hypothesis → 模型依据它采取行动 → 行动进入 transcript → 新状态再次认为它成立。
也就是你说的 self-reinforcement / drift。

而短任务根本没有必要承担这个风险。所以最合理的边界不是 ON/OFF，而是：

```
feature enabled → session eligible? → dirty? → generate → inject
```

### ② 要不要等 A/B？

**不要等。**

在 N21-9 出数据之前，我仍然主张：默认 enabled，但 guarded activation。原因有三个。

**第一，机制已经达到可以受控上线的成熟度。** 你不是在拿一个裸 LLM summary 直接塞回 context。
现在已有：raw JSONL 事实源、deterministic reducer、reducer 覆盖模型同名字段、CAS、
freshness degradation、dirty gate、hard budget、Tool Sweep archive-before-tombstone、recall、
timeout/failure 保留旧状态。这些已经把典型状态系统事故压掉了相当一部分。
现在最大的未知量是：semantic state 到底带来多少净收益。这更适合通过 guarded rollout + N21-9
测量，而不是把整个功能默认隐藏。

**第二，不启用生产路径就很难验证真实问题。** Shadow generation 可以测：状态是否准确、
成本多少、生成稳定性如何。但测不了最重要的问题：TASK_STATE injection 到底有没有降低
lost constraint，又有没有改变 agent 行为。必须进入真实 inference path 才能测。

**第三，A/B 的目标应该决定「扩大还是撤回」，而不是决定「第一次能不能跑」。**
所以状态应该是：现在 guarded default-on；N21-9 验证是否扩大到更短会话 / 保持当前 gate / rollback。
而不是：现在 default-off；N21-9 理论测试一个用户实际上不会打开的功能。

### ③ 默认开之前，我认为哪些硬化项必须做

**P0 — 上线前必须完成**

1. **切断 TaskState 的直接递归污染**（最重要的一项）。生成新 TaskState 时，输入必须来自
   canonical JSONL，并排除所有 synthetic context。明确排除：`<TASK_STATE>`、episode fold
   synthetic message、recall injection、tool-sweep tombstone 展开后的 synthetic content、
   previous state injection。即：

   ```
   stateGeneratorInput =
     rawCanonicalTranscript
     - syntheticTaskState
     - syntheticRecall
     - syntheticFold
   ```

   绝对不能：上一版 TASK_STATE → 进入下一版 TaskState generator。
   否则漂移会直接变成递归压缩。

2. **TASK_STATE 必须声明「非事实源」。** 注入块要有机器可识别的 authority contract：

   ```
   <TASK_STATE derived="true" authoritative="false" sourceHead="..." freshness="fresh|stale|partial">
   ```

   并明确给模型：This state is a derived working cache, not ground truth. If it conflicts with the
   raw transcript, tool results, or newer user instructions, the latter wins.
   尤其优先级必须固定为：

   ```
   new user instruction > actual tool result > deterministic reducer facts
   > raw transcript > derived semantic TaskState
   ```

   不能让模型自行猜优先级。

3. **semantic item 增加 provenance。** 至少 objective / assumptions / hypothesis / decisions /
   nextActions，建议从 `{ text: "..." }` 升级成 `{ text: "...", supportingEntryIds: ["..."] }`，
   然后落盘前验证：entryId 存在 AND entryId <= sourceHead AND 属于当前 ancestry。
   模型不能提供合法证据引用的项目：objective / decision 建议直接丢弃或降权；
   hypothesis / nextAction 允许存在但标记 inferred。最终能区分：observed / user-stated /
   derived / inferred。这是抑制语义漂移非常划算的一层。

4. **EpisodeState 旧语义生成不能悄悄混进默认路径。** 你提到「EpisodeState 语义生成还沿用上一版」。
   我的要求不是「必须立刻重写 EpisodeState」，而是上线时必须二选一：
   A. 完成新 EpisodeState generator；或 B. 默认开启版本暂时关闭 EpisodeState semantic fields。
   **不能** TaskState 用新 safety contract、EpisodeState 继续走旧语义逻辑，然后两个一起进入 inference
   —— 那会让你刚做的 provenance/freshness/CAS 防线出现旁路。我倾向 B，先关闭旧语义 EpisodeState。

5. **必须有 instant kill switch。** 至少 `episodeFold.enabled` / `episodeFold.generate` /
   `episodeFold.inject`，最好可以分别关闭。出现问题时能做到「停止 injection 但继续 shadow generation」，
   而不是只能把整个 context extension 拔掉。

**P1 — 强烈建议上线前做，但不是 architecture blocker**

- **semantic contradiction detector**：例如新 user turn「不要改数据库」，旧 TaskState 的
  `nextActions: 修改数据库 schema`。不要等完整 regeneration，在 deterministic overlay 阶段
  直接把旧 nextAction invalidated。不要求理解所有自然语言矛盾，但至少：
  new explicit user instruction 应让 nextActions / hypothesis / assumptions 进入 stale。

**P2 — 可以上线后补**

- **增量 delta**：我不会拿它卡默认开启。它主要解决 generation input cost / latency / 重复处理，
  而不是正确性。现阶段 full snapshot 反而更简单、更容易验证。
- 更精细的 EpisodeState generator（前提是旧版本不要参与默认 inference 即可）。
- 动态模型选择：也不是上线 blocker。先保证一套模型路径行为稳定，再优化成本。

### ④ 四种「第三方案」逐个判断

**A. 只在长会话达到阈值后开启 —— 强烈推荐，而且我认为应该成为最终方案。**

```
const tokenGate = Math.min(48_000, workingSet * 0.35);

eligible =
  (settledTurns >= 4 && rawTranscriptTokens >= tokenGate)
  || firstToolSweepOccurred
  || contextUsage >= workingSet * 0.60
  || compactionImminent;
```

为什么不是 70%？因为 70% 已经进入 Tool Sweep 区域。状态第一次生成如果也等到那里：
大 turn 突然把 usage 从 55% 推到 95%，可能第一次 state generation 就与紧急 compact 撞在一起。
35% 左右更合理。同时 `settledTurns >= 4` 防止一个巨大的 pasted log 导致短任务仅因 token 大
就反复生成状态。

一旦激活就 sticky：`false → true`，本 session 不再变回 false。否则使用量在 compact 后下降会发生
开/关/开/关，产生状态生命周期语义混乱。

**B. 首次命中时给一次用户提示，可一键关闭 —— 推荐，但不能做 modal。**

例如：「已启用长会话上下文状态，用于保留任务目标、决策和下一步。关闭 · 了解更多」，只出现一次。
优点：用户知道额度为什么多一次 completion；用户知道这个能力存在；出现异常时知道哪里关闭；
避免「隐藏 AI 行为」。副作用：如果每次 session 都提示会非常烦，所以应该是 per-install /
per-user acknowledgement，而不是 per-session。

**C. 按模型成本分级 —— 暂时不推荐作为默认策略。**

例如「贵模型 → 更少 refresh，便宜模型 → 高频 refresh」，表面合理，但会引入新的耦合：
模型价格 → 状态 freshness → agent 行为质量，最后同一个项目在不同 provider 上会出现不同 memory
semantics。更麻烦的是：便宜模型往往恰好可能更容易产生 semantic state error。
不能简单认为 cheap model = cheap state generator。如果以后做，应该根据 capability class
而不是价格。现阶段不值得增加变量。

**D. 默认开，但注入时带可见标记 —— 分两种「可见」。**

对模型可见：**必须**，就是前面的 `<TASK_STATE derived="true" authoritative="false">`，
这是 correctness requirement。
对用户 UI 可见：**推荐**，例如状态栏一个 `Context State · Active`，点击后可以看 revision /
sourceHead / freshness / last generated / semantic token size，甚至开发模式显示 Deterministic /
Semantic / Stale。这对调试 N21-9 极有价值。但不要把 TASK_STATE 全文默认展示在聊天 transcript 中，
否则会污染主交互。

### ⑤ 我甚至建议再加一个方案：Shadow → Inject 两阶段

第一次达到 eligibility 时：

```
generate state → persist → 不 retroactively 影响当前 settled turn → 从下一用户 turn 开始 injection
```

也就是说不要在 `agent_settled → state completion → 再改变刚结束 turn`，而是
`agent_settled → generate revision N → next inference uses revision N`。
这能保持非常清晰的因果关系：`state[N]` 只能影响 `turn[N+1...]`，审计起来会简单很多。

### ⑥ N21-9 应该用什么判据决定以后「彻底开」还是「退」

不要只看任务成功率。这个系统至少要看五组指标。

| 指标 | 默认扩大开启 | 保持 guarded | 应关闭 injection |
|---|---|---|---|
| Lost Constraint Rate | 相对下降 ≥25% | ±25% 内 | 相对上升 ≥10% |
| Task Success Rate | ≥ baseline +2pp，或至少非劣 | ±2pp | 下降 ≥3pp |
| Semantic contradiction rate | <1% injected items | 1–3% | >3% |
| State-attributable harmful task rate | <0.5% tasks | 0.5–1% | >1% |
| 额外 token 成本 | ≤15% | 15–25% | >25% 且无明显质量收益 |

其中最重要的不是 Task Success，而是前两个组合。

**第一判据：Lost Constraint Rate** —— 这是 TaskState 最直接应该改善的指标。定义尽量严格：
用户明确给出的仍然有效的 requirement/constraint 在后续 agent decision 中被遗漏或违反。
我会要求 episode-fold 相比 native baseline 至少降低 25% relative LCR。例如 baseline 8.0% → 5.8%
属于明显成功；如果 8.0% → 7.8%，那不足以证明值得承担复杂度。

**第二判据：成功率必须 non-inferior** —— TaskState 的目标不能是「记得更多约束但最终更容易做错任务」。
最低要求是成功率不能有 ≥3pp 的下降；如果能 +2pp 以上，就有比较明确的正向证据。

**第三判据：Semantic Contradiction Rate** —— 建议直接在 N21-9 增加。检测 injected state item
与其 supporting entries 或更新后的 transcript 是否矛盾。目标 <1%，超过 3% 我不会继续默认 injection，
因为这是一个反馈系统，3% 并不低。

**第四判据：真正的 harmful-state attribution** —— 单独统计：如果没有 TASK_STATE，agent 不太可能
执行这个错误动作，而错误动作明显来自错误 state。例如 state 说「Tests already pass.」而实际
tests failed，agent 跳过测试并宣布完成。这类事件如果 >1% active sessions/tasks，
应该直接关闭 semantic injection，回 shadow mode 调查，不是继续微调 threshold。

### ⑦ Cost 指标别只算 6000 token 输出

这个地方我特别建议你留意。现在成本真正危险的不是 6000 output hard cap，而是
**每 1–3 settled turn 做一次 full transcript snapshot input**。长会话可能变成 80k → 100k → 120k →
140k input，累计输入 token 很快超过主 agent inference 本身的一大截。所以 N21-9 必须单独记录：

```
stateGenerationInputTokens / stateGenerationOutputTokens
mainAgentInputTokens / mainAgentOutputTokens

stateOverhead = stateGenerationTokens / mainAgentTokens
```

这会直接告诉你 N21-4 后面是否必须优先做 incremental delta。如果 overhead 长期 >25%，
即使用户现在说接受成本，我也会把 delta 从 P2 提升到 P1。

### 最终执行决策

如果现在让我直接给 N21-4 下 merge decision，我会写成：

将 `episode-fold` 加入默认 kinds，但增加 session-level eligibility gate。短会话不启动；
达到 `settledTurns >= 4 && rawTranscriptTokens >= min(48k, 35% workingSet)`，
或发生首次 Tool Sweep、达到 60% workingSet、即将 compact 时启动；启动后本 session sticky。

上线前必须保证 state generator 不读取 synthetic TASK_STATE、明确 derived-state authority、
给 semantic state 加 provenance，并禁止旧 EpisodeState semantic path 混入默认 inference；
必须提供独立 injection kill switch。

N21-9 不作为首次启用的阻塞条件，而作为扩大/保持/撤回默认策略的 gate。

换句话说，你现在不该把问题定义成「episode-fold 默认开还是默认关？」
真正合理的最终状态机是：

```
DEFAULT ENABLED
       │
       ▼
   not eligible ──────────► 零额外 completion
       │
       │ 长会话
       ▼
    eligible
       │
       ▼
     dirty?
    /     \
   no      yes
   │        │
 reuse    generate
            │
           CAS
            │
     ┌──────┴──────┐
   reject         accept
     │              │
 old state      revision N
                    │
                    ▼
              next inference
              TASK_STATE[N]
```

这比二元默认开关更符合你现在整个 N21-4 的架构。

ChatGPT 也可能会犯错。请核查重要信息。

---

## 三、我方核查（源码级，2026-09-17）

这一节**不是** ChatGPT 的说法，是拿到意见后回代码里逐条对的结果。
结论分三类：**已具备** / **不成立（前提在我们这里不对）** / **确实缺**。

### 已具备（它要求的防线已经在代码里）

| ChatGPT 的要求 | 我们的现状 |
|---|---|
| 条目级 provenance | **已有**：`provenance{source, confidence}`，`confidence ∈ observed / derived / hypothesis`，且校验器强制「模型自己写的内容只能是 `hypothesis`，不能自称 observed」（`src/shared/context-state.ts`） |
| 给条目加可校验的引用 | **已有**：`sourceRange`（§12.7），并且校验器拒绝指向 `ctx://` 归档引用 —— 这就是「禁止递归摘要」的既有判据 |
| reducer 覆盖模型同名字段 | **已有**：`mergeTaskState` 用确定性结果覆盖 files/commandsRun/testsRun |
| CAS 而不是 abort 保正确性 | **已有**：revision 前置条件 + 落盘前复读比对，超时/解析失败保留旧状态（单测覆盖「生成期间被改过 → CAS 拒绝」） |
| dirty 分类 + 阈值 | **已有**：`dirtyMask` / `dirtyMaskWithEvidence` / `shouldRefresh`（硬触发、权重累计、落后、净增） |
| 状态自身 token 预算与裁剪 | **已有**：`clipTaskStateToBudget`，`objective / constraints / failedAttempts / unresolved` 永不删 |
| Shadow → Inject 两阶段（state[N] 只影响 turn[N+1]） | **已经是这个结构**：生成发生在 `agent_settled`（回合真的结束之后），注入发生在**下一次** `context` 调用 |
| 写盘校验通道 | **已有**：主进程是唯一 durable writer（扩展经 `saveContextState` 走主进程校验 + 原子写） |

### 不成立 —— 它假设我们有的东西，其实没有

这三条直接影响它的方案能不能照抄，必须回到用户面前：

1. **我们**没有** `settledTurns` 这个计数。**
   `watermarkOfEntries()` 只产出 `{ entryCount, lastEntryId }`；`freshnessOf()` 的 `gap` 是
   **entry 条数差**（`count - w.entryCount`），不是「回合数」。
   所以它的 `settledTurns >= 4` 与我们的 `gap >= 2` **不是同一个量**。
   更要注意：一个回合通常会产生**多个 entry**，所以现有那条「落后 ≥2 就刷新」实际上比字面激进得多
   —— 它等于说「只要会话比上次快照多了 2 条 entry 就重新生成」，
   dirty 权重（≥6）这个闸门在长会话里几乎被这一条绕过。
   **这一点与「打开 episode-fold 后成本有多高」直接相关，需要在写 gate 之前先定口径。**

2. **没有「首次 Tool Sweep 发生过」这个信号。**
   `context` 钩子里 sweep 的成功/跳过只写 `trace`，没有任何会话级持久标记
   （`context.js` 的 `sweep-applied` / `sweep-skipped` 分支）。要用 `firstToolSweepOccurred`
   这个条件，得先加一个（或改成从归档目录推断）。

3. **`compactionIsImminent` 也没有现成值**，只有主进程侧的水位策略
   （`context-policy.ts` 的三档线）。扩展侧要判定它，需要把「下一步是哪一档」传进来
   —— 目前扩展拿不到工作集（代码注释里明确写了「工作集在扩展侧拿不到」）。

### 确实缺（它指出的问题成立）

| 它指出的 | 我们的现状 | 严重度 |
|---|---|---|
| 生成器输入可能含 synthetic 内容（递归污染） | `produceAndCommit` 取的是 `ctx.sessionManager.getEntries()`，**没有排除 `<TASK_STATE>` / 墓碑 / 召回正文**。目前靠「注入块是 synthetic message、不在 entries 里」侥幸，但**没有断言** | 高（正是「漂移变递归压缩」的入口） |
| `EpisodeState` 旧语义会进注入 | `episodes` **确实会被渲染进注入文本**（`context-transform.js` 的 episodes 分支），而 producer 只写 `episodes: previous?.episodes ?? []` —— 也就是**当前恒为空、暂无症状**，但**没有任何防线**阻止旧语义将来混入 | 中（隐性；P0-4 的正确做法是先关或补契约） |
| instant kill switch（generate / inject 分开） | 只有 `kinds` 一个总开关：关掉 `episode-fold` 等于同时停掉生成与注入 | 中 |
| 用户侧可发现性（提示一次 + 状态栏可见） | 都没有；设置面板里也没有这个开关的入口 | 中（与「默认关会不会等于没人用」直接相关） |

### 我（砚）对这份意见的判断

- **「分条件开」这个形态我认同**，而且它说的「episode-fold 是状态层的启动器，不是可选优化」
  与我们自己的诊断一致（默认关 = 整条状态层空转）。
- **`settledTurns >= 4` 这类具体阈值不能照抄** —— 前提不对（见上），必须先定「回合」的口径。
- **P0-1（切断 synthetic 输入）与 P0-4（EpisodeState 别旁路）我建议无条件先做**，
  它们与「默认开还是关」无关，是纯收益的防线。
- **它的成本判断（真正的开销是 full snapshot 的输入 token，而不是 6000 输出上限）成立**，
  而我们的「增量 delta 未做」正好命中这条；`stateOverhead > 25%` 就升 P1 这个建议值得记下。
- **N21-9 的五组判据可以直接用**（Lost Constraint Rate 为主判据、成功率要求 non-inferior、
  加 contradiction rate 与 harmful-state attribution，成本单列）—— 这比我们原来「四策略对照 +
  Lost Constraint Rate」的口径更完整。
- 它有一条**没考虑到**：我们已经把 `recall` 的 TTL 设成 1 回合（上一轮召回的正文会清成存根），
  这本身就降低了「synthetic 内容被再次摘要」的概率 —— 但**不能替代** P0-1 的显式排除。

## 四、我方实施进度（2026-09-17 晚）

- **已落地**：P0-1（生成器输入自净）、P0-2（注入块 authority 契约头 + 固定优先级）、
  P0-4（episode 旁路两道防线）、P0-5（`generate` / `inject` 分路，压缩接手同路）、
  以及它第四问 A 的 **会话级 eligibility gate**；另加一条本轮核查发现的缺陷级口径修正
  （`settledGap` 从 entry 条数差改成**回合**差）。
- **仍未做**：默认 kinds **未动**（仍不含 `episode-fold`）—— 是否默认开仍待用户拍板，
  但现在打开它是受控的：短会话会被 gate 挡住（`contextgate` 场景在真实链路验过：0 次 committed、
  0 份状态文件），而且可以用 `state.inject=false` 单独停掉注入与压缩接手。
- 它要的三个 gate 信号里，**settled turn 计数已补上**（`turnsSince`）；另两个
  （`contextUsage ≥ 60% workingSet` / `compactionIsImminent`）需要主进程的工作集，**仍未接**。
- 细节与证据：[方案 §17.6](../../design/active/方案-上下文工具内的自动压缩-2026-09-15.md)、
  [归档 §1.11](../2026-09-17-已完成归档.md)（含两条观察：真实链路注入几乎总是 `partial`，
  以及「下一步」总会挂 `[stale: verify…]`）。
- **后续（同日晚）**：带着已经落地的实现又问了第二轮「这套做法有没有漏洞」——
  它指出两个该修的洞（Sweep 不得绕过最低回合数；`inject` 的语义要写死），
  并定案了上面那两条观察（落后 1 条未 settled 的 user 算 fresh）。
  原文与实测修正见[参考 · N21-5 硬化实现复核](../reference/参考-硬化实现复核（ChatGPT·原文）-2026-09-17.md)、方案 §17.7。
