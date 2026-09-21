# 实施-11 · Harness 工作窗口与 1M 模型策略融合

状态：**进行中**（2026-09-21 首批切片已开始；本文已把两份设计输入整理成有序队列，尚未宣称整项完成）

本实施文档把两份 2026-09-21 设计输入拆成可以逐片验收的工程任务：

- [DeepSeek Harness 功能与工作窗口移植方案](../../design/active/方案-DeepSeek-Harness功能与工作窗口移植-2026-09-21.md)
- [上下文压缩频率与 1M 模型策略审阅](../../design/active/审阅-上下文压缩频率与1M模型策略-2026-09-21.md)

两份文件是设计 / 审阅依据，不是已经完成的证据，也不把其中的示例命令、阈值或
外部产品行为直接当成砚的产品要求。当前状态和证据仍以
[HANDOFF](../../dev/HANDOFF.md) 为准，验收口径以
[工程清单](../../dev/ENGINEERING-CHECKLIST-2026-09-15.md) 为准；
片与片能不能同时开工、各自占哪些文件，见
[并行代理编排](./编排-并行代理分工-2026-09-19.md)（本文 §3.7 只做索引，不复制它的规则）。

**队列口径**（避免把本文读成进度表）：

- **位次**是推荐的开工顺序，表达依赖与风险，**不表示必须串行**；真正的并行边界由文件域决定（§3.7）。
- **状态列只写当前已有证据**：代码落地但没有真实窗口 / 视觉 / 包证据的，一律写「已实现，待证据」，不得写「完成」。
- 设计输入里的候选尺寸、阈值、示例数值都是**待验证参数**，实施前必须先更新
  [DESIGN](../../design/DESIGN.md) 再同步 `tokens.css`（AGENTS.md 代码约定）。
- 每片收尾必须同时做三件事：本文状态列、[plan/README](../README.md) 状态列、HANDOFF 追加自己一节。

## 0. 融合结论

两份方案的交集不是“把界面抄成另一个产品”，而是两条相互约束的线：

1. 对话回合要有可解释的生命周期：从 agent 回合开始，到模型输出、工具执行、重试和
   压缩相关动作结束，用户能看到整轮耗时；单条模型首 token 速度继续单独表达，不能把
   工具等待伪装成生成速度。
2. 工作窗口要成为右栏资源的协调层：工具、审查、浏览器和文件预览的切换不能因为
   “换标签”就销毁仍可返回的资源；但真正的多标签 / 多文档持久化还需要独立状态模型，
   不能用一个局部 `windowView` 变量冒充完成。
3. 1M 模型策略要按**精确的 provider/model**试行，不按模型名猜容量，也不把 600K / 700K
   写成全局默认。上下文预算仍须同时受模型实际窗口、输出预留和安全余量的 `min` 约束；
   “注册表写了 1M”也不能替代真实端点验证。
4. 自动压缩的后续工作重点是可观测性与防抖，而不是只把一个数字从 240K 改成更大的数字：
   要能解释本次用量、阶段、触发原因、压缩前后以及失败后的重试状态。

## 1. DSH 代码搬运规则

用户已明确允许直接搬运 DeepSeek Harness（DSH）的实现。执行规则如下：

- 优先原样移植与框架无关的纯函数、数据契约和状态生命周期逻辑；只改 import、类型、
  IPC / 宿主接口和项目路径适配，不为形式上的“重写”改变已经验证的语义。
- `Cordis`、`slots`、`resource service`、DSH 的 iframe / dockkit 或完整插件框架不整套
  引入。砚继续使用 Electron 原生 `WebContentsView`、现有 preload / IPC 和默认 pi RPC。
- 直接复制或实质性改编的文件保留 DSH 来源路径、commit / 版本信息和 MIT 许可说明；
  若代码量达到一个独立模块，补充项目级第三方来源记录。
- DSH 的阈值只能作为可配置策略的参考。`thresholdRatio=0.8`、`retainRatio=0.16`
  不能绕过砚已有的输出预留、物理闸门和 provider/model 覆盖链。
- **搬运不能绕过薄层口径**：任何搬运进来的能力，若必须注册模型工具或 pi 命令才能工作，
  就不搬（AGENTS.md 第五节）。纯函数、数据契约、宿主服务、`yan` 子命令是允许的落点。
- 搬运后仍按砚的六栏口径重新验证；DSH 的测试、截图和运行结论不替代砚自己的证据。

优先可搬运的参考实现：

| DSH 文件 | 搬运方向 |
|---|---|
| `packages/client/ui-primitives/src/markdown/file-link.ts` | 文件链接与 `#L42` 解析纯函数（→ H-4） |
| `packages/client/ui-chat/src/client/contract/turn-metrics.ts` | 首 token / decode / output token 的统计口径（→ H-1 / H-6） |
| `packages/client/ui-sidebar-right/src/client/tab-domain.ts` | 按会话持有 tab、导航 revision、关闭时 abort 的生命周期模型（→ H-3） |
| `packages/compaction/compaction-basic/src/config.ts` | 精确 provider/model 的策略解析与容量缩放（→ C-4 / C-6） |
| `packages/compaction/compaction-basic/src/index.ts`、`region.ts` | 先无模型清扫、重新测量、再摘要；失败与溢出恢复的事务边界（→ C-2 / C-6） |

参考根目录：`C:/Users/YuDaTou/Desktop/deepseek-harness/`。实际复制前核对该仓库的
当前 commit 与许可证；本表不表示这些文件已经全部移植。

## 2. 当前基线与不变边界

- 现有默认工作集上限仍为 **240K**；这轮不改全局默认。
- 现有模型级覆盖链已经存在：`env > user > provider/model`。本片只在其上增加明确的
  大窗口试行档，不改变覆盖优先级。
- 上下文公式仍由 `contextBudget()` 统一计算；任何试行档不能绕过物理兜底和输出预留。
- 右栏当前是单一活动窗口表面；本片先修复“切换时误销毁资源”，不声称已经完成
  Codex 式工作区、多浏览器、多文档并存或终端面板。
- 任务面板、旧记忆系统、`get_tree`、默认 pi / 插件边界不在本方案融合范围内，遵循
  根目录 `AGENTS.md` 的已确认产品边界。
- 图标已有自己的设计输入（[图标设计与应用准则](../../design/active/图标设计与应用准则-2026-09-21.md)）；
  本队列只做**接入与统一**，不在这里另定一套图形准则（见 H-8）。
- 安卓、账户同步、证书不在本轮（见 §3.5）。

## 3. 实施队列

### 3.1 位次总表

| 位次 | 编号 | 项 | 来源 | 依赖 | 状态 |
|---:|---|---|---|---|---|
| — | D-0 | 文档工作区分层 | 本轮整理 | — | **已完成**（brokenDocLinks = 0） |
| 1 | H-1 | 整轮时间与回合页脚 | 方案 §4.1–4.2、§9 S1 | — | **已交付**（六栏见 HANDOFF；包级归 H-5） |
| 2 | H-2 | 右栏资源保留 | 方案 §5.3、§9 S2 | — | **已交付**（六栏见 HANDOFF；多标签持久化归 H-3） |
| 3 | C-1 | 大窗口模型级试行档 | 审阅 §5.1 | — | **已交付**（六栏见 HANDOFF；真实端点归 C-3） |
| 4 | H-6 | 回合计时契约与 usage 口径 | 方案 §4.2 | H-1 | **已部分交付**（落盘 / 读回 / 终止原因 / 未记录；稳定回合身份、等待分段、usage 聚合归 H-6b） |
| 4b | H-6b | 稳定逻辑回合、等待分段与 usage 聚合 | 方案 §4.2 出口 1/3/6 | H-6 | **部分交付**（崩溃→中断已交付：写侧 `final` + 读侧归一 + restart 端到端；稳定回合身份、waitSpans、usage 聚合未做） |
| 5 | H-7 | 时间呈现统一与可访问 | 方案 §13.1 | — | **已交付**（六栏见 HANDOFF；`submittedAt` 未实现） |
| 6 | C-4 | 统一策略来源与计量口径 | 审阅 §5.3、§3.1 | — | **已交付**（生效策略文件 + 两侧同规则；估算精度与行为口径的剩余归 C-4b / C-6） |
| 7 | C-2 | 压缩可观测性 | 审阅 §5.2(3)、§6 | C-4 | **部分交付**：回收比例 / 此后新增量 / 「待测」口径已闭环；三类动作分别统计归 C-2b |
| 8 | C-6 | 三类整理门槛与防抖标定 | 审阅 §5.2、§3.3、§5.1 | C-4、C-2 | 未开始 |
| 9 | C-5 | 上下文窗口 UI 分层 | 审阅 §6 | C-2 | **已交付**（分母口径：主值走物理尺度 + 工作集单独一行 + 刻度改窗口尺度；档位名与来源展示留作剩余） |
| 10 | C-3 | 大窗口策略验证矩阵 | 审阅 §7 | C-1、C-6 | 未开始 |
| 11 | H-3 | 工作窗口状态模型 | 方案 §5.3、§9 S2 | H-2 | 未开始 |
| 12 | H-4 | 文件与文档窗口 | 方案 §3、§8、§9 S3 | H-3 | **部分交付**：解析 / 呈现切片（`#L42` / 范围 / 点击预览）已闭环（见 HANDOFF「H-4a」）；文件标签、目录树联动、Markdown 源码切换、大文件与资源身份待 H-3 后做 |
| 13 | H-9 | 浏览器窗口融合 | 方案 §6、§9 S4 | H-3 | 未开始 |
| 14 | H-10 | 子代理展示与累计统计 | 方案 §7、§9 S5 | H-3 | 未开始 |
| 15 | H-8 | 图标接入统一 | 方案 §13.2 | H-3（形态确定后） | 未开始 |
| 16 | H-11 | 交互终端 | 方案 §8、§9 S6 | H-3 | 未开始 |
| 17 | H-5 | 六栏验收与交付 | 方案 §10、§9 S7 | 全部 | 贯穿 |

### 3.2 已开始的首批切片（证据）

| 切片 | 已落地内容 | 当前证据 | 状态 |
|---|---|---|---|
| H-1 整轮时间与回合页脚 | 计时口径抽成 `shared/turn-timing.ts`（`agent.ts` 的 `speedOf()` 委托）；`TurnView` 的用时条接上 `tok.elapsedTip`；起点为 `0` 的时间戳不再被当成「没有起点」 | `typecheck` / `build` 通过；`test:unit` 4227/4227（新增 `test-turn-timing.mjs`）；`turnfooter`（cost 0，28 断言）与 `turnfooterlive`（cost 1，本地模型 `local/qwen3-local`：整轮 4900ms vs 生成 1490ms）通过；深浅两张图已看图核对 | **已交付**（六栏见 HANDOFF；包级归 H-5） |
| H-2 右栏资源切换 | 切换工具 / 审查 / 浏览器 / 文件时不再自动关闭其他可返回资源；浏览器原生视图只随活动窗口显隐；显式关闭仍会关闭对应资源；文件区重挂载不再无条件清掉用户打开的预览 | `RightPanel.tsx`、`store.ts`、`FileTree.tsx` 已改；`test:live -- rightresources`（cost 0，21 条）全通过；`rightresources` 深浅两张图已看图核对（溢出 0px） | **已交付**（六栏见 HANDOFF；多标签持久化归 H-3） |
| C-1 大窗口模型级试行档 | 新增当前精确模型的 `balanced = 600K / 0.7` 与 `long = 700K / 0.7`；设置页只写入 `provider/model` 覆盖；运行时未登记至少 800K 窗口时按钮禁用 | `context-policy.ts`（6 条单测）、`ContextTab.tsx`、中英文文案、`test:live -- contextbudget`（cost 0，含写入 / 禁用 / 切模型不继承 / 清理）、`ctxmodelpresets` 深浅两张图 | **已交付**（六栏见 HANDOFF；真实 1M 端点归 C-3） |
| D-0 文档工作区分层 | 未完成实施计划集中在 `docs/plan/active/`；完成正文、逐片证据和外部参考分别进入 `docs/archive/plan/`、`docs/archive/evidence/`、`docs/archive/reference/`；活动设计输入集中在 `docs/design/active/` | 文档链接审计已达到 `brokenDocLinks = 0` | 已完成整理；历史提及缺失文件仍按追溯语义保留 |

### 3.3 逐项详述

#### A 组 · 对话与回合

**H-1 · 整轮时间与回合页脚（位次 1，已交付）**

- 内容：去掉助手正文顶部“砚 / N 步 / 标准”整行；底部只保留步数、用时、完成时刻；无点赞 / 点踩 / 评分入口。
- 出口：多次工具、重试、停止、重载后整轮时间仍正确；无工具无推理的普通回答直接从正文开始。
- 已交付证据：见 [HANDOFF](../../dev/HANDOFF.md) 的「实施-11 H-1」节（实现 / 单测 4227 / cost 0 与 cost 1 真实运行 / 深浅视觉图）。
- 剩余限制（登记在本条，不另开片）：
  1. `elapsedMs` 不落盘 —— 切会话 / 重载后整轮用时丢失，只余完成时刻 → 由 **H-6** 的宿主元数据日志解决；
  2. 方案 §4.1 草图里的“复制 / 更多”未实现（未擅自新增 UI）；
  3. 停止 / 失败路径的用时冻结只有纯逻辑口径覆盖，无真实窗口证据；
  4. 本机 27B 量化模型在仓库完整上下文下不调工具，cost 1 工具场景需 fixture 沙盒（见 HANDOFF §已知偶发）。
- 禁区：不把工具等待计入生成速度；本期不联动修改工作模式 / 回复详细度 / 工作区模式的实际值。

**H-6 · 回合计时契约与 usage 口径（位次 4，已部分交付）**

- 来源：方案 §4.2（含 `TurnTiming` 字段建议、settled 与 continuation 边界、崩溃恢复、旧历史无计时）。
- 已交付（六栏见 HANDOFF「H-6（部分）」）：
  1. 宿主侧版本化元数据日志 `YAN_DATA_DIR/turn-timing/<会话文件>.jsonl`（只追加、坏行跳过、同 `logicalTurnId` 后者胜）；
  2. 运行态用单调计时（`performance.now()`），落盘 `startedAt / endedAt / elapsedMs / terminalReason`；
  3. `peekSession` 与 `hydrate()` 两条读历史路径都挂回计时，锚点是用户消息 id；
  4. 停止 / 失败冻结用时并标注（`已停止 · 用时冻结` / `失败`）；
  5. 旧历史无记录时显示「用时未记录」，不用最后一条 `elapsedMs` 伪装。
- **已交付（H-6b，六栏见 HANDOFF）**：崩溃 / 退出→「中断」的**写侧、读侧与端到端**：
  1. 写入的记录带 `final` —— 回合中途（`message_end`）写 `false`，终止收尾写 `true`；
  2. 读回时 `final === false` 归一为 `interrupted`（旧记录无此字段按已收尾处理，不误报）；
  3. 界面显示「已中断」（`TurnView` 原有分支，本片之前没有任何产出路径）；
  4. 端到端：`turnrestore` 断言收尾记录 `final: true`；`turninterrupted` 走真实回合 → 重启前追加中途快照 → 重启后切会话，**页脚真的写「已中断」**。
  - 测试框架新增能力：`seedBeforeRestart`（仅第二次启动前跑，改的是上次运行写下的数据）。
- **未交付（H-6b）**：
  1. 稳定 `logicalTurnId` 覆盖自动继续与跨会话链交接（现在等于本轮第一条 assistant 消息 id）；
  2. `waitSpans`：工具 / 子代理等待按真实经过时间分段，并行分支不相加；父回答结束后台子代理继续时父用时冻结；
  3. usage 按请求 / 消息 ID 去重后聚合（**语义已核实**：pi 的 JSONL 里 usage 是单次请求的独立用量，不是流式累计）；
  4. 中途快照的**产生**是重启前追加（可复现），非真 SIGKILL —— 强杀时最后一条快照是否已落盘未实测。
- 禁区：不生成平行历史（消息仍读 pi 会话 JSONL，元数据只装饰已有消息）；不猜 provider usage。

**H-7 · 时间呈现统一与可访问（位次 5，已交付）**

- 来源：方案 §13.1。
- 已交付：`shared/duration.ts` 成为唯一时长写法（回合页脚 / 图片进度 / 子代理列表共用）；
  `TurnTime` 有 `aria-label` + `data-full` + `tabIndex`，聚焦浮层不依赖悬停；
  证据见 HANDOFF 的「H-7」节（13 条单测 + 6 条 live 断言 + `turntime` 深浅图）。
- 仍不做：`submittedAt`（点击发送时刻）—— 界面目前不需要展示它，
  也就不会用组件挂载时刻伪造（缺时间就不显示，见禁区）。
- 禁区不变：缺失时间不显示伪造值；复制 / 分叉 / 历史恢复保留原消息时间语义。

#### B 组 · 上下文与 1M（C 系列）

**C-1 · 大窗口模型级试行档（位次 3，已交付）**

见 §3.2。`balanced = 600K / 0.7`、`long = 700K / 0.7` 仍是可回退试行档，不是全局默认或性能承诺；
公式单测、设置页接线、禁用态与视觉证据已齐（HANDOFF「C-1」），
**真实 1M 端点验证**仍归 C-3，需要用户明确允许与可控额度。

**C-4 · 统一策略来源与计量口径（位次 6，已交付）**

- 已交付（六栏见 HANDOFF「C-4」）：
  1. 宿主把**分层覆盖**写进 `<YAN_DATA_DIR>/context-policy.effective.json`（`v` / `revision` / `default` / `byModel` / `foldEnabled`），内容不变不落盘；
  2. 扩展的 `requestBudgetFor()` 改为 **env > 宿主文件 > 默认**，逐字段合并；阈值仍由两侧同一套 `contextBudget()` 算（交叉校验在单测里）；
  3. “1M”仍按运行时实际 `contextWindow` 计算，不硬编码；
  4. 走独立文件而**不写 `YAN_CONTEXT_POLICY`** —— 那个 env 优先级高于设置面板。
- **未交付（C-4b）**：请求估算仍以字符为主（宽字符 ≈ 1 token、其余 /4），图片与 provider
  特殊结构覆盖不足；“未知成本不得当零”尚未逐 provider 验证。
- **未交付（归 C-6）**：“到线以前不会整理”这个措辞仍不准（`tool-sweep` 另有收益门槛与防抖）——
  数字对齐不等于行为对齐。
- 禁区不变：不改默认 240K；不绕过输出预留与物理闸门。

**C-2 · 压缩可观测性（位次 7，部分交付）**

- **已交付（C-2a，证据见 HANDOFF）**：
  1. **回收比例**（`compactionReclaimPercent` / `compactionReclaimText`）：`after > before` 夹到 0%，缺任一端返回 `null` → 界面写「回收待测」，不编百分比；
  2. **此后新增量**（`compactionGrowthText`）：当前用量 − 压缩后估算，当前用量未知（pi 刚压完故意报 null）时不显示，不写成 0；
  3. 失败 / 取消 / 跳过各有文案且不显示回收行（已有，本片保持）；
  4. 压缩前后用量、耗时、触发原因、发起方（砚 / 阈值 / 溢出）已有（N21-2）。
- **未交付（C-2b）**：三类动作分别统计 —— 轻量整理（tool-sweep）与状态刷新（episode-fold）
  不产生 pi 的 `compaction_*` 事件，需扩展侧留痕（写 `YAN_DATA_DIR` 下的操作日志），宿主读并在 UI 分开显示。
- **未交付（归 C-6）**：失败 / 取消之后的**重试窗口**（下次何时再试）；防抖参数标定。
- 口径不变：无压缩后 token 时显示「待测」，不补想象值或没有供应商证据的百分比。
- 落点：`src/main/agent.ts`（热点）、`src/main/context-watermark.ts`、`src/shared/context-state.ts`、
  `resources/pi-extensions/context*.js`（留痕，不改业务阈值）。

**C-6 · 三类整理门槛与防抖标定（位次 8）**

- 来源：审阅 §5.2、§3.3、§5.1。
- **前置核实（先做，否则参数无意义）**：
  1. 本次请求**实际**输出预留是多少 —— 本地模型登记 `maxTokens=393216` 是能力字段，
     不是实际请求参数；如果某次请求真的预留 393216，则 1M 减去它与安全余量后软线最多约 586784，
     连 600K 都要下调；
  2. pi 0.85.1 的原生 overflow / 恢复行为按当前 vendored 版本另行核实 ——
     **不得假设** pi 一定会在 `window − reserve` 处自动压缩（实施-06 已确认旧 `compactionstatus` 前提失效）。
- 内容（均为待标定候选，不是已验证最优参数）：
  1. **Tool Sweep**：普通内容清扫需达到统一压力门槛或更明确的回收收益条件；1M 档可先试
     64K–96K 近期原文尾部，与检索能力一起验证，不全量删除旧工具内容；
  2. **状态摘要**：1M 档不再单凭固定 48K 或“曾发生 sweep”启动语义摘要；候选准备线为整轮软线的 60%
     （600K 档约 360K），保留最低回合数与脏判定；
  3. **整轮 compaction**：压缩后重新估算实际占用；候选要求回落到软线 80% 以下，或此后新增达到
     `max(16K, 软线×5%)` 才重新触发；低回收 + 低新增时延后普通整理，并显示“主要为不可压缩基础开销”。
- 禁区：
  - 不把“冷却从 30 秒改成几分钟”当唯一修复（既不能解决首次压缩过早，也可能耽误真实容量不足的恢复）；
  - **不得删除** 实施-06-S3 那个“成功后重新上膛”的修复 —— 新增回收量 / 增长量条件是**额外**条件，
    并须保留低线压力反向测试（`contextpressurelow`）；
  - 硬压力不受普通整理冷却与防抖放行：不能安全请求时先恢复 / 阻断发送，不靠继续盲压解除限制；
  - 模型从 1M 切到 128K 时立即重算，不继承 600K；窗口未知或 provider 容量不可信时回落保守策略。
- 落点：`src/shared/context-policy.ts`、`src/main/context-policy.ts`、`context-budget.js`、
  `context.js`、`context-producer.js`、`context-stage-runtime.js`。

**C-5 · 上下文窗口 UI 分层（位次 9，已交付）**

- **已交付（六栏见 HANDOFF）**：
  1. **进度条分母 = 有效模型窗口**（策略窗口优先，否则物理窗口）：主值百分比、`ctx-tokens`、条本体填充全按它；
  2. 新增工作集单行（`ctx-working-set-line`）：`工作集 36k / 240k · 15%` —— 即审阅要求的「另画软压缩标记」的文字形式；
  3. 三档阶段刻度改画在窗口尺度上（`at / 窗口`），位置仍由工作集比例算出；
  4. 压力色（黄 / 红）只看工作集：物理窗口满之前早就过线了，拿它当压力会漏报；
  5. 无策略（自动压缩关）时退回物理窗口视角，工作集行消失。
- **未交付**：
  1. 默认行里的**档位名**（600K / 700K 试行档）未写出来 —— 设置页有，右栏只有「下一步：…」；
  2. 展开项里的**容量来源**（默认 / 用户 / 模型级 / env）仍只在设置面板的 `ctx-source`；
  3. 三类动作分别统计（sweep / fold / compaction）归 **C-2b**。
- 口径不变：示例数值不是运行状态；不显示没有来源的百分比。
- 落点：`src/renderer/src/components/toolbar/RightPanel.tsx`（真实水位落点）与设置页的 `ContextTab.tsx`。

**C-3 · 大窗口策略验证矩阵（位次 10）**

- 来源：审阅 §7。
- 出口（逐项取证，缺项不得宣称参数可用）：
  1. 128K / 256K / 512K / 1M / 1,048,576 × 多输出预算 × 未知窗口 × 切模型：宿主、扩展、UI 数值一致；
  2. 模拟“压缩后仍在软线上、回收很少、无新增消息”的反复事件不重复调用；新增达门槛可恢复；
     硬压力不被防抖放行；
  3. 多轮工具、大型工具结果、首次 sweep、状态摘要 sticky、分叉与会话切换：统计真实触发原因；
  4. 采集实际端点输入用量与估算偏差、压缩次数 / 每 100K 新增上下文、压缩间隔、回收率、
     关键约束保留、延迟与错误；600K/700K 长请求的 CPU / 字符串分配成本要单列
     （S4 已明确估算 O(体积)、没有增量缓存，不能只核对 token 装不装得下）；
  5. 用真实约 1M 模型做有明确预算的针对性验证后再推广 —— **需要用户明确允许且外部额度可控**。
- 禁区：旧 6K / 20K 压力测试只证明机制，不证明 600K 参数好；N21-9 已完成且不支持状态层优势，
  不重跑、也不当作放宽参数的效果证据；不把“1M”硬编码为具体容量。

#### C 组 · 工作窗口与资源

**H-2 · 右栏资源保留（位次 2，已交付）**

见 §3.2。切页只隐藏、不销毁；显式关标签才释放对应资源。
多标签 / 多文档的会话级持久化是下一片 H-3，不在本片声称完成。

**H-3 · 工作窗口状态模型（位次 11）**

- 来源：方案 §5.3、§9 S2；生命周期思想来自 DSH `tab-domain.ts`。
- 内容：按会话（稳定会话链身份）保存 `tabs / activeTabId / width / expanded / version`；
  首期只有一个活动内容区，但可保留多个已打开标签。
- 必须明确的语义：
  - 当前活动窗口与可恢复窗口；浏览器的存活、显隐、导航 revision；
    文件预览的路径 / 指纹 / 可用性；审查对象与关闭后的返回位置；
    多文档标签的稳定身份（不用标题或 DOM 猜测）；
  - 从网页切到工具 / 文件：隐藏原生视图但保留网页会话与标签；
  - 收起右栏：所有资源仍存在，仅取消可见原生区域，不改变任务状态；
  - 关闭一个文档 / 网页标签：只释放对应资源，Chrome 连接与用户浏览器生命周期分开处理；
  - 关闭子代理详情：只关查看窗口，任务继续（“停止”是独立操作）；
  - 关闭终端标签：有运行进程时必须明确“结束终端”或“保留后台”，不可因切页杀进程；
  - A/B 会话切换：还原各自活动页与滚动，旧请求不得写进新会话窗口。
- 原生视图显隐集中到一个协调器：只有“当前会话 + 当前活动网页 + 右栏可见 + 无覆盖弹窗”才显示；
  bounds 同步继续乘 `win.webContents.getZoomFactor()`。
- 迁移与存储：保留 `rightPanelOpen`、宽度、`toolOrder` / `toolHidden`；存储带版本号与未知标签回退；
  浏览器恢复只保存必要 URL / 标题等布局信息，**不把 Cookie / 凭证放进布局 JSON**。
  落盘前先定会话边界与旧数据兼容策略，不能因新增字段破坏现有会话 JSONL。
- 禁区：不同时引入多列 docking、拖出独立 OS 窗口或复杂分屏树；不新增第二份“布局真源”。

**H-4 · 文件与文档窗口（位次 12，部分交付）**

- **已交付（H-4a，证据见 HANDOFF）**：`shared/links.ts` 的 `parseFileLink`（DSH 搬运）
  与 `classifyLink` 接入；支持 `path#L42` / `path#L42-L60` / `file://…#L7`；
  `LinkAnchor` 的 `data-line` 与带行号的 title；点击仍走 `previewFile(path, line)`。
- **未交付（依赖 H-3）**：单击文件 / 目录打开标签并联动文件树、Markdown 阅读 / 源码切换、
  >2000 行定位的窗口化、文件变化提示、文件缺失保留标签、
  `projectId + workspaceRoot + canonicalPath` 资源身份、范围高亮、
  相对路径按所属消息 / 文档上下文解析。
- 下面的出口清单保留原样；其中未在上一条列到的，就是本片的剩余项。

- 来源：方案 §3（含 §3.1 点击行为、§3.2 路径与渲染边界）、§8、§9 S3。
- 出口：
  1. 正文文件引用显示为“小文件图标 + 蓝色短路径”；普通行内代码不自动染蓝；悬停 / 键盘聚焦显示完整路径与行号；
  2. 兼容现有 `path:42`，新增 `path#L42`、`path#L42-L60`，正确处理 Windows 盘符、中文、空格与百分号编码；
     范围链接可标高亮范围，但不把范围当文件名；
  3. 相对路径按所属消息 / 文档上下文解析（文档内 `../` 相对当前文档目录，聊天引用相对所属会话工作目录）；
     历史来自工作树或会话链时保留来源根目录，不一律套当前 cwd；
  4. 单击文件：打开或激活文档标签，目录树选中该文件并展开父目录；单击目录：打开文件窗口并展开该目录；
  5. Markdown 支持阅读 / 源码切换；带行号时优先源码视图并定位高亮；超过 2000 行的定位需窗口化加载
     或围绕目标行读取，不能只估算滚动；大文件仍显示截断 / 分页状态；
  6. 文件变化提示“内容已更新 · 重新加载”，不自动打断阅读位置；
  7. 文件缺失保留标签并显示原路径与“重试 / 定位父目录”，不伪造内容；
  8. 资源身份取 `projectId + workspaceRoot + canonicalPath`，不同工作树的同名文件不混为一个标签。
- 禁区：不对原始流式字符串做全局正则替换（用 Markdown AST 与导航委托）；`classifyLink` 只分类，
  实际文件 / 目录 / 项目边界与读取权限仍由主进程判断，不把“蓝色可点”当跨目录授权；
  Markdown 阅读模式禁用原始 HTML 执行，HTML 运行预览不随此项开启；裸路径识别另列开关与误判测试。
- 落点：`src/shared/links.ts`、`src/renderer/src/components/chat/MessageParts.tsx`、
  `FileTree.tsx`、`FilePreview.tsx`、文件宿主 IPC（`window.yan.readPreview / revealPath / openPath` 边界不换）。

**H-9 · 浏览器窗口融合（位次 13）**

- 来源：方案 §6、§9 S4。
- 第一阶段范围（优先做）：切窗口保留页面、活动标签归属、原生视图不覆盖设置 / 菜单 / 子代理弹层。
- 第二阶段：导航状态与错误体验 —— 以真实事件（`did-navigate` / `did-navigate-in-page`）为已提交 URL 真源，
  旧导航结果不得覆盖新地址；编辑草稿与已提交地址分离，后台导航不清掉正在输入的内容；
  错误时在导航栏下显示“打不开该页面 / 重试 / 在外部浏览器打开”，并保留原 URL。
- 保留：Chrome 来源标识与显式接入 / 断开；用户接管与恢复 Agent，显式展示正在操作的页面，
  后台标签不夺取用户当前阅读页；下载与按 origin 权限管理收进更多菜单 / 状态区域；
  `yan browser …` → 宿主能力服务 → `BrowserManager` / CDP 这条链路不变，UI 与 CLI 命中同一页面。
- 禁区：不把原生 `WebContentsView` 换成 iframe；不因参考方存在多个 `browser-use` provider 就批量引入
  （文件存在不证明本机可用）；不恢复 `browser_*` 模型工具；不改 `src/main/browser.ts` 的权限 / 网络边界
  （L04 已取证）；不复制 iframe 的“关闭 sandbox”按钮。
- 落点：`BrowserSurface.tsx`、`src/main/browser.ts`、`src/main/browser/*`、浏览器 IPC。

**H-10 · 子代理展示与累计统计（位次 14）**

- 来源：方案 §7、§9 S5。
- 出口：
  1. 会话标题旁仅在存在子代理时显示入口（`2 个子代理 ▾` / 运行中可显示 `1 个运行中`）；
     点击展开约 340–420px 的紧凑列表，不永久占用主对话高度；
  2. 每行：状态点、任务短标题、第二行摘要或最新动作、右侧用时与可选 tok、末端箭头；
     完成 / 错误同时用文字或图形，不只靠颜色；
  3. 详情展示任务、模型、工作目录、只读 / 工作树模式、最新活动、转录、最终结果、变更摘要，
     保留停止与现有审阅 / 合并路径；没有写入变更的只读任务不显示合并动作；
  4. 回合内保留短归属入口（如“子任务：目录审查 · 已完成”），点击打开同一 `runId`；
     不在正文和输入区同时展开两份完整转录；`parentMessageId` 归属必须保留；
  5. token 统计在事件接入时按消息 ID 累计并持久化，**不从最多 200 条的转录截尾反推**；
     旧记录无法还原精确用量时显示 `—`；时间和 token 缺失不阻止打开结果；
  6. 弹层按当前父会话 / 会话链过滤，跨会话结果不串线。
- 禁区：首期不改并发上限、不引入嵌套代理、不复制参考方的持续对话调度 ——
  对子代理继续提问需要独立设计取消、上下文、权限与归属生命周期（现有 bridge 没有 follow-up 接口）；
  UI 上的“只读”是工具白名单约束，不得说成 OS 沙箱。
- 落点：`SessionHeader.tsx`、`SubagentList.tsx`、`SubagentDetails.tsx`、`TurnView.tsx`、`src/main/subagents.ts`。

**H-8 · 图标接入统一（位次 15）**

- 来源：方案 §13.2（“采用统一单色线性图标、复用现有 Icon / sprite 接口”）。
- 现状：砚已有 `reicon`（MIT）sprite + `<Icon>`，25 个 symbol 由 `npm run icons` 从设计稿抽出，
  尺寸档为 12 / 14 / 16。
- 出口：同一语义全应用同一图形；主操作 16 / 次级 14 / 小标签 12；描边视觉重量统一；
  100% / 125% / 150% 下检查清晰度；点击命中区独立于图形尺寸；提供中文 `aria-label`；
  成功 / 错误不只靠颜色；品牌图形（应用身份）不被通用图标替换。
- 边界：**具体图形准则以 [图标设计与应用准则](../../design/active/图标设计与应用准则-2026-09-21.md) 为准**；
  本项只做接入、语义映射与统一渲染，不新增第二套图标运行库，也不用彩色 emoji 或混用实心 / 线性风格。
- 落点：`src/renderer/src/icons/sprite.ts`、`src/renderer/src/icons/Icon.tsx` 与各组件用法。

**H-11 · 交互终端（位次 16，不阻塞首批）**

- 来源：方案 §8、§9 S6。
- 出口：真正的输入 / 输出 / resize / 退出 / 断线重连；会话工作目录与环境正确；
  新增原生依赖必须包内真跑（`dist:dir` / `test:packaged`），不能只在开发态可用。
- 禁区：不用一次性 Shell 工具输出冒充交互终端；不做成灰色永久占位按钮；
  若将来需要 Agent 控制终端，走宿主服务 + `yan` 子命令，不注册模型工具。
- 依赖：H-3 的工作窗口 registry；`package.json` 新增依赖前先与其它在改该文件的片打招呼。
- 落点：新增宿主 PTY 服务 / IPC / xterm 视图，接入工作窗口。

#### D 组 · 交付

**H-5 · 六栏验收与交付（位次 17，贯穿）**

每个切片必须单独补齐：实现、自动检查、真实运行、视觉验收、应用与包、剩余限制。
没有真实窗口或视觉证据时，不能因为代码和 mock 通过就把切片改成完成。

- 自动检查：类型 / CSS、构建、相应单测；重点覆盖 turn 归属与去重、路径编码与行号、tab reducer、
  异步结果过期、资源显隐；**先 build 再跑依赖 `out/` 的测试**。
- 真实运行：文件点击、Markdown 切源码、浏览器 → 文件 → 工具 → 浏览器保留原页、A/B 会话切换、
  子代理开始 / 完成 / 失败 / 停止与回合归属；使用隔离 `YAN_*` 目录，需实际模型的行为单列。
- 视觉验收：深 / 浅主题、1440×900、窄窗 / 矮窗、100% / 125% / 150% 缩放；检查蓝色链接、底部统计、
  开始页、长标签、多文件、子代理弹层、原生浏览器视图与弹窗叠层。**示意图 / 交互示意不算真实窗口证据。**
- 应用与包：走 `启动-砚.cmd`，确认本次 `out/` 时间戳；需要时更新目录包与安装 / 便携验证。
- 剩余限制：明确旧历史无计时、部分 provider 无 usage、网站登录限制、Windows 终端兼容、
  未执行测试与未取证的档位；不用文件存在或静态检查宣称完成。

### 3.4 与设计输入切片的映射

| 设计输入切片 / 建议 | 落到队列 |
|---|---|
| 方案 §9 S1 阅读减负与计时 | H-1（已实现）+ H-6 + H-7 |
| 方案 §9 S2 工作窗口内核 | H-2（已实现）+ H-3 + H-8 |
| 方案 §9 S3 文件体验 | H-4 |
| 方案 §9 S4 浏览器融合 | H-9 |
| 方案 §9 S5 子代理展示 | H-10 |
| 方案 §9 S6 交互终端 | H-11 |
| 方案 §9 S7 联调交付 | H-5 |
| 方案 §13.1 用户消息时间 | H-7 |
| 方案 §13.2 图标风格 | H-8（图形准则另由图标设计输入接管） |
| 审阅 §5.1 按模型选大窗口档 | C-1（已实现）+ C-6 前置核实 |
| 审阅 §5.2 三类动作分别放宽 | C-6 |
| 审阅 §5.3 统一计量与策略来源 | C-4 |
| 审阅 §3.1 阶段线口径不一致 | C-4 |
| 审阅 §6 上下文窗口 UI | C-5 |
| 审阅 §7 验证计划 | C-3 |
| 审阅 §9.3 文档口径修订 | 已完成（本轮整理），不另立切片 |

### 3.5 明确不进本队列

这些在方案里已被排除或需要单独立项，**不要**因为有文档提及就顺手排进来：

| 项 | 处置 |
|---|---|
| 多窗格 docking / 拖出独立 OS 窗口 / 分屏树 | 暂缓；原生网页视图使多窗格成本明显增加 |
| PDF 内嵌预览 | 单列可选立项，需用户确认；现状保持下载 / 外部打开边界 |
| 独立“对话 / 轨迹”阅读分层 | 后续可选，等窗口架构稳定后再考虑，避免同时改两套阅读习惯 |
| 外部能力发现 / 安装框架迁移 | 归 [实施-04](./实施-04-能力自主选择-MCP与Skill.md)；参考方插件系统不能解除砚的默认 pi 边界 |
| 对子代理持续对话（follow-up） | 需独立设计取消 / 上下文 / 权限 / 归属，不在 H-10 首期 |
| Android UI / 账户同步 / 证书 | 归 [实施-08](./实施-08-安卓远程管理.md) 与独立后端条件 |
| 任务面板布局与任务来源改造 | AGENTS.md 已拍板保持现状 |
| 图标视觉风格定稿 | 由 [图标设计与应用准则](../../design/active/图标设计与应用准则-2026-09-21.md) 接管 |
| 旧记忆 / `get_tree` / 扩展插件生态 | 已确认的产品边界，不恢复 |

### 3.6 与其它主题的边界

- **实施-06（上下文管理收尾）**：06-S1–S5 已完成，C 系列是它的后续改良，不是重做。
  - 不撤销 06-S3 的“成功后重新上膛”修复（C-6 只加额外条件）；
  - 不重跑 N21-9，也不把它的结论当放宽参数的证据；
  - 06 登记的“真实长会话证据”限制仍然有效，只有 C-3 取到真实 1M 证据时才更新那里。
- **实施-01（默认 pi 架构迁移）**：C-4 改的 `resources/pi-extensions/context*.js` 属**薄层**，
  只能承载宿主表达不了的生命周期桥接与策略执行；不得借此注册模型工具或 pi 命令。
- **实施-09（交付与验收收尾）**：H-11 新增原生依赖的包验收、以及 H-5 的发布门槛，
  最终按 09 的口径重跑，不复用旧 `out/` / `release/` 产物。
- **实施-03 / 05 / 08**：本队列不碰项目知识、会话级工作模式与远程链路；
  若某片需要动它们的状态文件，先停下来登记，不要顺手改。

### 3.7 并行与共享热点

规则本身只在[编排](./编排-并行代理分工-2026-09-19.md)里，这里只列**本队列会撞到的地方**：

| 文件域 | 涉及队列项 | 规则 |
|---|---|---|
| `src/main/agent.ts`、`capability-server.ts`、`resources/yan-cli/yan.mjs` | H-6、C-2（还会与 01 / 03 / 04 / 05 的片撞） | 走**能力面串行队列**，进队列前先 `grep` 确认没人在改这一段 |
| `src/renderer/src/state/store.ts`、`components/toolbar/RightPanel.tsx` | H-3、H-4、H-9、H-8（H-2 已改过） | 渲染端右栏**同波次只开一项** |
| `resources/pi-extensions/context*.js` | C-4、C-2、C-6 | 与任何 06 残留互斥；动手前 `git diff` |
| `src/shared/context-policy.ts`、`src/main/context-policy.ts` | C-1（已改）、C-4、C-6、C-3 | 与 06 的模型级覆盖链共用，改前先在单测里固定现状 |
| `src/main/browser.ts`、`src/main/browser/*` | H-9 | 独占 |
| `src/main/subagents.ts` | H-10 | 独占 |
| `scripts/test-live.mjs` | 所有新增场景 | 只在 `CASES` 表尾**追加自己一行**；同波次多个片由编排者统一登记 |
| `scripts/visual-matrix.mjs` + `docs/design/preview/` | H-1、H-2、H-3、H-4、H-8、H-9、H-10、C-5 | 截图**另存新名**，不覆盖用户视觉证据 |
| `docs/dev/HANDOFF.md` | 每片收尾 | 只追加自己的节，片末一次写完 |
| `package.json` | H-11 | 新增依赖 / 脚本前先打招呼 |

**可并行簇**（文件域不重叠时）：`{H-6} ∥ {H-7} ∥ {C-4/C-2/C-6 组}`；渲染端 `{H-3 → H-4 / H-9 / H-10 / H-8}` 内部串行、
彼此可错开；H-11 单独一簇。`C-3` 依赖 C-6 出数，不和 C-6 同波次。

## 4. 当前六栏状态

| 六栏 | 当前结论 |
|---|---|
| 实现 | H-1、H-2、C-1、H-7、C-4、C-5 已交付，C-2 部分交付（回收比例 / 新增量 / 待测口径），H-6 部分交付（计时落盘 / 读回 / 终止原因），H-6b 部分交付（崩溃→中断：写侧 + 读侧 + restart 端到端），H-4a 部分交付（文件链接解析与呈现）；H-3、H-4 其余出口、H-8、H-9、H-10、H-11、C-2b、C-3、C-4b、C-6 尚未闭环。 |
| 自动检查 | 本片 `npm run typecheck` / `build` 通过，`test:unit` **4304/4304**（含 turn-timing 两份、`test-duration.mjs`、C-1 的 6 条、C-4 两侧的 17 条、C-2 的 10 条、H-6b 的 6 条）。 |
| 真实运行 | H-1 `turnfooter` / `turnfooterlive`；H-2 `rightresources`（21 条）；C-1 `contextbudget`；C-5 `contextbudget`（分母 / 工作集行 / 填充比例 / 刻度位置）；H-7 `turnfooter`；H-6 `turnrestore`（cost 1）；H-6b `turnrestore` + `turninterrupted`（cost 1，restart 双探针）；H-4a `filelink`（11 条）；C-4 `policyfile`；C-2 `compactionview`（11 条）。 |
| 视觉验收 | H-1 / H-2 / C-1 / H-7 / H-6 / H-4a / C-2 / C-5 各有深浅两张（stamp 见 HANDOFF；C-5 为 `2026-09-22-c5`）。 |
| 视觉验收 | H-1 `matrix-turnfooter-*`、H-2 `matrix-rightresources-*`（dark 引 h2b）、C-1 `matrix-ctxmodelpresets-*`、H-7 `matrix-turntime-*`、H-6 `matrix-turnstatus-*` 深浅各一张并看图核对；C-2 / C-5 的上下文窗口证据仍未取。 |
| 应用与包 | 尚未按本片重新运行 `启动-砚.cmd`、`dist:dir` 或打包探针；不把旧 `out/` / `release/` 文件当成本片证据。 |
| 剩余限制 | 未完成真正的 `WorkbenchState`、多标签 / 多文档、终端入口和真实 1M 端点验证；600K / 700K 仍是模型级试行参数，不是性能承诺；**整轮计时已能落盘与读回（H-6），但自动继续 / 跨会话链的稳定回合身份、等待分段与 usage 聚合仍未做（H-6b）**；sweep 阶段线口径尚未核实（C-4）。 |

## 5. 参考实现位置

回合与时间：

- 回合聚合与时间戳：[src/shared/turns.ts](../../../src/shared/turns.ts)
- agent 生命周期与整轮计时：[src/main/agent.ts](../../../src/main/agent.ts)
- 回合页脚与消息时间：[TurnView.tsx](../../../src/renderer/src/components/chat/TurnView.tsx)

工作窗口与资源：

- 右栏协调：[RightPanel.tsx](../../../src/renderer/src/components/toolbar/RightPanel.tsx)
- 资源状态：[store.ts](../../../src/renderer/src/state/store.ts)
- 文件链接分类：[src/shared/links.ts](../../../src/shared/links.ts)
- Markdown 渲染与点击：[MessageParts.tsx](../../../src/renderer/src/components/chat/MessageParts.tsx)
- 文件预览 / 目录树：[FilePreview.tsx](../../../src/renderer/src/components/toolbar/FilePreview.tsx) / [FileTree.tsx](../../../src/renderer/src/components/toolbar/FileTree.tsx)
- 浏览器视图壳 / 宿主：[BrowserSurface.tsx](../../../src/renderer/src/components/browser/BrowserSurface.tsx) / [src/main/browser.ts](../../../src/main/browser.ts)
- 子代理界面与控制器：[SessionHeader.tsx](../../../src/renderer/src/components/chat/SessionHeader.tsx) / [SubagentList.tsx](../../../src/renderer/src/components/chat/SubagentList.tsx) / [SubagentDetails.tsx](../../../src/renderer/src/components/chat/SubagentDetails.tsx) / [src/main/subagents.ts](../../../src/main/subagents.ts)
- 图标 sprite 与组件：[sprite.ts](../../../src/renderer/src/icons/sprite.ts) / [Icon.tsx](../../../src/renderer/src/icons/Icon.tsx)

上下文与 1M：

- 上下文预算与试行档：[src/shared/context-policy.ts](../../../src/shared/context-policy.ts)
- 有效策略与覆盖层：[src/main/context-policy.ts](../../../src/main/context-policy.ts)
- 水位与状态：[src/main/context-watermark.ts](../../../src/main/context-watermark.ts) / [src/shared/context-state.ts](../../../src/shared/context-state.ts)
- 模型级设置入口：[ContextTab.tsx](../../../src/renderer/src/components/settings/ContextTab.tsx)
- 请求预算与物理闸门：[context-budget.js](../../../resources/pi-extensions/context-budget.js)
- 清扫、摘要调度与请求钩子：[context.js](../../../resources/pi-extensions/context.js)
- 摘要资格与脏判定：[context-producer.js](../../../resources/pi-extensions/context-producer.js)
- 独立阶段冷却：[context-stage-runtime.js](../../../resources/pi-extensions/context-stage-runtime.js)
- 既有测试与剩余限制：[实施-06](./实施-06-上下文管理收尾.md)
