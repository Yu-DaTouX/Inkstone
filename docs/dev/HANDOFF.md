# 开发交接 · 砚

整理日期：**2026-09-17**。本文是**当前状态与剩余任务的唯一入口**。
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
| 自动检查 | `typecheck` / `build` / `audit:refs` 干净；**单测 1282/1282**（S1 的 `test-context-state.mjs` 78 条 + S2–S6 的 `test-context-transform.mjs`；**2026-09-17 本轮 +14 条**：Tool Sweep 默认开、activePaths 硬约束①、路径提取；**同日 N21-7 再 +20 条**：四层 lookup 优先级 / source 可解释 / 清洗 / 预设；**同日 S7 再 +114 条**（`test-context-producer.mjs`：evidence reducer / 解析清洗 / 合并与 provenance / 防幻觉覆盖 / 裁剪 / freshness 四档 / dirty 与刷新判定 / CAS / **fake ctx 真落盘 + TS schema 交叉校验**））。全量 `npm run check` **最后一次实跑是 71 个场景 69 通过**（2026-09-17 晚，**不含 S1/S2**；`historyswitch`、`contextstate` 与 `contextsweep` 已进 check 列表，下次是 75 个 —— 又加了 `contextproduce`，S7 的真实运行证据） | 失败 2 项都已归因、都与代码回归无关：`todos`（**陈旧失败**：任务面板按产品边界保持现状，AGENTS.md 第五节）、`subagent`（免费模型返回**空文本**：转录里 `assistant` 正文是空串、`status=done`/`error=null`）。另有手动场景 `compactionstatus` **前提过期**：pi 0.85.1 不再按 `reserveTokens` 在回合结束自动压；用改动前的实现重跑同样失败，app 侧压缩链路由 `contexttakeover` 覆盖并通过 |
| 真实运行 | cost 0 场景 + 手动 cost 1 场景 | 上一次全量轮次实跑：`sessions` `historyswitch` `contextbudget` `toolgroup` `fs` `e2e` `tokens` `language` `contexttakeover` `live` `reasoning` `virtual` `logs`。**2026-09-17 S1 轮次**：`contextstate`（真实窗口删会话 → 退出后查派生状态清理）、回归 `trash`（真删 + 撤销）与 `sessions`。**2026-09-17 S2–S6 轮次**：`contextsweep`（cost 1，三个回合：真实 pi 里第二个回合后 sweep 生效 + 模型真的 `context_recall` 取回原文 + 第三个回合确认召回正文被清成存根，见方案 §15.4），同批回归 `contextstate` 与 `trash`；随后用用户指定的 `YAN_TEST_MODEL=commandcode/longcat-2.0:free` 独立重跑并通过（bash 8893、recall `turn=2`、`expiredRecalls≥1`、0 error）。**2026-09-17「清理默认开」轮次**：同一场景改为**不设 `kinds`** 重跑通过 —— 验的就是默认接管集本身（bash 8893、归档 1 条、`ctx://` 指得回原始条目、`swept≥1`、模型真的 recall 取回原文 `tokens=2224`、`expiredRecalls≥1`、0 error），见方案 §15.5。不可用或触顶时备用 `commandcode/laguna-s-2.1-free`。**同日 N21-7 轮次**：`contextbudget`（cost 0）重跑通过 —— 第 7 节真实改设置 → 来源 `user`、界面工作集 = 主进程算的、设置面板回填与恢复默认；同场修正 2 条陈旧断言（`下一步` 应为清理、图例两格已接管）。**同日 S7（状态生成器）轮次**：`contextproduce`（cost 1，**已进 check**）真实通过 —— 真实回合调 bash → 诊断 `stage=producer, hook=committed` 1 次且 0 错误、状态文件 `revision=1` / `objective` 非空 / `commands=1`、下一回合 `injectedTaskState=true`、状态文件过主进程 `loadContextState` 校验；同批回归 `contextsweep`（cost 1，**默认 kinds 下没有 producer 行** —— 验证“默认不花钱”）与 `contextstate` / `contextswitchguard` / `contextbudget`（cost 0）全通过 |
| 视觉 | `npm run visual:matrix` **8 组全绿、40 张截图**（37 个状态 + 3 张引导层） | 组 0/1 重跑（深/浅共 26 张，含 `usageelapsed`）；每张带溢出 ≤ 1px 与关键元素硬断言。**2026-09-17 追加批次**（`STAMP=2026-09-17`）：只重跑受「Tool Sweep 默认开」影响的 3 张 —— `matrix-contextbudget-{dark,light}` 与 `matrix-ctxnarrow-dark`（`YAN_MATRIX_ONLY=contextbudget,ctxnarrow` 跑组 0/1 全绿、溢出 0px）：新图里「下一步」已变成**清理旧工具输出（约 168k 时）**、清理阶段标记为已接管；旧批次（`-2026-09-16`）原样保留。**整组**重跑仍受本机 GPU/Network 崩溃影响（组 0 跑到 10 分钟看门狗），与本次改动无关。**同日 N21-7 追加批次**：`YAN_MATRIX_ONLY=ctxsettings` 跑组 0/1，产出 `matrix-ctxsettings-1440x900-100-{dark,light}-2026-09-17.png`（设置面板「上下文」tab，溢出 0px） |
| 应用与包 | **部分复验（2026-09-17 本轮）** | `npm run dist:dir` 成功；`npm run test:packaged` 全绿（打包内 pi 就绪、`扩展加载没有报错：0`）；`npm run dist:portable-fast` 产出 `release/砚-0.2.0-portable-fast.zip`（169,553,338 B，SHA256 `e722ea45daa29471355f550e9108df1d87fd4151bd3af03b7f53f7c3f76e143b`）；确认 `release/win-unpacked/resources/pi-extensions/` 含 `context.js` / `context-transform.js`。**仍未做**：安装包 / 便携 ZIP 的最终版（P0-8）、SHA256SUMS.txt 更新、便携数据副本升级读取验证 |
| 已知偶发 | 免费模型可能因日配额或供应商状态返回空文本/零 usage；这会让 `tokens` `subagent` `contexttakeover` 等需要真实 usage 的场景变红 | 先用 `YAN_TEST_MODEL=commandcode/longcat-2.0:free`；不可用或触顶时换 `YAN_TEST_MODEL=commandcode/laguna-s-2.1-free`，再分辨「模型当时不可用」还是「代码回归」 |

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

### 一、P0（阻塞发布结论）

| ID | 状态 | 剩余工作 |
|---|---|---|
| **P0-8 / L01 发布门槛** | **部分开始（2026-09-17 本轮）**：`dist:dir` / `test:packaged` 通过，便携 ZIP 已产出并记哈希；**未做**：安装包（`npm run dist`）、`SHA256SUMS.txt` 更新、用 `release/砚数据/` 的**备份副本**做升级读取验证。用户要求放到最后 —— 它依赖所有功能合入，而 N21-5～N21-9 仍有未完成项 |

### 二、P1 · 上下文管理（唯一还缺的大功能）

方案唯一真源：[design/方案-上下文工具内的自动压缩](../design/方案-上下文工具内的自动压缩-2026-09-15.md)
（§12 = 阶段 4 开工契约与验收，§13 = 对外部参考方案的对齐结论）。

> **N21-10（安全规则补三条）已于 2026-09-17 完成**：切成"正在使用的 diff / 用户约束 / reasoning 中间切割"
> 三条硬约束，落地为纯函数 `resources/pi-extensions/context-safety.js` + 42 条单测（**N21-4 直接调它**）。
> 明细见[已完成归档](../archive/2026-09-17-已完成归档.md) §1.7。

| ID | 状态 | 剩余工作 | 依赖 |
|---|---|---|---|
| **N21-4 多阶段与归档** | **✅ S1–S7 已交付并真实验证（2026-09-17）** | S1（State / Archive 基础设施）证据见[方案 §14](../design/方案-上下文工具内的自动压缩-2026-09-15.md#14-阶段-4--s1-落地记录state--archive-基础设施2026-09-17)；
S2–S6 证据见[方案 §15](../design/方案-上下文工具内的自动压缩-2026-09-15.md#15-阶段-4--s2s6-落地记录扩展执行层--recall--降级2026-09-17)：`context` 钩子做 Tool Sweep（墓碑 + `ctx://` 引用）、Task State 前置注入（水位一致才注入）、`context_recall`（预算 / TTL / 审计）、`session_before_compact` 接管闸门（缺字段/无状态一律降级回 pi 摘要），默认**清扫 + 可召回墓碑 + 压缩**（`kinds` 默认 `['tool-sweep', 'recall', 'compaction']`，2026-09-17 用户拍板：清理默认开但保留必要引用；本回合正在动的文件不清扫）。**剩下**：EpisodeState 的语义生成（目前只生成 TaskState，`episodes` 沿用上一版）；增量 delta（现为全量快照）；三阶段独立 Rearm/Cooldown（随 N21-5 状态层）；`symbolsTouched`（需语言级解析，目前为空）；§12.11 第 10 条 20+ 回合压力测试。**另：S7（状态生成器）已于 2026-09-17 落地** —— 混合式（确定性 reducer 提供 files / commands / tests + 一次无工具 completion 产出语义字段，落盘前 reducer 覆盖模型返回的同名字段）、`revision` CAS、freshness 分档（gap 1–2 标 stale / 3–6 丢语义 / >6 不注入）、状态自身预算与裁剪；**默认关**（只在 `kinds` 含 `episode-fold` 时工作）。证据见方案 §17。以下为这批交付前的描述（供回溯）：EpisodeState / TaskState 的语义生成器（**扩展内即可完成** —— 方案 §16.1 更正了「扩展侧没有推理 API」的误判：`agent_settled` 事件 + `ctx.modelRegistry.complete()` 就能跑一次无工具归纳；实施级契约（coordinator/CAS/freshness/预算与裁剪/dirty 阈值/注入切分）见**方案 §16.6**，由第三轮外部评审经内置浏览器对话取得并经源码核查；开工前的三项待决中**第 1 项已定**：复用已验证的浏览器 loopback bridge 落盘，见方案 §16.6.3）、三阶段独立 Rearm/Cooldown（随 N21-5 状态层） | N21-3（已完成） |
| **N21-5～N21-9 状态化压缩** | **N21-5 已交付（状态生成器，2026-09-17）**；N21-7 已完成；N21-8 / N21-9 未开工 | 任务表见 [PRIORITY 的 P1c 节](PRIORITY-2026-09-15-未完成排期.md)。**③ 阈值可配 + 模型级 override 已落地**（N21-7，见[归档 §1.8](../archive/2026-09-17-已完成归档.md#18-n21-7-上下文阈值可配置化--模型级-override2026-09-17已完成)：lookup `env > model(provider/model) > provider > user > default`、设置面板「上下文」tab、`contextbudget` 第 7 节 + 20 条单测 + 两张 `ctxsettings` 截图）。**剩余**：① 增量 delta 更新（目前每次产出全量快照）；② `episode-fold` 是否进默认接管集（生成器已落地但默认关，见方案 §17.4 第 5 条）；④ Deep Context Mode 默认关闭、开工前先做两项前置调查（其中「扩展侧到底能不能自己调模型」已在方案 §16.1 更正并核实）。**需要用户拍板的三点在 §13.5**；外部评审提的改进项（字段级 freshness、ancestry + 有界陈旧、富墓碑等）已登记在方案 §16.2（**待评估、未排期**）；用户已同意「必要时多一次无工具 completion」，其可控方案（智能调用 / 手动调用 / 开关、信号与默认值）在方案 §16.4，**四个待拍板点在那里**；另有一轮**本机 Codex** 的第三方核对（一致处与分歧见方案 §16.5，它额外指出 TaskState 自适应裁剪、生成器重入/迟到结果 CAS、归档回滚三项硬要求） | N21-4；用户拍板 |

### 三、P2 · 已取证项的尾巴（都不阻塞主链路，可批量补）

| ID | 已取证的部分 | 还差什么 |
|---|---|---|
| **N12 会话运行** | 切走不停 / 切回不串 / 同 cwd 拒绝 / 单独停止 / 退出落盘（`-- sessionab`、`-- sessionrunners`） | 等待输入 / 失败 / 未读三种后台状态的**真实窗口**证据；退出变体（保存 / 中断 / 取消 / 重复）；「无孤儿进程」的独立进程表观测 |
| **L03 子代理审阅** | 并发矩阵、冲突、只读封堵、退出归档与无残留（`-- subagentpair` + 单测） | 模型自身失败 / 超时的恢复（10 分钟上限目前只有代码审阅 + 单测）；孤儿进程表观测 |
| **N04 推理流** | 注入矩阵完整（含 reduced-motion）、`-- reasoning` | 真实带 thinking 模型的**长中英文混合**推理流截图 |
| **N10 自主模式** | 开关 / 落盘 / 边框动画名（`-- autonomous`）+ 四相位截图 | 光带**运行中**的静态截图（需一条真实长任务在跑） |
| **N18 命令菜单** | `-- slashcmd` 15 节（筛选 / 滚动 / 光标 / 同名不同来源 / 输入法 / Esc / 未连接） | 逐命令的**真实执行反馈**（`/new` `/compact` `/browser` 无参/带 URL、成功与失败、后台作用域）；运行时技能的**真实发现** |
| **N19 `@` 引用** | `-- atpathedge`、`-- atrefsend`（真实发送 + 模型读到文件） | 已随本轮 `fileincontext` 补上同场景截图；无其它缺口 |
| **N20 首次引导** | 三张引导层截图（深/矮/浅） | 点击回路目前只有探针证据（`-- onboarding`） |
| **N05 项目切换** | `-- projectswitch`（草稿按实例隔离、权限目录） | 「每个项目最后一个会话」持久化（否则空闲实例被回收 + 会话未落盘时草稿只能丢）——属新功能 |
| **N09 队列撤回** | `-- queueretract` + `-- queue` 的 N09 节 | `restoreQueue` 失败恢复分支无法人为构造，只能审阅 + 单测 |
| **L04 浏览器边界** | 权限 / 网络边界 / 下载来源 / Cookie 传递 / DNS 重绑定（`-- browserboundary` 9 节 + 单测 21 条 + 2 张截图） | 真实**账号**登录（需要用户凭证，外部条件）；进程级隔离需单独代理 |
| **L05 变更归属** | 目录级快照 + 改动卡片（`-- workspacechanges` + 单测 33 条 + 2 张截图） | 外部进程改的目录看不到（只能靠并发防线）；`concurrent` 分支基本只能单测触发 |
| **N11 标题 / N16 语言 / N03 工具详情** | 本轮补齐（`-- title` / `-- language` / `toolgroup` 15 条） | 见各项「剩余限制」：标题的候选「忽略」路径只有单测、语言只有两种界面语言的对照、工具详情缺深/窄窗口的单独截图 |
| **N01 拖拽排序（P2-7）** | 分组 / 排序 / 落盘已有；**拖拽本身没有实现** | 当**新功能**做：项目与分组顺序拖拽 + 落盘，与「前五项折叠」、搜索态互斥 |

### 四、P3 · 外部条件阻塞（不排期）

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
