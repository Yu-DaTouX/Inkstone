# 开发交接 · 砚

整理日期：2026-09-15（**最近一次真实执行与回写：2026-09-16**）。本文是**当前状态与剩余任务的唯一入口**。工程标准看[工程清单](ENGINEERING-CHECKLIST-2026-09-15.md)，架构与依赖看[实施方案](实施方案-2026-09-15.md)。

## 接手顺序

1. 阅读根目录 [AGENTS.md](../../AGENTS.md)，检查 `git status --short`，保留已有改动。
2. 从下表选择一组任务；用 [PROJECT](../PROJECT.md) 和 [CODE-MAP](CODE-MAP.md) 定位实现。
3. 按 [TESTING](TESTING.md) 做相应检查，在下表登记证据；打包按 [RELEASING](RELEASING.md)。

## 当前结论与证据

会话运行缓存、实例注册表、底座缺陷与多个验收矩阵已有实现与证据；**方案仍未全部完成**，剩下的都列在下面的“尚未完成的工作”里。本表只反映**最近一次真实执行**的结果（2026-09-16）；具体命令与输出见本节末尾的补充段。

| 范围 | 最近已有记录（2026-09-16） | 尚不能证明 |
|---|---|---|
| 底座缺陷 D1–D5 | D1–D5 修复那一轮单测 573/573；`test:live -- runnerselect`（含 D5 断言，已反向验证）、`-- subagent`、`-- subagentpair` 均通过 | 真实机器上的长时压力（本机有用户的实例在跑，未做进程表全扫） |
| 自动检查 | `typecheck` / `build` / `test:unit` **659/659**；`audit:refs` 干净（CASES 85 探针、i18n 598/598 平衡）；`npm run check` 70 个场景 **68 通过**（见下方失败备注） | 后续源码改动仍需重跑；`todos` 稳定失败，`sessionab`（模型回合落盘）与 `reasoning`（逐字流）偶发，均与本轮改动无关 |
| Electron | `test:live` 已跑通：crash、slashcmd、reasoning、projectlimit、modelmenu、queuestack、queueretract、workspacechanges、live、sessionab、modelswitch、atrefsend、queue（真实模型）、fsedge、atpathedge、projectswitch、sessionrunners、runnerselect、fs、atPath、sessionlayout | 需要模型额度的批次与需要外部条件的项（见“尚未完成的工作”表） |
| 视觉 | `npm run visual:matrix` 8 组全绿、**26 张真实窗口截图**（3 尺寸 × 3 缩放 × 深浅 + 引导层 + 窄右栏文件树 `fsnarrow` + shell 改动卡片 `wschanges`/`wsunknown`），存 `docs/design/preview/matrix-*-2026-09-16.png`；历史截图与窗口测量见 [CODE-MAP §11](CODE-MAP.md) | 回收站通知的静态截图；真实模型长推理流的截图 |
| 应用与包 | 交接记录中的 launcher、dist:dir、test:packaged 曾通过 | 最终源码对应的安装包、便携 ZIP、升级数据副本和 SHA256（L01） |
| 限制 | 图像理解、站点登录、签名与跨平台仍有模型或外部条件限制 | 不将界面接线通过视为真实能力通过 |

具体输出和该轮边界见[自验证报告](自验证报告-2026-09-15.md)。早期阶段记录见[首轮实施记录](../archive/2026-09-15-engineering-first-pass.md)，其中“未开始 / 阻塞”仅代表当时。

**2026-09-15 晚补充**（本轮实际执行过）：`npm run build` 后 `test:unit` 524/524 通过；`test:live -- autonomous` 通过（开关、落盘、边框状态、动画名）；自主模式光带改为沿边框顺时针并用四相位截图取证（`docs/design/preview/autonomous-border-phases-2026-09-15.png`）。自主模式的模型侧行为已有 `scripts/test-question.mjs` 覆盖（系统提示随模式切换 + 自主模式下不弹 UI）。

**2026-09-16 补充**（本轮：底座缺陷 + L02/N19/L03 + N12 + 视觉矩阵 + P2 小修 + N02/N04/N07/N17/N18 + D14–D18）：

- **D1–D5**：`test:live -- runnerselect`（新增 D5 断言，已反向验证）与 `test:live -- subagent` 通过；新增 `scripts/test-subagents.mjs`（注入假 RPC，不花额度）覆盖并发槽位、上下文代次、只读白名单、退出归档。
- **L02 + N19**：test-live 支持场景级 cwd + 合成 fixture 项目（含一个最小 git 仓库），新增 `test:live -- fsedge atpathedge`；探针顺带发现并修掉 D14。**2026-09-16 续做（L02 收尾）**：fixture 增加真实无权限目录（`icacls /deny <用户>:(RD)`，只 deny 读取、可复位）+ 超长中文名；`fsedge` 从 5 节扩到 8 节（无权限看 `permission` 而不是「空」、220px 窄右栏不横溢/超长名省略但 `title` 给全文/分页仍可用、与内置浏览器共存不重叠不挤掉），`atpathedge` 补 `completePath('noperm/')` → `permission`；顺带修掉窄栏深层缩进把图标顶出右边界（`--fs-indent` + CSS 上限）；视觉矩阵新增 `fsnarrow` 状态（截图 `matrix-fsnarrow-1440x900-100-dark-2026-09-16.png`），全量 24 张。
- **L03**：新增 `test:live -- subagentpair`（真起两个以上 pi 子进程写各自 worktree，合并/放弃/同一行冲突/只读封堵/后台存活/退出归档/无残留），退出后的证据由 test-live 的 `afterExit` 在 Electron 关闭后直接查文件系统与主工作树；顺带修掉 D15（toolResult 回填 + 消息 id 稳定）与 D16（结束后收进程）。两个修复都做过反向验证。
- **N12**：新增 `test:live -- sessionab`（真实 A/B/C 三会话）。试跑时纠正了 test-live 一个长期误解：`delay` 是“窗口显示后等多久才执行探针”，不是探针预算 —— 于是给长场景把 delay 设成 5 分钟的场景其实是在**白等**。现在探针预算由 `budget` 单独给，`subagentpair` 从 275s 降到 51s，`sessionab` 22s；`sessionab` 已进 `npm run check`。
- **视觉矩阵**：新增 `npm run visual:matrix`（`scripts/visual-matrix.mjs` + 分组跑批的 `visual-matrix-run.mjs`），出 24 张真实窗口截图（3 尺寸 × 3 缩放 × 深浅 + 引导层 + 窄右栏文件树 `fsnarrow`），存进 `docs/design/preview/matrix-*-2026-09-16.png`（新名，不覆盖已有预览图）。每个状态都带硬断言：横向溢出 ≤ 1px、关键元素必须真的在 DOM 里。覆盖 N02/N04/N07/N13/N14/N15/N17/N20 的视觉项；发现并记录了 D10 的视觉证据（思考强度提示重复两遍）。
- **P2 小修（D8/D9/D10/D12）**：新增 `test:live -- crash`（已进 check）、`src/main/queue-items.ts` + 单测 18 条、模型菜单的短状态词与「未配置」徽标；`test:live -- queue`（真实模型）与 `-- modelmenu` 通过。
- **N18 命令矩阵**：`test:live -- slashcmd` 从 7 节扩到 15 节（筛选 / 滚动 / 光标进参数区 / 同名不同来源 / **输入法组合态** / 未连接 / Esc）；矩阵顺带发现并修掉 D17（组合态 Enter 被当成菜单确认）与 D18（Esc 关不掉命令菜单）。
- **N02 模型能力**：新增 `test:live -- modelswitch`（真实 pi、81 个模型、只切不发 → cost 0，已进 check）：档位跟随模型、快速连切后发的落地、切到不支持推理的模型档位清空、图像输入模型的 `input`/`contextWindow` 跟着走、`contextUsage.modelKey` 与当前模型一致。
- **N19 真实发送**：新增 `test:live -- atrefsend`（真实模型 + `afterExit` 直查会话 JSONL）：引用原样随消息发出、后文不被吃掉、**模型按路径自己读到了文件内容**；查清并记录 RPC `prompt` 不展开 `@路径` 的语义。
- **N04 / N07 / N17**：`reasoning` 补 `prefers-reduced-motion` 下直接给全文；`N07` 把所有设置写入点按 key 走查完（各只有一处 UI 入口）；`projectlimit` 补“顺序与分组真的落盘（主进程重读）”。
- **基线**：`typecheck` / `build` / `test:unit` 659/659。
- **N05 项目切换**：新增 `test:live -- projectswitch`（已进 check）：文件树/视图跟着 cwd 走、草稿按运行实例隔离（切走再切回原样恢复）、附件绝对路径不被改写、不存在的目录被拒且视图不动、无权限目录不假装能读；单测 `test-project-session.mjs` 9 条。顺带修两个缺陷：选会话抽成 `pickProjectSession`（运行实例优先，避免“刚建会话未落盘”时新建空会话把草稿弄丢）、**D19**（文件树被丢弃的旧请求不清 loading → 永久「正在读取目录…」）。
- **N09 队列撤回**：新增 `test:live -- queueretract`（cost 0、进 check：撤回不存在的 id / 连续撤回 / 并发撤回都不谎报成功、队列快照不被连带清掉）；`queue` 场景补 N09 节（真实模型）：四路并发入队 id 互不串、同文本两条都保留、对同文本撤回要么只少一条要么明确报“已被接收”。注：`reclaimedTexts`/`consumeQueuedItem` 的 FIFO 语义早由单测 18 条覆盖。
- **`npm run check`（L05 这轮，70 个场景）**：**68 通过**。失败两条：`todos`（陈旧失败，与文件树 / 项目切换 / 快照都无关）与 `sessionab`（**偶发**：断言“A 的会话文件里多了模型自己的回合（被中断也算落盘）”，取决于真实模型在被中断前是否真的落了回合；上一轮全量跑时它是通过的）。`reasoning` 本轮全量跑未复现偶发（上一轮失败、单跑 1436/1436）。三条都不碰本轮改动面（L05 改的是主进程快照与工具行内的一个子块）。排查时先看工作区中其它未提交改动（任务面板、消息分段、推理流）。
- **L05 变更归属（本轮，P1-7）**：shell / 第三方工具的目录级改动。主进程 `snapshots.ts` 新增 `captureTree`/`diffTrees`/`beginTreeSnapshot`/`endTreeSnapshot`（同步 fs，跳过依赖目录，文件数 4000 / 深度 12 / 内容预算 12MB 上限）；`isShellTool` 与渲染端 `detailKind('command')` 名单对齐。接入两处：模型调的 `bash` 工具（`tool_execution_start/end`）与**直执行 shell**（`window.yan.runBash` → `finishBash`）—— 后者让这个能力有了**不花额度**的真实窗口证据。界面新增 `WorkspaceChangesDetail`（终端窗口下方的改动卡片）。顺带发现并修 **D20**（`busy()` 不算直执行 shell：正在跑命令时切换会复用到同一实例，新会话直接报“已有一条命令在跑”）。

### 本轮已完成（逐项标注）

| 项 | 状态 | 关键证据 |
|---|---|---|
| **D1–D19**（清单外缺陷） | ✅ 全部已修（D1–D16 + D17 IME / D18 Esc / D19 文件树卡 loading） | 单测 659/659；各 live 探针见下；D5/D16/D19 做过反向验证 |
| **D20**（L05 时新报） | ✅ 已修 | 单测 4 条（`test-runners.mjs` 新增“直执行 shell 也算忙”）+ `test:live -- workspacechanges` 第 8 节 |
| **L02 文件树** | ✅ 已取证（本轮补齐：Windows ACL 无权限目录、220px 窄右栏、与内置浏览器共存） | `test:live -- fsedge`（8 节）+ 截图 `matrix-fsnarrow-1440x900-100-dark-2026-09-16.png` |
| **N05 项目切换** | ✅ 已取证（本轮） | `-- projectswitch`（进 check）+ 单测 9 条（`test-project-session.mjs`） |
| **N09 队列撤回** | ✅ 已取证（本轮） | `-- queueretract`（cost 0、进 check）+ `-- queue` 的 N09 节（全真实队列，cost 1）；单测 18 条覆盖 FIFO 纯逻辑 |
| **L05 变更归属** | ✅ 已实现并取证（本轮） | `-- workspacechanges`（cost 0、进 check）+ 单测 33 条 + 2 张视觉截图 + D20 |
| **N12 会话运行** | 已取证（剩：等待输入 / 失败 / 未读的真实后台状态、退出变体、孤儿进程的表观测） | `-- sessionab`、`-- sessionrunners` |
| **L03 子代理审阅** | 已取证（剩：模型自身失败/超时恢复、孤儿进程的表观测） | `-- subagentpair` + `test-subagents.mjs` |
| **N02 模型能力** | 已取证 | `-- modelswitch`（进 check）+ 视觉矩阵 |
| **N04 推理流** | 已取证（剩：真实带 thinking 模型的长推理流截图） | `-- reasoning`（含 reduced-motion） |
| **N07 设置收敛** | ✅ 已走查完（未发现第二处写入路径） | 见“尚未完成的工作”表里的 N07 行（按 key 汇总） |
| **N08 / N13 / N14 / N15 / N17** | 已取证（剩：回收站通知静态截图） | 视觉矩阵 + `-- railtitle` / `-- railsearch` / `-- trash` / `-- railmini` / `-- projectlimit` |
| **N17 项目顺序** | ✅ 已取证（顺序与分组归属真的落盘） | `-- projectlimit` |
| **N18 命令菜单** | 已取证（剩：逐命令真实执行反馈、技能真实发现） | `-- slashcmd`（15 节） |
| **N19 @ 引用** | 已取证（剩：与文件树同场景的截图级证据） | `-- atpathedge`（含无权限目录的 `permission` 断言）、`-- atrefsend` |
| **N20 首次引导** | 视觉已取证（点击回路仍靠 `-- onboarding`） | 视觉矩阵的 3 张引导层截图 |
| **视觉矩阵（本批）** | ✅ 8 组全绿、26 张截图 | `npm run visual:matrix` |

N06（取消双击项目名重命名）保留首轮实现，未列入新增待办；证据范围见首轮记录，最终集成回归仍需覆盖。

## 当前产品边界

遵循 [AGENTS.md 第五节](../../AGENTS.md)：任务面板保持现状；记忆模块与 get_tree 不恢复；推理限高显示最新内容且保留模型原文；本地档案不冒充登录。工具库只用按钮收放和排序，拖动排序限工具栏内部。Yan 自有账号与 ChatGPT 模型接入登录是两条不同能力。

## 尚未完成的工作

状态含义：**未完成**＝仍缺实现或接入；**部分完成**＝已有实现或检查但未补齐验收；**待视觉验收**＝仍缺目标窗口证据；**外部阻塞**＝需要模型、证书、目标系统或上游接口。

### 一、下一轮应优先处理的 P0/P1 任务

| ID / 优先级 | 状态 | 接手任务 | 完成标准与证据 |
|---|---|---|---|
| **L02 文件树** / P1 | ✅ 已取证（2026-09-16 补齐无权限目录 / 窄右栏 / 浏览器共存） | 已取证：空目录、失效路径、把文件当目录、越界、目录联接（进「已隐藏」名单）、五级目录缩进、中文空格路径预览、同名文件身份与加入上下文、大目录 50 一批分页与「显示更多」、无横向溢出。实现（单击只读预览、“加入上下文”独立动作、`role=tree/treeitem`、方向键、请求绑定 `cwd+generation+projectId`、切项目清缓存、搜索 requestId/取消）不变。 | 已取证（本轮补齐）：真实**无权限目录**（`icacls /deny <用户>:(RD)` 造出，主进程给 `permission`、界面给「没有读取权限」，不是「空目录」）、**220px 窄右栏**（`PANEL_MIN`：行不横溢、超长名省略且 `title` 给全文、分页与「显示更多」仍可用；顺带修掉深层缩进顶出右边界）、**与内置浏览器共存**（右栏上下分区不重叠、文件树不被挤掉、开关能还原）。证据：`test:live -- fsedge`（8 节）+ `npm run visual:matrix` 24 张全绿（含新增 `fsnarrow` 状态）；截图 `docs/design/preview/matrix-fsnarrow-1440x900-100-dark-2026-09-16.png`。**应用与包**：留待 P0-8（L01 发布门槛）统一复验，本轮未重打包。 |
| **N12 会话运行** / P0 | 已取证（运行中切换/同 cwd 拒绝/单独停止已跑通；剩等待输入/失败/未读与退出变体） | `test:live -- sessionab`（三个真实会话：A=cwd `repo`、B=cwd `other`、C 与 A 同 cwd；模型用 `deepseek-v4.1-flash`）覆盖：A 发一个 `sleep 90` 工具任务真的跑起来 → 切到 B（不同 cwd 允许）**且 A 仍在跑**、B 视图里没有 A 的内容 → 切到 C（同 cwd）给出「同一工作目录已有运行中的会话」且视图不跟着走、A 不受影响 → 切回 A 内容不丢不串 → 左栏菜单「停止运行」只停 A。退出后由 `afterExit` 直查会话文件：A 的记录里真的有那次工具调用、B/C 的回复各归自己（同 cwd 被拒的那次没写坏 C）。渲染端身份的已有证据是 `test:live -- sessionrunners`（注入后台实例推送，不连 pi）。 | 剩余：等待输入 / 失败 / 未读三种后台状态的真实窗口证据（目前只有 `sessionrunners` 的状态槽断言）；退出变体（保存退出 / 中断退出 / 取消 / 重复退出）与“无孤儿进程”的独立进程表观测。 |
| **L03 子代理审阅** / P1 | 已取证（真实并发矩阵已跑通；剩失败恢复/超时与独立进程观测） | `test:live -- subagentpair`（真起两个以上 pi 子进程，模型用 `deepseek-v4.1-flash`）覆盖：并发槽位与第三个被拒、两个独立 worktree 互不相交、合并前主树无产物、差异归属只含自己的文件、合并后主树出现该文件、放弃后主树干净且留补丁、**同一行冲突**（先合并者留、后者 `conflict` 且不半截写入）、只读子代理 `--tools` 封堵（`Tool write not found` + 主树无文件）、运行中切查看对象不断后台、退出时未审阅的改动归档为 `archived`、退出后 temp 无残留隔离目录（`afterExit` 在 Electron 关闭后直查文件系统）。单测 `test-subagents.mjs` 覆盖策略层。反向验证：临时关掉“等安静 + 收进程”后，该场景的残留断言确实变 ✗（4 个 worktree 残留）。 | 剩余：模型自身失败/超时的恢复（10 分钟上限靠代码审查 + 单测）；“无孤儿进程”的独立进程表观测待做（本机有真实实例在跑，不适合扫全进程表）。 |
| **L01 发布门槛** / P0/P1 | 部分完成 | 用 `release/砚数据/` 的备份副本做升级读取验证，严禁改原目录；所有功能合入后重新跑 launcher、目录包和包内启动；按实际发布范围生成安装包、便携 ZIP 和 SHA256，并分别记录未签名、平台和证书状态。 | 历史基线中的 `dist:dir` 与 `test:packaged` 已通过，内置 pi 0.85.1、包内路径和扩展加载均正常；尚需最终源码的发布复验、便携数据升级副本、安装包/ZIP/SHA256 和签名/跨平台证据。 |

### 二、已有实现但仍需补真实验收或功能闭环的 P1/P2 任务

| ID | 当前状态 | 具体剩余工作 |
|---|---|---|
| **N01 分组** | 已取证（拖拽排序**不存在**，不是验收缺口） | 分组新建/重命名/解散已有实现（`test:live -- grouprename`）。**已验**：项目顺序与分组归属落盘（`-- projectlimit` 现在会去主进程重读设置）、多项目搜索不受 5 项折叠限制、折叠/展开与当前项目自动展开、滚动位置不被搜索改动、窄栏视觉（视觉矩阵 `matrix-railmini-*`）。⚠️ **拖拽排序项目没有实现**（代码里没有 reorder/drag 相关处理）—— 若要就要当作新功能做，不要再列成“验收未做”。 |
| **N02 模型能力** | 已取证（真实切换矩阵已跑通） | 能力快照已区分 unknown / unsupported / 可用；新增 `test:live -- modelswitch`（**真实 pi、81 个模型、只切模型不发消息 → cost 0，已进 check**）：切到另一个模型后档位跟随它、**快速连切时后发的落地（迟到响应被丢弃）**、切到不支持推理的模型后档位清空为 `["off"]`（不残留上一个的 `low/high/max`）、图像输入模型的 `input` 与 `contextWindow` 都跟着模型走、`contextUsage.modelKey` 与当前模型一致（旧 token 快照不冒充）。视觉：`matrix-modelmenu-*`（含未配凭证徐标与短状态词）。 剩余：带真实对话的跨模型统计对比（需要发消息，已用 `tokens`/`e2e` 覆盖同一模型下的统计）。 |
| **N03 工具详情** | 部分完成 | 默认收起和失败工具入口已有实现；仍需用长输出、并行工具、历史消息、滚动阅读和深浅/窄窗口确认展开状态不抢焦点、不跳动、不出现第二滚动条。 |
| **N04 推理流** | 已取证（注入矩阵完整；真实模型的推理文本由 `deltas`/`tokens` 覆盖） | 口径已于 2026-09-15 由用户变更：**推理默认展开但限高省略**（`--reason-max-h` = `min(32vh,260px)`，裁掉开头 + scrollTop 贴底显示最新 + 顶部 mask 渐隐 + 「展开全部」出口）。`test:live -- reasoning` 现覆盖：流式逐字（字素不截断 emoji）、裁剪/贴底/渐隐/展开收起、内容增长时高度钉住、**思考→工具→思考→回复**、回合结束自动折叠并保留预览与开关、短推理不淡化、**无推理不占位**、**prefers-reduced-motion 下直接给全文**（不逐字等）。视觉证据：`matrix-reasoning-*`。 剩余：真实模型（带 thinking）的长中英文混合推理流；“上滚看历史”不适用 —— 限高态是 `overflow:hidden` + 程序贴底，用户本来就滞不动它，历史全文走「展开全部」。 |
| **N05 项目切换** | ✅ 已取证（2026-09-16） | 新增 `test:live -- projectswitch`（已进 check）：视图与文件树跟着 cwd 走、**草稿按运行实例隔离**（切走再切回原样恢复）、附件绝对路径跨项目不被改写、不存在的目录被拒且视图不动、无权限目录不假装能读（Windows 上 `access(R_OK)` 不做真实读取，切过去后文件树给「没有读取权限」而不是「空目录」）。实现侧顺带修两处：选「该项目最近访问的会话」抽成纯函数 `pickProjectSession`（**运行实例优先**，避免“刚建会话没落盘”时新建空会话把草稿弄丢）+ **D19**（文件树旧请求丢弃后不清 loading，偶发卡在「正在读取目录…」）。**剩余限制**：空闲实例会被回收、会话又还没落盘时（新建会话没发过消息就切走），没有任何东西可切回去，草稿只能丢 —— 要根治得把「每个项目最后一个会话」持久化，属新功能，未做。 |
| **N07 设置收敛** | 已走查（一致性复核已完成） | `StatusTab` 已改为只读诊断（会话/模型/上下文用量/工具·轮次·成本），无可写重复控件；自动压缩只在 `RightPanel` 压缩区、自动重试只在右栏状态区各有一个入口。**2026-09-16 逐项走查**（把所有 `patchSettings` / `setAutoCompaction` / `setAutoRetry` / `setUiScale` 调用点按 key 汇总）：`autoCompaction`、`autoRetry`、`toolDetail`、`sendKey`、`density`、`sound`、`responseDetail`、`autonomous`、`projectNames`、`projectGroups` 各自只有**一处** UI 入口；`streamWidth` 在设置页内是“选一个值 / 重置为 0”两个动作（同一控件组）；`browserHeight` 是拖拽与关闭归零（同一控件）；`theme` 多出的那一处是 `App.tsx` 把主题**回写**设置的副作用（唯一用户入口在设置页），`lang` 同理。视觉部分由 `npm run visual:matrix` 覆盖。 不适用（未发现第二处写入路径）。 |
| **N08 / N13 / N14 / N15 / N17** | 已取证（视觉矩阵 + 探针断言齐） | 模型菜单、窄栏标题、mini 项目栏、回收站通知、项目前五项折叠已有代码/探针基础。**视觉矩阵**：`npm run visual:matrix` 出了模型菜单、迷你项目栏、主界面在正常/窄/矮 + 深浅 + 125%/150% 下的截图。**探针**：`railtitle`（超长中文标题在 210px 窄栏下被省略且 `title` 里能给全文、五层会话行缩进递减）、`railsearch`（入口/焦点/命中/清空后焦点归还）、`trash`（通知条 30s 计时、窄栏下不超宽、撤销按钮不裁不重叠、`role=status`、关闭按钮有无障碍名）、`railmini`（mini 栏只放前五个、不撑破、溢出走浮层）、`projectlimit`（默认 5 个 / 展开 / 搜索不受限 / 滚动位置不变，**新增：顺序与分组归属真的落盘**）。 剩余：回收站通知的**静态截图**（几何与文案已由 `trash` 场景断言）；若后续加“拖拽排序项目”，需要单独的视觉与落盘证据。 |
| **N09 队列撤回** | ✅ 已取证（2026-09-16） | 新增 `test:live -- queueretract`（**cost 0、进 check**）：撤回一个 pi 里不存在的 id（= “刚被消费”那条分支）→ 明确报「已被接收或撤回」、**不谎报成功**、不往草稿塞文本、队列快照不变；连续撤回同一 id；两条并发撤回都被串行化处理（不互锁）。新增 `test:live -- queue` 的 N09 节（**真实模型，cost 1**）：四路并发入队每条都有独立 `queueId` 且互不串；同一句话两次入队都保留（两条独立对象）；对同文本撤回一条时 —— 撤掉了就只少一条（FIFO），被拒就明确报“已被 pi 接收”且快照保持原样（不连带清掉）。**剩余限制**：“refill 失败后恢复原队列”这条分支（`Agent.restoreQueue`）无法人为制造，只能靠代码审阅 + 单测。 |
| **N10 自主模式** | 已取证（缺一条光带运行中的静态截图） | 开关、文字/图标区分已有。**2026-09-15 修复**：光带原用 `conic-gradient` + `transform: rotate()`，那是绕中心的角度插值 —— 在宽扁输入框上长边一闪而过、短边几乎停住，与边框形状不匹配，即用户报的“光效有位置问题”。现改为 `offset-path: rect(...)` + `offset-distance`，沿 padding box 周长按弧长匀速顺时针运动（`offset-rotate: auto` 让拖尾指向运动方向）；减少动画偏好与不支持 `rect()` 的运行时退化为静态强调色边框。四相位视觉证据：`docs/design/preview/autonomous-border-phases-2026-09-15.png`。仍需：关闭瞬间、任务运行中、长文输入不改变尺寸的真实窗口证据。 **已验**（2026-09-16）：`test:live -- autonomous` 覆盖开关、落盘、边框状态与动画名；视觉矩阵的 15 张主界面截图里都能看到输入区下方的自主模式开关（默认关）。剩余：光带**运行中**的静态截图（需要一条真实长任务跑着时截）。 |
| **N11 标题** | 部分完成（入口与实现已具备） | `Rail.tsx` 会话菜单已有“重新生成标题”→ `store.regenerateTitle` → 主进程 handle；`title.ts` 已有目标 sessionId、候选生成→采用、手动标题保护与缓存。仍需真实模型场景确认只发送首条/最近用户文本、单次生成锁、失败保留旧标题、显式重试，以及不因切会话/刷新列表重复生成。 |
| **N16 语言** | 部分完成 | 新 runner 的语言提示和不重启现有会话已有；仍需用实际中英文模型输出验证新会话语言、旧会话不中断、切换后不误停后台任务。 |
| **N18 命令菜单** | 已取证（矩阵已补齐，剩逐命令的真实执行反馈） | 本地 `/login`、`/new`、`/compact`、`/model`、`/browser`、`/subagent` 已接入，兼容命令可见但禁用；`test:live -- slashcmd` 现覆盖：列表自动重拉、用过优先、来源分类、兼容命令禁用、Enter/Tab 填入且带尾空格、按键说明可见、`/model` 与 `/login` 路由不发给模型，**以及本轮补的**：按名/按说明筛选、超 12 项可滚动且不越出窗口上沿、光标进参数区不把参数当命令名、同名不同来源不互相覆盖、**中文输入法组合态不吞 Enter**（D17）、**Esc 能关掉菜单且不改输入**（D18）、未连接时本地命令仍可执行。 剩余：逐命令的真实执行反馈（成功/失败/后台作用域、`/browser` 无参数/带 URL、`/new`/`/compact` 实际动作），以及运行时技能的**真实发现**（不能把技能目录存在当成已接入）。 |
| **N19 @ 引用** | 已取证（真实发送已跑通，剩无权限目录） | 裸 `@` 根层菜单、单字符、光标范围、中文/空格/引号/Windows 路径、cwd 身份绑定和越界保护已有；2026-09-16 新增 `test:live -- atpathedge`：多级目录（五层）、中文+空格候选与自动引号、同名文件不混淆、大目录 30 条截断（`truncated`）、引号前缀、句中光标与多引用只替换光标所在段、切 cwd 后迟到候选归属（旧 cwd 候选不会留在菜单里）。**真实发送**：`test:live -- atrefsend`（真实模型，`afterExit` 直查会话 JSONL）—— 补全选中后引用以 `@README.md` 原样随消息发出、后文不被吃掉、**模型按路径自己读到了文件内容**。⚠️ 审计到一条语义差异：pi 的 RPC `prompt` 只有 `message`/`images`/`streamingBehavior`，**不会展开 `@路径`**（展开是 CLI 参数层 `pi @file "..."` 的行为）；砚的文案写的是“附件文件，可直接读取”与行为一致，不承诺“内容已入上下文”。 剩余：与 L02 文件树“加入上下文”统一的同场景截图级证据（**无权限目录已取证**：`atpathedge` 断言 `completePath('noperm/')` → `permission` 且不返回候选）。 |
| **N20 首次引导** | 视觉已取证（点击回路仍靠探针） | `npm run visual:matrix` 出了三张引导层截图：**1440x900 深色、940x620 深色、900x520 浅色**（矮窗 + 浅色都不裁切、按钮不溢出）。入口走「设置 → 关于 → 查看首次引导」（`data-testid="ob-reopen"`）——探针与非探针模式下首次自动弹的开关在 `App.tsx` 里（`window.yan.isProbe` 时**不**自动弹），这个入口渲染的是同一个组件。检测/配置回路仍由 `onboarding` 探针覆盖。 |
| **L04 浏览器边界** | 部分完成 | 默认拒绝、按 origin 临时允许/撤销、网络私网/DNS 策略和纯逻辑测试已有；仍需逐站授权状态的可追溯 UI、真实目标网站登录、Cookie/页面存储说明、真实 Chrome 下载来源展示和不自动打开、恶意 DNS resolver live 验证。不得输出 Cookie 值。 |
| **L05 变更归属** | ✅ 已实现并取证（2026-09-16） | 原状：写入类工具（edit/write/…）有执行前后快照与逐行 patch。**本轮补完**：shell / 第三方工具改走**目录级前后快照**（`snapshots.ts` 的 `captureTree`/`diffTrees`/`beginTreeSnapshot`/`endTreeSnapshot`，同步 fs、带条数/深度/内容预算上限）——`bash` 工具的 `tool_execution_start/end` 与**直执行 shell**（`window.yan.runBash`）都拍。新文件 `WorkspaceChanges` 挂在 `call.details.workspaceChanges`，界面上是终端窗口下方的改动卡片（文件清单 + created/modified/deleted/可能改动 + 能算时给 +N/−N 与 patch）。**归属防线**：同一 cwd 已有活跃快照 → 两边都标 `concurrent`（谁都不认领）；快照截断 → `truncated`；根目录读不到 → `unreadable`；只有 mtime 变、没读过内容 → 文件状态 `unknown`（`touch` 不算改动）。证据：单测 `test-workspace-changes.mjs` 33 条（含同大小不同内容、依赖目录忽略、大文件、并发不认领）、`test:live -- workspacechanges`（8 节，已进 check）、两张视觉截图。**剩余限制**：外部进程（用户自己的脚本 / 构建）改的目录看不到，只能靠并发防线；`concurrent` 分支在当前 runners 策略下几乎只能由单测触发（同 cwd 第二个实例会被直接拒绝，见 D20）；行级 patch 只对 ≤256KB 且预算内的文件给（其余只给状态与大小）。**应用与包**：留待 P0-8（L01 发布门槛）统一复验，本轮未重打包。 |
| **N21 上下文管理器** | 阶段 0/1 已完成，阶段 2–4 待办 | 把自动压缩升级为砚自管的上下文管理（方案：[design/方案-上下文工具内的自动压缩](../design/方案-上下文工具内的自动压缩-2026-09-15.md)；阶段表见 [PRIORITY](PRIORITY-2026-09-15-未完成排期.md) 的 P1a 节）。已完成：**N21-0** 接口定稿（`ContextBudget` / `ContextOperation`（kind 四类，idle = `null`）/ `ArchiveEntry`（`recallable` 三态 `none/manual/agent`）/ `ContextPolicy`）；**N21-1** UI 归位（自动压缩进上下文主体、详情分容量与花费、删重复只读开关行；**仍显示真实物理窗口**，未提前展示工作集；证据 `docs/design/preview/context-stage1-2026-09-15.png`）。剩余：**N21-2 可观测**（用已有 RPC `compaction_start/end` 的 `reason`/`status` 显示正在压缩/完成/被拒绝，详情加「最近一次」，0.5–1 天）→ **N21-3 接管工作集**（按公式 `min(240k, 窗口×70%, 窗口−预留−余量)` 算预算并决定何时 `compact()`，此时才启用工作集 UI 与「清理/折叠/压缩」三标记，保留 90% 物理兜底，1–2 天）→ **N21-4 多阶段与归档**（pi Extension 用 `context` 钩子做 tool sweep / episode fold / recall 注入，`session_before_compact` 接管结构化压缩，archive 元数据 + `recall`，3–5 天）。边界：原始 session/history 保持完整，不 fork pi 内核。 |
| **N22 右栏项目文件改版** | N22-0～3 已完成，N22-4（验收补强）待办 | 定义为“低风险 UI + 局部交互改造”，**核心文件树能力不变**（懒加载/预览/加入上下文/方向键/身份校验/搜索/跳过依赖目录都不动），**只改右栏**。三条最终决策：计数**完全不显示**（项目头与分区头部都不显示）；分页步长保留 50 且明确为 **UI 展示批次**（不触发额外递归加载）；范围只限右栏。已按 12 条批注修订：项目头**替换** root row（加 `variant`，不新增层级）；五态分开定义（hover / focus / current(preview，`aria-current`，不用 `selected`) / in-context / expanded）；窄栏用右侧固定 66px 槽 + `opacity` 切换；`.rp-fs-*` 三个同名选择器收拢到 `tools.css`；探针改为与 CSS 变量**计算值**比较并补行为断言。拆为 N22-0～4（见 [PRIORITY](PRIORITY-2026-09-15-未完成排期.md) P1b）。方案：[design/方案-右栏项目文件](../design/方案-右栏项目文件-2026-09-15.md)。已交付（`7f40c0c`）：样式归属收拢到 `tools.css`、五态视觉 + 固定 trailing 槽、项目头（无计数）、`visibleLimit` 分页（50/次）；验证 typecheck / build / 单测 524 / `test:live -- fs`（含无横向溢出体检）均通过，证据 `docs/design/preview/filetree-n22-2026-09-15.png`。剩余 N22-4：键盘与焦点恢复行为断言、折叠目录内的 current、搜索态截图（**窄栏 + 超长名已由 L02 交付**：`fsedge` 第 7 节 + `matrix-fsnarrow-1440x900-100-dark-2026-09-16.png`）。 |

### 三、N18/N19 的下一轮最小验收矩阵

接手时建议先完成这一组，因为两项共用 Composer、光标状态和文件引用语义：

1. **命令**：裸 `/`、说明筛选、超过 12 项滚动、光标回移、已有参数/后文、Enter/Tab/Esc/方向键、中文输入法组合态、同名不同来源、未连接和切项目；接受候选不发送，执行时才进入正确本地/扩展入口。
2. **文件引用**：裸 `@`、单字、多级目录、中文空格路径、引号路径、同名文件、多引用、句中光标、快速删除/切项目、大目录、权限/符号链接边界；选候选不发送，真实发送后检查模型收到的引用文本和附件列表。
3. **交叉竞态**：在 A 项目发起补全后立即切到 B，确认旧响应不能打开菜单或覆盖 B；切换命令来源列表时同样丢弃迟到响应。

### 四、L06 真实能力边界和外部阻塞

以下事项不要在接手时误标为“代码未完成”或把 Windows 证据扩大解释：

- **代码签名**需要开发者证书；当前只能生成未签名 Windows 目录/安装产物。
- **macOS / Linux** 需要对应构建环境或 CI；Windows 上不能把目标包和签名当成已验证。
- **扩展 `registerShortcut`** 在 pi 0.85.1 RPC 模式没有枚举/调用接口；等待上游 `get_shortcuts` / 执行接口，不做静态假映射。
- **Yan 自有账号登录、每日模式、任务面板整体改造**不在本轮；ChatGPT `openai-codex` 应用内模型接入登录是另一条已实现的能力，不要混称为 Yan 账号登录。
- **Command Code 月度额度**没有账户权威字段前继续标注为估算。
- 密度三档、已有文件预览、工具分型和主窗口沙盒是保留基线；若没有新需求，不要扩大成字体/图标重设计或记忆系统恢复。

### 五、全量审计新增缺陷（2026-09-15）

对全仓库 19633 个文件做过一次机器审计与代码核对（清点、语法、i18n、IPC、推送、探针、文档链接全部闭合），结论与方案见 [项目全量审计与收尾方案](AUDIT-2026-09-15-项目全量审计与收尾方案.md)；按轻重缓急的执行顺序见 [未完成工程排期](PRIORITY-2026-09-15-未完成排期.md)。除上表任务外，另登记 D1–D20 共 20 条清单外问题（D1–D9 出自本次审计，D10–D20 为后续实测新报；**已关闭：D1–D20 全部**（含 P2 小修的 D8 ErrorBoundary、D9 插话排队、D10 文案重复、D12 未配凭证状态，N18 矩阵发现的 D17 输入法组合态、D18 Esc 关不掉命令菜单，N05 收尾时发现的 D19 文件树卡在“正在读取目录…”，以及 L05 实现时发现的 D20 直执行 shell 不算忙））。**D1–D5 已修**，N12/L03 的验收基座可以开始动：

| 编号 | 严重度 | 问题 | 状态 |
|---|---|---|---|
| D1 | 高 | 子代理并发槽位在 `await prepareWorkspace` 前未预占，三个并发 `start` 可同时越过上限 | **已修**：`SubagentController.preparing` 在第一个 `await` 前占位并计入 `runningCount`；单测「并发启动时最多两个通过」 |
| D2 | 高 | `finalize()` 的 promise 缓存挡住退出时的 `cleanupReview=true`，已结束的 worktree 不会被归档清理 | **已修**：缓存 promise 之后再走 `archiveOnExit()`；单测用真 git worktree 验证「退出时把未审阅的 worktree 归档」且目录已删除，重复退出保持归档 |
| D3 | 中 | 子代理启动期重读 `this.opts`，准备期间切父会话会让 cwd 与 parentSessionId 来自不同代次 | **已修**：`start()` 开头整体快照上下文并贯穿本次启动；单测「准备期间切会话不影响已发起的子代理」 |
| D4 | 中 | “只读”子代理没有工具白名单，`controlled-cwd` 只是不隔离；注释承诺的“上层限制为只读”未实现 | **已修**：只读模式给 pi 传 `--tools read,grep,find,ls`（pi 0.85.1 的语义是 `Comma-separated allowlist of tool names`，已用 `rpc-entry.js --tools ...` 真机启动确认被接受）；单测 3 条覆盖参数拼接。模型侧“想写也写不了”的端到端证据仍待补 |
| D5 | 高 | 复用空闲 runner 跨项目时只改注册表 `cwd`，pi 进程实际 cwd 不变，`new_session` 可能落在旧项目目录 | **已修**：跨 cwd 复用时换进程（先起新的、成功后再停旧的；失败整体回退并收掉半个进程）；单测 2 组 + `test:live -- runnerselect` 断言「跨项目复用后 pi 进程的 cwd 跟上新项目」（关掉换进程该断言失败，已反向验证） |
| D6 | 工程风险 | 48 个核心新文件（含 10 个源文件、10 个单测）曾未纳入版本管理 | **已解决**（`6a35d47`） |
| D7 | 低 | `scripts/probe/libdrag.js` 已删除但仍在 git 索引 | **已解决**（随同一次提交删除） |
| D8 | 低 | 无渲染端 ErrorBoundary，渲染异常整屏白屏且无重新加载出口 | **已修**：新增 `components/ErrorBoundary.tsx`（包在 `I18nProvider` 里的 `App` 外层），兑底界面给出原因 + 详情 + 「复制详情 / 重新加载界面」两个出口，文案进 i18n（zh/en），不把 React 的英文提示直接给用户；`test:live -- crash` 故意把 `sessions` 置成非法值把整棵树搞崩，断言出现兑底界面而不是白屏（已进 `npm run check`） |
| D9 | 低 | 已被 pi 接收的插话仍显示在“排队中”，主进程队列快照落后于真实消费 | **已修**：判定规则抽成 `src/main/queue-items.ts`（纯函数 `consumeQueuedItem` / `reclaimedTexts`，单测 18 条），`agent.ts` 在**收到 user 消息时**按原文摘掉队首匹配项（先 steering 后 followUp、FIFO、trim 后比较），`abort()` 之后无条件把本地快照清空（pi 的 `clear_queue` 返回值才是权威）；`test:live -- queue` 新增“已接收的插话不再显示为排队”与时间线采样，旧的“撤回后队列与提示一致”断言改为正确语义 |
| **D10** | 低 | 模型菜单“思考强度”在无可选档位时同一句提示重复显示两次（`.mt-head-level` 与 `.mt-capability-note` 条件完全相同）；`Pickers.tsx` | **已修**：头部右侧只显示**短状态词**（`未知 / 不支持`，新 i18n 键），完整说明交给下面的 `mt-capability-note`，并把完整说明挂到 `title`；视觉证据 `docs/design/preview/matrix-modelmenu-1440x900-100-dark-2026-09-16.png` |
| **D11** | 高 | 支持推理的模型拿不到思考档位：pi 的 `get_state` 不返回 `availableThinkingLevels`，而 `setStateFrom` 把它当唯一来源 → 每条 state 推送都把档位重置成 unknown（真实模型 `commandcode/deepseek/deepseek-v4.1-flash` 上游实际返回 5 档） | **已修**（`resolveThinkingLevels` + 首次连接/`model_change` 补拉；单测 5 条 + live 探针 `thinking-levels`） |
| **D12** | 中 | 未配置凭证的模型缺少明确状态：无 `auth.json` 时 `set_model` 失败、pi 只返回 `["off"]`，界面没有区分“模型不可用 / 未配 API”与“模型不支持思考” | **已修**：store 新增 `authProviders` + `loadAuthProviders()`（菜单打开时拉一次，拿不到就不标），`Pickers.tsx` 在**分组标题与模型行**上标出「未配置」（用警告色而非错误色，并给出“去设置 → 模型接入 / 终端 pi → /login”的提示文案）；`test:live -- modelmenu` 新增 5 条断言（24 条里 16 条被标、openai 的 8 条不误标、分组徽标、文案可读） |
| **D13** | 中 | 会话柄（导航轨高亮）停在第一格：原 `activeFromGeometry` 只在“顶边越过视口顶部”的回合里挑，一个都没有时 `best` 停在初始值 0 | **已修**（滚到底优先判最后一格 + 无越顶回合不再回落；`test:live -- outline` 两条新断言） |
| **D14** | 高 | 项目 id 只取 `base64url(cwd).slice(0,36)` —— 36 个 base64 字符只覆盖路径**前 27 字节**，同一父目录下的 `.../pi-desktop` 与 `.../pi-desktop-2` 会共用一个 id。按 id 反查项目的 `resolveFileContext`（文件树 / `@` 补全 / 全项目搜索共用）命中另一条记录，于是这些入口报「项目与工作目录不匹配」/「读取目录失败，请检查当前项目权限」 | **已修**（新增 `src/main/project-id.ts`：碰撞时改用整条路径的 sha1，不碰撞时仍用旧 id 保证已有归属不丢；`resolveFileContext` 增加按 cwd 兜底确认并回带正确 id；单测 `test-project-id.mjs` 9 条 + `test:live -- atpathedge` 的切 cwd 断言。由 L02/N19 边界探针发现） |
| **D15** | 中 | 子代理转录把 `toolResult` 当新消息 push：同一个工具调用在详情面板里显示成两条（一条默认 `ok`、一条 `error`），真实结果看不出来。而一改回填，消息 id 就因依赖 `transcript.length` 而错位 —— 同一条流式回复被拆成多条、最终文本被盖掉 | **已修**（`toolResult` 回填到原调用；改用只在落新消息时递增的 `msgSeq` + `streamingId` 给消息编号；单测两条：回填不新增消息、流式回合只落三条消息） |
| **D16** | 高 | 子代理跑完后 pi 进程**不会自己退出**，而原实现只在 `stop`/`fail` 里 close：每跑完一个子任务就泄漏一个 pi 进程；进程的 cwd 就是隔离 worktree，Windows 上 `git worktree remove` 静默失败，临时目录残留（实测退出后残留 4 个）。但也不能一收到 `agent_settled` 就 close —— 实测那一刻 assistant 消息还是空的，尾巴会被切掉 | **已修**（`agent_settled` 后先等转录安静（600ms 无变化、上限 5s）→ 关进程 → 再读差异/清理；merge/discard 也补记 `worktreeDone`；单测两条 + `subagentpair` 的“退出后无残留隔离目录”断言，并已反向验证） |
| **D17** | 中 | 中文输入法（IME）组合期间按 Enter，命令补全菜单把候选当成确认：选词时会把 `/help` 之类填进输入框（“发送键”分支一直有 `isComposing` 检查，菜单分支漏了） | **已修**：菜单键盘处理开头 `if (e.nativeEvent.isComposing) return`（Enter / Tab / ↑↓ / Esc 全部让给输入法）；`test:live -- slashcmd` 第 12 节用合成组合态按键断言输入内容不被改动 |
| **D18** | 低 | 按 Esc 关不掉 `/` 命令菜单：Esc 顺手置 `atMenuDismissed`，而它在重开 effect 的依赖里 —— effect 重跑又把菜单打开了 | **已修**：新增 `slashMenuDismissed`（只在 `slashQuery` 变化时清掉），Esc 关闭后不再被重开；`test:live -- slashcmd` 第 14 节断言 Esc 后菜单消失且不动已输入内容 |
| **D19** | 中 | 文件树被丢弃的旧请求不清 `loading` 标记：根层守卫（`cache[''] === undefined && !loading.has('')`）于是永久挡住重试，切项目 / 切会话时偶发卡在「正在读取目录…」（跟 D16 同一类：代次早退把清理带走了） | **已修**（N05 收尾时发现）：`FileTree.tsx` 的 `load` finally 里无条件清标记，并把 `loading` 进根层 effect 的依赖让它自愈；`test:live -- tools projectswitch` 曾稳定复现（tools 跑完再切项目），修后连跑 3 次通过 |
| **D20** | 中 | `RunnerRegistry.busy()` 只看 `isAgentRunning`/`isStreaming`/`isCompacting`/pending UI，**不算直执行 shell**（`this.bash`，不经过模型）。于是“跑着 `npm run build` 时切到同 cwd 的另一个会话”会復用同一实例，而它的 `this.bash` 还在 —— 用户在新会话里每条命令都报「已有一条命令在跑」，看着像卡死；同时两个实例同 cwd 并行改文件正是 L03 要防的事 | **已修**（L05 实现时发现）：`AgentController.hasRunningBash()` + `busy()` 纳入它。同 cwd 切换现在明确拒绝（“同一工作目录已有运行中的会话…”），不同 cwd 仍可切（后台保留）。单测 4 条 + `test:live -- workspacechanges` 第 8 节（真实进程两条命令验证） |

### 六、建议接手顺序

1. ~~**L02 + N19**~~（2026-09-16 完成：边界探针取证 + D14 修复；**L02 三项收尾已完成** —— 无权限目录 / 220px 窄右栏 / 与内置浏览器共存，N19 共用同一条权限 fixture）；
2. ~~**N12**~~（2026-09-16 完成主矩阵：真实 A/B/C 会话的切走不停、切回不串、同 cwd 拒绝、单独停止、退出落盘；剩等待输入/失败/未读与退出变体）。L03 已随上一轮完成（证据见上表）；~~**N05 项目切换**~~ 也已完成（`-- projectswitch` 进 check：草稿恢复 / 失效与无权限目录 + D19）；
3. **N02 + N04 + N07 + N13/N14/N15/N17/N20**：视觉矩阵已出图（`npm run visual:matrix`）；剩余的是不需要截图的真实模型/交互矩阵：多模型切换迟到响应与空档位清理、推理块的长中英文/emoji/上滚/减少动画、设置入口逐项走查、长标题与多项目搜索与重启顺序。
4. **N18**：完成逐命令验收矩阵、技能发现边界和中文输入法验收；不为满足数量虚构技能。
5. ~~**L05 变更归属**~~（2026-09-16 完成实现与取证：目录级前后快照 + 改动卡片 + D20）；**L04**：补目标网站/真实 Chrome/私网 DNS 证据，保持 Cookie 和账户字段边界。
6. **P2 小修与补强**：D8 ErrorBoundary、D9 已接收插话展示、D10 模型菜单文案重复、D12 未配凭证状态，以及 N22-4 文件树验收补强、N21-2 压缩可观测。
7. **L01 最终门槛**：使用数据备份副本验证升级，重新构建最终源码，生成并核对发布范围内的安装包、便携 ZIP 和 SHA256，最后再讨论签名和跨平台。


## 更新状态的方法

在对应任务行链接证据，按[工程清单第 6 节](ENGINEERING-CHECKLIST-2026-09-15.md)补齐：**实现 / 自动检查 / 真实运行 / 视觉验收 / 应用与包 / 剩余限制**。不适用项注明原因；不能仅凭源码、mock、探针 ok 或旧产物勾选完成。

通用排障经验见 [MAINTENANCE](MAINTENANCE.md)，不再向本页追加“本轮已落地”流水账。
