# 开发交接 · 砚

整理日期：**2026-09-17**（最后一轮更新：**2026-09-18**，含 P2-7 与 N21-4 剩余项）。本文是**当前状态与剩余任务的唯一入口**。
已完成的任务、缺陷明细（D1–D41）与逐轮记录见 [2026-09-17 已完成归档](../archive/2026-09-17-已完成归档.md)；
按优先级接手看 [未完成工程排期](PRIORITY-2026-09-15-未完成排期.md)（那份**只列未完成项**）；
工程标准看[工程清单](ENGINEERING-CHECKLIST-2026-09-15.md)，架构与依赖看[实施方案](实施方案-2026-09-15.md)。

## 接手顺序

1. 阅读根目录 [AGENTS.md](../../AGENTS.md)，检查 `git status --short`，保留已有改动。
2. 从下面的「当前未完成」选一组任务；用 [PROJECT](../PROJECT.md) 和 [CODE-MAP](CODE-MAP.md) 定位实现。
3. 按 [TESTING](TESTING.md) 做相应检查，把证据登记回本表（六栏口径见文末）；打包按 [RELEASING](RELEASING.md)。

## 当前基线（最近一次真实执行：2026-09-17 晚）

| 面 | 数字 / 结论 | 说明 |
|---|---|---|
| 自动检查 | **2026-09-18（方案 S1）**：单测 **2237/2237**（新增 38 条真实文件读写：图片落盘 + 逐字节读回、同内容幂等、会话隔离、路径穿越进不来、文件引用「还在不在」的复核、**「登记着但磁盘上没有」如实报**、移除只删副本不碰原文件、会话清理带走副本）。**2026-09-18（方案 P2 界面 + 端到端）**：单测 **2199/2199**；新增 live 场景 **`pkgs`**（cost 0，专属 fixture）—— 真实调用 pi 的 CLI 装一个本地包再卸掉，6 条详情断言（描述 / 来源 / 许可 / **「会执行代码、不做沙箱隔离」的边界声明**）。**隔离**：`YAN_PI_DIR` + 本地路径源，不联网、不碰用户真实装的包。**2026-09-18（方案 H1 / G3）**：单测 **2145/2145**（新增 15 条纯解析：remote 的三类写法、Windows 盘符不当成 scp、自建服务不猜、三家托管站各自的 compare 路径 —— Bitbucket 的顺序与我们相反）。**2026-09-18（方案 W2a）**：单测 **2130/2130**（G11 新增 24 条真实仓库：已暂存/未暂存/未跟踪三份分开迁移、二进制逐字节、未跟踪文件内容、目标侧 diff 摘要比对、源 status 与 index **逐字节不变**、起点非 HEAD 时拒绝、冲突时拒绝且不留半个工作树、勾选项过期时拒绝）。**2026-09-18（方案 W1）**：单测 **2106/2106**（G10 新增 52 条真实 `git worktree`：slug 规则、`worktree list` 解析、真实创建、主工作树不受影响、未提交改动不跟着过去、五条拒绝路径、删除的三类拦截、干净且已推送后真的删掉）。**2026-09-18（方案 G2）**：单测 **2055/2055**（G2 新增 **+79 条真实仓库写操作**：暂存只动选中文件、取消暂存**不碰工作区内容**、无首提交走 `rm --cached`、hook 拒绝、身份未配置、脏工作区切分支由 git 裁决、并发写按仓库串行、被拒时 HEAD 与提交数不变；以及 **+42 条纯逻辑**：失败分类 / 提交说明与分支名校验 / 长度前缀的版本摘要 / 命令参数构造）。`typecheck` / `build` / `audit:refs` 干净；**单测 1853/1853**（2026-09-18 从 1509 增至 **1620** —— 其中 +7 是 N18 尾巴的 IPC 错误剥壳 `stripIpcErrorPrefix`；新增 P2-7 `episode-fold` 界面开关 22 条、「三阶段独立 Rearm/Cooldown」30 条、**EpisodeState 切片 36 条**（确定性边界 / 收束判据 / 幂等与上限 / 消费门与生成门 / 真落盘三连 + schema 交叉校验），1509 那批是 N21-8 Deep Context 的闸门 / 输入有界 / 解析容错 / 注入幂等，以及用户开关的三个来源与优先关系；1450 那批的构成是 **N21-5 前置硬化 +50、N21-11 CJK 估算 +7、N21-6 State Refresh +5、provenance +35**：`turnsSince` 回合口径 / 输入自净 / `foldEligible`（含「清扫不得绕过地板」）/ 注入契约头与 `freshness`+`sourceHead` 透传 / `episodesDropped` / `pendingUserOnly` 与 `freshView` / `tailRolesOf`；此前 1353 里含 N01 的 25 条拖拽顺序与 R01–R04 的 **42 条失败路径断言**）。**2026-09-18 用 `YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash` 分批跑完了 check 的全部 live 场景**（33 + 23 + 18 次执行，含重复回归）：**唯一的红是 `todos`**；另有三处红是**真 bug、已修**（`features` 的档位断言拿了 detached 节点；`contextproduce` / `contextgate` 的退出后检查没按会话隔离），两处是**批量负载下的偶发**（`sessions` / `virtual`，单跑即绿）。上一次全量实跑（早于本轮改动）是 71 个场景 69 通过 | `todos` 是**陈旧失败**（任务面板按产品边界保持现状，AGENTS.md 第五节）；`subagent` 在换用 deepseek 后已转绿（此前是免费模型返回**空文本**）。另有手动场景 `compactionstatus` **前提过期**：pi 0.85.1 不再按 `reserveTokens` 在回合结束自动压；用改动前的实现重跑同样失败，app 侧压缩链路由 `contexttakeover` 覆盖并通过 |
| 真实运行 | **2026-09-18（方案 S1）**：`gitwrite` 扩到 **96 条断言**全绿 —— 第 13 节走完整路径：加网页来源 → 列表出现（标题取自输入、"已关联"态、打开按钮带原始地址）→ 四个筛选出现 → 移除后消失；并断言两句**边界文案**（「移除不会删你的原文件、不改写已发送的历史」「只是关联，不上传代码」）。**2026-09-18（方案 H1 / G3）**：`gitwrite` 扩到 **81 条断言**全绿 —— 第 13 节走界面加/删外部链接（`javascript:` 地址被拒、标题与原始地址都对、**边界文案里「不会上传代码」被读出来断言**），并验证本地 bare remote **不显示**「在网上比较」（给一个打不开的链接比不给更糟）。**2026-09-18（方案 W2）**：`gitwrite` 扩到 **72 条断言**全绿 —— 第 11 节走界面勾选携带（未暂存 + 未跟踪）→ 回读**目标工作树**里真有那些改动、源仓库里那份改动**还在**；第 12 节点「开新会话」→ 回读会话 cwd 真的换了、菜单自动收起。**这一轮又抓出三个真问题**：① 已暂存的 patch 必须应用**两次**（`--cached` 进 index + 再进工作区），只做 `--cached` 会在目标里凭空造出一个「未暂存改动」，源仓库里那个文件本来是 index 与工作区一致的；② `notes.unshift(...字符串)` 把**每个字符**塞成一条 note；③ 探针里 `data-testid` 在 input 自身上却按「内部 input」查 → 数到 0 个（诊断输出显示文案里明明有文件名）。**2026-09-18（方案 W1）**：`gitwrite` 场景扩到 **57 条断言**全绿 —— 新增工作树一节：菜单里创建 → **主进程回读**多出一条、路径落在 `<仓库名>-worktrees` 下（不是临时目录）、没有上游时「移除」被拒并列出原因、被拒后工作树还在。**这一轮也抓出两个真问题**：① `git worktree list --porcelain -z` 的 `-z` 是把**每一行**都以 NUL 结尾（不是记录之间分隔）—— 我按后者解析，导致 `branch` 永远是 null、「分支被其它工作树占用」不会亮、删除检查里的未推送判断被整段跳过（合成输入不会暴露它，真实仓库测试一跑就中）；② 探针第 9 节点了 `env-create-branch` 却没先等它可用，**disabled 的按钮不派发 click**，事件被浏览器吞掉（同一个坑第三次复发，已写进注释）。**2026-09-18（方案 G2）**：新场景 `gitwrite`（cost 0，**已进 check**）—— 44 条断言全绿，每条关键步骤都**回读主进程的真实 git 状态**（不是界面自证）；退出后 `afterExit: gitWriteApplied` 用真 git 核对：HEAD 的提交说明就是界面上输入的那条、分支停在 main、`live-made` 分支存在、**bare remote 里的 main 与本地 HEAD 同一个 sha**（推送真的出去了）。同批回归 `gitreview`（只读保证）全绿。**真实运行抓出两个设计问题**：① 初版让每个动作都比三件套预期版本 → 连点两个文件的暂存第二个必被拒、提交后立刻推送必被拒（全是假冲突）→ 改成按动作分级；② 写操作成功后界面手里的 expected 还是旧的 → 切回 main 后马上建分支被拒 → 用响应里带回的状态就地更新（摘要字段置空，任何「全比」的动作照常被拒）。**2026-09-18 深夜（方案 G1）**：新场景 `gitreview`（cost 0，**已进 check**）全绿 —— 环境菜单/范围切换/行号与增删/「N 行未修改」真的展开（8→83 条上下文行）/已查看持久化/图片前后对照（两张图字节不同）/二进制不伪造行数/筛选与折叠；**退出后逐字节比对** `status`、`ls-files -s`、`diff --cached --numstat`、`HEAD` 证明只读，并做了三条反向验证（注回 `git add -A` → 场景 6 条红；只污染 index → 退出后 3 条只读断言红）。此前：cost 0 场景 + 手动 cost 1 场景 | **2026-09-17 R01–R04 轮**：`title`（cost 1，真实通过；新增「手动名真的落盘」与「返回明确成功」两条断言）、`browserboundary`（cost 0，R01 回归）、`sessionrunners`（cost 0，R02 回归）全绿。上一次全量轮次实跑：`sessions` `historyswitch` `contextbudget` `toolgroup` `fs` `e2e` `tokens` `language` `contexttakeover` `live` `reasoning` `virtual` `logs`。**2026-09-17 S1 轮次**：`contextstate`（真实窗口删会话 → 退出后查派生状态清理）、回归 `trash`（真删 + 撤销）与 `sessions`。**2026-09-17 S2–S6 轮次**：`contextsweep`（cost 1，三个回合：真实 pi 里第二个回合后 sweep 生效 + 模型真的 `context_recall` 取回原文 + 第三个回合确认召回正文被清成存根，见方案 §15.4），同批回归 `contextstate` 与 `trash`；随后用用户指定的 `YAN_TEST_MODEL=commandcode/longcat-2.0:free` 独立重跑并通过（bash 8893、recall `turn=2`、`expiredRecalls≥1`、0 error）。**2026-09-17「清理默认开」轮次**：同一场景改为**不设 `kinds`** 重跑通过 —— 验的就是默认接管集本身（bash 8893、归档 1 条、`ctx://` 指得回原始条目、`swept≥1`、模型真的 recall 取回原文 `tokens=2224`、`expiredRecalls≥1`、0 error），见方案 §15.5。不可用或触顶时备用 `commandcode/laguna-s-2.1-free`。**同日 N21-7 轮次**：`contextbudget`（cost 0）重跑通过 —— 第 7 节真实改设置 → 来源 `user`、界面工作集 = 主进程算的、设置面板回填与恢复默认；同场修正 2 条陈旧断言（`下一步` 应为清理、图例两格已接管）。**同日 S7（状态生成器）轮次**：`contextproduce`（cost 1，**已进 check**）真实通过 —— 真实回合调 bash → 诊断 `stage=producer, hook=committed` 1 次且 0 错误、状态文件 `revision=1` / `objective` 非空 / `commands=1`、下一回合 `injectedTaskState=true`、状态文件过主进程 `loadContextState` 校验；同批回归 `contextsweep`（cost 1，**默认 kinds 下没有 producer 行** —— 验证“默认不花钱”）与 `contextstate` / `contextswitchguard` / `contextbudget`（cost 0）全通过。**同日（N01 拖拽排序）轮次**：`test:live -- railreorder`（cost 0，**已进 check**）37 条断言全绿 —— 合成 PointerEvent 走真实拖拽路径、回读 `yan.getSettings()` 验落盘、跨组拒绝、折叠态自动展开、搜索态禁用、click 被吞、无残留类名；同批回归 `live` / `grouprename` / `railsearch` / `projectlimit` / `railmini` / `railtitle` 六个侧栏场景全通过；另做了**两次反向验证**（去掉同组限制 → 跨组两条变红；不消费 click → click 那条变红，均已还原）。**2026-09-17 晚（N21-5 前置硬化）轮次**：`contextgate`（cost 1，新场景，**已进 check**）全绿 —— gate 被评估 1 次 / judged `too-early` / `committed` 0 次 / 状态文件 0 份，即「短会话不花钱」在真实链路成立；`contextproduce`（cost 1）适配 gate 后全绿，含 `task-state-injected{freshness:partial, sourceHead:6, tokens:119}`、`episodes 为空`、`gate 当场激活`；同批回归 `contextsweep`（cost 1，默认 kinds）/ `contextstate` / `contextswitchguard` / `contextbudget` / `context`（最后一条顺带修了一处陈旧 fixture，见 [归档 §1.11](../archive/2026-09-17-已完成归档.md)）。**同日第四轮复核轮次**：按外部意见改掉两处（Sweep 不得绕过最低回合数；`inject` 的语义写死为「允许 TaskState 参与任何模型可见上下文」），并落地「落后 1 条未 settled 的 user 视为 fresh」（`pendingUserOnly` + `freshView`），单测到 1394；`contextproduce` 重跑 7 次：**前 6 次里 5 次是免费模型侧失败**（`aborted` ×3 / `not-json` ×1 / `error` ×1，均已核实不是代码问题），**第 7 次成功且全绿** —— 拿到的关键证据是 `{"freshness":"fresh","sourceHead":6,"tokens":141,"gap":0,"turnsGap":1,"pendingOnly":true,"tail":["session_info","user"]}`（`pendingOnly:true` ↔ `freshness:fresh`，而 `turnsGap` 仍为 1）。 **2026-09-17 晚（N21-11 CJK 估算）轮次**：新口径下重跑 `contextsweep`（cost 1，默认 kinds）✓ 与 `contextgate`（cost 1）✓（前者 `swept>=1`，后者短会话仍 `too-early` / 0 提交 / 0 状态文件）；cost 0 四场景 `context` / `contextstate` / `contextbudget` / `contextswitchguard` ✓；`contexttakeover` 顺带修好了它的**静默失败**（探针现在先跑预热回合、发够大的消息、并在等压缩前断言「回合真的跑起来了」+ 打印 `pi 用量`），实测用量 1940 > 1500、**接管真的触发**（`triggeredBy: policy` / `policyStage: compact`），但压缩那一步调模型时撞上 **longcat 当日 100 次免费额度用尽（429）**、`laguna-s-2.1-free` 上游不可用 —— **改用用户指定的 `deepseek/deepseek-v4.1-flash` 后，`contextsweep` 与 `contexttakeover` 都取到绿**：后者 `pi 用量=31019` → 压缩 `completed`、`beforeTokens=31019` → `afterTokens=120`、`triggeredBy: policy` / `policyStage: compact`、界面「最近一次工作集 · 已完成」（场景本身也修好了：单个大回合 + `keepRecentTokens:1`，预算 180s → 420s，见 [方案 §18.8](../design/方案-上下文工具内的自动压缩-2026-09-15.md)）；**`contextrefresh`**（cost 1，新场景，已进 check）在策略 `{minTurns:1, minTokens:1e8, refreshRatio:1e-6}` 下命中 `near-window`，诊断 `{reason:"near-window", activated:true, window:1000000}` 证明 `ctx.model.contextWindow` 在真实链路可用（方案 §20）；**同模型下 `contextproduce` 也全绿** —— 生成器 1 次提交 0 错误、注入 1 次且 `freshness="fresh"`（`pendingOnly:true`）、gate 当场激活、状态文件 `revision=1` / `episodes 为空` / 主进程校验 ok、`stateOverhead=4.6%（low，分母改为只算本场景会话）；**同日 provenance 轮**：`contextproduce` 全绿且带回证据分布 `{"observed":1,"derived":1,"hypothesis":4,"total":6}`（模型真的引用）、注入 `tokens` 141 → 329（`inferred` 标记真的进了注入块）、状态文件过主进程校验（新的 `kind:tool + derived` 组合合法），`stateOverhead = 6.4%（low）`；**同日 superseded 轮**：注入诊断新增 `items:{active,skipped}`（真实运行 `{"active":7,"skipped":0}`），并用真实状态文件 + 真实注入链验证 superseded 不进注入块（`skipped=1` 渲染与注入均不含它，证据层级=模块级，见[归档 §1.17](../archive/2026-09-17-已完成归档.md)）；**同日模型级 override 轮**：`contextbudget`（cost 0，预算 90s → 180s）第 8 节真的 `setModel` 换到 `deepseek/deepseek-v4-flash`，模型级 override 当场失效（来源 `model` → `default`、工作集 321k → 240k），切回又生效（[归档 §1.18](../archive/2026-09-17-已完成归档.md)）；**同日结构化摘要轮**：新场景 `contexttakeoversummary`（cost 1）在**真实落盘的状态文件**上跑真实 `buildStructuredSummary` —— 逐类非空 4 类（task/constraints/unresolved/nextActions）、摘要 863 字符、两个块都在（[归档 §1.19](../archive/2026-09-17-已完成归档.md)）。**同一轮曾误报一个缺陷（已撤回）**：当时以为 `session_before_compact` 一次都没被调到，实际是**检查里的过滤条件写错了**（compact 系 trace 没在 payload 写 `stage`，而 `diagnostic` 只把第一参数放进 `hook`）；给 compact 系补上 `stage` 后 `contexttakeover` 实测 `{entered:1, fallback:1}` —— 钩子确实被调到，fallback 原因是 `inject-off`（该场景没开 `episode-fold`，符合设计）。「状态存在 + 水位可用 → 真的接管」那一次成功分支**已闭环**（同日）：新场景 `contexttakeoverstate`（cost 1）实测 **`takeover 1 次 / fallback 0 次`**（`tier=stale-hard`、`before=36397 → after=108`）—— 这是 `hook:'takeover'` 第一次在真实链路出现（[归档 §1.21](../archive/2026-09-17-已完成归档.md)）。**同日 N21-8 Deep Context 落地**：新模块 `context-deep.js`（216 行）+ `context.js` 的 ④ 挂接，单测 **1498/1498**；`contextdeep`（cost 1）全绿 —— Pass 1 `ms=3627 / outputChars=177`（真调了模型）、`injectedWorkingTrace:true`（注入真的进了这一轮）；反向验证在 `contexttakeoversummary` 里（没开则 **0 条 deep 记录**）；**默认关，且「可手动开」已闭环**：设置面板「上下文」页有开关（`ctx-deep`），传递链是「渲染端 → 主进程 → `desktop.json` → 扩展读文件」（不是 env，所以改完立即生效、不用重建实例）；视觉证据 `matrix-ctxsettings-1440x900-100-{dark,light}-2026-09-17.png` 已看图；界面路径的 live 证据是 `contextdeeppref`（cost 1）—— 扩展读到了开关并停在门槛上（`below-threshold`），真正的注入由 `contextdeep` 用测试通道降门槛验（[归档 §1.20](../archive/2026-09-17-已完成归档.md)）。**同日 P2-7 轮**：新场景 `contextfoldpref`（cost 1，**已进 check**）全绿 —— 从设置面板关掉之后，`desktop.json` 真的落 `contextFold.enabled:false`、诊断里 0 条生成动作但有 1 条 `hook:skipped / reason:kind-off`（带 `kinds=["tool-sweep","recall","compaction"]`，即扩展真的读到了关闭且只关了一项）、0 次注入、0 份状态文件；同日同模型的 `contextfolddefault` 是反向对照（同样条件下会生成）（[归档 §1.23](../archive/2026-09-17-已完成归档.md)）。**同日 N21-4 剩余项轮**：`contextproduce` 重跑全绿 —— 加了阶段节流后真实链路仍然「生成 → 落盘 → 注入」（[归档 §1.24](../archive/2026-09-17-已完成归档.md)）。**同轮 EpisodeState 切片**：新场景 `contextepisode`（cost 1，已进 `check`）全绿 —— 真实回合里 `hook:'episode-window'` 两次（`4条/837tok`）、模型给出 Episode 并落盘（id `ep-…` / `sourceRange` 指回原始条目 / `unresolved` 为 0）、`task.episodeRefs` 里没有它（shadow）、状态文件过主进程校验（[归档 §1.25](../archive/2026-09-17-已完成归档.md)）。**同日孤儿进程检查**：`test-live` 在所有场景跑完后新增一道进程表检查（命令行含 `--mode rpc` 且**父进程已不在表里**）—— `sessionrunners`（cost 0）实跑输出「✓ 没有残留」；反向验证：构造的真孤儿被检出（2 个），同时用户环境里正在跑的 5 个真实 pi 实例**全部未被误报**（父进程链在）。` |
| 视觉 | **2026-09-18（方案 S1）**：`envlinks` 重跑成来源菜单（筛选、图片缩略图、文件、网页、「文件不在了」的异常态、边界文案）；`matrix-envlinks-1440x900-100-dark-2026-09-18p.png`（溢出 0px，已看图）。**这张图又抓出一次真问题**：`src-*` 那一整块样式我忘了写，标题与「已关联」粘在一起、缩略图占不到位置 —— 新组件没有样式时不会报错，只会难看。**2026-09-18（方案 P2）**：新增 `settingspkg` 状态（目录入口 / 安装区 / 已装列表三种状态：用户级、项目级、「磁盘上找不到」/ 生效时机）。**这张图抓出两个真问题**：① 视觉矩阵**不跑 `registerIpc`**、全靠桩，漏了 `yan:packages:*` 就在界面上渲染成 `No handler registered`；② `.set-row` 是 **grid**（两列），只写 `flex-direction: column` 完全无效 —— 内容被留在第二列、整块跑到右半边（改成显式 `display: flex` 才对）。图：`matrix-settingspkg-1440x900-100-dark-2026-09-18n.png`（溢出 0px）。**2026-09-18（方案 H1 / G3）**：新增 `envlinks` 状态（菜单滚到底：在网上比较 · github.com、关联外部任务的一条 + 两个输入 + 边界文案）；`matrix-envlinks-1440x900-100-dark-2026-09-18j.png`（溢出 0px，已看图）。**2026-09-18（方案 W2）**：`envworktrees` 状态重跑（`matrix-envworktrees-1440x900-100-dark-2026-09-18i.png`，溢出 0px，已看图）。分支名原来被挤成 `feat/git-re...` —— 改成允许换行 + 名字保底 96px（分支名是这个区里最需要看全的东西，要拿它去终端里敲）。**2026-09-18（方案 W1）**：新增 `envworktrees` 状态（工作树区：主工作树**没有**移除按钮、砚创建的带标记、同时删分支、新分支名与目标目录两个输入）；`YAN_MATRIX_ONLY=envworktrees` 跑组 0/1 → `matrix-envworktrees-1440x900-100-{dark,light}-2026-09-18g.png`（2 张，溢出 0px，已看图）。**2026-09-18（方案 G2）**：新增两态 —— `reviewwrite`（文件行「暂存 / 取消暂存」+ 头部批量按钮 + 底部提交区）与 `envbranches`（环境菜单展开分支列表 + 当前分支标记 + 新建分支输入 + 拉取 / 推送 ↑N）；`YAN_MATRIX_ONLY=reviewwrite,envbranches` 跑组 0/1 → `matrix-{reviewwrite,envbranches}-1440x900-100-{dark,light}-2026-09-18f.png`（4 张，溢出 0px，已看图）。**2026-09-18 深夜（方案 G1）**：新增两个状态 —— `envmenu`（环境菜单：变更/本地+打开复制/分支/PR 不可用/比较分支）与 `review`（审查面板：范围+统计+两列行号 diff+未修改区+变更树+已查看进度+图片对照）；`YAN_MATRIX_ONLY=envmenu,review` 跑组 0/1 → `matrix-{envmenu,review}-1440x900-100-{dark,light}-2026-09-18e.png`（4 张，溢出 0px，已看图）。**截图当场拍出两个真问题**（审查面板与工具栏争空间、「本地」点了却打开审查），已修并重拍。此前：**2026-09-18 深夜本轮**：组 0 **全绿**（**24 个状态**、溢出 0px）—— 新增 `pendingcards`（待投递卡片）、`railsessions`（项目会话折叠），`railmini` 重拍成「左栏完全消失」；证据 `matrix-{pendingcards,railsessions,railmini}-1440x900-100-dark-2026-09-18.png`（已看图）。**同日更早一轮**：新增 `autonomous` 状态（自主模式双光带），跑组 0 全绿，产出 `matrix-{autonomous,main,modelmenu}-1440x900-100-dark-2026-09-18.png`。此前：`npm run visual:matrix` **组 0/1 追加 `usageturn` 通过**（R03 证据：`matrix-usageturn-1440x900-100-{dark,light}-2026-09-17.png`，溢 0px；`YAN_MATRIX_ONLY=usageturn` 跑组 0/1）。此前：**8 组全绿、40 张截图**（37 个状态 + 3 张引导层） | 组 0/1 重跑（深/浅共 26 张，含 `usageelapsed`）；每张带溢出 ≤ 1px 与关键元素硬断言。**2026-09-17 追加批次**（`STAMP=2026-09-17`）：只重跑受「Tool Sweep 默认开」影响的 3 张 —— `matrix-contextbudget-{dark,light}` 与 `matrix-ctxnarrow-dark`（`YAN_MATRIX_ONLY=contextbudget,ctxnarrow` 跑组 0/1 全绿、溢出 0px）：新图里「下一步」已变成**清理旧工具输出（约 168k 时）**、清理阶段标记为已接管；旧批次（`-2026-09-16`）原样保留。**整组**重跑仍受本机 GPU/Network 崩溃影响（组 0 跑到 10 分钟看门狗），与本次改动无关。**同日 N21-7 追加批次**：`YAN_MATRIX_ONLY=ctxsettings` 跑组 0/1，产出 `matrix-ctxsettings-1440x900-100-{dark,light}-2026-09-17.png`（设置面板「上下文」tab，溢出 0px）。**同日（N01 拖拽排序）追加批次**：`YAN_MATRIX_ONLY=railreorder` 跑组 0/1，产出 `matrix-railreorder-1440x900-100-{dark,light}-2026-09-17.png`（截图停在**拖拽进行中**：被拖行半透明 + 目标位置 2px 插入线；溢出 0px；已裁剪放大逐张核对深浅两套对比度）。**同日 P2-7 追加批次**（`STAMP` 起可由 `YAN_MATRIX_STAMP` 覆盖，旧批次原样保留）：`YAN_MATRIX_ONLY=ctxsettings` 跑组 0/1 → `matrix-ctxsettings-1440x900-100-{dark,light}-2026-09-18.png`（新增 `ctx-fold` 开关行，溢出 0px，已裁剪放大看图核对「已开启」按钮与中英文案）。**同日 N03 追加批次**：新增两个状态 —— `toolgroup`（折叠组展开、组内行保持一行）与 `toolterm`（命令行的终端窗口，只有命令类工具会渲染 `.term`）；`YAN_MATRIX_ONLY=toolgroup,toolterm` 跑组 0/4 → `matrix-toolgroup-1440x900-100-dark`、`matrix-toolterm-1440x900-100-dark`、`matrix-toolgroup-900x520-100-dark`（**窄窗口**）三张，溢出 0px，已裁剪放大核对 |
| 应用与包 | **P0-8 已完成（2026-09-18，六步走完）** | `vendor:pi:check`：内置 pi 0.85.1 + RPC 握手正常；`dist:dir` + `test:packaged` 全绿（内置 pi ready、扩展加载 0 报错）；**`test-packaged --exe=release/砚-0.2.0-portable.exe` 也全绿**（单文件便携版真实自解压启动）；**升级读取验证**用 `release/砚数据/` 的副本启动打包产物 —— 读到 cwd/lang/theme/projects/profile（`signedIn:false`，不伪造登录）+ localStorage（theme/onboarded）+ 凭证（`auth count=1`、`conn=ready`），原目录原样保留；`npm run dist` 重产三个产物并重写 `SHA256SUMS.txt`（`9E307C76…` setup.exe 126,991,251 B / `6501AF9A…` portable.exe 126,758,099 B / `7B998F57…` portable-fast.zip 169,672,278 B）；包内可索引到本轮新串（`review-diff` / `review-gap-open` / `env-changes` / `yan:git:snapshot` / `--font-body`），无 `out/test/` 与测试凭证。明细见[归档 §1.26](../archive/2026-09-17-已完成归档.md) |
| 已知偶发 | 免费模型可能因日配额或供应商状态返回空文本/零 usage；这会让 `tokens` `subagent` `contexttakeover` 等需要真实 usage 的场景变红 | 先用 `YAN_TEST_MODEL=commandcode/longcat-2.0:free`；不可用或触顶时换 `YAN_TEST_MODEL=commandcode/laguna-s-2.1-free`，再分辨「模型当时不可用」还是「代码回归」。**2026-09-17 晚实测**：同一夜连跑 `contextproduce` 6 次只有 1 次成功，失败形态分别是 `aborted`（20s 生成超时）/ `not-json`（返回空文本）/ `error`；换备用模型也一样。**2026-09-17 深夜已确证原因**：`commandcode/longcat-2.0:free` **当日 100 次免费额度用尽**（pi 原样报回 `429 You've used all 100 free LongCat 2.0 requests for today`，配额 `2026-09-18T00:00:00Z` 重置），换 `laguna-s-2.1-free` 则报上游暂不可用。**规则**：看到 429 就直接停手（每跑一次都是在烧剩余额度，而且拿不到结论）。**换模型**：用户指定 `YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash`（1M 窗口、支持思考）后，`contextsweep` / `contexttakeover` 均真实通过 —— 免费模型不可用时的首选替代。**另一个易踩的坑**：探针变慢以后没同步加 `budget`，进程会在打印前被 kill，而 `buf` 为空又被报成「应用可能启动失败」（`contexttakeover` 就此白查三轮，现已在提示里区分这两种情况） |

### 本轮（2026-09-18 深夜）用户报的 5 条（上一条的**反向修正**也在里面）

用户原话逐条：**① 用户发送的消息默认悬浮在输入框上方 让用户自己选择是插话还是排队；② 项目文件夹应该默认显示前五个会话 其余进行折叠；③ 左边栏变为完全折叠 不要留下一个边框；④ 模型调用的工具和命令保持默认折叠 但是展开时应该有一个固定的范围 或者在最上方显示折叠回去的按钮（推理过程同理 但是推理过程的胶囊还是保留）**。

| 项 | 决定 / 根因 | 改法与证据 |
|---|---|---|
| ① 待投递悬浮 | **推翻上一轮的“默认插话”**：那次只是把主进程的默认值从 `followUp` 改成 `steer`，用户仍然没有选择权。现在消息先悬在输入框上方（**只存在于渲染端**），点「插话」或「排队」才投递 | IPC 链路加 `mode`（`agent.send(text, images, mode)` / `yan:send` / preload / `shared/ipc.ts`），主进程只在回合级 `agentRunning \|\| isStreaming` 时才带 `streamingBehavior`，`mode` 缺省仍兜底 `steer`（防 pi 报“Specify streamingBehavior”）。store 新增 `pendingSends` + `holdSend`/`releaseSend`/`restoreSend`（**失败不移除卡片**，不假装成功）；切会话 / 新会话 / 分叉 / 复制都会清空。判据是**回合级** `runners[active].running`（`session.isStreaming` 在工具执行期间是 false，正是用户最想插话的时刻）；回合结束后悬着的消息**自动按「排队」发出**（插话时机已过，且不能把消息丢掉） |
| ② 项目会话折叠 | 一个项目几十条会话时，展开态把下面的项目全挤出视野 | 新增 `SESSION_PREVIEW = 5` + 持久化的 `shownAllSessions`；「更多会话（N）」/「收起会话」两个出口。**当前会话落在折叠段里时自动多展开到它那一行**（`floor = max(5, currentIndex + 1)`）—— 不能把用户正待着的会话藏起来；只有真能收起来时才给「收起会话」（否则点了看着像没反应） |
| ③ 左栏完全折叠 | ⚠️ **产品边界变更**：N14 的 48px 紧凑图标轨（砚 / 搜索 / 新建 / 项目文件夹 / 设置）**已按用户要求删除**。它在深色主题下就是消息区左边一条颜色不同的竖条 —— 用户说的「边框」就是它 | `--w-rail-collapsed: 0px` + `.app.rail-off .rail { display: none }`；`Rail.tsx` 的 mini 轨 JSX（含 `miniMenu`/`miniHover`/`miniProjects` 与点外关闭的 effect）与 `rail.css` 的 `.rail-compact*` / `.rcm-*` 样式（150 行）一并删除。**展开入口只剩标题栏的开关**（`rail-toggle`）—— 项目入口退回「先展开左栏再切项目」 |
| ④ 展开要有固定范围 | **用户澄清后的准确范围**：他报的是「主动展开调用工具/命令栏的时候，给展开的条目一个显示范围，而不是铺开到整个界面」—— 指**工具组展开后那一长串调用条目**（他截图里那条组有 146 次调用），`.tgroup-body` 此前没有任何高度限制（第一次实现只做了单条详情，属于理解偏差）。同一条要求也落在单条详情与推理全文上 | **工具组**的高度按**条数**定：用户 2026-09-19 看过第一版（`min(70vh, 620px)`，900px 窗口下约 19–22 行）后要求「改为 25 条」，所以现在写的是 `min(623px, 80vh)`（行步进实测 ≈ 24.8px × 25 行 ≈ 618px，留几像素让第 25 行完整可见；不再挂 70vh，只在矮窗口下用 80vh 兜底）—— 列表的单位是“条”，就不再让它跟着 vh 跑。**单条详情** `.trow-body > :not(.term)`（**刻意排除终端窗口**：它自带高度与缩放手柄，套上会出现“终端外面还有一层滚动条”）与**推理全文** `.reason-body.clip.expanded`（原 `max-height: none`）是一段连续文本，“行”不是它们的自然单位，仍用 `min(70vh, 620px)`。三处卡住高度后 `tgroup-head` / `trow-head` / `reason-head` 都留在上方，**它们本身就是那个「折叠回去的按钮」**。⚠️ 这改掉了 AGENTS.md 里「展开全部不引入第二条滚动条」的旧边界 —— 那条是为**默认态**定的，展开全部是用户主动要看全文，已记入 DESIGN §3.5 |

**顺带修掉两个截图问题**：① `trashtoast` 视觉状态里那条合成会话时间戳较旧，新增的会话折叠把它藏了起来（`no-row`）—— 把 `railsessions` / `pendingcards` 排到组末（它们会改 `sessions` 与 `runners`，放中间污染后续 fixture）；② `toolgroup` 状态为了拍出“限高”要先造长组，但**不能整包替掉 `messages`**（后面 `wschanges` / `wsunknown` / `usageelapsed` 等 6 张图都靠 fixture 的消息，实测全变成缺件）—— 改成给已有的 assistant 消息**追加** toolCalls，并把长组放在页面靠上的那一条（放最后会有一大半截在视口外）。

| 六栏 | 证据 |
|---|---|
| 实现 | `src/main/agent.ts`（`send` 加 `mode`）、`src/main/index.ts`、`src/preload/index.ts`、`src/shared/ipc.ts`、`store.ts`（`pendingSends` + 三动作）、`Composer.tsx`（`roundRunning` 分支 + 待定卡片 + 自动投递 effect）、`Rail.tsx`、`composer.css` / `rail.css` / `layout.css` / `chat.css`、双语 i18n（`queue.hold` / `queue.steerNow` / `queue.queueIt` / `queue.sendNow` / `queue.restore` + tip、`rail.moreSessions` / `rail.foldSessions`）、`DESIGN.md` §3 / §3.5 |
| 自动检查 | `typecheck` / `build` 干净；**单测 1620/1620**（本轮没改纯逻辑） |
| 真实运行 | **新场景 `pending`（cost 0）**：空闲 Enter 直发 / 生成中 Enter 只悬着 / 插话=steer / 排队=followUp / 撤回回填草稿且不投递 / **工具执行窗口（running 真、isStreaming 假）也进待定区** / 回合结束自动按 followUp 投递 / 投递失败卡片留在原地 / **自动压缩期间（running 假、isCompacting 真）也进待定区，压缩结束自动 followUp**。重写 **`railmini`**（mini 轨已删）：默认只列前五条 + 更多会话 + 收起 + **当前会话在第 7 位时自动展开到 7 行** + 收起后 `display: none` / `--w-rail-collapsed = 0px` / `.workspace` 列宽 `0px …`。`reasoning` 展开后断言 `max-height` 有值 + 内部滚动 + **滚动时胶囊 top 不变**；`toolgroup` 新增**第 6 节**：造 60 条调用的组 → 上限生效 / 真的溢出（当时 `min(70vh,620px)` 下实测可视 548px、内容 1486px）/ **列表内部滚动时组头 top 不变**，并加“终端窗口没被上限套住”的反向断言。同批 16 个场景全绿（含 `sendkey` `layout` `vheight` `queuestack` `fs` `slashcmd` `queueretract` `autonomous` `modelnotready` `modelmenu` `settings` `trash`）；返工后又跑 11 个（含 `toolrow`）全绿。**随后用户要求把组高度「改为 25 条」**（`min(623px, 80vh)`）—— 探针那条断言已同步改成“按实测行步进算可见条数、要求 ≥ 25”，**这一轮没重跑** |
| 反向验证 | ① 一次把四处改回旧行为（`if (roundRunning)` → 永假、`--w-rail-collapsed: 48px`、`.expanded { max-height: none }`、`SESSION_PREVIEW = 99`）→ `pending` / `railmini` / `reasoning` **3/3 变红**；② 去掉 `.tgroup-body` 上限 → `toolgroup` 第 6 节 **3 条红**（可视高度 1486px = 铺满）；③ 摘掉 `Composer` 里的 `isCompacting` 判据 → `pending` 第 9 节 **3 条红**：消息被**直接投出去**且 `mode` 为 `undefined`（正是改动前的裸 prompt 行为） |
| 视觉验收 | 视觉矩阵组 0 全绿（**24 个状态**）。新增两个状态 `pendingcards`（三张待定卡片：“待投递”标签 + 实心「插话」+「排队」+「撤回」，placeholder “生成中，Enter 插话”）与 `railsessions`（“会话 1–5 + 更多会话（3）”）；`railmini` 重拍后是**左栏完全消失、消息区贴到窗口左边**；`toolgroup` 重拍成 **62 条调用的长组**——图上看得到列表右自己的滚动条、组头“调用了 62 次工具/命令”留在上方（**另存新名**，没覆盖 N03 那张：`matrix-toolgroup-long-1440x900-100-dark-2026-09-18.png`，原名仍是 d94adf9 里那张）。`matrix-{railmini,railsessions,pendingcards}-1440x900-100-dark-2026-09-18.png` 与上面那张 long 已看图。⑤ 压缩期的待投递卡片**没有单独截图** —— 它与 `pendingcards` 的差别只是「插话 / 排队」两个按钮换成一个「发送」（压缩时模型没在生成，`QueueStack` 的判据不算 `isCompacting`），该形态由 `pending` 第 9 节的「卡片真的出现了」与元素断言覆盖 |
| ⑤ 自动压缩期间也要能发消息 | 压缩期间 pi 同样不接受裸 prompt，而**回合级判据漏了它**：`roundRunning` 只看 `runners.running`，但 pi 在**回合之间**自动压缩（threshold）时 `agent_settled` 早已发过、`running` 已经是 false —— 这时按 Enter 会把裸 prompt 直接投出去，pi 报「Agent is already processing」，而 `submit` 已经把输入框清空了，**用户的消息就这样丢了**（既发不出去、又没有留在框里） | `Composer` 的回合级判据加上 `isCompacting`：压缩期间按 Enter 与“生成中”走同一条路 —— 消息**悬到待定区**（不丢草稿），压缩一结束自动按「排队」投出去。`QueueStack` 里那个同名判据**故意不算压缩**：模型没在生成时“插话”没有意义，卡片只给一个「发送」（内部走 `followUp`）。主进程 `agent.send` 的 `streamingBehavior` 判据也补上 `isCompacting` 作兜底（别的调用路径漏判时也不会撞 pi）。探针 `pending` 新增**第 9 节**（cost 0）：摆出「running 假 + isCompacting 真」→ 按 Enter 不投递 / 进待定区 / 界面上看得见 / 压缩结束自动 `followUp` |
| 应用与包 | 未做（随 P0-8） |
| 剩余限制 | ① 待定消息**不持久化**（切会话即清），也不支持拖拽排序 —— 它本来就是“等一句话就要发出去”的临时状态；② 回合结束后自动投递是**不可关的行为**（用户不选也不会丢消息，但也就没有“一直挂着不发”的选项）；③ 左栏收起后项目快捷入口只能“先展开再切”（N14 的 mini 轨已删，这是用户拍的）；④ 展开上限：**工具组现在是 25 行**（`min(623px, 80vh)`；900px 窗口实测一屏 25 条、行步进 24.8px）—— 矮窗口下会跌到 80vh（那时物理上放不下 25 行）；单条详情与推理全文仍是 `min(70vh, 620px)`（900px 窗口 = 548px）；⑤ 压缩期间的待定消息同样要**等压缩结束**才发（用户不能强制它立刻走），这是有意为之：压缩中 pi 本来就不接活 |

### 本轮（2026-09-18）用户报的 6 项界面问题 → 全部已修

用户原话（逐条）：**① 输入框的快捷按键提示在默认输入框的情况下不要显示 ② 自主模式的跑马灯不太明显 可以添加两个对称的灯光效果 ③ 输入框下的模型选择器放到输入框内部 并根据设计方案对模型思考能力显示的文字进行变色 ④ 长文模式使用拖拽柄关闭的时候动画消失 ⑤ 上下文工具的提示文件太长 导致出现两行 ⑥ 模型工作的时候 插话失效 [错误] 消息已被 pi 接收，无法撤回**。

| 项 | 根因 / 决定 | 改法与证据 |
|---|---|---|
| ① 快捷键提示 | 提示此前**常显**（注释里的理由是“不写出来就得靠试”），但它默认状态说的就是 Enter 发送 —— 默认输入框里纯噪声 | `Composer.tsx` 改为「长文模式 或 用户改过发送键」才渲染；`sendkey` 探针第 2 节重写为 **默认不显示 → 长文模式出现 → 退出收回** 三连（原断言写的是“持续显示”，正是被改掉的那个行为） |
| ② 自主模式光带 | 原来只有一条 96px 的光带，3px 细线贴在 1px 边框上，暗色主题里几乎看不出 | 加第二条并让两条**相位差半周期**（`animation-delay: -1.6s`，周期 3.2s）—— 同相位的两条会重叠成一条、反而更暗；拖尾加宽到 112px + 同色辉光。`autonomous` 探针新增三条断言（第二条在跑 / 相位差 1.6s / 两条独立推进）；视觉矩阵**新增 `autonomous` 状态**（此前没有，光带一直没进过证据集） |
| ③ 模型选择器位置 + 档位变色 | 选择器在输入框**下方的用量条**里；档位文字统一用强调色，七档在文字上不可区分 | 选择器移进 `.composer-bar`（发送键左侧），`UsageBar` 只留用量（**容器保留** —— `layout` / `tokens` 探针与视觉矩阵按 `usagebar` 定位）。档位文字按 `--think-*` 染色：给 `.mt-level` / `.mt-head-level` 加 `data-level`，在 `composer.css` 里与输入框顶边框共用同一套七色；`modelnotready` 探针断言 high=`rgb(178,148,187)` / low=`rgb(95,135,175)` 且两者不同 |
| ④ 长文模式收起动画 | 高度是 JS 写的 inline style，CSS 侧没有过渡 —— 点拖拽柄收起是 180px→内容高 的瞬跳 | `Composer` 在切换那一瞬间加 `.animating`（240ms 后移除），CSS 只在此时挂 `transition: height 200ms`（**不能常开**：打字自动长高与拖动跟手都会被拖慢）。`sendkey` 探针断言「收起瞬间有 animating + transition 含 height + 动画结束后移除」 |
| ⑤ 文件树提示太长 | `rp.fsAddContext` = “加入上下文（**文件标签**）”，一行放不下就折成两行 | 文案缩为「加入上下文」/「Add to context」（中英同步）。`fs` 探针不受影响（它按 `data-testid` 取按钮，不断言文案） |
| ⑥ 生成中发送默认插话 | **产品行为改动**（用户选定）：此前默认 `streamingBehavior: 'followUp'`（等这轮跑完再投递）。于是消息半天不出现，用户去点「插队」/「撤回」，而 followUp 在这轮结束时已被 pi 接收 → 报「消息已被 pi 接收，无法撤回」 | `agent.ts` 默认改为 `'steer'`；顺带同步两处会说谎的文案（placeholder「生成中，Enter **排队**」→「插话」、`queue.retractTip` 去掉“排队”）。`queue` 探针的默认断言重写：**不拿“快照里此刻挂着几条”当判据**（steering 会被 pi 很快取走，取走是成功不是失败），改为「followUp 必须为空 + 消息在 steering 里或已进对话」 |

**顺带修掉一个由 ③ 引入的布局回归**：模型菜单是 `.picker-wrap` 的 absolute 子元素，而 `.composer` 有 `overflow: hidden`（圆角与光带需要它）—— 移进输入框后菜单被整块裁掉，实测截图里只剩两行。改为 `position: fixed`，坐标由 `Pickers` 按触发器的 rect 写进 inline style（`right`/`bottom`，夹到 ≥ 8px）。

**设计规范同步**（`docs/design/DESIGN.md`）：`--think-*` 七档色此前**只存在于代码里**，现补 §2.6「思考档位色」小节（令牌表 + 四个载体的选择器）；§4 新增 4.2 节「自主模式的双光带」（两条必须相位差半周期）；§3 输入区一行改写；§5 动效从“只有三处”改为列出实际清单。

| 六栏 | 证据 |
|---|---|
| 实现 | `Composer.tsx`（keyhint 条件 / `.animating` / 选择器入栏）、`UsageBar.tsx`（移除选择器）、`Pickers.tsx`（`data-level` + fixed 坐标）、`agent.ts`（默认 steer）、`composer.css` / `redesign.css` / `motion.css`、`zh-CN.json` / `en-US.json`、`DESIGN.md` |
| 自动检查 | `typecheck` / `build` 干净；**单测 1620/1620**（本轮未改纯逻辑，故条数不变） |
| 真实运行 | `autonomous`（含三条新断言）✓、`sendkey`（第 2 节重写 + 动画断言）✓、`modelnotready`（档位色）✓、`modelmenu` ✓、`layout` / `vheight` / `queuestack` / `fs` / `slashcmd` / `queueretract` ✓（同批次）；`tokens` 用 `YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash` ✓ |
| 视觉验收 | 视觉矩阵新增 `autonomous` 状态，**组 0 全绿**（21 个状态，溢出 0px）；`matrix-autonomous` / `matrix-main` / `matrix-modelmenu`-`1440x900-100-dark-2026-09-18.png` 已看图：两条光带在上下边框、模型胶囊在输入框内、底栏无快捷键提示、模型菜单完整弹出不被裁 |
| 应用与包 | 未做（随 P0-8） |
| 剩余限制 | ① 光带是**动画**，静态截图只能证明“有这个状态、两条都在”，相位对称由探针的 `animation-delay` 断言钉住；② 第 ⑥ 项是**行为变更**：默认不再排队，想“等这轮跑完”的用户现在没有入口（未做「解除插话」按钮 —— 两种默认值同时存在时用户无法判断这条消息的归属）；③ `queue` 场景在 LongCat 上游故障时会红两条（`中止后不再流式` / `流式光标已消失`）—— 已用 A/B（临时改回 `followUp` 重跑）确认**与投递方式无关**，是上游 500 触发自动重试 |

### 本轮（2026-09-17 晚）用户报的三条 → 五个缺陷

用户原话：**① 切换会话的时候会话历史会丢失 ② 会话结束的时候（看不到）本次用时 ③ 推理过程跟随用户语言的功能失效**。

| 编号 | 现象 / 根因 | 修法 | 反向验证 |
|---|---|---|---|
| **D37** | **切语言会重建 pi 实例**：`restartAgent` 把主实例建在一条**新会话**上（`startPrimary(cwd, undefined)`），先推了一次空 `sync` 把当前会话清空，再 `switchSession(file)`（suppressPush）—— 界面就停在空白上。触发场景：切界面语言（旧实现为了 `--append-system-prompt` 生效必须重建）、应用内登录 ChatGPT | 语言不再走重建（见 D39）；`startAgent(restore)` 支持把 `sessionFile` 带进去，主实例**直接落在要接回的会话上**并推一次快照；重建后若仍不在原会话则显式 switch 并把失败写进日志 | `language` 探针断言「切语言没有重建实例 + 消息数不变」；`historyswitch` 第 3 节同断言 |
| **D38** | **切换会话时视图被清空/换掉**（用户报的「历史丢失」，实测可复现）：① pi 的 `get_messages` 只给**当前上下文**（压缩过的会话只剩尾巴：实测文件 858 条 → 界面 86 条，首条用户消息消失）；② 渲染端的 `sync` 无条件覆盖，旧实例的 sync 晚到就盖掉刚点开的会话；③ 运行时缓存投影按 `run:${runId}` 兜底，实例复用后把**上一条会话**（常见是空的）的状态投影到眼前 | ①`hydrate()` 改以**会话文件**为历史来源（`readSessionMessages`），`get_messages` 只做兜底；②`sync` 加会话身份校验（`peekedSessionId` vs `runtime.sessionId`）；③`findRuntimeSnapshot` 的 `run:` 兜底要求会话身份一致，新增 `snapshotForView`：`runners` 推送/切换后的缓存投影只认当前会话 | 去掉①→ `historyswitch` 报 `0/1010`、`1010→0`；只去掉②③ → 报「铺上内容之后没被打回 0」✗；两条都已实测 |
| **D39** | **语言要求只在进程启动时生效**：`--append-system-prompt` 是启动参数，切语言只能靠重建实例（代价见 D37），而且**已有会话永远拿不到新要求**。用户报「推理不跟随界面语言」 | 新增内置扩展 `resources/pi-extensions/language.js`：每轮读 `desktop.json` 的 `lang` 注入**同一句**要求（删掉主进程那份措辞，单一真源在扩展）。切语言**不重建实例**、下一轮就生效、历史会话与新会话一视同仁 | `language` 探针改断言「不重建 + 同一会话下一轮生效」；`YAN_LANG_EXT_LOG` 记录每轮 `{hook,lang,injected}` 作为注入取证 |
| **D40** | **同一句要求放在系统提示末尾时模型不服从**（实测 5 次里 5 次忽略）：`before_agent_start` 追加的句子落在 11k 字符提示的**最后 60 字符**，而 `--append-system-prompt`（位置在 ~1900 字符处）同一句话模型就服从 | 扩展改用 `before_provider_request`，在**最后一条 user 消息前插一条独立 developer 消息**（同一句；系统提示末尾那份保留作兜底）。实测「界面英文 + 中文提问」2/2 服从 | 去掉 payload 注入（只留系统提示末尾）→ `language` 探针第 2 节连试 3 次全红（CJK 0.57/0.82/0.80）✓ |
| **D41** | `e2e` 场景**总是**红成「没抓到 PROBE 输出 —— 应用可能启动失败」：探针内部等 150s，而 case 的 `budget` 默认只有 90s —— 被杀在打印之前 | `e2e` 显式 `budget: 200000` | 加上后 `e2e` 全绿（含 bash 工具卡、流式、折叠） |

**用户报的第 2 条（用时）**不是缺陷而是缺功能：`elapsedMs`（本轮墙钟耗时，含工具往返）一直存在，但只写在「速度」项的 tooltip 里、回合结束就看不到。现在用量条上直接显示 **`用时 12.4s`**（<60s 一位小数，更长 `5m20s`），流式期间仍是「生成中 Ns」，新会话不残留上一轮的用时；视觉证据 `matrix-usageelapsed-{dark,light}`。

**推理语言**的边界（别改回去）：语言是**软约束** —— 注入发生在每一轮（有 `YAN_LANG_EXT_LOG` 取证），但模型可能「用英文想、按界面语言答」（实测 deepseek-v4.1-flash 就会）。所以 `language` 探针把推理语言列为**只报告**、不作硬断言；回复语言按「多次尝试里出现过符合期望的一次」判。机制确定性由 `scripts/test-language-extension.mjs`（909 单测里的一部分）钉住。

## 当前未完成

### 代码与文档审阅（2026-09-17，R01–R04 已修复、D01–D06 已同步）

[审阅批注](REVIEW-2026-09-17-代码与文档批注.md)的 R01–R04 已全部修复，并补齐了失败路径证据；
D01–D06 的文档/注释漂移已按当前实现改写。

| 项 | 修法 | 自动检查 | 真实运行 / 视觉 |
|---|---|---|---|
| **R01** 完整 IPv6 被误判非私网 | `parseIpv6` 只对含 `::` 的压缩形式要求补零段，八组完整写法直接校验（`src/main/browser/network-policy.ts`） | +12 条（完整/压缩/映射等价、zone id） | `test:live -- browserboundary` 通过（真实网络边界未回归） |
| **R02** 新 runner 失败后漏回收 | 新增 `discardNewRunner()`：先摘登记 + 还原 activeId，再尽力 `stop()`；覆盖 start/switch 的失败返回与抛异常（`src/main/runners.ts`） | 失败返回 / start 抛 / switch 抛三组（size、stop、activeId 均断言） | `test:live -- sessionrunners` 通过（多实例链路未回归） |
| **R03** 旧轮速度被标成本轮实时 | 新增纯函数 `currentTurnMessages()`；用量条只在**当前回合**取 usage/speed/elapsedMs（`src/shared/turns.ts`、`components/chat/UsageBar.tsx`） | +5 条（回合范围/刚发消息的空范围/bash 分界/无分界兜底/工具往返）；单测总数 1282 → **1328** | 视觉 `matrix-usageturn-{dark,light}-2026-09-17.png`（断言「生成中 Ns」+ live 点，且无旧速度、无旧用时） |
| **R04** 手动标题写盘失败却返回成功 | `setManualTitle` 返回 `{ok,error}`；IPC 如实透传（不再无条件 ok）；store 乐观写入后**失败回退 + 提示**、候选保留（`main/title.ts`、`main/index.ts`、`state/store.ts`、`shared/ipc.ts`、`preload`） | +4 条（正常写入 / 清除 / 真实 EISDIR 写失败 / 恢复后可写） | `test:live -- title`（cost 1）通过，新增「真的落盘（主进程读盘读回）」与「返回明确成功」两条断言 |

| 文档项 | 改法 |
|---|---|
| D01 | `docs/dev/TESTING.md`：区分**默认接管集**（tool-sweep + recall + compaction）与显式只配 compaction |
| D02 | `context.js` 的 `session_before_compact` 注释改写为 freshness 分档 + `requiredFields` 默认空；`docs/PROJECT.md` §2.13 同步 |
| D03 | `docs/PROJECT.md` §2.2：pi 负责切换/分支运行语义，Yan 解析 JSONL 还原**显示历史** |
| D04 | HANDOFF / PRIORITY 的待拍板项收敛为**只剩 `episode-fold` 默认开关** —— 该开关**已于 2026-09-18 拍板：进默认接管集**（[方案 §17.5.7](../design/方案-上下文工具内的自动压缩-2026-09-15.md) / [归档 §1.22](../archive/2026-09-17-已完成归档.md)），**待拍板项现在为零**；§13.5 三问标为已随实现定下（保留原文供回溯） |
| D05 | `scripts/test-live.mjs` 的 settings 注释改成当前设置布局 + 记忆移除边界 |
| D06 | `docs/WORKSPACE.md`：pi-extensions 职责补全（浏览器/提问/语言/详细度/上下文） |

[代码功能实现清单](FEATURES-2026-09-17-代码功能实现清单.md)按现有实现列出产品能力和上下文细项。

### 一、P1 · 上下文管理（唯一还缺的大功能）

方案唯一真源：[design/方案-上下文工具内的自动压缩](../design/方案-上下文工具内的自动压缩-2026-09-15.md)
（§12 = 阶段 4 开工契约与验收，§13 = 对外部参考方案的对齐结论）。

> **N21-10（安全规则补三条）已于 2026-09-17 完成**：切成"正在使用的 diff / 用户约束 / reasoning 中间切割"
> 三条硬约束，落地为纯函数 `resources/pi-extensions/context-safety.js` + 42 条单测（**N21-4 直接调它**）。
> 明细见[已完成归档](../archive/2026-09-17-已完成归档.md) §1.7。

| ID | 状态 | 剩余工作 | 依赖 |
|---|---|---|---|
| **N21-4 多阶段与归档** | **✅ S1–S7 已交付并真实验证（2026-09-17）** | S1（State / Archive 基础设施）证据见[方案 §14](../design/方案-上下文工具内的自动压缩-2026-09-15.md#14-阶段-4--s1-落地记录state--archive-基础设施2026-09-17)；
S2–S6 证据见[方案 §15](../design/方案-上下文工具内的自动压缩-2026-09-15.md#15-阶段-4--s2s6-落地记录扩展执行层--recall--降级2026-09-17)：`context` 钩子做 Tool Sweep（墓碑 + `ctx://` 引用）、Task State 前置注入（水位一致才注入）、`context_recall`（预算 / TTL / 审计）、`session_before_compact` 接管闸门（缺字段/无状态一律降级回 pi 摘要），默认**清扫 + 可召回墓碑 + 压缩**（`kinds` 默认含 `episode-fold`（2026-09-18 拍板，见方案 §17.5.7），2026-09-17 用户拍板：清理默认开但保留必要引用；本回合正在动的文件不清扫）。**剩下**：① ~~EpisodeState 的语义生成~~ —— **已完成（2026-09-18，但两道门默认关）**：边界用 `episodeWindow` 的**确定性规则**算（尾部窗口之外 + 上一版终点），收束由模型的 `unresolved` 判（非空即不折），生成后**只落盘、不消费**（`episodeGenerate` / `episodeInject` 都默认关）；真实链路已验证位、落盘与 schema，见[归档 §1.25](../archive/2026-09-17-已完成归档.md)。**开它之前先要有质量数据**；② `symbolsTouched`（需语言级解析，目前为空）；③ §12.11 第 10 条 20+ 回合压力测试（真行为、成本高，同时也是 N21-9 的输入）。~~三阶段独立 Rearm / Cooldown~~ —— **已完成（2026-09-18）**：新模块 `context-stage-runtime.js` + `context.js` 的 sweep / fold 接线，30 条单测 + 3 次反向验证，见[归档 §1.24](../archive/2026-09-17-已完成归档.md)；~~增量 delta（现为全量快照）~~ —— **已决策不做**（方案 §18）。**另：S7（状态生成器）已于 2026-09-17 落地** —— 混合式（确定性 reducer 提供 files / commands / tests + 一次无工具 completion 产出语义字段，落盘前 reducer 覆盖模型返回的同名字段）、`revision` CAS、freshness 分档（gap 1–2 标 stale / 3–6 丢语义 / >6 不注入）、状态自身预算与裁剪；**默认在接管集里**（2026-09-18 拍板；但短会话由会话级门槛挡住，不是每轮都跑）。证据见方案 §17。以下为这批交付前的描述（供回溯）：EpisodeState / TaskState 的语义生成器（**扩展内即可完成** —— 方案 §16.1 更正了「扩展侧没有推理 API」的误判：`agent_settled` 事件 + `ctx.modelRegistry.complete()` 就能跑一次无工具归纳；实施级契约（coordinator/CAS/freshness/预算与裁剪/dirty 阈值/注入切分）见**方案 §16.6**，由第三轮外部评审经内置浏览器对话取得并经源码核查；开工前的三项待决中**第 1 项已定**：复用已验证的浏览器 loopback bridge 落盘，见方案 §16.6.3）、三阶段独立 Rearm/Cooldown（**已于 2026-09-18 完成**，见[归档 §1.24](../archive/2026-09-17-已完成归档.md)） | N21-3（已完成） |
| **N21-5～N21-9 状态化压缩** | **N21-5 / N21-6 / N21-7 / N21-8 全部完成（2026-09-17～18）**，只剩 **N21-9（A/B 基准）未开工**。N21-6 的接管**成功分支**已在真实链路取证（`contexttakeoverstate`：`takeover 1 次 / fallback 0 次`，[归档 §1.21](../archive/2026-09-17-已完成归档.md)）；N21-8 已闭环（默认关 + 设置面板开关 + 视觉证据，[归档 §1.20](../archive/2026-09-17-已完成归档.md)）。方案 §19 的结论仍然成立：pi **没有 system 注入通道**（`convertToLlm` 把 `custom` 一律映射成 user、`default` 直接丢弃），要做 system 级注入只能走 `before_provider_request` | 任务表见 [PRIORITY 的 P1c 节](PRIORITY-2026-09-15-未完成排期.md)。**③ 阈值可配 + 模型级 override 已落地**（N21-7，见[归档 §1.8](../archive/2026-09-17-已完成归档.md#18-n21-7-上下文阈值可配置化--模型级-override2026-09-17已完成)：lookup `env > model(provider/model) > provider > user > default`、设置面板「上下文」tab、`contextbudget` 第 7 节 + 20 条单测 + 两张 `ctxsettings` 截图）。**剩余**：① ~~增量 delta（全量快照）~~ —— **已决策不做**（方案 §18：量化后收益 ≤900 token/次且已有硬 cap，成本是合并语义与新的正确性面；N21-5 不再是「未完成」）；② `episode-fold` 默认值：**2026-09-18 已取得第五轮外部意见，它修正立场为「现在默认关是对的」**（原文存档于 `docs/design/参考-episode-fold 默认策略（第五轮·ChatGPT·原文）-2026-09-18.md`）；它把 `supportingEntryIds`（provenance）定为默认开的前置，而本项目核查确认「语义递归经 `<previous_state>` 仍在」—— 与现状一致，**默认值保持关**（方案 §17.5.6）—— 2026-09-17 晚已取得**第四轮外部意见**并做完源码核查（§17.5），随后**把与开关无关的硬化项全部落地**（[归档 §1.11](../archive/2026-09-17-已完成归档.md)：synthetic 输入自净 / 注入 authority 契约头 / `generate`+`inject` 分路 / episode 旁路防线 / **回合口径修正** / 会话级 gate + 新增 `contextgate` 场景）；它用的三个 gate 信号里「settled turn 计数」已补上（`turnsSince`），另两个（离压缩还有多远）仍需主进程的工作集；**第四轮复核又定掉三条**（Sweep 不得绕过最低回合数 / `inject` 的语义写死为「允许参与任何模型可见上下文」/ 「落后 1 条未 settled 的 user 算 fresh」，见方案 §17.7）；③ Deep Context Mode 默认关闭、开工前先做两项前置调查（其中「扩展侧到底能不能自己调模型」已在方案 §16.1 更正并核实）。方案 §13.5 的开工前三问与 §16.4 的四个拍板点，除②（等价于 §16.4 的默认值项）外都已随实现定下，原文保留仅供回溯；外部评审提的改进项（字段级 freshness、ancestry + 有界陈旧、富墓碑等）已登记在方案 §16.2（**待评估、未排期**）；另有一轮**本机 Codex** 的第三方核对（一致处与分歧见方案 §16.5，它额外指出 TaskState 自适应裁剪、生成器重入/迟到结果 CAS、归档回滚三项硬要求） | N21-4；用户拍板 |

### 二、P2 · 已取证项的尾巴（都不阻塞主链路，可批量补）

| ID | 已取证的部分 | 还差什么 |
|---|---|---|
| **N12 会话运行** | 切走不停 / 切回不串 / 同 cwd 拒绝 / 单独停止 / 退出落盘（`-- sessionab`、`-- sessionrunners`）；**「无孤儿进程」的进程表观测已补（2026-09-18）**：`test-live` 收尾统一查一次（判据「命令行含 `--mode rpc` 且父进程已不在表里」，只报告不杀进程），并做过反向验证 | 等待输入 / 失败 / 未读三种后台状态的**真实窗口**证据；退出变体（保存 / 中断 / 取消 / 重复） |
| **L03 子代理审阅** | 并发矩阵、冲突、只读封堵、退出归档与无残留（`-- subagentpair` + 单测）；**孤儿进程观测已补（2026-09-18，与 N12 共用同一条检查）** | 模型自身失败 / 超时的恢复（10 分钟上限目前只有代码审阅 + 单测） |
| **N04 推理流** | 注入矩阵完整（含 reduced-motion）、`-- reasoning` | 真实带 thinking 模型的**长中英文混合**推理流截图 |
| **N10 自主模式** | 开关 / 落盘 / 边框动画名（`-- autonomous`）+ 四相位截图 | 光带**运行中**的静态截图（需一条真实长任务在跑） |
| **N18 命令菜单** | `-- slashcmd` **19 节**（15 节菜单行为 + `/new` / `/browser` / `/compact` 的**真实执行** + 来源分布）：`/new` → 会话身份真的变 · `newSession` 收到 `scope:'global'` · 输入框被消费掉 · 没当消息发出；`/browser` → 真开原生视图（用 `about:blank`，不依赖外网可达性）· 无参传 `undefined` / 带 URL 原样透传 · **`file://` 被拒且提示可读原因**；`/compact` → 路由到本地 `compact()`；来源分布里出现 `skill:probe-skill`（**技能真实发现**：`test-live.mjs` 给这个场景单独准备一份 piDir，里面放 `skills/probe-skill/SKILL.md` —— 不拿「本环境没技能」当结论）。**三次反向验证**：摘掉三个本地分支 → 4 条红；去掉 piDir 覆盖 → 技能那条红；把 `openBrowser` 的剥壳还原 → 提示前缀那条红 | 本场景**测不到**的：`/compact` 的**成功**（真压缩要调模型，见 cost 1 的 `contexttakeover` / `contexttakeoverstate`）与 `/new` 的**失败**分支（要 pi 不可用，只能单测/审阅）；`/browser` 只真实打开 `about:blank`，网页导航本身归 `browserboundary` |

> 这块取证时发现一个**用户可见的缺陷**并顺手修了：`/browser` 的失败提示原本长成
> `Error invoking remote method 'yan:browser:open': Error: 只允许打开 http(s) 网页`。
> `piCall` 早就剥了这层壳，但 `store.openBrowser` 是直接 `try/catch`（成功返回的是
> `BrowserState` 而不是 `{ok}`），漏了。现抽成共享纯函数 `stripIpcErrorPrefix`
> （`src/shared/ipc-error.ts`）+ 7 条单测（1620/1620），两处共用同一套规则。
> 还有一处**同类**的直接 `catch` 未审：`closeBrowser` / `previewFile` 目前不报具体错误，暂不涉及。
| **N19 `@` 引用** | `-- atpathedge`、`-- atrefsend`（真实发送 + 模型读到文件） | 已随本轮 `fileincontext` 补上同场景截图；无其它缺口 |
| **N20 首次引导** | 三张引导层截图（深/矮/浅） | 点击回路目前只有探针证据（`-- onboarding`） |
| **N05 项目切换** | `-- projectswitch`（草稿按实例隔离、权限目录） | 「每个项目最后一个会话」持久化（否则空闲实例被回收 + 会话未落盘时草稿只能丢）——属新功能 |
| **N09 队列撤回** | `-- queueretract` + `-- queue` 的 N09 节 | `restoreQueue` 失败恢复分支无法人为构造，只能审阅 + 单测 |
| **L04 浏览器边界** | 权限 / 网络边界 / 下载来源 / Cookie 传递 / DNS 重绑定（`-- browserboundary` 9 节 + 单测 21 条 + 2 张截图） | 真实**账号**登录（需要用户凭证，外部条件）；进程级隔离需单独代理 |
| **L05 变更归属** | 目录级快照 + 改动卡片（`-- workspacechanges` + 单测 33 条 + 2 张截图） | 外部进程改的目录看不到（只能靠并发防线）；`concurrent` 分支基本只能单测触发 |
| **N11 标题 / N16 语言 / N03 工具详情** | 本轮补齐（`-- title` / `-- language` / `toolgroup` 15 条）；**N03 的深/窄窗口截图已补（2026-09-18）**：`toolgroup`（折叠组展开 + 组内行保持一行）与 `toolterm`（终端窗口）两个状态，1440×900 dark 各一张 + 900×520 dark 一张 | 见各项「剩余限制」：标题的候选「忽略」路径只有单测、语言只有两种界面语言的对照（工具详情缺深/窄窗口截图这一条已闭环） |

### 三、安卓远程管理（2026-09-18 新增）

界面与功能规划见 [Android UI 方案](../design/ANDROID-UI-PLAN-2026-09-18.md)：六类页面、移动视觉候选、断线/双端交互与协议依赖已形成设计提案；尚无可交互原型、Android UI 或 APK，工程状态保持下表口径。

| 项 | 当前状态 | 已有证据 | 剩余限制 |
|---|---|---|---|
| **Android 远程管理第一阶段** | **电脑端 API 已落地，Android UI 尚未开始** | `src/main/remote-server.ts` + `src/main/index.ts`；`typecheck`、`build`、`test:unit`（远程协议 14 条）和 `audit:refs` 通过；隔离 Electron 实例实测 `/health`、带 token 的 `/status` / `/sessions`，服务默认不启动 | 当前是 HTTP + SSE、环境变量 token；尚无二维码配对、设备密钥、TLS/中继、Android APK、视觉验收和正式包验收；详见 [REMOTE-CONTROL](REMOTE-CONTROL.md) |

### 四、Git 审查与环境菜单（方案 G1 + G2，2026-09-18）

方案唯一真源：[design/方案-Git审查与环境菜单及插件视觉规划](../design/方案-Git审查与环境菜单及插件视觉规划-2026-09-18.md)
—— 它的 **§16 是评估与落地记录**（源码核查复核、外部条件、已落地的六栏证据、
与方案的偏差及理由）。本节只列**还没做完的**。

**已完成**：D0（字体 / 颜色规范校正）、G1（环境菜单 + 只读 Git 审查：范围选择、
连续逐文件 diff、变更树、筛选、已查看、图片前后对照、未修改区真展开）、
**G2（暂存 / 取消暂存 / 提交 / 切换与新建分支 / 拉取 / 推送，含失败分类与
「提交并推送」两步语义）**。证据见方案 §16.3 与 §16.4。

**G2 的三条硬约束**（改动这一层时别拆掉）：

1. **写操作只在一个文件里**：`src/main/git-actions.ts`。`git-service.ts` /
   `git-diff.ts` 里没有 `add` / `commit` / `switch` / `reset` / `stash`，
   所以「哪些代码能改用户仓库」是一眼可答的问题。**也不要**复用
   `subagent-isolation.collectDiff()`（它会 `git add -A`）。
2. **不覆盖用户改动**：不 stash / reset / clean / force push，**不跳过 hook**
   （不传 `--no-verify`）。脏工作区能不能切分支由 git 自己判。
3. **预期版本按动作分级**（`commit` 全比 / 未指定起点的新建分支只看 HEAD /
   其余不比）。分级不是偷懒：一律全比会造出假冲突（连点两个文件的暂存、
   提交后立刻推送都会被拒），而假冲突的代价是用户学会无视那句提示。

| 阶段 | 状态 | 剩余工作 | 依赖 |
|---|---|---|---|
| **G3 获取远程 / 推送 / PR** | **已做**（2026-09-18） | 推送 / 拉取（G2）、远程比较 + **托管网页比较**、**PR 状态**。PR **没有用 GitHub CLI**：本机实测没有 `gh`（用户也不一定装过、更不一定登录过），而 Yan 已经能发外发请求 —— 直接调 **GitHub REST API**，没有 token 时匿名读公开仓库（实测余量 59），私有仓库 404/403 时如实显示「需要认证」。关联依据是 **`head={远端 owner}:{分支}`**（方案 §7 明确「不能仅按同名分支猜测」，带 owner 才能正确处理 fork），并把 PR 的 `head.sha` 与**本地** head 比一次，本地有未推送提交时明说。状态区分齐全（无关联 / 草稿 / 打开 / 已合并 / 已关闭 + 检查三态 + 五种失败分类）。**只读**：不创建、不合并、不评论。**未做**：GitLab / Bitbucket 的 PR —— 那两家 API 形状不同（不是换个域名就行），方案第一阶段也只要求 GitHub，界面上如实说「本阶段只接了 GitHub」 | — |
| **W1 创建并打开用户工作树** | **已做**（2026-09-18） | 建在仓库旁边的长期目录（关掉砚还在）、三类删除拦截（未提交改动 / 未推送提交 / 有任务在跑）+ 主工作树与 locked 不可删 + **路径必须是 git 登记过的工作树**；创建的五条拒绝（分支已存在不静默复用、目标已存在、目标在仓库内部会变成未跟踪文件…）。创建成功后**登记为项目**（§6.2 要求「可独立打开」）—— 只写 settings.projects，**不**动 cwd、**不**切会话。**未做**：工作树的分组与关联任务 | — |
| **W2 携带未提交改动 + 带会话继续** | **已做**（2026-09-18，按方案允许的降级路径） | 已做：三份内容**分开**迁移（已暂存 → 目标里仍然已暂存、未暂存 → 仍然未暂存、未跟踪 → 按勾选）、二进制与内容逐字节、目标侧**验证应用**（比两侧 diff 摘要）、失败整个回滚、源工作区与 index **一个字节不动**；冲突 / 子模块 / 勾选项过期一律拒绝并解释；另做「**在新工作树开新会话**」。**未做**：完整「带会话继续」要求的重绑定（项目权限 / 相对文件路径 / 附件授权 / 上下文派生）与新会话的**来源关系落盘** —— 这两件没有可靠落点，所以按方案要求只开新会话，界面与按钮 title 都写明「不带走历史、权限与附件授权」，**不显示**「无缝继续」 | — |
| **S1 来源与附件菜单** | **已做**（2026-09-18） | **先做了方案要求的前置核查**：现有附件链**不持久化**（图片是内存 base64、文件只存路径）。所以这一层的第一步是 `main/sources.ts` —— 图片**写到数据目录**（按会话隔离、文件名就是内容指纹，同内容幂等），文件引用**不复制**（只登记路径 + size:mtime 指纹），移除只删**我们自己存的副本**。菜单（环境菜单里的「来源」）三类合并展示 + 筛选：图片缩略图 / 文件名 / 网页标题，带「已关联」与「文件不在了」两态。**不显示「已读取」与「本轮已参与上下文」** —— 方案 §8 说「证据不足时不显示后一状态」，我们证明不了就不显示。**未做**：网页搜索（方案要求「只在已发现兼容搜索能力时启用」，我们没有搜索服务，所以不做）；「定位关联消息」（需要消息与来源的关联落盘，属于后续） | — |
| **P1 / P2 pi 插件目录与包管理** | **已做**（2026-09-18） | **P1**：设置新增「插件」tab —— 目录入口（内置浏览器打开 pi.dev/packages）+ 已装资源列表。**实测结论写在界面上**：目录有 5426 个包、字段齐全，但筛选/排序全在服务端、**没有结构化数据接口**，所以**不做**原生搜索（做了立刻与站点脱节），也不伪造收录状态。**P2**：安装（支持指定版本 `npm:名@1.2.3`）/ 卸载 / 更新，用户级与项目级（`.pi/settings.json`）都支持，列表带包名 / 版本 / 描述 / 来源 / 仓库 / 许可 / 作用域，详情里写**「会执行代码、不做沙箱隔离」**（§9 的硬要求，有 live 断言在读它）。**生效时机**：pi 启动时加载，所以对新会话生效；有任务在跑时主进程直接拒绝。**未做**：`pi config` 那套启用/禁用（它是 TUI，没有非交互入口）—— 需要时应当派一个真实终端，而不是我们在设置里重新实现一遍 | 无 |
| **H1 外部链接关联 / 权威额度入口** | **已做**（2026-09-18） | 额度那一半**本来就已实现**（providerQuota + 只认供应商权威字段 + 失败保留上次成功快照 + 切 provider 清旧账户数字）—— 方案 §6.5 的要求已达到，不需要改。新增：**关联外部任务链接**（存 URL 与标题、按会话隔离、只接受 http/https、在内置浏览器打开），文案按 §6.4 的硬要求写明「不会上传代码、不会同步会话、不会远程执行」。存本地（与「已查看」同样的做法），不做跨设备同步 —— 那要先有账号体系，而我们不显示虚假的登录/同步状态 | — |

### 全量门槛 `npm run check` 的一次记录（2026-09-18，**前提很重要**）

这一轮跑 `npm run check` 有 7～12 个 live 场景红着（两次连跑清单还不一致），
但**那次跑没有设 `YAN_TEST_MODEL`** —— 于是需要真实模型的场景
（`contextsweep` / `contextproduce` / `contextfoldpref` / `contextepisode` /
`subagent` 等）落到免费模型上，配额或供应商状态一抖就红。上面「当前基线」里那条
结论仍然成立且更可信：**设 `YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash` 分批跑完
全部 live 场景后，唯一的红是 `todos`**。

**所以这一节不是"既有失败清单"，别照着它去修**。真正需要记住的是下面两条：

1. **`todos` 的红是产品边界下的陈旧失败** —— AGENTS.md 第五节写明「任务面板保持
   现状」，那条断言描述的是旧设计（进度条推进动画 / 当前那条 active / 行内
   「正在进行」）。**不要为了让场景变绿去改任务面板**；要动就动断言，而且要按
   当前实现重新核对意图。
2. **偶发（批量负载）**：`sessions` / `virtual` 这类单跑即绿，跑全量时因为并发与
   资源紧张会红 —— 先单跑确认，再判断。

这一轮**真正修掉的过时断言**（不是回归）：`narrow` / `resize` / `topbar` /
`panels` / `gitreview` 里关于「48px 紧凑轨」与「没有 gh 就说无法获取」的那几条。
紧凑轨（`.rail-compact`）早已从源码移除，断言还在找它 ——
`railmini` 探针那边甚至有「已彻底移除」的断言，两边的认知原本是矛盾的。

**已知布局遗留（真问题，未修）**：窄窗口（≤1002px）下左栏收起后**稳定停在 48px**
（宽窗口是 0）。查清了不是动画中间值 —— 那是紧凑轨移除时没清掉的那一列宽度。
`narrow` 的断言已改成意图级并**打印实测值**，不让它假装是 0；要彻底修需要动
`rail.css` 的列定义。

⚠️ **跑 Electron 前必须清掉 `ELECTRON_RUN_AS_NODE`**（pi 运行时会注入它）。
注意 `export ELECTRON_RUN_AS_NODE=`（空串）**也算设置了** —— Electron 检查的是
键是否存在，所以只能用 `env -u ELECTRON_RUN_AS_NODE`。带着它 `measure:design`
会报 `does not provide an export named 'BrowserWindow'`（AGENTS.md 里的坑 #2，
这次实际踩到了）。

**G1 / G2 的剩余限制**（不改就是已知行为，不是待办）：

- 审查面板是**右栏的宽档位**，不是主内容区（取舍见方案 §16.4）；宽度不支持拖动
- **没有「按行 / 按块暂存」**（方案 §5.2 的第二版）
- **没有「丢弃工作区改动」** —— 整个 Git 集成里唯一不可恢复的操作，方案 §5.1
  明确要求不覆盖用户改动；要加它先要有「哪些文件会被覆盖」的完整预览与二次确认
- 「已查看」存在渲染端 localStorage（本机有效、不跨设备）；键含仓库 / 工作树 /
  范围 / 两侧内容指纹，内容一变即失效
- 非 Git 目录的界面形态只有数据层与文案覆盖，**没有真实窗口截图**（fixture 的
  cwd 永远是仓库）
- 展开上下文一次最多 300 行，超出只提示还有多少行
- 切换分支的阻断判据是「该 cwd 有 running 的 runner」；**别的进程**（终端里的
  git、编辑器）不受我们控制，只能由 git 自己的 lock / 检查兜住

### 六、核查时新发现的两条真问题（2026-09-18；**不是**方案这一轮引入的）

核查「待办是否全部完成」时逐个跑了红着的场景，分离出两条**真正的缺陷**
（区别于上面那些过时断言）。两条都确认与方案这一轮的改动无关 —— 改动清单里
没有文件树，也没有左栏的列定义。

| 项 | 现象与已查到的线索 | 状态 |
|---|---|---|
| **fs 文件树的键盘导航** | End 没落到最后一个可见节点、3c 节「0 行 tabIndex=0」。**关键线索**：同一节里「Home 回到树根」**是通过的** —— 所以 focusPath → focused → tabIndex 这条链本身是好的，问题在**探针的顺序依赖**：前面的节折叠了目录（或焦点离开了树），那一刻 visiblePaths 只剩根，End 就只落到根上，而 3c 节没先把焦点放回树里。**要修的是探针**（每节开头恢复展开态并先聚焦），不是产品 | 待修（探针侧） |
| **窄窗口下左栏收起的 48px 残留** | 见上一节末尾。宽窗口收起是 0，**窄窗口（≤1002px）稳定停在 48px** —— 紧凑轨移除时没清掉那一列宽度 | 待修（rail.css 的列定义） |

### 五、P3 · 外部条件阻塞（不排期）

代码签名（证书）｜macOS / Linux 包（构建环境）｜扩展 `registerShortcut`（pi 0.85.1 RPC 无枚举/执行接口）｜
`image` 场景视觉验收（需视觉模型）｜Yan 自有账号与跨设备同步（产品与服务端）｜Command Code 月度额度（缺账户权威字段）。

## 当前产品边界

遵循 [AGENTS.md 第五节](../../AGENTS.md)：**任务面板保持现状**；**记忆模块与 `get_tree` 浏览链路不恢复**；
推理块默认展开但限高省略（`--reason-max-h`）且永远保留模型原文；本地档案不冒充登录
（只有 ChatGPT `openai-codex` 能在应用内登录）；深浅主题、设置面板、模型接入、Windows 打包、
内置浏览器与本机 Chrome 接入**都已实现**。
「Yan 自有账号登录」与「ChatGPT 模型接入登录」是两条不同能力，不要混称。

## 更新状态的方法

在对应任务行链接证据，按[工程清单第 6 节](ENGINEERING-CHECKLIST-2026-09-15.md)补齐：
**实现 / 自动检查 / 真实运行 / 视觉验收 / 应用与包 / 剩余限制**。不适用项注明原因；
不能仅凭源码、mock、探针 ok 或旧产物勾选完成。**做完一项就从本页删掉**（明细进归档），
本页只留"现在还没闭环的"。

通用排障经验见 [MAINTENANCE](MAINTENANCE.md)，不再向本页追加「本轮已落地」流水账。
