# 开发交接 · 砚

整理日期：**2026-09-17**（最后一轮更新：**2026-09-23**，最新增量为 **实施-11 H-6b 稳定逻辑回合 / 等待分段 / 用量聚合**，同日本轮早些时候为 **实施-01 S5d 空壳 `browser.js` 与死代码 loopback bridge 删除 + 宿主浏览器能力登记**；上一批包括 **实施-04 S6b-2 用户授权外部 Skill 文件整链与恶意内容审查**、**实施-01 S5a 默认发现边界**、**实施-11 C-4b 估算口径（图片/附件不当零）**、**实施-11 C-5 上下文窗口 UI 分层**、**实施-11 H-6b 崩溃→中断**、**实施-11 C-2 压缩可观测性（回收比例与新增量）**、**实施-11 C-4 生效策略交给薄层**、**实施-11 H-4a 文件链接解析与呈现**、**实施-11 H-6（部分）整轮计时落盘与恢复**、**实施-11 H-7 时间呈现统一与可访问**、**实施-11 H-2 右栏资源保留 / C-1 大窗口模型级试行档**、**实施-11 H-1 回合页脚与整轮计时口径**、**额度：Command Code 月度口径修复与三档色阶**、**04-S7 能力设置页、模式策略、MCP 显式核验的取消 / 重连与项目隔离**、**04-S6b-2 staging manifest 精确文件集复核**，以及固定项目内 `skill-files` 的安全边界调度器；既有进展包括 Pi 包 Electron 运行时适配器 + 本地离线 Pi smoke，以及 08-S0 远程消息定向与 abort 的隔离 Electron 端到端证据。当前已有一个获授权外部 Skill 文件候选完成 acquire / 安全审查 / 激活 / 原目标续接；其它资源类型的包级证据与最终发布门槛仍未完成。本文是**当前状态与验证基线的唯一入口**；
**接下来做什么**看 [实施计划](../plan/README.md)（按主题切成「一次会话一片」）。
已完成的任务、缺陷明细（D1–D41）与逐轮记录见 [2026-09-17 已完成归档](../archive/2026-09-17-已完成归档.md)；
工程标准看[工程清单](ENGINEERING-CHECKLIST-2026-09-15.md)，架构与依赖看[实施方案](实施方案-2026-09-15.md)。


### 2026-09-23 · 自动继续上限与退避放宽（用户：重试五次、时间拉长）

> 用户口径：「修改一下自动重试系统，重试五次，时间拉长一些，有时候供应商会抽风」。
> pi 自己的重试（`auto_retry`）次数/退避写在 pi 的 `settings.json`（砚刻意不写那个文件，
> RPC 也只有开关），所以放宽的是砚这层「模型出错后的自动继续」——
> 它正是 pi 重试用尽之后接着干的那一环。

| 六栏 | 证据 |
|---|---|
| 实现 | [`shared/auto-continue.ts`](../../src/shared/auto-continue.ts)：`AUTO_CONTINUE_LIMIT` 3 → **5**；`AUTO_CONTINUE_DELAYS_MS` `[3s, 10s, 30s]` → **`[10s, 30s, 1m, 2m, 4m]`**（单调递增、与上限一一对应）。判定语义**未变**：429 / 限流、401 / 403、上下文超限、用户取消仍然不重试；用户发言或停止仍然立刻归零；续行仍然是 `custom` 消息且带「先检查再动手」。只放宽「值得重试」那类的次数与间隔。 |
| 自动检查 | `npm run typecheck` / `npm run build` 通过；`npm run test:unit` **4682/4682**（日志 `out/retry-unit2.log`）—— [`test-auto-continue.mjs`](../../scripts/test-auto-continue.mjs) 改成从常量派生断言，并新增「退避表长度 = 上限」「退避单调递增」「第五次用最后一段退避」三条；存储层用例从第 2 次循环到第 5 次，到限改在第 6 次断言。 |
| 真实运行 | 未跑 live：`autocontinue` 场景用 `YAN_AUTO_CONTINUE` 显式覆盖 `limit` / `delays`（1.2s），默认值改动不影响该路径；真实默认退避最长 4 分钟，不适合放进自动化场景（会拖垮整批）。 |
| 视觉验收 | 不涉及界面：提示文案里的「第 N/5 次」「连续 5 次」由 `planAutoContinue` 按 `limit` 生成，没有硬编码数字需要同步。 |
| 应用与包 | 未重启用户现有窗口，未重跑解包 / 便携 / 安装包。 |
| 剩余限制 | 未在真实供应商故障上验证「5 次 / 最长 4 分钟」是否够用或过长（这是拍板的默认值，不是实测标定）；pi 自身的 `auto_retry` 次数仍由 pi 的 `settings.json` 决定（砚不写那个文件）。 |

### 2026-09-23 · 实施-14 F7 收口：故障恢复、连续两次交接与跨片段归属

> 用户指出「实施-14 的修复记录」仍未闭环的部分：故障恢复与两次连续交接只有单测/vm 证据，
> 跨片段计时归属没有端到端取证，`HandoffNote` 视觉未覆盖计数。
> 本节把这几项补齐，过程中发现并修掉两个真实缺陷（界面历史被当前片段覆盖、矩阵 light 组静默出深色图）。

| 六栏 | 证据 |
|---|---|
| 实现 | ① **故障恢复（cost 0）**：新增 [`handoff-recover.js`](../../scripts/probe/handoff-recover.js) 与场景 `handoffrecover`；`scripts/test-live.mjs` 新增本机 fixture provider `startHandoffFailureProvider`（写进**默认** pi 目录，因为 `piSettings.keepRecentTokens=1` 在那个目录里；另建 `YAN_PI_DIR` 会让压缩参数失效，实测会一直 `Nothing to compact (session too small)`）：普通回合回长文本推上下文、交接包请求（system prompt 含「跨会话交接」）回一段非 JSON 文本，于是宿主走 `unparsable` 恢复路径。退出后检查 `handoffs.json` / 请求结果文件 / `handoff/events.jsonl`。② **连续两次交接 + 跨片段计时（cost 1）**：新增 [`handoff-chain.js`](../../scripts/probe/handoff-chain.js) 与场景 `handoffchain`（`YAN_HANDOFF_THRESHOLD=0` 测试通道）：两次交接 → 链上 3 段、两次事务都 `resumed`、第二次的源就是第一次的目的、`conversationId` 跨两次换段不变、模式/目标/用户原话保留、源段消息仍在时间线里、停目标后不再排第三次；退出后比对 `session-chains.json` / `handoff-transactions.json` / `turn-timing/*.jsonl`（两段 `logicalTurnId` 不重叠，用量与计时不跨片段重复累加）。③ **修真实缺陷（界面历史）**：[`index.ts`](../../src/main/index.ts) 的 `pushRunnerSnapshot` 新增 `{ chainHistory: true }`，`publishHandoffReplacement` 改用它 —— 原来交接后用 `agent.getMessages()`（pi **当前片段**的上下文）覆盖前端时间线，交接后历史只剩最后一段（`handoffchain` 探针实测 `messages` 全是空文本）；现在读链上的 JSONL（与 AGENTS.md「界面历史就是会话文件」一致），拿不到时回退原行为。④ **F7 视觉计数**：[`HandoffNote.tsx`](../../src/renderer/src/components/chat/HandoffNote.tsx) 增加 `data-testid="handoff-tally"`，显示「本片段 {done}/{threshold} · 整条会话 {segments} 段」（H5 要求两个计数分开，不能拿链首旧计数冒充当前进度）；i18n 中英各 1 key、`composer.css` 加 `.handoff-note-tally`、视觉矩阵新增状态 `handofftally`。⑤ **矩阵修复**：[`visual-matrix.mjs`](../../scripts/visual-matrix.mjs) 的主题同时写进 store 与 `<html data-theme>` —— 只改 DOM 时任何一次 settings 更新都会让 App 的 theme effect 写回旧值，light 组会静默截出深色图（文件名却写 light）；另修过期断言 [`test-handoff-runner.mjs`](../../scripts/test-handoff-runner.mjs)（F5 起完成提示是「上下文已整理…」，不再是「交接完成」）。 |
| 自动检查 | `npm run typecheck` / `npm run build` 通过；`npm run test:unit` **4675/4675**（含修好的过期断言；日志 `out/f7-unit.log`）。 |
| 真实运行 | **cost 0**：`npm run test:live -- handoffrecover` 全绿 —— 默认阈值 2 未覆盖、真实策略压缩 2 次、交接包生成失败（`unparsable` / `no-json-object`）、占用释放（`pending=false`）、会话仍在源片段（`chainSegments=1`）、目标未被伪报完成、失败后源片段又收到新回合；退出后：源片段计数 2、`package` 为空、失败那次的结果文件已消费且请求已清理（残留 1 份是失败后重新排的新尝试，预期行为）。**cost 1**（`YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash`）：`npm run test:live -- handoffchain` 全绿 —— 两次交接都到 `resumed`、链 3 段、`conversationId` 不变、模式/目标保留、链历史与前端时间线都含源段用户消息、退出后两次事务链式相接、两段 `logicalTurnId` 不重叠。均无残留 pi 进程。**回归**：`npm run test:live -- handoffcommit` 也重新跑绿（一次交接链路 + 退出后事务 / 链 / 续接证据），过程中修掉探针自身的两处过时假设 —— `YAN_HANDOFF_THRESHOLD=0` 下它会**连续交接**（旧目的段随即变成链中间段被侧栏隐藏，拿交接那一刻的 `sessionKey` 去查列表必然 0 次），现在交接后先 `stopGoal` 停住再断言；另加列表刷新与流式收尾的轮询。 |
| 视觉验收 | `npm run visual:matrix -- 9 10` 全绿（1440×900 / 100% / 横向溢出 0px），两张已看图：[`handofftally 深色`](../design/preview/matrix-handofftally-1440x900-100-dark-2026-09-23-1719.png)、[`handofftally 浅色`](../design/preview/matrix-handofftally-1440x900-100-light-2026-09-23-1719.png) —— 输入框正上方一行「上下文已整理，任务继续　本片段 2/2 · 整条会话 3 段」，深浅主题都可读；同组的 `segmented` / `handoffnote` 也随之重新出图（light 组这次**真的**是浅色）。 |
| 应用与包 | 未重启用户现有窗口，未重跑 `dist:dir` / `test-packaged` / 便携 / NSIS；新增文件都在 `scripts/` 与渲染端。 |
| 剩余限制 | ① `handoffchain` 用的是**阈值 0 测试通道**（生产默认 2 下，第二次交接同样要再攒两次真实压缩）——「默认阈值 2 的连续两次交接」仍无直接证据；② 崩溃恢复的「启动确认」仍是磁盘标记近似（`resume-confirmed` 不等于 run 启动回执）；③ 正式应用窗口与包未复验；④ `handoffrecover` 的失败类型只覆盖「模型吐坏 JSON」（`unparsable`），落盘失败 / 目的创建失败仍只有 vm 单测；⑤ 阈值 0 下「目标继承 → 计数归零 → 立即再够格」会连续交接，这是测试通道行为（生产阈值 2 下不会），但**没有冷却机制** —— 探针靠 `stopGoal` 收尾。 |

### 2026-09-23 · 实施-14 复审修复（不调用模型）

本次按用户“节约额度”的要求修复复审发现的五项问题；不使用 cost 1 场景。以下覆盖本次修改范围，早前 F2/F3/F6 的描述以此处为准。

| 六栏 | 证据 |
|---|---|
| 实现 | 暂停状态在交接资格、提交与发送边界复核；停止使在途交接失效。结果收集先认领、读后核对，pending 保留至提交结束，超时不与提交重复消费。生成错误、解析失败、缺字段、持久化失败统一释放占用并恢复续行。目的实例私有创建，提交时重新核对当前选择，以 `handoff-rebind` 原位替换运行身份，保留完整历史、草稿及逻辑会话标识，右栏与标题使用逻辑身份；失败回源也沿用此路径。推理从首段开始按段渲染，后续正文出现不切换 DOM 结构。 |
| 自动检查 | `typecheck`、`build` 通过；全量单测 **4671/4671**；后续交接边界调整另跑当前源码定向测试 **76/76**。新增生产宿主函数注入 IO 的竞态测试、执行器停止边界、实例发布与缓存保留测试。日志：`out/review-fixes-unit.log`、`out/review-fixes-types.log`、`out/review-fixes-build.log`。 |
| 真实运行 | 隔离、隐藏窗口、cost 0 的 `reasoning` 与 `toolgroup` 通过。`reasoning` 新增真实 DOM 顺序和节点引用断言，覆盖“第二段只有推理”和“第二段正文到达”。日志：`out/review-fixes-reasoning.log`、`out/review-fixes-toolgroup.log`。 |
| 视觉验收 | 本次未进行人工上屏、截图或多主题视觉验收；隐藏窗口的 DOM 测量不等同人工视觉验收。 |
| 应用与包 | 当前源码已构建至 `out/`；未重启用户现有窗口，未制作便携版或安装包。 |
| 剩余限制 | 本次模型调用为零。默认阈值 2 的真实压缩→交接→继续执行未重跑；真实模型续接与用户窗口焦点连续性仍需单独验收，不能以本次单测或 marker 代替。 |

## 接手顺序

### 2026-09-23 · 实施-12 U-1：左栏收起时复位「更多会话」

> 实施-12（侧栏交互与可移动工具磁贴）分波推进；本波只交付**无依赖的 U-1**。
> 用户已完全授权自主开工。尝试过的隔离子代理（`sub-99e81cfc`）撞上 **10 分钟运行上限**，
> 只读完代码就超时 —— 大主题不能用一次子代理交付，后续按「一轮一片」推进。

| 六栏 | 证据 |
|---|---|
| 实现 | [`Rail.tsx`](../../src/renderer/src/components/rail/Rail.tsx)：左栏 `railPinned` 从 true 变 false 时把 `expanded-sessions` 置空（复位到 `SESSION_PREVIEW` 五条），并关掉会话行 / 项目 / 分组三个临时菜单；用 `useRef` 记上一次的 pin 值，只在**真的发生 true→false 那一次**复位（不在 render 中写状态）；`collapsed-projects`、`expanded-branches`、`pinned`、`unread`、`projects-open` 均不动。 |
| 自动检查 | `npm run typecheck` / `npm run build` 通过（纯渲染端改动，不涉及共享契约）。 |
| 真实运行 | cost 0：`npm run test:live -- railmini` **通过**。探针新增 1b 段：先展开到 8 行 → 收起左栏 → 重新展开 → **5 行 / data-count=3**（复位）；临时菜单不在已折叠的栏里；搜索中收起再展开后结果仍完整；清掉搜索才回到预览。探针还把当前会话放回第 1 条作前置（避开「自动多展开到当前会话」这个正确旧行为对断言的干扰）。 |
| 视觉验收 | 未单独出图：本片只改变「收起后复位」这一步，既有 `railmini` / `railsearch` 截图不含该步骤。留到下一次侧栏批量视觉验收（U-2/U-6）一起补。 |
| 应用与包 | 未重跑解包 / 便携 / 安装包（纯前端行为）。 |
| 剩余限制 | 探针里**没点到**会话行菜单按钮（`.srow-menu-btn` 选择器没命中），所以断言只证明了「收起后菜单不可见」，没证明「打开着的菜单被关掉」；U-2 会重做项目菜单（含 testid），届时把一个正向用例补上。 |

### 2026-09-23 · 实施-14 F2–F7：交接调度、稳定身份、内部续接、状态 UI 与推理位置

> 接上一节（F0/F1）。本轮把实施-14 剩下的 F2–F6 实施完并做了 F7 的联合验收。
> 用户授权用 `deepseek/deepseek-v4.1-flash` 跑 cost 1（本阶段跑了 `handoffcommit` 三次：一次定位回归、一次修复后验证、一次补断言后终验）。

| 六栏 | 证据 |
|---|---|
| 实现 | ① **F2 单一调度**：新增 [`shared/handoff-schedule.ts`](../../src/shared/handoff-schedule.ts)（`decideSessionWork` 优先级：忙 > 错误重试 > 交接进行中 > 交接 > 续跑；`ownsHandoffOperation` 操作所有权）；`index.ts` 的 `scheduleSessionWork` 取代了 `pushFrom` 里三个 `void` 并发；`handoffPending` 带 `interval`+`timeout`+`goalId`，超时/轮询回调都带 `operationId` 并校验；`commitHandoff` 前新增 `revalidateHandoff`（操作身份 / 空闲 / 源会话未切走 / 目标未变 / 档位未变 / **源水位未前进**）；交接开始时冻结源续跑，放弃时放回。② **F3 稳定身份**：`HandoffSessionTarget.activate` + `shouldActivate`（后台交接不抢用户视图，**在停源之前判定**）；新增 `onDestinationReady` 回调，在 `destination-created` 之后、**发 resume 之前**继承模式与用户级目标事实（`GoalStore.inheritTo`：同一 goalId/revision/取证/pursue/brief/暂停，不带幂等记录与待发续行），快照写给**目的 runner**。③ **F4 内部续接**：交接 resume 改走薄层的 `custom` 通道（`ResumeKind` 加 `handoff` → `yan-handoff-resume`，复用 `goal-resume/<runnerId>.json` 槽位与消费幂等），不再用 `agent.send` 冒充用户消息；`hasResumeEvidence` 认 `custom`（旧 `user` 只读识别）。④ **F5 状态与异步隔离**：新增 [`shared/handoff-notice.ts`](../../src/shared/handoff-notice.ts)（进行中 / 已整理 / 整理未完成的判定 + 原因翻人话）与 [`HandoffNote.tsx`](../../src/renderer/src/components/chat/HandoffNote.tsx)（输入区上方一行非阻塞状态 + 重试 / 停止），`HandoffView` 加 `segmentTally` / `chainSegments`（区分当前片段与整条会话）与 `events`；新增 `yan:retryHandoff`；A7：`identityForAwait` 挡住 await 后往别的会话写 `goal`/草稿。⑤ **F6 推理位置**：[`shared/turns.ts`](../../src/shared/turns.ts) 新增 `TurnSegment` 与 `segments`（推理/工具/正文按真实顺序归段，正文一输出就封段），[`TurnView.tsx`](../../src/renderer/src/components/chat/TurnView.tsx) 在**多段正文**时按段渲染（单段正文仍走原路径，零回归）。 |
| 自动检查 | `npm run typecheck` / `npm run build` 通过；`npm run test:unit` **4639/4639** —— 新增 `test-handoff-schedule.mjs`（14 条：五种决定的优先级与所有权校验）、`test-handoff-notice.mjs`（13 条：窗口边界、失败后成功、`result-mismatch` 不算失败、原因文案）、`test-turns.mjs` 新增 13 条（多段顺序、正文 A 不被搬动、单段零回归）、`test-goal.mjs` 新增 10 条（`inheritTo` 幂等 / 不覆盖别的目标 / 暂停与 pursue 跟随）、`test-handoff-runner.mjs` 新增 4 条（继承早于 resume、后台不抢选中、**激活判定必须在停源之前**）、`test-goal-resume.mjs` 3 条与 `test-handoff-resume.mjs` 3 条（`handoff` kind 与 custom 证据）。 |
| 真实运行 | **cost 0**：`test:live -- reasoning toolgroup autocontinue` 全绿。**cost 1**（`YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash`）：`handoffcommit` **通过**（交接包生成 → 事务 `committed → resumed` → 视图切到目的段 → 链上两段拼成一条时间线 → 模式继承 autonomous → 目的会话文件里有 `"customType":"yan-handoff-resume"` 且**不冒充用户消息** → 源会话保留 → 请求/结果文件清空）。过程中用 `handoff/events.jsonl` 定位到一个真实回归：`shouldActivate` 原本在 `stopRunner` **之后**询问，导致目的实例永不激活（现场 `rev0 phase=planning mode=standard` 全是空壳），修正后完全恢复。顺手把探针的「历史里出现 resume 那条交接消息」改成用宿主侧消费证据判定（F4 后它不再进消息流）。 |
| 视觉验收 | 新增矩阵状态 `segmented`（两次「推理 → 工具 → 正文」）：`matrix-segmented-1440x900-100-dark-2026-09-23-0535.png`，溢出 0px，**已看图**：顺序为「解说 → 推理1（已推理 3 秒）→ 工具 → 正文A → **推理2（第二段推理：界面这侧要跟着改…）** → 工具 → 正文B → 页脚 2 步」，正文 A 保持在原位。light 组因 Electron GPU/network 进程崩溃未出图（记入剩余限制）。`HandoffNote` 尚无视觉证据（矩阵桩会被 4 秒轮询的真 IPC 覆盖）。 |
| 应用与包 | 未重跑 `dist:dir` / `test-packaged` / 便携 / NSIS；本片新增的文件都在 `src/` 与 `scripts/`（随包只改了既有 `goal-resume.js`）。 |
| 剩余限制 | 本表记录时默认阈值 2 的真实自动完整压缩→交接未跑，阈值 0 下连续交接也未验收；这两项及视觉证据已在下方 F7 补验更新。复审后已用 `handoff-rebind` 原位替换 runtime；跨片段 `logicalTurnId` 归属仍未取证。`HandoffNote` 视觉还未覆盖三类压缩统计；崩溃恢复的「启动确认」仍是磁盘标记近似（`resume-confirmed` 不等于 run 启动回执）。 |

#### F7 补验（2026-09-23）

| 六栏 | 证据 |
|---|---|
| 实现 | 新增 `handoffautocompact` 隔离 cost 1 场景：交接阈值不覆盖，确认运行时默认值 2；只将测试工作集压至 6000、将 `keepRecentTokens` 设为 1 以在有限轮次触发真实策略压缩。探针要求达到两次成功自动完整压缩后才建立持续目标并切入自主档，再验证模型生成交接包、后台事务续接、目的片段写入并读取 proof、目标完成。退出后复查 `handoffs.json` 和 fixture 文件。视觉矩阵增加 `segmented` 与失败态 `HandoffNote` 的深浅主题状态；修正 `.center` 网格行，将提示放在输入框正上方；只读 IPC 桩保留提示 fixture，避免轮询清掉它。 |
| 自动检查 | `npm run typecheck`、`npm run build`、新增探针与视觉脚本的 `node --check` 通过；`test:live -- handoffautocompact` 的运行中与退出后断言通过。此补验没有重跑单测（F2–F6 最近一次基线仍为 4639/4639）。 |
| 真实运行 | `npm run test:live -- handoffautocompact` 通过：隔离 Electron 实际确认阈值 2，记录至少两次策略触发的成功完整压缩；随后模型生成交接包，事务到 `resumed`，链新增目的片段且计数归零，目的片段执行工具写入并读回 `F7_HANDOFF_RESUMED`，宿主将目标记录为 `completed`。交接阈值没有环境覆盖。 |
| 视觉验收 | `visual:matrix -- 9 10` 在布局修正后通过，四图均 1440×900 / 100%，横向溢出 0px，并逐张看图：[`segmented 深色`](../design/preview/matrix-segmented-1440x900-100-dark-2026-09-23-1554.png)、[`HandoffNote 深色`](../design/preview/matrix-handoffnote-1440x900-100-dark-2026-09-23-1554.png)、[`segmented 浅色`](../design/preview/matrix-segmented-1440x900-100-light-2026-09-23-1555.png)、[`HandoffNote 浅色`](../design/preview/matrix-handoffnote-1440x900-100-light-2026-09-23-1555.png)。推理按正文段落顺序呈现；失败提示在输入框正上方显示原因与「重试 / 停止」，矩阵另断言它距输入框 6px。 |
| 应用与包 | 构建产物已更新，cost 1 在隔离测试数据目录运行，矩阵在独立 Electron 窗口取图；未重启用户主应用，也未重跑解包、便携或安装包验收。 |
| 剩余限制 | F7 仍部分完成：还需为故障恢复与连续两次交接补真实证据（见 §7.2）；未验证正式应用窗口与包。`logicalTurnId` 跨片段归属仍未取证；崩溃恢复的启动确认仍是磁盘标记近似；`HandoffNote` 视觉只覆盖交接失败状态，未覆盖三类压缩统计。 |

### 2026-09-23 · 实施-14 F0+F1：阶段诊断事件 + 目标控制修复

> 此处保留 F0/F1 完成时的状态快照：当时 F2–F7 尚未实施。后续实施与当前验收状态见上方 F2–F7 及 F7 补验记录。
> 本轮未跑 cost 1 场景，未做真实交接链路取证 —— 那属于 F7。

| 六栏 | 本轮范围 |
|---|---|
| 实现 | ① **F0 阶段诊断**：新增 [`shared/handoff-diagnostics.ts`](../../src/shared/handoff-diagnostics.ts)（阶段枚举、事件形状、`redactDiagnosticText` 凭证替换与截断、脏行清洗）与 [`main/handoff-diagnostics.ts`](../../src/main/handoff-diagnostics.ts)（内存环 + 整份重写落在 `YAN_DATA_DIR/handoff/events.jsonl`，失败不抛）；[`index.ts`](../../src/main/index.ts) 在资格拒绝 / 写请求失败 / 生成中断 / 结果对不上 / 解析或落盘失败 / 提交各阶段 / resume 未确认 / 目标续接 arm·limit·暂停·终态清理处埋点；[`HandoffView.events`](../../src/shared/handoff.ts) + `yan:getHandoff` 回传最近 40 条。② **F1 目标控制**：A1 目标进终态（report / 重复拦下）时**同时**清 `goals.json` 与薄层快照；A2 新增 `GoalEntry.paused` + `setPaused`/`isPaused`，`yan:abort` 改成「先暂停清快照 → 再停回合」，新增 `yan:stopGoal` 作为与暂停分开的终态出口；A3 `yan:setWorkMode` 按「自主档 or pursue」判断是否保留续行（旧实现切回标准档时漏清）；A4 [`repeat-guard`](../../src/shared/repeat-guard.ts) 的 `pendingRepeatFailures(counted, blocks)` 改用**独立按目标分立的消费游标** `GoalEntry.repeatCursor`（不再用 `failure.count` 当账本，新目标只建基线）；A5 [`goal-resume.js`](../../resources/pi-extensions/goal-resume.js) 把「读到已消费的旧记录」也纳入等待窗口，不再直接 return；A6 `GoalStore.armContinue` 对同一待发操作幂等（`reason: 'pending'`），不再重复递增轮数。 |
| 自动检查 | `npm run typecheck` / `npm run build` 通过；`npm run test:unit` **4572/4572** —— 新增 [`test-handoff-diagnostics.mjs`](../../scripts/test-handoff-diagnostics.mjs)（≈30 条：凭证与长文本不得进日志 / 未知类型降级 / JSONL 跨实例读回 / 坏行跳过 / 落盘行数有界 / 写失败不抛），`test-goal.mjs` 新增 17 条（A2 暂停≠放弃、A3 改档保留判据、A6 幂等不烧轮数、A4 基线·增量·换目标重建），`test-goal-resume.mjs` 新增 3 条（A5 已消费旧记录不阻塞新指令、只发一次）。 |
| 真实运行 | **cost 0**：`npm run test:live -- autocontinue` 全绿（2 条自动继续、上限停住、控制消息非伪造用户、无残留 pi 进程）—— 覆盖与本次改动共用的宿主 arm → 薄层消费链路。**cost 1 未跑**：`goal` / `goalloop` / `handoffpack` / `handoffcommit` 需要用户当次授权模型与额度。 |
| 视觉验收 | 不涉及界面改动（本轮只改主进程、共享契约与随包薄层）。F5 才会把 `HandoffView.events` 接到界面。 |
| 应用与包 | 未重跑 `dist:dir` / `test-packaged` / 便携包 / NSIS；未新增随包文件（`resources/pi-extensions` 只改了既有 `goal-resume.js`）。 |
| 剩余限制 | ① **F2–F7 全部未做**：交接的单一调度所有者、timer/poll 的 operationId 隔离（H1/H2）、用户会话与物理会话解耦（H3）、控制消息不冒充用户（H4）、持久交接状态 UI（H5）、推理随正文位置（R1）仍按实施-14 正文推进；② 用户现场「两次压缩后交接无提示且偶发报错」**仍未现场归因** —— 本轮给的是可观测性与目标控制修复，真实链路证据等 F7；③ `armContinue` 的轮数仍在 arm 时递增（靠幂等而非“真实启动确认”）；④ `HandoffView.events` 尚无可视化出口。 |

### 2026-09-23 · 自主目标与同会话无感交接修复档案（F0/F1 已实施）

用户反馈两次完整压缩后交接缺提示、偶发报错，要求底层交接后台完成且前端始终同一会话；另已确认推理窗口跟随的是**聊天中的正式回复位置**。唯一活动正文 [实施-14](../plan/active/实施-14-自主目标与无感交接修复.md) 收录上一轮 7 项审查问题及新增交接/推理缺口，给出 F0–F7、文件域、依赖、失败恢复与验收矩阵。**此历史记录当时**只完成 F0（阶段诊断）与 F1（目标控制 A1–A6）；F2–F7 的后续状态见上方更新记录，用户偶发错误的现场根因仍需用故障恢复用例归因。

| 六栏 | 本轮范围 |
|---|---|
| 实现 | 修复档案 + F0/F1；F2–F7 未实施。 |
| 自动检查 | 本轮 F0/F1 的自动检查见上一节；档案轮只做了文档链接与格式检查。 |
| 真实运行 | F0/F1 跑了 cost 0 的 `autocontinue`；cost 1 交接 / 目标链路未跑。 |
| 视觉验收 | 未生成新截图；推理跟随聊天正文及后台交接仍是已确认的产品要求。 |
| 应用与包 | F0/F1 未构建安装包、未应用、未打包。 |
| 剩余限制 | 按实施-14 完成交接调度/身份/控制消息和推理顺序修复，再分别记录真实运行与视觉证据。 |

### 2026-09-23 · 侧栏、子代理与全局 UI 规划（非实现交付）

用户本轮要求整合/补齐方案并切片，后续由其指派 agent；已确认“收起左侧项目栏时折叠更多会话”。已新增 [侧栏交互设计](../design/active/方案-侧栏工作台与子代理交互-2026-09-23.md)、[实施-12](../plan/active/实施-12-侧栏交互与可移动工具磁贴.md)、[实施-13](../plan/active/实施-13-全局UI精修与设计验收.md)，并完善实施-11 §5 的 H-3/H-9/H-10。核对既有源码与本表后，纠正图标准则“整项尚未实施”的过期描述；墨色工作空间核心已有实现，全局精修/完整验收仍待做。

| 六栏 | 本轮范围 |
|---|---|
| 实现 | 仅规划文档、索引与两张用户参考图副本；应用源码未改。 |
| 自动检查 | `npm run audit:refs` 的 `brokenDocLinks=[]`；本轮文档范围 `git diff --check` 通过。全工作树检查另报已有 `scripts/test-work-mode.mjs:54` 尾空格，未修改无关源码；引用审计其余静态告警未在本轮收口。不把文档检查当应用测试。 |
| 真实运行 | 未启动/重启应用，未调用模型。 |
| 视觉验收 | 用户图只作参考；没有新的产品窗口视觉验收。 |
| 应用与包 | 未构建、未应用、未打包。 |
| 剩余限制 | 新切片均待指派；尺寸/放置约束是设计基线，V-0 将补当前窗口证据；真实行为、视觉和包按各片分别收口。 |

### 2026-09-23 · 实施-11 H-6b：稳定逻辑回合、等待分段与用量聚合

> 队列位次 4b 的剩余三项（H-6b）。用户授权用 `deepseek/deepseek-v4.1-flash` 跑 cost 1 场景。

| 六栏 | 证据 |
|---|---|
| 实现 | ① [`shared/turns.ts`](../../src/shared/turns.ts)：新增 `turnUsageOf` / `addUsage` / `hasUsageNumbers`（整轮用量按消息 id 相加，有请求没报用量时 `partial`）、`toolWaitSpans` / `waitSpansMs`（区间并集，并行不重复计）；`groupIntoTurns` 输出 `usagePartial` / `waitSpans` / `waitMs`；② [`UsageBar.tsx`](../../src/renderer/src/components/chat/UsageBar.tsx) 改用聚合用量，下限标 `≥` 并在 tooltip 说明；③ [`TurnView.tsx`](../../src/renderer/src/components/chat/TurnView.tsx) 的用时 tooltip 补「其中等工具 N」；④ [`agent.ts`](../../src/main/agent.ts)：`turnRunId`（每个 pi 回合一个）、`logicalTurnId = anchorId`（用户消息 id）、落盘 `runId` 与 `waitSpans`；⑤ [`turn-timing-store.ts`](../../src/main/turn-timing-store.ts)：解析 `runId` / `waitSpans` + `mergeTurnRecords`（同 run 覆盖、不同 run 用时累加、旧记录无 `runId` 保持后者胜）；⑥ i18n 中英各 2 个 key；⑦ **附带修**：`ContextTab` 对 `policy.overridden` 容错（缺字段时整树白屏）、visual-matrix 两处 contextPolicy 桩补齐 `source` / `overridden`。 |
| 自动检查 | `typecheck` / `build` 通过；`test:unit` **4473/4473** —— `test-turns.mjs` 新增聚合 / partial / 区间并集 / `waitMs` 断言，`test-turn-timing-store.mjs` 新增同 run 覆盖、不同 run 累加、旧记录不翻倍。`audit:refs` 的 `brokenDocLinks = []`；`git diff --check` 干净。 |
| 真实运行 | **cost 0**：新场景 `usageagg`（10 条断言，已进 `npm run check` 列表）全绿 —— 输出 100 = 10+90、输入 3.00k、缺用量时 `≥90`、页脚 tooltip「其中等工具 2s」（两段重叠的 3s 不重复计）。**cost 1**（`YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash`）：`tokens`（真实单请求账单；顺手修掉一条 H-1 之后过期的「用量条上有用时」断言）、`turnrestore`（新增断言：记录锚定 `m0`、`logicalTurnId` = anchorId、带 `runId`）、`goalloop`（**16 条记录 / 1 个逻辑回合 / 4 个 run**；用时累加 36709ms > 单段最大 19016ms）。均无残留 pi 进程。 |
| 视觉验收 | `matrix-usageagg-1440x900-100-{dark,light}-2026-09-23-0312.png` 与 `matrix-usagepartial-…`（`YAN_MATRIX_ONLY=usageagg,usagepartial`，组 0/1 全绿、溢出 0px）；**已看图三张**：用量条显示 `输入 3.60k / 输出 120`（聚合值），下限态显示 `≥2.40k / ≥96`（深浅主题都可读）。 |
| 应用与包 | 未重跑 `dist:dir` / `test-packaged`；本片只改宿主与渲染层（未新增随包文件），包级证据归 09。 |
| 剩余限制 | ① **跨会话链交接**（handoff 换会话文件）的 `logicalTurnId` 归属未取证 —— 自动继续已由 `goalloop` 端到端验过，跨文件需要新场景；② 真 SIGKILL 的中途快照仍是未实测边界（H-6b 旧项）；③ `waitSpans` 未单列「等待用户」；④ **视觉矩阵组 0 仍有 9 个状态失败**（`autonomous` / `goalpursued` / `envbranches` / `envworktrees` / `envlinks` / `sourcesearch` / `subagentlaunch` / `subagent` / `subagentfailed`）—— 状态脚本自己返回 `no-branches` / `no-launcher` 等，说明是这些状态依赖的主进程数据桩与当前 UI 不同步（既存债，与本片文件域无交集）；本片顺手修的 ContextTab 白屏曾让其后 10 余个状态连带失败，修后组 0 失败从 21 项降到 9 项。 |

### 2026-09-23 · 实施-01 S5d：空壳扩展与死代码 bridge 收尾

> 01-S5 的尾巴之一：那个「什么都不注册」的空壳扩展。AGENTS.md 的迁移边界写着
> 「不保留空壳扩展」，它只是 pi 的加载占位，能力早已全部在 `yan browser …`。
> 删完扩展又顺着调用链发现：只服务于它的 loopback HTTP bridge 也没有消费者了。

| 六栏 | 证据 |
|---|---|
| 实现 | 删除 `resources/pi-extensions/browser.js`；[`src/main/index.ts`](../../src/main/index.ts) 去掉 `browserExtensionPath()` 并把它从 `yanThinExtensionPaths()` / `AgentController` 构造里移除；[`src/main/agent.ts`](../../src/main/agent.ts) 去掉 `browserExtension` 字段 / 选项与 `--extension` 参数；[`extensions-inventory.ts`](../../src/main/extensions-inventory.ts) 的 `builtinCapabilities()` 把「内置浏览器」登记为**宿主能力**（固定 id、无 `file`，与 `task-plan` 同形）；i18n 中英 `pkg.builtin.browserDesc` 改写为「宿主提供的原生浏览器视图；模型经 `yan browser …` 看网页、截图」；并删除只服务于它的 loopback bridge（`browser.ts` 的 `startBridge` / `bridgeEnv` / `readBody` / `handleRequest` / `json()` / `server` / `token` / `port` / `MAX_BODY` 与 `node:http` 导入，`index.ts` 的 `startBridge()` 与 `browserEnv` 注入，`agent.ts` 的 `browserEnv` 字段 / 选项 / `env` 展开）；另把 `browser.ts` / `browser/ElementRegistry.ts` 的两处 STALE_ELEMENT 文案从 `browser_observe` 改成 `yan browser observe`，`cliHint()` 保留为兜底。 |
| 自动检查 | `npm run typecheck` / `npm run build` 通过；`npm run test:unit` **4443/4443**（`test-unit.mjs` 的 browser 守卫改成「空壳文件不存在」并新增「宿主文案不点名旧工具名」静态断言，`test-extension-inventory.mjs` 更新内置清单断言）；`npm run audit:refs` 的 `brokenDocLinks = []`；`git diff --check` 干净。 |
| 真实运行 | `npm run test:live -- pkgs browser browserboundary browsercli`（cost 0）全绿：`pkgs` 新增 3 条断言（内置能力区列出宿主「内置浏览器」/ 该条不带扩展文件名 / 不再出现 `browser.js`）；`browser` 场景（Google 标题、右栏、元素数、标签页与原生 bounds）不受影响；删 bridge 后 `browserboundary`（授权 / 网络 / 下载边界）与 `browsercli`（进程外 CLI、press 带回新观察、用户接管门禁）也重新跑通（视觉矩阵自身全 10 组通过）。无残留 pi 进程。 |
| 视觉验收 | `matrix-settingspkg-1440x900-100-{dark,light}-2026-09-23-0221.png`；**两张都已看图**：内置能力区依次为「任务计划 内置」（无文件名）→「内置浏览器 内置」+ 新描述（无 `browser.js` 文件名）→ 其余薄层扩展仍带文件名；溢出 0px。 |
| 应用与包 | 未重跑 `dist:dir` / `test-packaged`；打包路径 `resources/pi-extensions → yan-thin` 不变，包级证据归 09。 |
| 剩余限制 | ① bridge 删除后，**不再存在**供第三方进程读写浏览器的 HTTP 通道（有意收窄：01-S5 后砚不加载用户扩展，也不给第二个入口；将来若要恢复需重新设计，不重建旧 token 通道）；② 内部文案已改完，但 `cliHint()` 仍只是**字符串改写**而不是编译期约束（靠静态断言防回归）；③ 04 其它资源类型包级候选证据与最终发布门槛仍待复核。 |

### 常规接手步骤

1. 阅读根目录 [AGENTS.md](../../AGENTS.md)，检查 `git status --short`，保留已有改动。
2. 从下面的「当前未完成」选一组任务；**执行顺序与切片看 [实施计划](../plan/README.md)**；用 [PROJECT](../PROJECT.md) 和 [CODE-MAP](CODE-MAP.md) 定位实现。
3. 按 [TESTING](TESTING.md) 做相应检查，把证据登记回本表（六栏口径见文末）；打包按 [RELEASING](RELEASING.md)。

## 当前基线（最近一次自动验证：2026-09-22；部分真实运行仍为 2026-09-20）

> 上一轮完整 `npm run check` **全部通过（83 个 live 场景）**；其中 `npm run typecheck` / `npm run build` / `npm run test:unit` **4158/4158**、`vendor:pi:check`、设计测量均通过。那一轮实际调用模型的场景使用本地 llama.cpp；随后按用户要求停止本机模型服务，当前不把本地模型作为运行前提。随后按最新源码重跑 `npm run dist:dir` 与 `npm run test:packaged`，解包、便携版与全新 NSIS 安装态 EXE 的运行探针均通过。能力设置页的安全快照、显式 MCP 核验 / 取消 / 重连与项目隔离回归仍在矩阵内；本轮也保留 acquisition staging manifest 精确文件集核对（拒绝未登记文件、缺失文件及符号链接），并新增 `mcp-package` 的精确 bin 解析、官方 SDK `tools/list` smoke、项目范围 stdio 登记 / 复核回归、受保护环境变量拒绝和超时清理回归。Pi 离线 RPC smoke 通过。能力设置页已用真实 Electron 视觉矩阵生成并看图核对：深浅主题的策略 / 能力目录 / Skill / MCP 服务状态均无溢出，截图见 `matrix-capabilities*` 与 `matrix-capabilitiesmcp*`（2026-09-21-cap2）。Computer Use 原生后端仍未配置（`apps: []`)，但不影响本次独立的 `capturePage` 视觉证据。Pi 自写无副作用 fixture 以资源 glob 加 `!` 排除成功加载并触发 `session_start`，且父进程注入的 sentinel 环境变量未传入 Pi；随后 `skillacquire` 在用户明确授权下完成了一个外部 Skill 文件候选的 acquire → staging → 安全审查 → active → 同一 runner 重载 → 原目标 `resumed`，当前未覆盖的是其它资源类型的外部候选包级证据及其解包 / 便携 / NSIS 包内运行级证据。工作区仍有大量已有未提交改动，保留不清理。
> **本轮更正（2026-09-22）**：上一句“没有获授权外部候选……”是本轮开始前基线；随后用户明确授权后，`skillacquire` 已对一个真实 SkillMD 候选取得 acquire → staging → 安全审查 → active → 同一 runner 重载 → 原目标 `resumed` 证据。其它资源类型的包级候选与最终发布门槛仍按“当前未完成”保留。

### 本轮增量（2026-09-22）· 自主档不会自动续行（报障：续行消息发给了不存在的通道）

> 用户观察：自主档下报完进展就停住，不会自己接着干。
> 现场硬证据：`goal-resume/r1.json`（15:06:55）已写入，但 `r1.consumed.json` 里还是
> 14:43 那个旧 `operationId` —— 续行写了、从来没人消费。
> **真因（两条，都要修）**：① **主因** —— 发送写的是 `context.sendMessage?.()`，而 pi 0.85.1 的
> 钩子 ctx **没有** `sendMessage`（`createContext()` 只给 `cwd / model / modelRegistry /
> sessionManager` 等 getter）；可选链把失败吞了 —— 日志里写着 `resume_sent`、
> `operationId` 也记成已消费，而消息从未发出去。② **次因** —— 检查点 `message_end` 比宿主的
> arm（挂在 `state` 推送、即 `agent_settled` 之后）更早，只读一次盘会整轮错过。

| 六栏 | 证据 |
|---|---|
| 实现 | [`resources/pi-extensions/goal-resume.js`](../../resources/pi-extensions/goal-resume.js)：① 发送方改成 `pi`（`ctx` 带 `sendMessage` 时优先用 ctx —— 重载后 `pi` 会被 invalidate，`test-handoff-request.mjs` 里有这条护栏）；两边都没有时**不写消费证据**并记 `resume_failed(reason=no-sendMessage)`；`appendEntry` 同理（对比 `context.js` 用的 `pi.appendEntry` 才是对的写法）。② 检查点加 `agent_settled`（更接近宿主 arm 完成的一刻，不累加 activity，靠 token 让后者接管前者）+ `maybeResume` **窗口化读盘**（读空后每 1.2s 再读、最多 8 次 ≈9.6s，每次重试复查 token）。③ 诊断补 `resume_sending.via=pi|ctx`、`agent_settled.hasContext`、`before_agent_start`。测试通道 `YAN_GOAL_RESUME_DELAY_MS / POLL_TRIES / POLL_MS`。 |
| 自动检查 | `typecheck` / `build` 通过；`test:unit` **4441/4441**（`scripts/test-goal-resume.mjs` 15 条：晚到 resume 也能消费 / 只发 `agent_settled` 也能消费 / 幂等不重发 / 二次确认与窗口轮询期间让位 / 让位的那份留到下一次 / **ctx 没有 sendMessage 时走 pi** / **新 ctx 带 sendMessage 时换成它** / **没有发送方时不发也不写消费证据**） |
| 真实运行 | `test:live -- goalloop`（cost 1，真模型）**通过**：第 4 节「自动续接真的起了新回合（目标被再次推进：rev1 → rev2，助手 2→7）」；退出后检查三条全绿 —— 会话里有 `yan-goal-resume` 消费证据、有 **`yan-goal-continue` 控制消息**、且它不是伪造的用户消息。薄层日志链路：`resume_sending via=pi` → `resume_sent` → 新回合的 `before_agent_start`。 |
| 视觉验收 | 不涉及界面。 |
| 应用与包 | 未重跑打包；只改随包薄层文件。 |
| 剩余限制 | ① 这是**跨版本 API 漂移**（pi 升级后 ctx 语义变了）：薄层里其它 ctx 用法已复查，只剩 `ctx.model` / `ctx.sessionManager`，都是 `createContext()` 提供的；② 「宿主写文件 + 薄层在 pi 事件里读」仍然靠窗口 + 轮询，没有「请求已就绪」的通知通道；③ 顺手修了 `goal-loop.js` 探针的**全局 deadline**（原来一节慢会让后面全红）与两处过时判据（不再押 `phase`、允许自主链在一轮里跑很多回合）；④ 交接链路的同类窗口修复见上一节。 |

### 本轮增量（2026-09-22）· 两条超时报障修复（compact / 交接包）

> 用户同一天报回两个超时。**根因不同**：一个是 RPC 默认超时用在模型调用命令上，
> 一个是宿主与薄层的请求文件竞态。排障经验已记入 `MAINTENANCE.md`。

| 六栏 | 证据 |
|---|---|
| 实现 | ① `agent.ts` 新增 `COMPACT_REQUEST_TIMEOUT_MS = 300_000`：`compact` 是**模型调用**（长会话几分钟很正常），不能沿用 `REQUEST_TIMEOUT = 30_000`；`compact()` 契约改成**不抛**（超时/进程挂了都归 `{ ok: false }`），`evaluateContextPolicy` 再补 `catch` —— 它的调用点是 `void` 出去的，原来会直接把异常变成主进程 `unhandledRejection`。② `resources/pi-extensions/handoffs.js`：`agent_settled` 后给请求文件落盘留**等待窗口**（默认 **20×1000ms**，`YAN_HANDOFF_SETTLE_TRIES/MS` 是测试通道）—— 宿主的 arm 链（收 state 推送 → load store → 写请求）天然晚于 pi 同时发出的 `agent_settled`，原来只读一次盘就 return，请求再没人处理，用户只能等到 90 秒后的弹窗；同时把**独占锁前移到等待之前**（否则两次触发会各调一次模型），并在 `check` 行里记 `ageMs`（宿主请求写下来到 `agent_settled` 的间隔）。③ 宿主侧两道：`abandonHandoff` 在 90 秒超时放弃**之前**再收一次结果（挡掉「只差几十毫秒」的假超时，`collectHandoffResult` 因此改成返回 `boolean`）；写请求 / 超时各留一行 `[handoff] …` 控制台日志。 |
| 自动检查 | `typecheck` / `build` 通过；`test:unit` **4398/4398**（新增 `scripts/test-handoff-ext.mjs` 18 条：请求晚到也能生成 / 确实等过（`attempts`）/ **默认窗口 ≥ 15 秒**（读源码断言，防调参拆护栏）/ 过期遗物不重做且清请求 / 同 operationId 不重复调模型 / 无模型注册表不写结果 / 真没请求时不凭空造包） |
| 真实运行 | `test:live -- handoffpack`（cost 1，真模型，自主档 + 阈值 0）修复后两次都过。**关键证据**：扩展日志 `check {hasRequest:true, attempts:1, ageMs:1005}` —— 宿主的请求写下来时距 `agent_settled` 已过 **约 1 秒**，所以修复前（窗口为 0）这条链**每次都超时**（与用户报的「自主模式交接」吐合：交接要「目标在推进 + 不忙」才 arm，自主链连续跑回合，arm 推到链尾之后）；`produced ms≈4.7s, chars≈1.2k`。 |
| 视觉验收 | 不涉及界面（改了主进程与薄层的超时 / 时序）；弹窗文案未变。 |
| 应用与包 | 未重跑打包；未新增随包文件（只改 `resources/pi-extensions/handoffs.js`）。 |
| 剩余限制 | ① 其它可能超 30 秒的命令未动（如 `export_html` —— 长会话导出）——无实测证据，按下不改成；② 交接链路的现场仍需要 `YAN_HANDOFF_EXT_LOG` 才能看见，生产默认不开（宿主侧的 `[handoff] …` 行是一半，另一半在薄层）；③ 超时放弃前的那次「最后收集」属边界时序，**没有自动化覆盖**（要 90 秒 + 压线写入才能构造），这次只做了代码审查；④ 本期两处修复不涉及第 4–6 步。 |

### 本轮增量（2026-09-22）· `+` 菜单 codex 化 + 持续目标（目标 f74930c3 第 1–4/6 步）

> 目标：把输入区的 `+` 做成 codex 式「添加」菜单。本片只做**入口与两项**；
> 「目标」、档位定位、可配置快捷键、重复动作兜底是后续四步。

| 六栏 | 证据 |
|---|---|
| 实现 | `+` 从「直接开图片选择器」改成 `PlusMenu`（`Composer.tsx`）：**文件和文件夹**（新 `yan:pickFiles` → **只回路径** → 复用 `addFileRefPaths` 的校验/来源登记链路）、**图片**（原 `pickImages`）、**能力**分组（打开时才拉 `capabilities.snapshot()`，列已装技能与 MCP 服务器；点击把「使用能力「X」：」插到光标处，`insertAtCursor` 保留用户已写位置）；空态整块可点直达 设置 → 能力。契约 / 桥 / 主进程三处同步（`shared/ipc.ts` 的 `pickFilePaths`、`preload/index.ts`、`main/index.ts`）。 |
| 自动检查 | `npm run typecheck` / `npm run build` 通过；`npm run test:unit` **4370/4370** |
| 真实运行 | 新场景 **`plusmenu`（cost 0）16 条全绿**：菜单默认收起 / 点开 / 三项与文案 / **几何**（w=320 且整体落在视口内 —— 专防 `.composer` 的 `overflow:hidden` 把浮层裁掉）/ 能力分组给出空态或已装项 / 点外部与 `Esc` 都收起 / 收起后还能重开。回归 `workmode`（cost 0）通过。 |
| 视觉验收 | 新状态 `plusmenu` → `matrix-plusmenu-1440x900-100-{dark,light}-2026-09-22-plusmenu.png`，**两张都已看图**：菜单在输入框上方完整可见（未被裁）、三项与说明文案正确、能力分组列出了已装能力（发布验收 / 项目知识 / 本地 MCP Fixture），溢出 0px。 |
| 应用与包 | 未重跑打包；随包资源清单未变（没新增薄层文件）。 |
| 剩余限制 | ① 「目标」入口、档位定位、Ctrl+Tab 可配置快捷键、单轮重复动作兜底是后续四步；② 「文件和文件夹」与「图片」会开系统对话框，探针只验存在与几何，真实点击留给人工视觉验收；③ 能力分组的点击语义目前是「把能力引用插进消息」，不是开关连接器。 |

#### 第 2 步 · 持续目标（`+` 菜单 → 目标）

> 口径：**目标与档位正交**（用户 2026-09-22 拍板）——“持续目标”是目标语义，
> 自主档是档位语义；设了目标，非自主档也会在回合收尾后继续被叫醒。

| 六栏 | 证据 |
|---|---|
| 实现 | 契约 [`shared/goal.ts`](../../src/shared/goal.ts)：`GoalState` 新增 `pursue: boolean` 与 `brief: PursuedBrief \{ goal, outcome \}`，新纯函数 `applyPursuedGoal`（重开计划 + 置 pursue + revision+1），`goalContinueSummary` **复述用户原话与达成判据**（不让模型自己把目标做小），`normalizeGoalState` 对旧记录 / 脏值宽容。存储 `main/goal-service.ts` 新增 `startPursued`（真落盘、清旧步骤 / 幂等记录 / 未发续行、续接计数归零）。接线 `main/index.ts`：`maybeArmAutonomousGoal` → **`maybeArmGoalContinue`**（`mode !== autonomous` 时还要看 `goal.pursue`），新 handler `yan:setGoal`（身份只取当前会话，两栏必填，拒收不回可读原因）。界面：`+` 菜单第二层目标表单（两栏 + 开始 / 返回，填不齐则按钮禁用），成功后才把 `[持续目标] … / 达成判据：…` 写进输入框（`insertAtCursor`）；右栏 [`GoalSection.tsx`](../../src/renderer/src/components/toolbar/GoalSection.tsx) 新增「持续目标」标记与 `goal-brief`（用户写的目标与判据原样显示在模型登记的步骤之上）。 |
| 自动检查 | `typecheck` / `build` 通过；`test:unit` **4380/4380**（新增 10 条：pursue 置位 / 原话与判据落盘 / 续行正文含判据 / 重设目标清旧步骤且计数归零 / 磁盘往返 / 旧记录与脏值不得凭空造身份） |
| 真实运行 | `plusmenu`（cost 0）**扩到 27 条全绿**：目标项与说明 / 进表单 / 空栏与半填时「开始」禁用 / 两栏齐了才可点 / 开始后菜单收起且输入框出现模板 / **`getGoal` 里 `pursue=true` 且判据原样存下** / 右栏目标面板出现。本场景会真建目标（写隔离的 `goals.json`），但**不产生模型调用** —— 续行只在 `message_end` 被消费，而该场景没有模型回合。 |
| 视觉验收 | 新状态 `plusgoal`（表单，两栏已填）与 `goalpursued`（建立后的右栏面板）→ `matrix-{plusgoal,goalpursued}-1440x900-100-{dark,light}-2026-09-22-goal.png`。**已看图**：`goalpursued` 深浅两张显示「持续目标」标记 + 目标 / 达成判据 + 计划第 3 版 · 2/4 步 + 完成证据；`plusgoal` 的表单（标题 / 两栏 / 开始·返回）在 dark 图里看过。溢出 0px。 |
| 应用与包 | 未重跑打包；未新增随包薄层文件。 |
| 剩余限制 | ① 目标达成仍靠模型 `yan goal report` + 证据（沿用既有契约，没新增自动验收器）；② 用户手写的目标只在本会话生效（与目标存储同键），不跨会话/交接迁移；③ 档位定位、快捷键、重复动作兜底仍是后续三步。 |

#### 第 4 步 · 模式快捷键改成全局 `Ctrl+Tab`（可改键 / 可关）

> 用户口径（2026-09-22）：模式切换改成 `Ctrl+Tab`，**焦点不在输入框也生效**，
> 设置里可改键、可禁用。旧的裸 Tab 快切下线（不再保留第二个入口）。

| 六栏 | 证据 |
|---|---|
| 实现 | 纯逻辑 [`shared/work-mode.ts`](../../src/shared/work-mode.ts)：`DEFAULT_WORK_MODE_BINDING = 'Ctrl+Tab'`、`KeyBinding` / `parseKeyBinding` / `formatKeyBinding` / `bindingFromKey` / `isUsableKeyBinding` / `normalizeWorkModeShortcut` / `matchesKeyBinding`、`isWorkModeShortcutEnabled`（替掉 `isWorkModeTabShortcut`）。设置 [`ipc.ts`](../../src/shared/ipc.ts)：新增 `workModeShortcut?: string`（`undefined` = 默认 / `''` = 无绑定 / 其余是规范化组合键）+ `workModeShortcutEnabled?: boolean`，**删除 `workModeTab`**；[`settings.ts`](../../src/main/settings.ts) 读时迁移（旧 `workModeTab === false` → 关，幂等，不再写回）+ patch 清洗。界面：全局监听改在 [`App.tsx`](../../src/renderer/src/App.tsx)（`window` capture；录音中让路；repeat 只算一次），[`Composer.tsx`](../../src/renderer/src/components/chat/Composer.tsx) 删掉裸 Tab 分支与那层 capture 兜底（`Esc` → 焦点到模式按钮保留）；设置页把「Tab 快切」那行换成「模式快捷键」：**键位按钮（点一下录音，键位写在 `data-binding` 上）+ 「默认」重置 + 开·关**，录音时只按修饰键不算、裸键拒收并提示原因。 |
| 自动检查 | `typecheck` / `build` 通过；`test:unit` **4415/4415**（新增 18 条纯逻辑断言：默认值是 `Ctrl+Tab` / 脏写法规范化 / 裸键与非法值不收 / `Cmd`=`Meta` / 只按修饰键不算 / 空格叫 `Space` / 未设置时按默认比 / 裸 Tab 不匹配 / 大小写无关 / **多按修饰键不算命中**） |
| 真实运行 | `test:live -- workmode`（cost 0）全绿。新第 4 节用**主进程真按键**（`keys: 'ctrl+tab,ctrl+tab'`）：先把焦点放在**模式按钮**（不在输入框）再按键 → 两次循环到自主，并断言**裸 Tab 不再被拦**（`defaultPrevented === false`）；第 6 节开关（关掉后按键不被拦、重置后不落盘）；第 7 节**录音改键**（点键位 → 按 Ctrl+Shift+K → 落盘 / 录音那次不切模式 / 新键能切 / 旧 Ctrl+Tab 失效 / 「默认」按钮清掉自定义值）。 |
| 视觉验收 | 新状态 `workmodekey` → `matrix-workmodekey-1440x900-100-{dark,light}-2026-09-22-wmkey2.png`；另重拍 `workmodemenu` 两张（同 stamp）——**已看图**：设置页「模式快捷键」行为「在任何地方按下它，循环标准 → 计划 → 自主；必须带 Ctrl / Alt / Shift」+ 键位按钮 `Ctrl+Tab` + 「已开启」，上一行说明也换成「（Ctrl+Tab 切换）」，溢出 0px |
| 应用与包 | 未重跑打包；未新增随包薄层文件。 |
| 剩余限制 | ① 快捷键是**渲染层**消费的 —— 窗口未聚焦时不生效（不做 OS 级全局热键）；② 旧 `workModeTab` 只读不写，磁盘上残留的旧键不再清（幂等迁移，无副作用）；③ 录到系统保留组合（如 Ctrl+Alt+Del）时我们只能存不能用，未做冲突检测（探针也不模拟）；④ 只验了中英两套文案与当前主题下的外观。 |

#### 第 3 步 · 档位定位：计划档 + 自主档

> 用户口径（2026-09-22）：澄清档「偏向作为计划模型推进」；自主档「不询问问题，自行分析问题并解决」。
> **内部 id 仍叫 `clarify`**（它是 `work-modes.json` 里的存量值，改 id 要写迁移而迁移无用户可见收益）；
> 界面名与提示词里是「计划」。代码注释与测试文案里的中文也统一成「计划档」，
> 免得下一会话读代码时以为界面叫澄清。

| 六栏 | 证据 |
|---|---|
| 实现 | [`question.js`](../../resources/pi-extensions/question.js)：计划档从「把目标问清楚」改为**产出计划** —— 新增「先用 read/grep/find/ls 读现状」「用 `yan goal report`（phase `planning` + 具体 `steps`）把计划登记下来；只活在回复里的计划不算计划」，保留只读限制与 `yan goal ready` 出口；自主档从「自己拿主意」改为**自行诊断** —— 新增「先找出真正的成因或约束（读代码 / 跑失败用例 / 看真状态），不要停在第一个看起来合理的猜测上」「选你能辩护的方案、一行说明理由、实施并自证」。界面：`workMode.label.clarify` → **计划**、`workMode.desc.clarify` → 「先读代码、出计划；确认后再动手」、`workMode.desc.autonomous` → 「不问问题，自己分析问题并解决」、`set.workModeTabDesc` 同步。模型可见的其它文案：`agent.ts` 两条能力门禁拒因、`capabilities/catalog.ts` 的 `goal.ready` / `goal.status` 描述、`shared/goal.ts` 的 `readyResumeSummary`（“计划阶段结束”）。 |
| 自动检查 | `typecheck` / `build` 通过；`test:unit` **4380/4380**（`test-question.mjs` 两条断言从 `/Clarify mode is ON/` 改为 `/Plan mode is ON/`，并补回「2-4 个具体选项」那条） |
| 真实运行 | `test:live -- workmode`（cost 0）通过：菜单三档、Tab 真按键快切、A/B 会话不串档、退出后 `work-modes.json` 落盘校验均正常 |
| 视觉验收 | `matrix-workmodemenu-1440x900-100-{dark,light}-2026-09-22-planmode.png`（另有一张 900x520）：**已看图** —— 菜单三档为「标准 · 正常执行；信息不足时先问你」「**计划** · 先读代码、出计划；确认后再动手」「**自主** · 不问问题，自己分析问题并解决」，输入区模式按钮显示「计划」，溢出 0px |
| 应用与包 | 未重跑打包；未新增随包薄层文件。 |
| 剩余限制 | ① 计划档仍**只读**（工具表收紧 + bash 白名单不变）—— “按计划推进”指的是先用 `yan goal report` 登记步骤、就绪后 `ready` 转标准执行，不是允许计划档直接改代码；② 提示词是软约束，真实模型是否真的先诊断再动手由 `goalloop` / `goal` 场景（cost 1）覆盖，本片未重跑；③ 快捷键与重复动作兜底仍是后续两步。 |

### 本轮增量（2026-09-22）· 实施-11 C-5 尾：右栏档位名与容量来源

> 队列位次 9 的剩余两项（原 C-5 增量把它们留作「剩余限制 ①③」）。
> 修的是同一个问题：右栏只给数字，用户没法从右栏回答「我在哪一档、这些数谁定的」。

| 六栏 | 证据 |
|---|---|
| 实现 | [`shared/context-policy.ts`](../../src/shared/context-policy.ts) 新增 `largePresetOf()`（试行档识别，设置页按钮与右栏共用）+ `LARGE_PRESET_NAME_KEYS`；`ContextPolicyView` 增加 `modelOverrides`（精确模型层原文，`agent.ts` 与 `yan:contextBudget` 两处同口径）；[`RightPanel.tsx`](../../src/renderer/src/components/toolbar/RightPanel.tsx) 新增 `ctx-preset` 行（默认行下方）与详情里的 `ctx-source-line`；i18n 中英各 3 个 key。 |
| 自动检查 | `npm run typecheck` / `npm run build` 通过；`npm run test:unit` **4370/4370**（`test-context-policy.mjs` 新增 8 条：预设原文命中、**只留上限也算均衡档**（设置层会丢掉与默认相同的 `windowRatio`）、比例 / 数值 / 额外字段不同则自定义、无覆盖不显示、i18n key 与设置页同源）。 |
| 真实运行 | `npm run test:live -- contextbudget`（cost 0）全绿：写入「长材料」试行档后右栏出现 `data-preset="long"`、文案「档位 长材料 · 700K（写在当前模型上）」；展开详情读到「容量来源 模型级 · commandcode/…」；`context`（cost 0）回归通过。 |
| 视觉验收 | 新状态 `ctxpreset`（数字自洽：均衡档 600K 在 400k 窗口上被 min() 压到 280k）—— `matrix-ctxpreset-1440x900-100-{dark,light}-2026-09-22-c5tail.png`，**两张都已看图**：`档位 均衡 · 600K（写在当前模型上）`、`工作集 36k / 280k · 13%`、详情里 `容量来源 模型级 · deepseek/deepseek-v4.1-flash`，溢出 0px、无遮挡。 |
| 应用与包 | 未因本片重跑 `dist:dir` / 便携包 / NSIS；包级证据归 09（**用户 2026-09-22 明确：暂无发布计划，全量门槛不着急**）。 |
| 剩余限制 | ① 三类动作分别统计仍是 **C-2b**；② 曾登记的「详情展开后被 store 推送收回」已自查**更正为探针自身的 bug**（无条件 `click()` + 在 React 提交前读 DOM），现为幂等探针 + 四条真护栏（进入本节仍展开 / 静置 400ms / store 推送后 / 再点一次才收起），未发现右栏重挂载；教训已归 `MAINTENANCE.md`；③ 档位名只对「精确 `provider/model` 覆盖」生效，用户级预设仍只在设置页展示。 |

> **当晚追加（同一片）**：同一探针新增四条护栏 —— 详情展开态「进入本节仍展开 / 静置 400ms /
> store 推送后 / 再点一次才收起」；并把先前登记的「展开态被推送收回」自行**更正为探针 bug**
>（无条件 `click()` 把已展开的详情又关上了，而读取跑在 React 提交之前，读到旧 DOM）——
> 产品侧未发现重挂载；教训归 `docs/dev/MAINTENANCE.md`。

### 本轮增量（2026-09-22）· 实施-01 S5c：`context_recall` 迁到宿主 CLI（薄层不再注册模型工具）

> 这是 01-S5 的最后一段尾巴（此前 S5a 关默认发现链、S5b 把 `question` 交给宿主）。
> 迁移前薄层是 16 个文件里唯一还注册模型工具的地方；迁移后三个入口各归其位：
> `yan browser` / `yan question ask` / `yan context recall`。

| 六栏 | 证据 |
|---|---|
| 实现 | 删除 [`context.js`](../../resources/pi-extensions/context.js) 的 `registerRecallTool` 与它专用的 `rawTextOf` / `textResult` / `audit`（`findArchiveEntry` / `mergeArchive` / `loadLedger` / `saveLedger` 仍被归档查询与 TTL 钩子使用，保留）；[`context-transform.js`](../../resources/pi-extensions/context-transform.js) 的三处**模型可见**文案（墓碑、`<TASK_STATE>` 归档引用行、TTL 存根）统一改成 `yan context recall --ref …`；[`extensions-inventory.ts`](../../src/main/extensions-inventory.ts) 的来源诊断改为「只承载无 CLI / RPC 等价物的钩子，不注册模型工具」。宿主侧实现（`src/main/context-recall.ts`：预算 / 审计 / 并发串行 / 逐字原文）此前已就绪，本片只收口入口。 |
| 自动检查 | `npm run typecheck` / `npm run build` 通过；`npm run test:unit` **4362/4362** —— 新增 [`test-context-recall.mjs`](../../scripts/test-context-recall.mjs)（13 条宿主侧确定性断言），`test-context-transform.mjs` 旧工具用例换成「扩展不注册模型工具 + 墓碑指向 CLI」，[`test-extension-inventory.mjs`](../../scripts/test-extension-inventory.mjs) 新增静态扫描（16 个薄层文件无 `registerTool` / `registerCommand`）；`git diff --check` 干净。 |
| 真实运行 | `YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash npm run test:live -- contextsweep`（**cost 1**）全绿：模型侧 `context_recall` 工具调用 **0 次**，改由 `bash` 调 `yan context recall --ref ctx://tool/49e3ab3c`（真实回执 `{"kind":"context","action":"recall","tokens":2224,"turn":2}`）；退出后审计由**宿主**写入 `result: ok / tokens: 2224`，下一轮 `expiredRecalls≥1` —— 宿主的 `[Recalled context]` 包装头仍被薄层 TTL 钩子认得。同批 `contextstate`（cost 0）通过；`context`（cost 0）顺带修掉一条 C-5 遗留的陈旧分母断言（旧断言还要求主值分母换成工作集）。 |
| 视觉验收 | 无 UI / CSS 改动：墓碑与召回存根是**发给模型的消息**，不进界面转录，不以截图替代运行证据。 |
| 应用与包 | 本轮未重新生成 `dist:dir` / 便携包 / NSIS；打包路径不变（`resources/pi-extensions → yan-thin`），包级证据仍归 H-5 与实施-09。 |
| 剩余限制 | ① 归档正文超过受管文件上限（4 MiB）仍「拒绝并解释」，不切片；② 模型是否**主动**回读仍取决于模型行为 —— 可信的是它已没有任何 `context_recall` 工具可调；③ recall 类策略的整体收益仍按 06 的 N21-9 结论（收益不成立），本片只收口载体，不重开收益评估；④ `browser.js` 空占位与其它资源类型的包级候选证据仍按「当前未完成」保留。 |

### 本轮增量（2026-09-22）· 工具栏拖拽回归与 H-1 探针同步

| 六栏 | 证据 |
|---|---|
| 实现 | [`RightPanel.tsx`](../../src/renderer/src/components/toolbar/RightPanel.tsx) 的指针拖拽收尾以 `elementFromPoint` 为首选，并回退到 `toolDropTarget` 共享落点，确保合成 PointerEvent 下仍执行排序与落盘；[`scripts/probe/motion.js`](../../scripts/probe/motion.js) 按 H-1 当前契约检查助手回合左侧砚图标，不再要求已移除的正文顶部品牌标签。 |
| 自动检查 | `npm run typecheck`、`npm run build`、`npm run test:unit` **4322/4322**、`git diff --check` 通过。 |
| 真实运行 | `env -u ELECTRON_RUN_AS_NODE npm run test:live -- tools motion` 全绿：工具栏拖拽插入位置与 `toolOrder` 落盘均通过；motion 也通过。 |
| 视觉验收 | 本片没有视觉改动；沿用 H-1 的助手回合页脚与左侧砚图标视觉证据。 |
| 应用与包 | `out/` 已按本片源码重新构建；未重新生成 `dist:dir` / 便携包 / NSIS，包级证据仍以既有发布验收为准。 |
| 剩余限制 | `elementFromPoint` 在合成事件下的回退已覆盖，但未新增跨缩放比例的视觉矩阵；其它资源类型的外部候选包级整链、Android 客户端与最终发布门槛仍按下方当前未完成清单处理；一个用户授权 Skill 文件候选的开发态整链已由 `skillacquire` 单独取证。 |

### 本轮增量（2026-09-22）· 实施-11 H-3/H-4b：工作窗口保留与 Markdown 阅读出口

| 六栏 | 证据 |
|---|---|
| 实现 | 新增 [`state/workbench.ts`](../../src/renderer/src/state/workbench.ts)：按 `sessionFile/sessionId` 隔离并持久化版本化 tabs、活动资源、宽度、展开态；[`RightPanel.tsx`](../../src/renderer/src/components/toolbar/RightPanel.tsx) 接入后，浏览器 / 文件 / 审查 / 子代理资源切换不再销毁。[`FilePreview.tsx`](../../src/renderer/src/components/toolbar/FilePreview.tsx) 对 Markdown 增加安全的 GFM 阅读 / 源码切换，错误态提供重试；[`subagent-isolation.ts`](../../src/main/subagent-isolation.ts) 遇到 Windows 已跟踪保留设备名（本工作区的 `nul`）时，以 `--no-checkout` + 有效路径 index 恢复隔离 worktree，不删除或改写原文件。 |
| 自动检查 | `npm run typecheck`、`npm run build`、`npm run test:unit` **4334/4334**、`git diff --check`、`npm run vendor:pi:check -- --if-present`、`env -u ELECTRON_RUN_AS_NODE npm run measure:design`、`npm run audit:refs` 通过；最终还重跑 `npm run dist:dir`。审计报告明确记录 Git 因跟踪 `nul` 无法读取 status（`short read while indexing nul`），未把它伪装成干净。 |
| 真实运行 | `env -u ELECTRON_RUN_AS_NODE npm run test:live -- rightresources filelink tools motion` 全绿（4 场景）；`YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash npm run test:live -- subagent` 全绿：真实 worktree 子代理、RPC 转录、详情、停止与孤儿进程回收；同时覆盖了 `nul` 导致的 Windows checkout 回退。 |
| 视觉验收 | 沿用 `matrix-filelink-*`、`matrix-subagent*` 与右栏资源既有截图；本片没有新增截图，不把未重拍视觉矩阵写成新证据。 |
| 应用与包 | `npm run dist:dir` 成功生成最新 `release/win-unpacked`；`npm run test:packaged` 全绿：解包态内置 pi、项目知识、Git、上下文策略、能力页、yan CLI 与远程服务边界均通过。本片未生成 NSIS / 便携包。 |
| 剩余限制 | 工作窗口仍是单活动表面，不是多文档 WorkbenchState；保留设备名会在隔离 worktree 中显示为缺失（不伪造为可读文件）；Git 状态审计仍受已跟踪 `nul` 的 Windows 限制，但审计脚本已隔离并显式报告；其它资源类型的外部候选包级证据、Android、真实 1M / 完整 Harness 证据仍未闭环；Skill 文件候选开发态整链已单独取证。 |

### 本轮增量（2026-09-22）· 实施-11 C-4b：估算口径（图片 / 附件不再当零）

> C-4 的剩余项：“请求估算仍以字符为主，对图片与 provider 特殊结构覆盖不足；
> 未知成本不得当零。”

| 六栏 | 证据 |
|---|---|
| 实现 | [`context-budget.js`](../../resources/pi-extensions/context-budget.js)：新增 `estimateContentTokens()`（递归）与 `NON_TEXT_BUDGET` 下限表 —— 图片按面积（像素 / 750）夹在 85–1600，**没尺寸时给 1100 中位数而不是 0**；附件 / 裸 base64 给 1000；认不出的块型给 128；`tool_result` 里嵌套的图片也计。同时修一个**真实链路上的真缺陷**：`payload.system` 只认字符串，而实测 pi 送来的不是字符串（旧实现算出 0，单测一直用字符串所以没暴露）—— 现在是字符串 / 数组 / 对象三种形状都认。 |
| 自动检查 | `npm run typecheck` / `build` 通过；`npm run test:unit` **4318/4318** —— `test-context-budget.mjs` 新增 14 条（文本口径回归、无尺寸图片 = 中位数、有尺寸按面积且夹上下限、OpenAI 风格 `image_url`、`file`/`data` 附件、未知块型、`tool_result` 嵌套、`toolCall` 不叠加 unknownBlock、图片把临界请求推进 soft、system 三种形状）。 |
| 真实运行 | `npm run test:live -- turnrestore`（**cost 1**）新开 `contextExtLog`，退出后读扩展诊断：真实 `before_provider_request` 留痕 `messages 1666 + tools 960 + system 0 = 2626`，预测量 `2626 + 32000 = 34626`，带着当时的预算线（工作集 240000 / 窗口 1048576）。`system = 0` 是**真实现象**（pi 把系统提示放在 messages 的 `role:'system'` 条目里），已写进断言注释，不把它当成漏估。 |
| 视觉验收 | 不改 UI（估算只影响扩展判定）；本片无新图。 |
| 应用与包 | 未因本片重跑 `dist:dir` / `test-packaged`，包级证据归 H-5 与实施-09。 |
| 剩余限制 | ① 图片下限是**保守值**，没有用真实多模态请求验证偏差（需要视觉模型 + 额度）—— 它保证的是“不会算成 0”，不是“算得准”；② 附件按固定下限算，不随体积增长（大附件仍会低估）；③ provider 特殊结构（缓存断点、schema 变体）仍未逐家覆盖；④ 硬闸门仍不能宣称精确可靠（C-4 原文口径）。 |

### 本轮增量（2026-09-22）· 实施-11 C-5：上下文窗口 UI 分层（分母口径）

> 队列位次 9。修的是两个相反的误读：`240k / 240k = 100%` 让人以为「1M 模型满了」；
> 而只给窗口尺度（`36k / 1M = 4%`）又会让人以为「还早得很」—— 钺在 240k 就动手了。
> 两个数一起给：主值走**物理尺度**，工作集单独一行。

| 六栏 | 证据 |
|---|---|
| 实现 | [`RightPanel.tsx`](../../src/renderer/src/components/toolbar/RightPanel.tsx) 把上下文主值拆成两个尺度：`pctWindow`（已用 / 有效模型窗口）做**主值百分比与进度条填充**（`data-testid="ctx-tokens"` 也改为分母窗口），新增 `data-testid="ctx-working-set-line"` 行专给工作集（`工作集 36k / 240k · 15%`）；三档阶段刻度改画在**窗口尺度**上（`at / 窗口`），仍按工作集比例算出；压力色（`tone`）只看工作集 —— 它才是钺的动手线。i18n 新增 `ctx.workingSetLine` / `ctx.workingSetLineUnknown`，`ctx.tipWorkingSet` 改写为“进度条分母是物理窗口”。 |
| 自动检查 | `npm run typecheck` / `build` 通过。`contextbudget` 探针里的 4 条旧断言（主值分母 = 工作集）**必须改**，否则会永假；改成：主值分母 = 有效窗口、工作集占一行、进度条填充按窗口比例（像素级）、三档刻度在窗口尺度上的位置（偏差 ≤ 3px）。 |
| 真实运行 | `npm run test:live -- contextbudget`（**cost 0**）全绿：`0 / 1049k`、`工作集 0 / 240k · 0%`、三条刻度偏差 -1px；关掉自动压缩后主值退回物理窗口、工作集行消失（不展示没生效的策略）。 |
| 视觉验收 | `contextbudget` / `ctxmodelpresets` / `ctxsettings` 各深浅一张（stamp `2026-09-22-c5`）；dark 已看图：主值 `9% 36k / 400k` + `工作集 36k / 240k · 15%` + 三条刻度落在条中部，无溢出。 |
| 应用与包 | 未因本片重跑 `dist:dir` / `test-packaged`，包级证据归 H-5 与实施-09。 |
| 剩余限制 | ① 默认行里还没把**档位名**写出来（600K/700K 试行档的名字只在设置页，右栏只有「下一步：…」）；② 三类动作分别统计（sweep / fold / compaction）归 **C-2b**；③ 展开项里的**容量来源**（默认 / 用户 / 模型级 / env）仍只在设置面板的 `ctx-source`，右栏详情未重复展示；④ `data-mode` 的语义现在是“策略是否生效”而不是“分母是谁”，探针与样式沿用该属性 —— 若将来重命名要同步改。 |

### 本轮增量（2026-09-22）· 实施-11 H-6b：崩溃 / 中途退出的回合报「已中断」

> 队列位次 4b 的**写侧 + 读侧切片**。`TurnTerminalReason` 里的 `interrupted` 与
> `TurnView` 的「已中断」分支早就写好了，但**没有任何代码产出它** —— 本片把它接上。

| 六栏 | 证据 |
|---|---|
| 实现 | [`turn-timing-store.ts`](../../src/main/turn-timing-store.ts) 的记录新增 `final?: boolean`；[`agent.ts`](../../src/main/agent.ts) 的 `persistTurnTiming()` 写盘时带上它（中途快照 `false`、终止收尾 `true`）；新增 `effectiveTerminalReason()` —— 读到 `final === false` 的记录就归成 `interrupted`，`applyTurnTimings()` 用它，于是 `peekSession` 与 `hydrate()` 两条读历史路径自动得到中断标记。**旧记录没有这个字段 → 按已收尾处理**：宁可把中断显示成完成，也不能把正常结束的历史集体误报成崩溃。 |
| 自动检查 | `npm run typecheck` / `build` 通过；`npm run test:unit` **4304/4304** —— `test-turn-timing-store.mjs` 新增 6 条（`final:false`→中断、`final:true`→原原因、无字段→不误报、中途快照的 `final` 能读回、仅中途快照→挂回即中断、后续正常收尾覆盖中途快照且不再报中断）。 |
| 真实运行 | `npm run test:live -- turnrestore`（**cost 1**，真实会话文件+真实盘）：退出后检查新增断言「**收尾记录带 `final: true`**」—— 实测通过（`146 ≈ 146ms`、`failed` 路径）；这是判据的另一半：正常跑完的回合不能留下中途快照。**中途快照端到端（H-6b-2）**：`npm run test:live -- turninterrupted`（cost 1）—— 真实回合 → 重启前向同一 `logicalTurnId` 追加 `final:false` 快照 → 重启后切进会话，peek 读到 `interrupted`（52ms）、**真实页脚写出「已中断」**；退出后检查确认盘上最后一条 `final=false`、同一回合有收尾+中途共 3 条记录。 |
| 视觉验收 | 界面分支（`turn-footer` 的「已中断」）由 H-6 的 `matrix-turnstatus-*` 覆盖（同一页脚、同一配色规则）；本片不改 UI。 |
| 应用与包 | 未因本片重跑 `dist:dir` / `test-packaged`，包级证据归 H-5 与实施-09。 |
| 剩余限制 | ① 稳定 `logicalTurnId`（自动继续 / 跨会话链）、`waitSpans`、usage 聚合仍未做；② 中途快照的**产生**方式是在重启前追加（可复现、每跑必得），不是真的 SIGKILL —— 强杀时最后一条快照是否已落盘取决于是否走过 `message_end`，这条边界未实测（也不能把“调度运气”当断言）；③ 长会话（多回合同一文件）下中途快照与收尾快照的配对未单独取证。 |

### 本轮增量（2026-09-22）· 实施-11 C-2：压缩可观测性的两个派生量

> 队列位次 7 的**派生量与口径切片**。「三类动作分别统计」（轻量整理 / 状态刷新 / 整轮压缩）
> 需要扩展侧留痕，未做。

| 六栏 | 证据 |
|---|---|
| 实现 | [`state/compaction-view.ts`](../../src/renderer/src/state/compaction-view.ts) 新增三个纯函数：`compactionReclaimPercent`（回收比例，`after > before` 夹到 0%、缺任一端返回 null）、`compactionReclaimText`（「回收 49%」/「回收待测」）、`compactionGrowthText`（「此后新增 12k」，取当前用量 − 压缩后估算）。[`RightPanel.tsx`](../../src/renderer/src/components/toolbar/RightPanel.tsx) 在「36k → 18k」下方新增一行（`data-testid="ctx-last-compaction-reclaim"`），只在 `status === 'completed'` 时出现；i18n 中英同步 3 个 key。 |
| 自动检查 | `npm run typecheck` / `build` 通过；`npm run test:unit` **4297/4297** —— `test-compaction-status.mjs` 新增 10 条（四舍五入、压完反而更大、缺前/后 token、除零、当前用量未知或低于基准时不显示）。 |
| 真实运行 | 新场景 `npm run test:live -- compactionview`（**cost 0**，真实窗口，11 条）：`36k → 18k`、`回收 49% · 此后新增 12k`；缺 `afterTokens` → 「回收待测（上游没报压缩后的用量）」且**无假百分比**；当前用量未知（pi 刚压完会故意报 null）→ 只给回收不给新增；`failed` 不显示这一行。 |
| 视觉验收 | 新状态 `compactionreclaim`（组 0 / 1）：右栏「最近一次」下方两行，深浅均无溢出 —— [`matrix-compactionreclaim-1440x900-100-dark-2026-09-22-c2.png`](../design/preview/matrix-compactionreclaim-1440x900-100-dark-2026-09-22-c2.png)、[`...-light-...png`](../design/preview/matrix-compactionreclaim-1440x900-100-light-2026-09-22-c2.png)（dark 已看图，读出「36k → 18k / 回收 49% · 此后新增 12k」）。 |
| 应用与包 | 未因本片重跑 `dist:dir` / `test-packaged`，包级证据归 H-5 与实施-09。 |
| 剩余限制 | ① **三类动作分别统计**（轻量整理 sweep / 状态刷新 episode-fold / 整轮压缩）未做 —— 目前后两者共用「最近一次压缩」那一行，sweep 与 fold 不产生 pi 的 `compaction_*` 事件，需扩展侧留痕 → **C-2b**；② “模型登记窗口 vs **实际请求窗口**”仍只有登记窗口（`session.model.contextWindow`）；③ 失败 / 取消 / **重试窗口**里前两者已有（`status`），重试的“下次何时再试”未做，归 C-6 的防抖标定；④ 无压缩后 token 时写「待测」已落实，但既然 pi 并非每次都报，长期看不到比例的可能性存在。 |

### 本轮增量（2026-09-22）· 实施-11 C-4：生效策略交给薄层

> 队列位次 6。原始问题：数值覆盖住在桌面端设置里，而 pi 扩展按设计不读它 ——
> 扩展永远按默认 240K 算阈值，界面却按用户设置的 300K 显示（“界面上的数 ≠ 真正在用的数”）。

| 六栏 | 证据 |
|---|---|
| 实现 | 新增 `contextPolicyRevision()` / `buildEffectivePolicyDocument()` / `overridesOfEffectiveDocument()`（[`shared/context-policy.ts`](../../src/shared/context-policy.ts)，纯函数、两侧共用规则）；[`main/context-policy.ts`](../../src/main/context-policy.ts) 的 `syncEffectivePolicyFile()` 把**分层覆盖**（默认层 + 模型层 + `foldEnabled` + revision + 时间）写进 `<YAN_DATA_DIR>/context-policy.effective.json`，内容不变不落盘；`index.ts` 在两个设置登记点调用（启动读盘 / `patchSettings`）。扩展侧 [`context-budget.js`](../../resources/pi-extensions/context-budget.js) 新增同规则的 `overridesOfEffectiveDocument` / `mergeBudgetOverrides`，[`context.js`](../../resources/pi-extensions/context.js) 的 `requestBudgetFor()` 改为 **env（测试通道）> 宿主文件 > 默认**，逐字段合并。**不写 `YAN_CONTEXT_POLICY`**（那个 env 优先级高于设置面板，写了会把用户设置静默盖掉）。 |
| 自动检查 | `npm run typecheck` / `build` 通过；`npm run test:unit` **4287/4287** —— `test-context-policy.mjs` 新增 10 条（revision 对键序不敏感 / 对开关与数值敏感、文档形状、四层挑选取值），`test-context-budget.mjs` 新增 7 条（精确命中 / provider 回落 / 默认层 / 未知版本、逐字段合并、宿主文档算出的预算 = 直接用同一覆盖算的）。 |
| 真实运行 | 新场景 `npm run test:live -- policyfile`（**cost 0**）：改设置后会话 `source=user`、`workingSet=333000`、清扫线 `233100` 跟着重算；退出后 `afterExit` 核对磁盘文件：`v=1`、`revision=ivkbu5`、`default.workingSetCap=333000`、`windowRatio=0.6`、`foldEnabled=true`、带写入时间。 |
| 视觉验收 | **本片不改 UI**，沿用既有上下文状态图（`matrix-contextbudget-*` 等：工作集主值 + 三档参考线 + 来源行）。本片改变的是这些数字的**来源**，不是画法。 |
| 应用与包 | 未因本片重跑 `dist:dir` / `test:packaged`，包级证据归 H-5 与实施-09。 |
| 剩余限制 | ① **扩展真正采用文件**没有 cost 1 端到端证据（本片给到“宿主写盘”与“两侧纯函数同规则”两段；跑一轮真实 pi 看阈值仍待 C-3 矩阵或本机模型）；② 请求估算仍以字符为主（宽字符 ≈ 1 token、其余 /4），对图片与 provider 特殊结构的覆盖不足，**未知成本不当零**这一点尚未逐 provider 验证 → C-4b；③ “到线以前不会整理”这个措辞仍不准 —— `tool-sweep` 另有收益门槛与防抖，数字对齐不等于行为对齐，归 **C-6**；④ 链式 / 多计划会话同时跑时，文件只有一份分层覆盖（按 `provider/model` 分），未验证多实例并发切换的时序。 |

### 本轮增量（2026-09-22）· 实施-11 H-4a：文件链接解析与呈现

> 队列位次 12 的**解析 / 呈现切片**。H-4 其余出口依赖 H-3 的工作窗口状态模型，未做。

| 六栏 | 证据 |
|---|---|
| 实现 | 搬运 DSH `file-link.ts` 的纯函数到 [`shared/links.ts`](../../src/shared/links.ts)（`parseFileLink`，保留 MIT 来源注释）：支持 `path#L42` / `path#L42-L60`（范围取首行）、`file://` URL 兼容，拒绝坏 percent / 零行号 / 反向范围 / 外部 URL。`classifyLink` 优先识别显式文件链接。[`MessageParts.tsx`](../../src/renderer/src/components/chat/MessageParts.tsx) 的 `LinkAnchor` 增加 `data-line` 与**带行号**的 title（悬停读到完整路径 + 行号），点击仍走 `previewFile(path, line)`。 |
| 自动检查 | `npm run test:unit` **4267/4267** —— [`test-links.mjs`](../../scripts/test-links.mjs) 新增 9 条（`#L42`、`#L42-L60`、`file://…#L7`、外部 URL 不被接管、零行号 / 反向范围 / 坏 percent 拒绝）。 |
| 真实运行 | `npm run test:live -- filelink`（**cost 0**，fixture 沙箱，11 条断言）：三个引用都渲染成 `a.md-link[data-link-kind=file]`；`#L3` → `data-line=3`、title「在右侧只读预览：README.md:3」；无行号链接不写 `data-line`；`#L1-L5` 取首行且路径不含范围；点击真的打开 `README.md` 预览并读到内容；`#L3` 未触发进程内导航。 |
| 视觉验收 | 新状态 `filelink`（组 0 / 1）：正文里三种文件引用同屏，深浅均无溢出 —— [`matrix-filelink-1440x900-100-dark-2026-09-22-h4.png`](../design/preview/matrix-filelink-1440x900-100-dark-2026-09-22-h4.png)、[`...-light-...png`](../design/preview/matrix-filelink-1440x900-100-light-2026-09-22-h4.png)（dark 已看图）。⚠️ **未加文件图标**：sprite 里没有 `file` symbol，图形准则归图标设计输入与 **H-8**，本片不擅自新增图形。 |
| 应用与包 | 未因本片重跑 `dist:dir` / `test:packaged`，包级证据归 H-5 与实施-09。 |
| 剩余限制 | ① 单击文件 / 目录打开标签并联动文件树选中、Markdown 阅读 / 源码切换、>2000 行窗口化定位、文件变化提示、缺失标签保留、`projectId + workspaceRoot + canonicalPath` 资源身份 —— 均为 **H-4 剩余出口**，依赖 **H-3**；② 范围链接只取首行，未做范围高亮；③ 相对路径按「所属消息 / 文档上下文」解析未做（当前仍按会话 cwd，边界仍由主进程判定）。 |

### 本轮增量（2026-09-22）· 实施-11 H-6（部分）：整轮计时落盘与恢复

> 队列位次 4。原始问题：`elapsedMs` 是推送时附上的 UI 字段，pi 的会话 JSONL
> **不存它**，所以切会话 / 重载后整轮用时丢失（H-1 登记的已知限制）。
> 本片交付「落盘 + 读回 + 终止原因 + 未记录不伪造」；稳定逻辑回合身份、
> 等待分段与 usage 聚合归 **H-6b**（见下）。

| 六栏 | 证据 |
|---|---|
| 实现 | 新增 [`main/turn-timing-store.ts`](../../src/main/turn-timing-store.ts)：`YAN_DATA_DIR/turn-timing/<会话文件名>.jsonl`，只追加、带版本号 `v:1`、坏行 / 未知版本跳过、同一 `logicalTurnId` 后者胜。`agent.ts` 在每条 assistant 消息收尾写一次、回合终止（`agent_settled` / `agent_end`）再更新一次；用时用 `performance.now()` 单调差（时钟调整不影响）。读回：`hydrate()` 与 `peekSession` 两条历史路径共用 `applyTurnTimings()`；挂点用**用户消息 id**（`m<idx>`，两侧同一套 `normalizeMessage` 生成）定位，读不到就静默丢弃。终止原因 `completed / stopped / failed` 由 agent 标注（abort / 模型错误）。页脚新增「已停止 · 用时冻结」「失败」「用时未记录」。 |
| 自动检查 | `npm run typecheck` / `build` 通过；`npm run test:unit` **4267/4267** —— 新增 [`test-turn-timing-store.mjs`](../../scripts/test-turn-timing-store.mjs) 10 条（会话 id 白名单 / 往返 / 去重 / 坏行 / 挂点与回退）与 `test-turn-timing.mjs` 里 6 条分组恢复（含「推送值优先于日志值」）。 |
| 真实运行 | 新场景 `npm run test:live -- turnrestore`（**cost 1**，真实回合）：界面 `elapsedMs=132ms` → 落盘 → `peekSession()` 读回**1 条 132ms 记录**，与界面同值；`afterExit` 核对 `data/turn-timing/*.jsonl`：2 条记录、`v=1`、带 `sourceIds`、终止原因 `failed` 与消息 `error` 一致。⚠️ 本次免费模型返回错误，所以走的是 **failed 路径**（恰好验证「失败不装成功」）；`completed` 路径由 `turnfooterlive` 与单测覆盖。 |
| 视觉验收 | 新状态 `turnstatus`（组 0 / 1）注入四种回合，看图核对：正常「用时 18s」、停止「用时 6s + 已停止 · 用时冻结」、失败「用时 1s + 失败（红框，上方错误条）」、旧历史「用时未记录」，深浅均无溢出 —— [`matrix-turnstatus-1440x900-100-dark-2026-09-22-h6.png`](../design/preview/matrix-turnstatus-1440x900-100-dark-2026-09-22-h6.png)、[`...-light-...png`](../design/preview/matrix-turnstatus-1440x900-100-light-2026-09-22-h6.png)。 |
| 应用与包 | 未因本片重跑 `dist:dir` / `test:packaged`，包级证据归 H-5 与实施-09。 |
| 剩余限制 | ① `logicalTurnId` 目前是本轮第一条 assistant 消息 id（宿主临时 id），**自动继续 / 跨会话链交接**时的稳定回合身份（H-6 出口 1）未做；② `waitSpans`（工具 / 子代理等待的真实分段、并行不相加，出口 3）未做；③ 崩溃 / 退出恢复为「中断」未做（出口 4 后半）—— 现在崩溃那一轮没有记录，界面显示「用时未记录」而不是「中断」；④ **usage 语义已核实**：pi 的 JSONL 里每条 assistant 消息的 usage 是**该次请求独立用量**（实测 `input` 1387 → 12404 → 13255 非单调），`turns.ts` 原先写的「累计」是错的，已改注释；但「按请求 / 消息去重聚合」（出口 6）未实现，`UsageBar` 仍按「最近一次请求」显示；⑤ 链式会话按段分文件存日志，跨段恢复未验证。 |

→ 上述①–③⑤ 与④的后半合起来记为 **H-6b**（在实施-11 里单列），完成前 H-6 不写「已交付」。

### 本轮增量（2026-09-22）· 实施-11 H-7：时间呈现统一与可访问

> 队列位次 5。目标：完整时间不能只有鼠标悬停才能读到；同一个时长在消息区与
> 子代理列表必须是同一种写法。

| 六栏 | 证据 |
|---|---|
| 实现 | 新增 [`shared/duration.ts`](../../src/shared/duration.ts) 的 `formatDuration()` —— 回合页脚、图片生成进度、子代理列表共用它；`TurnView.tsx` 的私有 `formatElapsed` 与 `SubagentList.tsx` 的私有 `duration` 删除（后者原来写成 `1m30s`，与消息区的 `1m 30s` 不一致）。`TurnView.tsx` 的 `TurnTime` 加 `aria-label` / `data-full` / `tabIndex=0`；[`motion.css`](../../src/renderer/src/styles/motion.css) 加 `.turn-time:focus::after` 浮层（`:focus-visible` 只负责 outline，`:focus` 让触摸 / 脚本聚焦也弹），`title` 仍作鼠标悬停兜底。 |
| 自动检查 | `npm run typecheck` / `build` 通过；`npm run test:unit` **4240/4240**（新增 [`test-duration.mjs`](../../scripts/test-duration.mjs) 13 条：0s / 59.4s / 59.5s 进位成 `1m 0s` / 90s → `1m 30s` / 负数与 NaN 与 Infinity 钳到 0 / `minSeconds`）。 |
| 真实运行 | `npm run test:live -- turnfooter`（cost 0）新增 6 条断言并全通过：`aria-label` 与 `data-full` 是同一份完整时间（实测「2026/09/21 GMT+10 22:42:50」）、`tabIndex === 0`、`focus()` 后 `document.activeElement` 就是该时间、`datetime` 仍是 ISO。探针另打印聚焦伪元素 content —— 隐藏窗口（`YAN_PROBE_HIDDEN=1`）下为 `none`，因为 `:focus` 在不可见窗口不匹配，所以浮层本身由下面真实可见窗口的视觉状态取证。 |
| 视觉验收 | 新状态 `turntime`（组 0 / 1）：注入一条带时间戳的回合，滚到底部后真 focus 最后一个 `.turn-time` 再截图。看图核对：`14:43` 有聚焦描边（外描边只给键盘），上方浮层给出完整时间「2026/09/21 GMT+10 14:42:50」，深浅均无溢出 —— [`matrix-turntime-1440x900-100-dark-2026-09-22-h7.png`](../design/preview/matrix-turntime-1440x900-100-dark-2026-09-22-h7.png)、[`matrix-turntime-1440x900-100-light-2026-09-22-h7.png`](../design/preview/matrix-turntime-1440x900-100-light-2026-09-22-h7.png)。 |
| 应用与包 | 未因本片重跑 `dist:dir` / `test:packaged`，包级证据归 H-5 与实施-09。 |
| 剩余限制 | ① 发送队列的「待发送」标记本来就有（`Composer` 的 `queue.hold`），本片没改；② `submittedAt`（点击发送的时刻）未实现 —— 界面目前不需要展示它，也就不会用组件挂载时刻伪造一个值；③ 子代理行分钟档从 `1m30s` 改为 `1m 30s`，旧 `matrix-subagent*` 截图是旧写法；④ 触摸设备上的浮层没有真机验证，靠在真实可见窗口里 focus 取证。 |

### 本轮增量（2026-09-22）· 实施-11 H-2 / C-1：右栏资源保留与大窗口试行档

> 队列位次 2、3。两片都是「代码已落、缺证据」的收尾：H-2 让切右栏标签只隐藏、
> 不销毁已打开的资源；C-1 让 600K / 700K 只作为**当前精确 `provider/model`** 的
> 试行档写下去，其余模型仍走原覆盖链。

#### H-2 右栏资源保留

| 六栏 | 证据 |
|---|---|
| 实现 | [`RightPanel.tsx`](../../src/renderer/src/components/toolbar/RightPanel.tsx)：`switchWindow()` 切页不再 `closeBrowser / closePreview / closeReview`，只切活动窗口并把浏览器原生视图隐掉；新增 effect 作为**唯一**显隐协调点（`activeView === 'browser'`）；`activeView` 不再被「资源存在」反向覆盖。[`store.ts`](../../src/renderer/src/state/store.ts)：`openBrowser` 不再清 `filePreview`，`closeReview / closePreview` 不再自行恢复浏览器视图（交给协调器）。[`FileTree.tsx`](../../src/renderer/src/components/toolbar/FileTree.tsx)：修掉真正的元凶 —— 右栏标签切换会让文件区重挂载，而 mount effect 无条件 `closePreview()`，于是「切到浏览器再回来，用户刚打开的文件没了」；现在只在 `cwd/projectId/generation` 真变化时清，首帧不算变化。 |
| 自动检查 | `npm run typecheck` / `npm run build` 通过；`npm run test:unit` **4227/4227**。 |
| 真实运行 | `npm run test:live -- rightresources`（**cost 0**，21 条断言）全通过。实测：打开浏览器 → 切工具 / 文件 / 再切回浏览器，`browserState.open` 与 URL 始终不变（旧行为会在这几步关掉网页）；浏览器 + 审查 + 文件三者并存；收起右栏后三者也都还在（仅审查 + 收起时 `rightpanel` 宽 576px；所有资源关掉后宽 0px、退出布局）；显式关浏览器只释放浏览器（`reviewOpen / filePreview` 仍为 true），关文件 / 关审查各自只释放自己，全部关掉后回到「工具」标签。 |
| 视觉验收 | 新状态 `rightresources`（组 0 / 1），看图核对：右栏标签行同时有 工具 / 审查 / 浏览器 / 文件，活动的是文件且 `PROJECT.md` 预览在下方（浏览器原生视图已让位），溢出 0px —— [`matrix-rightresources-1440x900-100-dark-2026-09-22-h2b.png`](../design/preview/matrix-rightresources-1440x900-100-dark-2026-09-22-h2b.png)、[`matrix-rightresources-1440x900-100-light-2026-09-22-0550.png`](../design/preview/matrix-rightresources-1440x900-100-light-2026-09-22-0550.png)。⚠️ 另有一张旧的 `...-h2.png` 是状态脚本被模板字符串里的反引号截断、状态没生效的产物（图上右栏只剩「工具」），**不要引用**；脚本已修并在 h2b 重拍。 |
| 应用与包 | 未因本片重跑 `dist:dir` / `test:packaged`，包级证据归 H-5 与实施-09 统一复跑。 |
| 剩余限制 | ① 仍只有一个活动内容区，`tabs / activeTabId / width / version` 的会话级持久化是 **H-3**；② 浏览器导航 revision、草稿与已提交地址分离、错误态是 **H-9**；③ 关闭浏览器标签是否 abort 正在跑的导航未单独取证；④ 未验证 A/B 会话切换时的资源归属（H-3 出口）。 |

#### C-1 大窗口模型级试行档

| 六栏 | 证据 |
|---|---|
| 实现 | [`shared/context-policy.ts`](../../src/shared/context-policy.ts) 新增 `LARGE_CONTEXT_POLICY_PRESETS`（`balanced = 600K / 0.7`、`long = 700K / 0.7`），只作为「当前 `provider/model` 覆盖」的候选值，不碰全局默认。[`ContextTab.tsx`](../../src/renderer/src/components/settings/ContextTab.tsx) 在模型级覆盖区新增两档分段按钮，只有 `contextWindow >= 800_000` 的当前模型才可点；`applyModelLargePreset()` 只写 `contextPolicyByModel[provider/model]`。中英文文案同步。 |
| 自动检查 | [`test-context-policy.mjs`](../../scripts/test-context-policy.mjs) 新增 6 条：两档参数就是 600K / 700K 且 `windowRatio=0.7`；`contextBudget(1M)` 仍是 240K（不污染默认）；写入 balanced / long 后工作集分别是 600K / 700K；**800K 窗口下 long 只拿到 560K**（70% 窗口约束生效，不会照搬裸上限）。全套 `test:unit` 4227/4227。 |
| 真实运行 | `npm run test:live -- contextbudget`（cost 0，真实窗口 + 真实模型）新增断言并全通过：当前 `commandcode/meituan/LongCat-2.0:free`（登记窗口 1048576）两档可点；点「均衡」后 `source=model`、`contextPolicyByModel[key].workingSetCap=600000` 且 `budget.workingSet=600000`；点「长材料」同样精确到 700000；把 model 形状注入成 131072 后两档**立刻禁用**、恢复后重新可用；换到 `deepseek/deepseek-v4-flash` 后来源回到 default、工作集重算 240000；切回原模型覆盖重新生效、清理无副作用。 |
| 视觉验收 | 新状态 `ctxmodelpresets`（组 0 / 1），看图核对：模型级覆盖点名 `commandcode/meituan/LongCat-2.0:free`，下方「大窗口试行档」有「均衡 · 600K / 长材料 · 700K」两个按钮，说明是「仅写入当前精确模型；先确认端点容量与本次输出预算，参数仍需实测」，深浅均无溢出 —— [`matrix-ctxmodelpresets-1440x900-100-dark-2026-09-22-c1.png`](../design/preview/matrix-ctxmodelpresets-1440x900-100-dark-2026-09-22-c1.png)、[`matrix-ctxmodelpresets-1440x900-100-light-2026-09-22-c1.png`](../design/preview/matrix-ctxmodelpresets-1440x900-100-light-2026-09-22-c1.png)。 |
| 应用与包 | 同上，未重跑包级，归 H-5 / 实施-09。 |
| 剩余限制 | ① **没有真实 1M 端点证据**：600K / 700K 是试行参数，不是容量承诺或性能结论，端点验证归 C-3（需要用户明确允许与可控额度）；② 未验证端点实际窗口与 pi 登记窗口不一致时的表现（C-4 / C-3）；③ 本片不涉及压缩门槛与防抖标定（C-6）；④ 单测只钉了 800K 一个缩放点，没有覆盖 600K / 700K 之间与更小窗口的连续矩阵（那正是 C-3）。 |

### 本轮增量（2026-09-22）· 实施-11 H-1：回合页脚与整轮计时口径

> 队列位次 1。目标：助手正文顶部不再有「砚 / N 步 / 标准」，整轮用时只在回合底部
> 出现一次，并且**工具等待算进整轮、不算进生成速度**。

| 六栏 | 证据 |
|---|---|
| 实现 | 计时口径抽成 [`shared/turn-timing.ts`](../../src/shared/turn-timing.ts) 的纯函数 `turnTiming()`，`main/agent.ts` 的 `speedOf()` 改为委托它（速度用首 token 起点、整轮用 agent 回合起点）；`TurnView.tsx` 的用时条接上已有的 `tok.elapsedTip`（悬停说明「含工具往返」）。顺带修掉一个真实边界：起点时间戳为 `0` 时被 falsy 判断当成「没有起点」而丢掉用时，改成 `!== undefined`。 |
| 自动检查 | `npm run typecheck`（含 CSS 约束 / layer 自检）通过；`npm run build` 通过；`npm run test:unit` **4227/4227**，其中新增 [`test-turn-timing.mjs`](../../scripts/test-turn-timing.mjs) 7 组 15 条：工具 8s + 生成 2s → 整轮 10s / 速度 50（若速度误用回合起点会得 12.5，会红）、没有 `usage.output` 时只省略速度、时钟回拨钳到 1ms、重试等待留在整轮、`groupIntoTurns` 取最后一条 = 整轮值。 |
| 真实运行 | 新增 `npm run test:live -- turnfooter`（**cost 0**，28 条断言，注入多工具 / 单工具 / 无用时 / 无元数据四种回合）与 `turnfooterlive`（**cost 1**，fixture 沙盒 + 本地模型 `local/qwen3-local`）。实测：工具 `read:ok`、`elapsedMs=4900ms`、由 `output/speed` 推导的生成时间 `1.49s`（差值即工具往返）、页脚秒数与消息字段一致、切走再切回该回合仍在。 |
| 视觉验收 | 新增视觉状态 `turnfooter`（组 0/1 末尾），看图核对：助手顶部无品牌 / 档位 / 步数行、底部「2 步 用时 42s 14:42」、单工具回合只显示「用时 18s」、用户消息时间仍在、无点赞点踩、溢出 0px —— [`matrix-turnfooter-1440x900-100-dark-2026-09-22-h1.png`](../design/preview/matrix-turnfooter-1440x900-100-dark-2026-09-22-h1.png)、[`matrix-turnfooter-1440x900-100-light-2026-09-22-h1.png`](../design/preview/matrix-turnfooter-1440x900-100-light-2026-09-22-h1.png)。 |
| 应用与包 | `out/` 已按最新源码构建；本片**未**重跑 `dist:dir` / `test:packaged`，包级证据归 H-5 与实施-09 统一复跑。 |
| 剩余限制 | ① **`elapsedMs` 不落盘**：它是宿主推送时附上的 UI 字段，pi 的会话 JSONL 不存它，所以切会话 / 重载后整轮用时丢失、底部只剩完成时刻 —— 由 **H-6**（宿主侧版本化元数据日志）解决；`turnfooterlive` 把这条事实打印出来而不判失败，避免场景永远红。② 方案 §4.1 草图里的「复制 / 更多」未实现（未擅自新增 UI），当前统计行只有步数 / 用时 / 完成时刻。③ 停止 / 失败路径的用时冻结只有纯逻辑口径覆盖，没有单独的真实窗口证据。④ 本机 27B 量化模型在仓库完整上下文（~8.6K）下**不调工具**，只在 fixture 沙盒 + 不可猜任务下稳定调用 —— 写 cost 1 工具场景时要用 `fixture: true` / `fixtureSub`。 |

### 本轮增量（2026-09-21）· 额度：Command Code 月度口径修复与三档色阶

> 用户报「commandcode 的月额度识别是反向的，显示已用完，其实是没有用」，同时要求
> 「70% 以下绿 / 70–95 黄 / 95–100 红」。两件事一起做，因为都落在右栏额度分区。

| 六栏 | 证据 |
|---|---|
| 实现 | 新增 [`main/quota-commandcode.ts`](../../src/main/quota-commandcode.ts)：`/alpha/billing/credits` → 三个窗口的纯函数。**口径**：`windowLimits.*.used` 是「已用」，而 `credits.monthlyCredits` 是「**本月剩余**」—— 已用 = 套餐总额度（`weekly.cap × 2` 反推）− 剩余，月度窗口带 `estimated`。`main/quota.ts` 改为调用它，不再内联解析。新增 [`shared/quota-tone.ts`](../../src/shared/quota-tone.ts)：`quotaTone()` = <70% 绿 / 70–95% 黄 / ≥95% 红（两个边界都算进更严的一档，`exceeded` 恒红），窗口与主值共用。`RightPanel.tsx` 三档**都**落类名 —— 原来 `ok` 档被写成空类名，于是「低用量」用的是默认前景色（灰），**根本不是绿色**。 |
| 自动检查 | `npm run typecheck` 通过（TS + 18 份 CSS 约束 + layer 自检 10 用例）；`npm run build` 通过；`npm run test:unit` **4210/4210**。新增两节单测（`test-quota.mjs`）：① 用线上真实快照钉住「月度已用 = 总额度 − 剩余」（反了会立刻红，就是这次报的 bug）；② `quotaTone` 的 70 / 95 边界逐点（69.9 绿 / 70 黄 / 94.9 黄 / 95 红 / 137 红 / `exceeded` 恒红 / NaN 不误红）。 |
| 真实运行 | 新场景 `npm run test:live -- quota`（**cost 0，不进 `check`**）—— 真实凭证走 主进程 https → IPC → 真实渲染：实测 `used=0.081258485 / total=70`、面板「已用 0.1%」「$0.08 / 剩余 $69.92」、月度带「推算」徽标。方向断言：本月已用必须 < 总额度的一半（口径反了会是 99.9%）。探针里另加两条「颜色必须等于 `--ok`」的断言，与下面视觉矩阵 `quotatone` 用的是同一判据（后者已实跑为绿）。 |
| 视觉验收 | 视觉矩阵新增组 7 / 8（只含 `quotatone` 一个状态，1440×900 深浅各一张），看图核对：5 小时 **69.0% 绿**、每周 **75.0% 黄**、本月 **100% +「已用完」红**、主值 `$10.00` 红，溢出 **0px**：[`matrix-quotatone-1440x900-100-dark-2026-09-21-2323.png`](../design/preview/matrix-quotatone-1440x900-100-dark-2026-09-21-2323.png)、[`matrix-quotatone-1440x900-100-light-2026-09-21-2323.png`](../design/preview/matrix-quotatone-1440x900-100-light-2026-09-21-2323.png)。状态脚本除了类名还比 **计算色**：三档必须分别等于 `--ok` / `--warn` / `--err`（第一次跑就抓出「ok 档没落类名 → `rgb(180,180,172)`」，即上面那条真缺陷）。额度桩只在 `provider === 'commandcode'` 时生效，其它状态的图不受影响。 |
| 应用与包 | `out/` 已按最新源码构建（本片最后一遍 `npm run build`）。**未**因本片重新生成 `dist:dir` / 便携 ZIP / NSIS，也没有重跑 `test:packaged`，所以不把包内运行级证据前移。 |
| 剩余限制 | ① 月度上限是**反推**的（接口没有官方月额度字段），界面已明标「推算」—— 若官方换比例或改字段口径，只有真实账号能发现（单测用的是快照 fixture）；② 色阶阈值是用户口径（70 / 95），与上下文水位的 85 / 95 **不是一套**，别互相照抄；③ `quota` 场景**不进 `check`**（要凭证，且「已用不到一半」依赖当月真实用量）；④ 另外买了额度包时总额度按「剩余」抬高，是保守近似。 |

### 本轮（2026-09-21）· 文档树归类与去重审计（非工程片）

文档按“当前入口 → 当前状态 → 活动实施 / 设计输入 → 已完成备份 → 外部原文”重新核对。活动正文只在
`docs/plan/active/` 和 `docs/design/active/`，完成主题、验收证据、外部原文分别只在
`docs/archive/plan/`、`docs/archive/evidence/`、`docs/archive/reference/`；已移除所有指向这些正文的根级短兼容入口，
不再保留同名第二份文件。当前 `docs/` 共 **95 个 Markdown 文件**；同内容 SHA-256 重复为 **0 组**，
README 清单覆盖活动、完成主题、16 份验收证据和 6 份外部原文。

`node .audit-deep.cjs` 当前结果：`missingTracked=0`、`deletedUnstaged=0`、`brokenDocLinks=0`、
`unreferencedSourceFiles=0`、中英文 i18n 键差异为 0、未导入 CSS 为 0。外部评审原文按逐字保存原则保留 1 条旧路径链接，
审计单列为 `archivedRawDocLinks=1`；历史快照中的旧源码名、示例路径和已删除探针不算当前待办，不能据此恢复旧架构。

### 本轮增量（2026-09-21）· Codex 风格审查 / 右栏启动器与模式正交

> 本片承接用户对 Codex 右栏、审查标签、Tab 快切、子代理归属和历史文件预览的反馈。
> 参考图只作为交互与密度输入；下面的运行和视觉结论来自当前仓库自己的 Electron 证据。

| 六栏 | 证据 |
|---|---|
| 实现 | 左栏“编码 / 日常”改为独立 `WorkspaceMode`，不再映射到当前回合的 AgentMode（标准 / 澄清 / 自主）；输入框的裸 Tab 增加 document-capture 兜底，保留补全、IME、长文和设置关闭时的正常焦点行为。模型委派的子代理通过 `parentMessageId` 绑定到触发它的助手回合，默认以内嵌卡片显示，不再自动抢占右侧详情；用户手动启动的子代理仍可打开详情。历史 artifact manifest 按会话链逐段恢复，源文件缺失时保留“不可用”卡片而不是静默消失。右栏标题行加入 Codex 风格紧凑工具启动器（审查 / 终端 / 浏览器 / 文件）；审查面板加入顶部“审查”标签与关闭入口；左栏导引线和右栏分区缩进按当前密度收紧。 |
| 自动检查 | `npm run typecheck` 通过（TypeScript、18 份 CSS 约束、layer 自检 10 用例）；`npm run build` 通过；`npm run test:unit` **4160/4160**；artifact 单测新增“历史源文件被删除仍保留 unavailable 卡片”。`work-mode` 探针同步当前产品边界：自主态是静态靛蓝边界，不再要求已废止的旧版动画光带；模型子代理探针同步改为检查 `parentMessageId`、消息内卡片和“不强制打开详情”。 |
| 真实运行 | `npm run test:live -- panels browser topbar settings` 通过；`npm run test:live -- workmode` 通过，真实 Electron 验证工作区切换不改 AgentMode、两次 Tab 循环、焦点不离开输入框、设置关闭 Tab 后恢复系统焦点行为，以及 A/B 会话模式隔离；浏览器原生视图场景通过，全部测试结束无残留 pi RPC 孤儿进程。 |
| 视觉验收 | 视觉矩阵组 0 新增并看图核对：`matrix-righttoolmenu-1440x900-100-dark-2026-09-21-review-sidebar.png`、`matrix-review-1440x900-100-dark-2026-09-21-review-sidebar.png`、`matrix-main-1440x900-100-dark-2026-09-21-review-sidebar.png`、`matrix-subagentinline-1440x900-100-dark-2026-09-21-subagent-inline.png`，均溢出 **0px**。右栏菜单为四行紧凑启动器；审查页为独立标签 + diff + 变更树；子代理截图证明卡片位于触发回合正文轴内，右栏没有被强制切换。当前新增批次只覆盖 1440×900 深色组，浅色 / 窄窗 / 高 DPI 未在本片新增看图。 |
| 应用与包 | 已通过 `启动-砚.cmd` 按最新源码重新构建并启动；当前开发构建包含本片 renderer / main 修改。尚未因本片重新生成 `dist:dir`、便携包或 NSIS 安装包，因此不把包内运行级证据前移。 |
| 剩余限制 | 右栏启动器中的“终端”仍是明确禁用项，宿主终端面板尚未接入；快捷键胶囊目前承担可发现性，未为未接入的终端动作伪造快捷键。审查打开时接管整个右栏，宽度仍为右栏档位而非主内容区可拖拽列。缺失的历史产物会显示不可用卡片，但无法恢复已删除的原始字节。模型自主触发子代理的 cost 1 `subagentmodel` 场景已按新语义更新探针，本片未再次调用远程额度；若要把这一条也更新成最新运行证据，应在用户确认的本地模型可用时重跑。Android 仍按用户决定放到最后。 |

### 本轮增量（2026-09-21）· 右栏统一窗口标签（工具栏 / 审查 / 浏览器 / 文件）

> 用户要求右栏工具栏也采用审查页的窗口形态，并把浏览器与文件纳入同一套窗口入口。
> 本片把几个表面收敛为一个活动窗口区；截图中的 Codex 页面只作为密度与层级参考，
> 不替代本仓库的运行证据。

| 六栏 | 证据 |
|---|---|
| 实现 | `RightPanel.tsx` 新增统一 `right-window-panel` 标签栏：工具栏、审查、浏览器、文件使用同级标签和关闭入口；工具窗口保留工具库与单一 `.rp-body` 滚动区，文件窗口在同一 `.rp-body` 中保持 `FileTree`，打开文件时把 `FilePreviewPane` 放在上方预览行，避免目录树被卸载；审查页移除重复的内部标签栏，避免双层窗口头；浏览器只在活动时渲染 DOM 壳，收起右栏时隐藏标签栏并让原生网页占满右列。`tools.css` 新增窗口表面布局、标签滚动与文件窗口约束。 |
| 自动检查 | 本片最终 `npm run typecheck`、`npm run build`、`git diff --check` 均通过。构建仍只有 zod / virtua 第三方注释位置告警，没有本片错误。 |
| 真实运行 | `npm run test:live -- panels browser settings` 通过；`npm run test:live -- fsedge` 通过，真实验证浏览器活动时工具正文卸载、切回工具栏关闭原生浏览器、文件窗口保留文件树、浏览器与文件表面不叠放、切回工具栏后文件树恢复；全部场景结束无残留 pi RPC 孤儿进程。 |
| 视觉验收 | `visual:matrix` 组 0 的 `rightwindows` 通过，1440×900 深色截图溢出 **0px**，并已看图核对四个同级入口（工具栏 / 审查 / 浏览器 / 文件）与右侧 `＋` 启动器：[`matrix-rightwindows-1440x900-100-dark-2026-09-21-2041.png`](../design/preview/matrix-rightwindows-1440x900-100-dark-2026-09-21-2041.png)。 |
| 应用与包 | 已通过 `启动-砚.cmd` 按最新源码重新构建并成功启动，当前开发构建已包含本片 renderer / CSS 修改；尚未因本片重新生成 `dist:dir`、便携 ZIP 或 NSIS 安装包，因此不把包内运行级证据前移。 |
| 剩余限制 | 终端仍是禁用入口；窗口标签是单活动表面，不提供多个浏览器 / 文件文档同时并排；浏览器关闭标签会结束当前原生浏览器状态而不是保存一个隐藏标签。Android 仍按用户决定放到最后。 |

### 本轮增量（2026-09-21）· 右栏工具栏左侧留白收敛

> 用户指出右栏工具栏靠左仍有大片空白。本片只收紧右栏分区的几何占位，保留排序、折叠和文件树行为。

| 六栏 | 证据 |
|---|---|
| 实现 | `tools.css` 将普通右栏分区的排序把手从 20px + 4px 左边距收为 12px + 0px；折叠箭头槽收为 14px，箭头与标题间距收为 2px；普通分区正文左缩进由 36px 收为 12px。标题保留层级箭头，内容直接从箭头附近起步；文件树自身继续使用 4px / 14px 的目录层级缩进，拖拽把手仍保留独立键盘 / 指针命中区。`DESIGN.md` 同步记录当前几何规则。 |
| 自动检查 | 最终版本 `npm run typecheck` 通过（TypeScript、18 份 CSS 约束、layer 自检 10 用例）；`npm run build` 通过；`git diff --check` 通过。构建仍只有既有 zod / virtua 第三方 Rollup 注释告警。 |
| 真实运行 | 最终构建后的 `npm run test:live -- panels settings` 通过；右栏存在、分区顺序、文件树、设置面板和左右栏收放均通过；测试结束无残留 pi RPC 孤儿进程。随后通过 `启动-砚.cmd --rebuild` 的项目入口重新构建并成功启动开发版本。 |
| 视觉验收 | `visual:matrix` 组 0 的 `main` 与 `righttoolmenu` 均通过，1440×900 深色截图溢出 **0px**，并已看图核对：[`matrix-main-1440x900-100-dark-2026-09-21-rightbar-left-compact.png`](../design/preview/matrix-main-1440x900-100-dark-2026-09-21-rightbar-left-compact.png)、[`matrix-righttoolmenu-1440x900-100-dark-2026-09-21-rightbar-left-compact.png`](../design/preview/matrix-righttoolmenu-1440x900-100-dark-2026-09-21-rightbar-left-compact.png)。本片新增的是深色 1440×900 证据，浅色 / 窄窗 / 高 DPI 未新增看图。 |
| 应用与包 | 最新 `out/` 已由入口脚本按源码重新生成并启动；尚未因本片重新生成 `dist:dir`、便携 ZIP 或 NSIS 安装包，因此不把包内运行级证据前移。 |
| 剩余限制 | 本片只处理普通工具栏分区的左侧密度，不改变右栏宽度、浏览器原生视图的生命周期或 Android 范围。排序把手在非悬停状态仍是低可见度控件；若用户把右栏缩到 296px 以下，长标题仍会按省略号处理。Android 仍按用户决定放到最后。 |

### 本轮增量（2026-09-21）· AI 文件产物展示与 GPT Image（实施-10）

| 六栏 | 证据 |
|---|---|
| 实现 | 新增 `src/main/artifacts.ts` 受控 artifact 仓、`src/main/image-generation.ts` 生图适配、`yan artifact attach` / `yan image generate` 能力入口；assistant 消息携带 artifact 元数据，历史读取通过 manifest 恢复；renderer 直接展示图片 / SVG，代码文件展示预览并提供下载、定位和复制路径。任何 `openai` / `compatible` provider 都在主进程 `fetch` 前走可见确认，拒绝错误为 `external_api_denied`。本轮补上 Codex 风格的生图进度条目（排队、请求、生成、保存、完成 / 失败）、空响应与 0 字节文件拒绝、旧空附件清理和损坏图片兜底；文件预览改为独立网格行，左栏模式开关和 artifact / SVG 预览收紧。 |
| 自动检查 | `npm run typecheck`、`npm run build`、`npm run test:unit` 已通过；单测 **4160/4160**。新增回归明确验证兼容 API 被拒时 `fetch` 未被调用、进度阶段按序更新，以及空文件被 `artifact_empty` 拒绝。 |
| 真实运行 | 本机 Codex OAuth 登录态已只读确认；当前构建用小尺寸 / 低质量测试 prompt 实际返回 `provider=codex`、`model=gpt-image-2` 的 PNG，并完成落盘与 assistant artifact push。真实响应要求 `store=false`，否则服务端返回 400；已修正并复验成功。 |
| 视觉验收 | 旧的真实 Electron `capturePage` 证据仍保留：`docs/design/preview/matrix-artifact-1440x900-100-dark-2026-09-21-artifact.png`。本轮为补拍 compact artifact / 生图进度状态启动了 `visual:matrix`，但进程在首个状态后无继续输出且未生成新截图，已中止，**不把本轮视觉复验标为通过**；原生 Computer Use 当前仍为 `apps: []`，无法替代截图看图。 |
| 应用与包 | 已用 `启动-砚.cmd` 按最新源码重新构建并成功启动；此前 `npm run dist:dir` 与 `npm run test:packaged` 的打包证据仍有效，但本轮 UI / 进度补丁之后尚未重新生成包并重跑包内探针。artifact 根目录由主进程绑定到 `YAN_DIR/artifacts`，不在安装目录。 |
| 剩余限制 | OpenAI-compatible 编辑模式尚未接入参考图上传；PDF 目前是可下载文件而非内嵌阅读器；真实 Codex 图像通道依赖当前 OAuth 登录态和套餐额度；当前生图进度条是阶段型 / 不定进度条，上游未提供可验证百分比，因此不伪造百分比；仍需在视觉矩阵可稳定运行后补拍最终截图；Android 仍按用户决定放到最后。 |

### 本轮增量（2026-09-21）· UI 收尾：右栏、原生视图隔离与生图终态

> 用户补充了右栏结构、模式开关错位、设置层与内置浏览器冲突、用户消息胶囊错位，
> 以及“生图完成后进度条不会消失”。设计取向先交给内置浏览器中的 GPT 做参考，
> 再按仓库现有组件和原生 `WebContentsView` 生命周期落地；外部意见只是设计输入，
> 不是运行证据。

| 六栏 | 证据 |
|---|---|
| 实现 | 右栏整理为固定 52px 标题 + 单一 `.rp-body` 滚动层 + 40px 分区行，保留现有功能分区和文件树；默认右栏宽度调整为 336px（设计范围 296–400px）。模式开关改成固定三列网格 `20px / minmax(0, 1fr) / 36px`，移除与它争夺空间的额外 flex 占位，图标、文字和轨道不再互相挤压。打开设置时先隐藏原生浏览器视图，关闭设置后在下一帧、且没有文件预览 / 审查 / 子代理预览时恢复，避免把原生层误当成 renderer 的 z-index 问题。用户消息改为 `fit-content` 胶囊，最大宽度 `min(680px, 72%)`，和正文内容轴右对齐。`TurnView` 对 `stage=done` 的生图进度条不再渲染，最终 artifact 保留；失败条目继续保留以便解释和重试。同步更新 `docs/design/DESIGN.md` 的右栏结构规则。 |
| 自动检查 | `npm run typecheck`、`npm run build`、`git diff --check` 通过；`npm run test:unit` **4160/4160**。构建只有既有 zod / virtua 第三方 Rollup 注释告警，没有本轮错误。 |
| 真实运行 | `启动-砚.cmd` 按最新源码重新构建并成功启动；`npm run test:live -- panels browser topbar` 通过，`npm run test:live -- settings` 通过。真实 browser 场景确认原生视图存在、边界有效且右栏 / 中栏关系保持；topbar 场景确认模式 switch 的语义、`aria-checked` 与真实工作模式同步；settings 场景确认设置面板可打开、三栏结构和右栏分区正常。四组场景结束均无残留 pi RPC 孤儿进程。 |
| 视觉验收 | 新跑视觉矩阵组 0 的 4 个暗色状态，均溢出 **0px** 并已实际看图：`matrix-main-1440x900-100-dark-2026-09-21-ui-fix.png`、`matrix-artifact-1440x900-100-dark-2026-09-21-ui-fix.png`、`matrix-imageprogress-1440x900-100-dark-2026-09-21-ui-fix.png`、`matrix-settings-1440x900-100-dark-2026-09-21-ui-fix.png`。其中 `imageprogress` 证明进行中的阶段卡仍显示，`artifact` 证明完成后的最终文件卡独立展示；代码逻辑另保证成功进度卡消失、失败进度卡保留。浅色、窄窗和高 DPI 尚未在本片新增看图证据。 |
| 应用与包 | 开发构建已包含本轮 renderer / main 修改；`启动-砚.cmd` 启动成功。此前的 `dist:dir` / `test:packaged` 证据仍有效，但本轮 UI 修复后尚未重新生成 Windows 包并重跑包内探针。 |
| 剩余限制 | 本片没有扩大到 Android；Android 仍按用户决定最后处理。设置与 browser 的行为分别已有真实场景覆盖，但尚未新增一条“打开原生浏览器后直接点击设置”的专门视觉探针；当前代码以打开前隐藏原生视图、关闭后带条件恢复作为生命周期边界。真实 provider 的失败网络分支没有另跑耗额度场景，失败卡保留由状态归一化和单测覆盖。 |

### 本轮增量（2026-09-21）· 墨色工作空间 UI 核心实施片

> 本片由用户明确要求“开始 UI 重构”后实施。两份 2026-09-21 设计文档作为设计输入，
> 不作为已经完成的运行 / 视觉 / 打包证据；本片只改视觉层，不改变会话、任务、模型、IPC、凭证或默认 pi 边界。

| 六栏 | 证据 |
|---|---|
| 实现 | 更新 [`docs/design/DESIGN.md`](../design/DESIGN.md) 为 v0.3“墨色工作空间”当前真源；令牌切换为 UI / 正文无衬线、代码等宽、13 / 14 / 12.5px 字号层级、暖中性色与靛蓝强调；布局候选调整为左 248px / 右 320px / 内容 800px。新增 `BrandMark`，品牌触点使用与提示砚 SVG 同几何的内联 SVG（避免 Electron 外部 mask 退化成色块）；标题栏、左栏、空状态、引导层使用品牌标记，功能控件仍使用 reicon。用户消息改为低对比靠右消息块，助手正文移除装饰竖线；输入区改为单层边界与静态自主档状态。 |
| 自动检查 | `npm run typecheck` 通过：TypeScript、CSS grid 约定、CSS layer 自检全部通过；`npm run build` 通过。构建仅出现既有第三方 Rollup 注释告警（zod / virtua），无本片错误。 |
| 真实运行 | `npm run test:live -- layout` 通过：真实 Electron 中测得左栏 248px、右栏 320px、用量条与输入框同宽、收起 / 展开持久化、无横向溢出、无残留 Pi 进程。 |
| 视觉验收 | `visual:matrix` 组 0 的主界面场景首轮通过，截图 `matrix-main-1440x900-100-dark-2026-09-21-ui-core.png`，溢出 0px；第二次为修正品牌颜色后的重拍，在已有 Electron 单实例环境中停在截图阶段并已中止，**不计为通过**。当前尚缺修正后的品牌图形深浅主题、窄窗与高 DPI 人工看图。 |
| 应用与包 | 开发构建产物已确认 renderer bundle 包含品牌标记与新令牌；尚未重跑 `dist:dir` / `test:packaged`，也未把 Windows 任务栏 / 安装器当成本片已验收。 |
| 剩余限制 | 这是核心实施片，不代表全套新 UI 完成；设置、右侧辅助区、浏览器原生视图、深浅主题完整矩阵、DPI、Windows 外壳和安装包仍需后续片段验收。`src/renderer/src/assets/prompt-stone.svg` 是与 `build/prompt-stone.svg` 几何一致的 renderer 构建副本，后续应补自动同步 / 一致性检查，避免两份源图形漂移。 |

### 本轮增量（2026-09-21）· 主题扩张切换与 Thinking Orb 运行态

> 本片在上一片 UI 核心实施之上增加动效反馈。主题切换、推理、工具运行、子代理状态的业务语义保持不变；只替换部分加载指示器的呈现。

| 六栏 | 证据 |
|---|---|
| 实现 | 新增 `ThinkingOrbIndicator`，安装并接入 `thinking-orbs` 0.3.1；推理胶囊使用 `solving`，工具行按可观察意图映射到 `searching` / `connecting` / `composing` / `working`，子代理使用 `working`。依赖的实际类型 API 是 `theme="auto"`，会跟随现有 `html[data-theme]`，而不是网页示例文字中的 `dark` prop。主题切换改为在支持的 Chromium 中用 View Transition 将新主题从中心向外扩张；不支持或 `prefers-reduced-motion` 时直接切换。 |
| 自动检查 | `npm install thinking-orbs` 成功，npm audit 为 0 vulnerabilities；`npm run typecheck` 通过（TypeScript、CSS grid 约定、CSS layer 自检）；`npm run build` 通过。构建仍只有既有第三方 Rollup 注释告警（zod / virtua）。 |
| 真实运行 | `npm run test:live -- settings` 通过：真实 Electron 中设置面板正常打开，外观 tab、主题切换入口及设置持久化链路均通过，结束后无残留 Pi 进程。该场景没有产生正在思考 / 工具运行 / 子代理实时态，因此不把它当作 Orb 像素级证据。 |
| 视觉验收 | 已通过 Orb 的深浅主题真实窗口截图：`matrix-reasoning-1440x900-100-{dark,light}-2026-09-21-orb*.png` 与 `matrix-subagent-1440x900-100-{dark,light}-2026-09-21-orb*.png`，4 张均由 `visual:matrix` 生成并核对，溢出 0px；深色与浅色下 Orb 都实际出现在运行态行内。主题扩张尚未单独录制逐帧证据，因此不把扩张动画本身标为视觉已验收。 |
| 应用与包 | 开发构建已包含 `thinking-orbs` renderer bundle；尚未重跑 `dist:dir` / `test:packaged`，因此不声称安装包已验收。依赖变更已写入 `package.json` 与 `package-lock.json`。 |
| 剩余限制 | Orb 目前只覆盖三类小尺寸运行态，输入框顶边框和右栏任务 / 压缩状态仍保留原有 pi 盲文指示器；主题扩张以窗口中心为起点，不追踪鼠标位置。依赖库自身按 `prefers-reduced-motion` 使用静态帧，应用层 View Transition 在该设置下关闭。 |

### 本轮增量（2026-09-21）· 左栏模式开关与标题栏品牌收敛

| 六栏 | 证据 |
|---|---|
| 实现 | 移除标题栏左侧重复的品牌图标，仅保留左栏品牌图标；左栏品牌入口改为可直接点击的二态开关，显示当前“编码 / 日常”模式和开关轨道。两档分别调用已有的 `autonomous` / `standard` 工作模式 IPC，Composer 内的“澄清”细粒度模式继续保留。 |
| 自动检查 | `npm run typecheck` 与 `npm run build` 通过；更新 `scripts/probe/topbar.js`，增加 switch 语义、`aria-checked`、真实切换和恢复断言。 |
| 真实运行 | `npm run test:live -- topbar` 通过：标题栏品牌图标不再重复；左栏 switch 直接切换到 `autonomous` 并恢复 `standard`，`aria-checked` 与实际状态同步；无残留 Pi 进程。 |
| 视觉验收 | 浅色 1440×900 主界面已重新生成并人工核对：左栏显示“砚 + 当前模式 + 轨道滑块”，标题栏仅保留文字“砚”，溢出 0px。截图：`docs/design/preview/matrix-main-1440x900-100-light-2026-09-21-mode-toggle.png`。上一批深色模式视觉在已有 Electron 单实例环境中超时，不计为通过。 |
| 应用与包 | 开发 renderer 已重新构建；尚未重跑 `dist:dir` / `test:packaged`。 |
| 剩余限制 | 左栏快捷入口只提供编码 / 日常两档，澄清仍在输入框模式菜单中；模式按现有工作模式契约在当前回合结束后生效，不能把正在执行的回合强行改写。 |

### 2026-09-21 本地模型与收口证据（历史批次）

本轮需要实际调用模型的场景统一改用用户确认可用的本地 llama.cpp 服务：`local/qwen3-local` → `http://127.0.0.1:8081/v1`，模型为本机 `Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp.gguf`，服务端 `n_ctx=65536`。已用真实 `GET /v1/models`、`POST /v1/chat/completions` 及强制工具调用核对连通性和 tool-call 形状；没有为这些验收消耗远程模型额度。测试模型路由只替换真实模型场景，故意不存在模型与路由探针仍保持原有对照语义。

当前收口证据分开记录如下：

- 自动：本轮源码已通过 `npm run typecheck`、`npm run build`、`npm run test:unit`、`npm run vendor:pi:check -- --if-present`、`npm run measure:design`、`npm run audit:refs`；新增的安全边界调度器通过 `npm run test:skill-files`。
- 真实模型：`contextsweep`、`contextproduce`、`contextfoldpref`、`contextepisode`、`contextgate`、`contextrefresh`、`sessionab`、`subagent` 等实际调用场景均已切到本地模型并取得通过证据。`contextepisode` 已走过真实候选窗口，但本次模型判断没有满足生成 Episode 的条件，属于正常业务结果，不计作失败。
- Live 复合证据：在修正会话标题可变导致的分支夹具误判、全量批次切会话迟到帧，以及本地模型极短回复轮询窗口后，完整矩阵已重新跑通 **83/83**。其中 `branch`、`taskext`、`contextrefresh` 已在修复后单独 3/3 通过，并再次包含在这次全量 83 场景中；不是把两次运行拼成“全量通过”。
- 已完成的 Skill 文件边界：固定项目内 acquire 只进入受管 staging，安全边界调度器在 runner 空闲且 `runnerId`、generation、项目、目标版本、来源和 manifest 仍匹配时物化 active、重建同一 runner，并核对 `--skill`、续接 ID 和 `resumed` 回执；忙碌 runner 只延后。
- 后续按用户要求已停止本机 Qwen llama.cpp 服务，当前不把它当作仍在运行的前提；DeepSeek API 批次曾取得 `82/83`（唯一一次 `contextfoldpref` 超时，随后同模型隔离重跑通过），本轮新增的 `skilldirnet` / `discnet` / `test:unit` / Skill 边界检查均为 cost 0，不依赖模型调用。

仍未能勾选为“全部完成”的项目边界：

- 独立 Skill 目录的**只读发现**已有真实证据；本轮又完成了一个用户授权外部 Skill 文件候选从 acquire → staging → 安全审查 → 激活 → 原目标续接的真实整链。其它资源类型的外部候选与包级整链证据仍待补齐；当前完成的固定项目内 Skill 文件安全边界、SkillMD 风格目录解析，以及本地 / 远程接入基础不受影响。
- Android UI / APK、配对、TLS / 外部连通性仍是方案或桌面端 API 基础，不应写成移动端已交付；pi、工具、模型调用、项目文件和凭证仍留在桌面端。
- 当前源码对应的 `dist:dir` / `test:packaged` 已于本节更新后重新跑并通过：解包态、便携版和全新 NSIS 安装态 EXE 都取得了内置 pi、项目知识、Git、能力设置页、随包 CLI 和隔离哨兵的运行证据；包形态本身不再是当前阻塞项。

| 面 | 数字 / 结论 | 说明 |
|---|---|---|
| 自动检查 | **2026-09-19（实施-07 S2b-2）**：单测 **3746/3746**（i18n 单测拓到文案里的 `**`）；`typecheck` / `build` / `audit:refs` 干净；`gitwrite` 连续两次全绿（新增 7 条信任断言）。**2026-09-19（实施-06 S2 后半，N21-9 跑批器）**：单测 **3746/3746**（任务集自证仍绿）；`typecheck` / `audit:refs` 干净；mock 跑批 12 次全 `exit=0`。**2026-09-19（实施-06 S2 前半，N21-9 口径）**：单测 **3746/3746**（本片 **+63**：四组策略表达 / 判分规则 / 主副指标边界 / 任务集自检）；`typecheck` / `build` / `audit:refs` 干净。**2026-09-19（实施-07 S4）**：单测 **3683/3683**（本片 **+18**：兼容搜索能力判定的真值表 17 条 + MCP fixture 工具表 1 条）；`typecheck`（含 CSS 约定 / layer 自检）/ `build` / `audit:refs` 干净；新场景 `sourcecap`（cost 0）已进 `check`。**2026-09-19（实施-09 S2 第六批，L03）**：单测 **3665/3665**（本片 **+12**：模型失败终态与对照 / pi 起不来的启动超时与回收 / 运行超时的实际值提示）；`typecheck`（含 CSS 约定 / layer 自检）/ `build` / `audit:refs` 干净；新场景 `subagentfail`（cost 0）已进 `check`，`runnerfailed` 加第 4 节。**2026-09-19（实施-09 S2 第五批，N12 退出变体）**：单测 **3653/3653**（本片无纯逻辑改动）；`typecheck`（含 CSS 约定 / layer 自检）/ `build` / `audit:refs` 干净；新场景 `exitsave` / `exitinterrupt`（cost 0）已进 `check`，两次反向验证（改回 `interrupt-exit` → 只那条红；`mode` 写死 `save` → `exitinterrupt` 红）。**2026-09-19（实施-05 S5b-1）**：单测 **3299/3299**（本片 **+55**：键归一化与 `work-mode-service` 交叉校验 8 / 链建模与代表段 11 / 拼接顺序与摘要 4 / 脏值清洗 7 / `link` 四种情形与重启后关系 15 / 落盘失败 2 + 既有回归）；`typecheck` / `build` / `audit:refs` 干净。**2026-09-19（实施-05 S5a）**：单测 **3244/3244**（本片 **+62**：计入规则 / 去重键 / 计数幂等与上限 / 资格四条件 / 交接包清洗 / 真文件存储的幂等与「重启不归零」）；`typecheck` / `build` 干净；`contexttakeover`（cost 1）afterExit 新增两条断言全绿。**2026-09-19（实施-05 S4）**：单测 **3182/3182**（本片 **+51**：公式交叉校验 8 / 默认值一致 2 / 覆盖值解析 7 / 估算口径 10 / 三档边界 11 / 产品接线 4 + 既有回归）；`typecheck` / `build` 干净；**假 provider 两组对照（cost 0）**：`hook-probe budget`（physical：假 provider 只收到 1 个请求，第 2 个被兜下；会话里有 `yan-budget-abort` 留痕）、`budget-soft`（对照：2 个请求全发、0 abort）；新增 cost 1 场景 **`budgetgate`** 全绿（真实链路：`request-budget-soft` 有，`physical` / `budget-abort` 为 0）；回归 `contexttakeover`（cost 1，压缩链路照常：`beforeTokens=31158 → afterTokens=98`）/ `contextbudget` / `context`（cost 0）/ `hook-probe abort` / `workmode`。**2026-09-19（实施-05 S3c）**：单测 **3131/3131**（本片 **+28**：续行契约 10 / 快照 kind 2 / 存储 16）；`typecheck`（含 CSS 约定 / layer 自检）/ `build` 干净；新场景 **`goalloop`**（cost 1，固定 `deepseek/deepseek-v4.1-flash`）+ `afterExit: goalLoopPersisted` 全绿；回归 `goal`（S3b 就绪续行，cost 1）/ `workmode`（cost 0）全绿。**2026-09-19（并行编排 W1 · 01-S4b / 03-S2 / 04-S1 / 08-S0）**：单测 **2684/2684**（01-S4b **+17**：`browser.js` 零注册 / `browser.*` 已登记 / CLI 错误码与退出码分层；03-S2 **+153**：14 节真实文件断言）；回归 `test:live -- live`（cost 0）、`browser` / `browserboundary`(L04) / `slashcmd`（3/3）通过。**01-S4b 取到端到端最小闭环**：`test:live -- browserclimodel`（cost 1）两次通过 —— 模型自己发现 `yan browser` 能力入口并完成 `navigate` → `observe`。04-S1 是**零模型调用**的技术预检（RPC 33 命令 / `yan` 10 个已登记命令、差集 8 个）；08-S0 是**零代码**设计冻结（526 行状态机文档）。全部由本机 `pi -p` 非交互子代理完成，主编排者已核对**文件域与 mtime**。⚠️ 单测与 live 数字来自各自子代理的实测输出（编排者只复跑了 `audit:refs`）**2026-09-19（子代理委派）**：单测 **2698/2698**（修 4 条红：`yan` CLI 校验顺序回退 + 测试按**组名**取动作表）；`typecheck` / `build` 干净 —— 详见下方本轮节。**2026-09-19（03-S3 项目知识）**：单测 **2773/2773**（**+75**）、live `knowledgeinject`（cost 1）全绿。**2026-09-19（03-S4 CLI）**：单测 **2787/2787**（**+14**）、live `knowledgecli`（cost 1）全绿。**2026-09-19（03-S5 设置页）**：单测 **2817/2817**（**+30**）、live `knowledgetab`（cost 0）全绿、视觉 4 张 **2026-09-20（实施-04 S6b-1）**：单测 **3948/3948**（本片 **+58**：远程 MCP 登记纯逻辑 / 真文件 / 真协议）；`typecheck`（含 CSS 约定 / layer 自检）/ `build` / `audit:refs` 干净；新场景 `mcpregister`（cost 0）已进 `check`，反向验证 4 条红 —— 均见下方本轮节` |
| 自动检查 | **2026-09-19（实施-05 S6，05 收尾）**：单测 **3610/3610**（本片 **+10**：`handoffCommitEnabled` 默认值与显式关闭 9 条 + resume 正文要求 1 条）；`typecheck` / `build` / `audit:refs` 干净；`dist:dir` + `test:packaged` 全绿（asar 静态索引 4 + 解包态交接 3）。**2026-09-19（实施-05 S5b-4）**：单测 **3600/3600**（本片 **+19**：链感知历史 / `forget` 幂等与落盘）；`typecheck`（含 CSS 约定 / layer 自检）/ `build` / `audit:refs` 干净；视觉矩阵 `chainjoin` 组 0/1 全绿（溢出 0px）；实测顺手修掉 `historyswitch` 的一条真缺陷（切会话时空缓存把 peek 铺好的历史打回 0，四道投影全改走 `projectSnapshotKeepingPeek`）。**2026-09-19（实施-05 S5b-3b）**：单测 **3581/3581**（本片 **+75**：`test-handoff-resume.mjs` 33 条 + `test-handoff-runner.mjs` 42 条）；`typecheck`（含 CSS 约定 / layer 自检）/ `build` 干净；新场景 **`handoffcommit`**（cost 1）全绿 + `afterExit: handoffCommitPersisted`（五阶段一个不缺 / 链两段且 `handoffId` 对得上 / 目的会话里有标记行 / 源会话与包都在）；回归 `workmode` / `live`（cost 0）全绿。**2026-09-19（实施-09 S1）**：`typecheck`（含 CSS 约定 / layer 自检）/ `build` 干净；单测 **2510/2510**（本轮无纯逻辑改动，条数不变）；**cost 0 四场景全绿**（`fs` / `narrow` / `railmini` / `toolgroup`）—— `fs` 此前稳定红 3 条现已全清，`narrow` 三档窗口收回硬值 0，`toolgroup` 补上上一轮「25 条高度」未重跑的尾巴。**2026-09-18（实施-02 S5）**：单测 **2510/2510**（本片 **+9**：证据链前提 —— 两个 fixture 扩展、`taskplan` 已接线、`electron-builder.yml` 里 `yan-cli` 的 from/to）；`typecheck` / `build` 干净；新增 cost 1 场景 **`taskplan`**（模型自主多步，全绿）与回归 `taskcli` / `taskext` / `slashcmd` / `todos` / `todonew` / `sessions` / `historyswitch` 全绿；`npm run dist:dir` + `test:packaged` 通过（新增 11 条 —— 启动器落地、指向解包目录、CLI 真跑、无宿主时报错可读）。**2026-09-18（实施-02 S4）**：单测 **2501/2501**（本片 **+48**）；`typecheck` / `build` 干净；`slashcmd`（cost 0，第 3/20 节改写）与回归 `todos` / `taskext` 全绿；`taskcli`（cost 1，deepseek）全绿（含 4 条来源断言）—— 同轮**修掉一个真缺陷**：`resources/yan-cli/yan.mjs` 的 help 文案里嵌了反引号，整个 CLI 语法报错（已补「真跑 CLI」的单测）。**2026-09-18（实施-02 S3）**：单测 **2453/2453**（本轮 +53）；`typecheck` / `build` 干净；新场景 `taskcli`（cost 1，不进 `check`）与回归 `todos` / `taskext` / `capability`（后者用 `YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash`）全绿；**`fs` 稳定红 3 条**（焦点 / roving tabindex，AB 验证与本片改动无关，**已于 2026-09-19 修真因**，见「本轮（2026-09-19）实施-09 S1」）。**2026-09-18（方案 S1）**：单测 **2237/2237**（新增 38 条真实文件读写：图片落盘 + 逐字节读回、同内容幂等、会话隔离、路径穿越进不来、文件引用「还在不在」的复核、**「登记着但磁盘上没有」如实报**、移除只删副本不碰原文件、会话清理带走副本）。**2026-09-18（方案 P2 界面 + 端到端）**：单测 **2199/2199**；新增 live 场景 **`pkgs`**（cost 0，专属 fixture）—— 真实调用 pi 的 CLI 装一个本地包再卸掉，6 条详情断言（描述 / 来源 / 许可 / **「会执行代码、不做沙箱隔离」的边界声明**）。**隔离**：`YAN_PI_DIR` + 本地路径源，不联网、不碰用户真实装的包。**2026-09-18（方案 H1 / G3）**：单测 **2145/2145**（新增 15 条纯解析：remote 的三类写法、Windows 盘符不当成 scp、自建服务不猜、三家托管站各自的 compare 路径 —— Bitbucket 的顺序与我们相反）。**2026-09-18（方案 W2a）**：单测 **2130/2130**（G11 新增 24 条真实仓库：已暂存/未暂存/未跟踪三份分开迁移、二进制逐字节、未跟踪文件内容、目标侧 diff 摘要比对、源 status 与 index **逐字节不变**、起点非 HEAD 时拒绝、冲突时拒绝且不留半个工作树、勾选项过期时拒绝）。**2026-09-18（方案 W1）**：单测 **2106/2106**（G10 新增 52 条真实 `git worktree`：slug 规则、`worktree list` 解析、真实创建、主工作树不受影响、未提交改动不跟着过去、五条拒绝路径、删除的三类拦截、干净且已推送后真的删掉）。**2026-09-18（方案 G2）**：单测 **2055/2055**（G2 新增 **+79 条真实仓库写操作**：暂存只动选中文件、取消暂存**不碰工作区内容**、无首提交走 `rm --cached`、hook 拒绝、身份未配置、脏工作区切分支由 git 裁决、并发写按仓库串行、被拒时 HEAD 与提交数不变；以及 **+42 条纯逻辑**：失败分类 / 提交说明与分支名校验 / 长度前缀的版本摘要 / 命令参数构造）。`typecheck` / `build` / `audit:refs` 干净；**单测 1853/1853**（2026-09-18 从 1509 增至 **1620** —— 其中 +7 是 N18 尾巴的 IPC 错误剥壳 `stripIpcErrorPrefix`；新增 P2-7 `episode-fold` 界面开关 22 条、「三阶段独立 Rearm/Cooldown」30 条、**EpisodeState 切片 36 条**（确定性边界 / 收束判据 / 幂等与上限 / 消费门与生成门 / 真落盘三连 + schema 交叉校验），1509 那批是 N21-8 Deep Context 的闸门 / 输入有界 / 解析容错 / 注入幂等，以及用户开关的三个来源与优先关系；1450 那批的构成是 **N21-5 前置硬化 +50、N21-11 CJK 估算 +7、N21-6 State Refresh +5、provenance +35**：`turnsSince` 回合口径 / 输入自净 / `foldEligible`（含「清扫不得绕过地板」）/ 注入契约头与 `freshness`+`sourceHead` 透传 / `episodesDropped` / `pendingUserOnly` 与 `freshView` / `tailRolesOf`；此前 1353 里含 N01 的 25 条拖拽顺序与 R01–R04 的 **42 条失败路径断言**）。**2026-09-18 用 `YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash` 分批跑完了 check 的全部 live 场景**（33 + 23 + 18 次执行，含重复回归）：**唯一的红是 `todos`**；另有三处红是**真 bug、已修**（`features` 的档位断言拿了 detached 节点；`contextproduce` / `contextgate` 的退出后检查没按会话隔离），两处是**批量负载下的偶发**（`sessions` / `virtual`，单跑即绿）。上一次全量实跑（早于本轮改动）是 71 个场景 69 通过 | `todos` 是**陈旧失败**（任务面板按产品边界保持现状，AGENTS.md 第五节）；`subagent` 在换用 deepseek 后已转绿（此前是免费模型返回**空文本**）。另有手动场景 `compactionstatus` **前提过期**：pi 0.85.1 不再按 `reserveTokens` 在回合结束自动压；用改动前的实现重跑同样失败，app 侧压缩链路由 `contexttakeover` 覆盖并通过。**已处置（2026-09-19）：按 [实施-06 §2](../plan/active/实施-06-上下文管理收尾.md) 选项 ② 从手动清单降级为说明** —— 场景条目与探针保留（顶部写前提过期），不再列入待跑项；覆盖改指 `contexttakeover` / `contexttakeoverstate` / `test-compaction-status.mjs` |
| 真实运行 | **2026-09-19（实施-07 S4）**：`sourcecap`（cost 0）全绿 —— 真连 MCP fixture（工具表含 `web_search`）→ `available:true` + 入口出现 + 只写草稿不代发；**反向验证**（工具名与描述都去掉搜索语义 → `available:false` + 入口消失）；回归 `mcpcli` 全绿。**2026-09-19（实施-09 S2 第六批，L03）**：`subagentfail`（cost 0）全绿 —— 修前后对比在反向验证里拿到（写死 `modelFailed=false` → `status=done` / `error=null` / 「已完成」）；`runnerfailed` 第 4 节全绿（坏入口下子代理 `status=error` / `pi 子进程提前退出` / `review=none`）。**2026-09-19（实施-09 S2 第五批）**：`exitsave` / `exitinterrupt`（cost 0）全绿 —— `requestExit()` 返回值（`save-and-exit` / `interrupt-exit` / 重复 `already-exiting`）+ 沙箱里真写的 `exit-snapshot.json`（`mode` 与本次请求一致、`at` 与探针时刻对齐、`runners` 条数一致、无 `.tmp`），两次反向验证见上；孤儿进程检查 ✓。**2026-09-19（实施-05 S6）**：`handoffcommit`（cost 1，**本场景不再设任何开关**）全绿 —— `autoCommit=true` 本身就是「默认开真的生效」的断言；新增「目的会话继承了自主档（实际 autonomous）」。**2026-09-19（实施-05 S5b-4）**：`handoffcommit` 扩出 4b 节全绿 —— `listSessions()` 里当前会话只出现一次、链上旧段没有单独出现，界面 `messages` 里源段消息与 resume 消息同处一条时间线；回归 `sessions` / `trash` / `historyswitch` 全绿（后者靠本轮修复才绿）。**2026-09-19（实施-05 S5b-3b）**：`YAN_HANDOFF_THRESHOLD=0 YAN_HANDOFF_COMMIT=1 npm run test:live -- handoffcommit`（cost 1，固定 deepseek 一闪）**全绿** —— 探针看到事务 `committed → resumed` 与视图切到目的段；退出后磁盘：`resumed(attempts=1)` / 五阶段一个不缺 / 链两段 `handoffId` 一致 / 目的会话文件（4439 字符）里有 `[yan-handoff-resume:<id>]` / 源会话与包都还在 / 请求与结果目录已清空。**2026-09-19（实施-05 S5a）**：`YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash npm run test:live -- contexttakeover`（cost 1）全绿 —— 既有链路（工作集压缩 `beforeTokens=31158 → afterTokens=98`）不受影响，且 afterExit 新断言拿到：`handoffs.json` 里那条会话 `count=1`、去重键 `entry:e-…` 已落盘。**2026-09-19（实施-05 S4）**：**假 provider（cost 0）**—— `hook-probe budget`：工具产出 40 万字符后，第 2 个请求的诊断为 `request-budget-physical`（估算 13621 + 输出预留 195000 = 208621 > 窗口 200000），`ctx.abort()` 后假 provider **只收到 1 个请求**，会话多一条 `custom: yan-budget-abort`（估算 / 预测 / 窗口 / 原因）；`hook-probe budget-soft` 对照：同一份消息与同一个大结果，**2 个请求全发**、0 abort，且第 2 个请求 `bodyChars=55054` ↔ 估算 13621 token（4 字符/token 口径偏差 ~1%）。**真实模型（cost 1）**：新场景 `budgetgate` 全绿 —— 工作集线压到 3000 后 `request-budget-soft`（窗口 1048576 在 `before_provider_request` 里真读到）出现，`physical` / `budget-abort` **都是 0**（未误拦）；回归 `contexttakeover` 全绿。**2026-09-19（实施-05 S3c）**：新场景 `goalloop`（cost 1）真跑通「**一条用户消息** → 自主档报一次进展（rev1 `executing`）→ 回合空闲后宿主续行自动叫醒（助手 2→3）→ 续接轮把目标推到 `completed`（rev2）」；退出后核对：`goals.json` rev2 + 报告 2 条、会话文件里有 `yan-goal-resume`（消费证据）与 **`yan-goal-continue`**（控制消息，角色不是 user）、`goal-resume/r1.consumed.json` 记了 operationId、扩展日志有 `kind=continue` 的 `resume_sent`。**一条实测教训**：默认免费模型 `longcat-2.0:free` 收到「跑这条命令再收尾」只回文本、一次 `bash` 都没调（目标停在 rev0，属假红）→ 场景固定 deepseek 一闪，与 `browserclimodel` / `capsearch` 同一处置。**2026-09-19（实施-05 S3b）**：跨轮续行真跑通 —— `test:live -- goal` 里就绪提交后**自动起了新回合**；会话文件里有 `yan-goal-resume`（消费证据）与 `yan-goal-ready`（控制消息，**角色不是 user**）；扩展日志给全时间线（message_end → 1.8s 二次确认 → check → resume_sent → custom 消息）。回归 `workmode` / `todos` / `queue`（abort 路径）/ `ask` 全绿。**2026-09-19（实施-05 S3a）**：澄清档门禁**三组对照**（假 provider，cost 0）—— 工具表 `[bash,read,write,edit]`→`[bash,read]` 且**发出去的请求里也没有 write/edit**；同一条写文件命令在对照组真写、在澄清组被拦；`yan goal status` 按形状白名单放行并真的跑到 CLI。端到端 `test:live -- goal`（cost 1）：澄清档 → 内联 `yan goal ready` → **模式自动切标准** + 目标 `executing` + 工具卡标「目标 · 砚内置」，退出后磁盘核对幂等与落盘。**2026-09-19（实施-05 S1）**：钩子能力边界五组对照实测（**假 provider，不联网不花钱**）—— `tool_call` 的 `{block:true}` 是真门禁（同命令在对照组真写了文件）、`ctx.abort()` 能让下一个请求**真的不发**（代价是整轮 `Request aborted`）、**钩子里不能压缩**（`ctx.compact()` 返回 undefined 并弄坏当前 run，安全点是宿主 RPC `compact`）、`before_provider_request` 返回新 payload **真能改写请求体**；设施 `scripts/hook-probe.mjs` + `scripts/lib/mock-provider.mjs`，全文 [证据-05-S1](../archive/evidence/证据-05-S1-钩子与安全点.md)。**2026-09-19（实施-05 S2）**：新场景 **`workmode`（cost 0，已进 check）全绿** —— 旧配置迁移 / 菜单三档与说明 / 方向键与 `Esc` / **`Tab` 真按键**（焦点没被移走）/ A-B 会话不串 / 退出后磁盘核对（`work-modes.json` 两条 + `work-mode/<runnerId>.json` 快照 + 旧字段保留 + 开关默认态不落键）；**`ask`（cost 1）**第 6 节两道证据（不弹窗 + 诊断 `execute mode=autonomous`）；回归 `slashcmd` `atPath` `settings` `sendkey` `hotkeys` `dialog` `todos` `pending` `queue` `layout` `vheight` `symmetry` `narrow` 全绿。**抽到两个真缺陷并修掉**：模式键不能用 pi 的 `sessionId`（同一文件会换 id）→ 改用会话文件路径；`answerUi` / `dismissRequest` 只清顶层、缓存里的旧 UI 请求会被 `runners` 推送投影回来（已回答的问题“复活”）。**2026-09-19（实施-09 S1）**：**cost 0** —— `fs`（3 条红全清：`End` 移到最后可见节点 / roving tabindex / 鼠标收起焦点）、`narrow`（三档窗口收起后 `rail=0px`）、`railmini`、`toolgroup` 全绿；两条缺陷都做了**反向验证**（48px 临时改回 → 两档变红并实测 48px；fs 的 `End` 用逐帧日志定案 `found:false` → `found:true`）。**2026-09-18（实施-02 S5）**：新场景 `taskplan`（cost 1，deepseek-v4.1-flash）一次全绿 —— 模型自己写请求文件、5 次 `yan tasks apply`、建出 3 个文件、界面 3/3 完成，**界面与磁盘日志逐条相同**（文字 + 勾选），会话 JSONL 里无任务条目；`taskcli` 新增「取消」一节 4 条（取消后清单不变、无卡住的运行行、输入框可用，退出后日志仍是 2 行）；`taskext` 扩成「旧任务扩展 + **无关扩展**」（诊断 2 项、`/notes` 可用）；回归 `todos` / `todonew` / `slashcmd` / `sessions` / `historyswitch` 全绿。**2026-09-18（实施-02 S4）**：`taskcli`（cost 1）新增 4 条 —— 工具行被标为砚内置任务计划 / 标记的仍是 bash 卡 / 徐标写「任务计划」/ 展开后能看到原始命令；`slashcmd`（cost 0）第 20 节 —— 手打 `/panel` 后草稿逐字符未变、合成附件仍在、给出两句话原因、**没发给模型**；`taskext`（cost 0）第 4 节 —— 用户扩展注册的 `/panel` 与兼容项两条并存，命中兼容那条。**2026-09-18（方案 S1）**：`gitwrite` 扩到 **96 条断言**全绿 —— 第 13 节走完整路径：加网页来源 → 列表出现（标题取自输入、"已关联"态、打开按钮带原始地址）→ 四个筛选出现 → 移除后消失；并断言两句**边界文案**（「移除不会删你的原文件、不改写已发送的历史」「只是关联，不上传代码」）。**2026-09-18（方案 H1 / G3）**：`gitwrite` 扩到 **81 条断言**全绿 —— 第 13 节走界面加/删外部链接（`javascript:` 地址被拒、标题与原始地址都对、**边界文案里「不会上传代码」被读出来断言**），并验证本地 bare remote **不显示**「在网上比较」（给一个打不开的链接比不给更糟）。**2026-09-18（方案 W2）**：`gitwrite` 扩到 **72 条断言**全绿 —— 第 11 节走界面勾选携带（未暂存 + 未跟踪）→ 回读**目标工作树**里真有那些改动、源仓库里那份改动**还在**；第 12 节点「开新会话」→ 回读会话 cwd 真的换了、菜单自动收起。**这一轮又抓出三个真问题**：① 已暂存的 patch 必须应用**两次**（`--cached` 进 index + 再进工作区），只做 `--cached` 会在目标里凭空造出一个「未暂存改动」，源仓库里那个文件本来是 index 与工作区一致的；② `notes.unshift(...字符串)` 把**每个字符**塞成一条 note；③ 探针里 `data-testid` 在 input 自身上却按「内部 input」查 → 数到 0 个（诊断输出显示文案里明明有文件名）。**2026-09-18（方案 W1）**：`gitwrite` 场景扩到 **57 条断言**全绿 —— 新增工作树一节：菜单里创建 → **主进程回读**多出一条、路径落在 `<仓库名>-worktrees` 下（不是临时目录）、没有上游时「移除」被拒并列出原因、被拒后工作树还在。**这一轮也抓出两个真问题**：① `git worktree list --porcelain -z` 的 `-z` 是把**每一行**都以 NUL 结尾（不是记录之间分隔）—— 我按后者解析，导致 `branch` 永远是 null、「分支被其它工作树占用」不会亮、删除检查里的未推送判断被整段跳过（合成输入不会暴露它，真实仓库测试一跑就中）；② 探针第 9 节点了 `env-create-branch` 却没先等它可用，**disabled 的按钮不派发 click**，事件被浏览器吞掉（同一个坑第三次复发，已写进注释）。**2026-09-18（方案 G2）**：新场景 `gitwrite`（cost 0，**已进 check**）—— 44 条断言全绿，每条关键步骤都**回读主进程的真实 git 状态**（不是界面自证）；退出后 `afterExit: gitWriteApplied` 用真 git 核对：HEAD 的提交说明就是界面上输入的那条、分支停在 main、`live-made` 分支存在、**bare remote 里的 main 与本地 HEAD 同一个 sha**（推送真的出去了）。同批回归 `gitreview`（只读保证）全绿。**真实运行抓出两个设计问题**：① 初版让每个动作都比三件套预期版本 → 连点两个文件的暂存第二个必被拒、提交后立刻推送必被拒（全是假冲突）→ 改成按动作分级；② 写操作成功后界面手里的 expected 还是旧的 → 切回 main 后马上建分支被拒 → 用响应里带回的状态就地更新（摘要字段置空，任何「全比」的动作照常被拒）。**2026-09-18 深夜（方案 G1）**：新场景 `gitreview`（cost 0，**已进 check**）全绿 —— 环境菜单/范围切换/行号与增删/「N 行未修改」真的展开（8→83 条上下文行）/已查看持久化/图片前后对照（两张图字节不同）/二进制不伪造行数/筛选与折叠；**退出后逐字节比对** `status`、`ls-files -s`、`diff --cached --numstat`、`HEAD` 证明只读，并做了三条反向验证（注回 `git add -A` → 场景 6 条红；只污染 index → 退出后 3 条只读断言红）。此前：cost 0 场景 + 手动 cost 1 场景 | **2026-09-17 R01–R04 轮**：`title`（cost 1，真实通过；新增「手动名真的落盘」与「返回明确成功」两条断言）、`browserboundary`（cost 0，R01 回归）、`sessionrunners`（cost 0，R02 回归）全绿。上一次全量轮次实跑：`sessions` `historyswitch` `contextbudget` `toolgroup` `fs` `e2e` `tokens` `language` `contexttakeover` `live` `reasoning` `virtual` `logs`。**2026-09-17 S1 轮次**：`contextstate`（真实窗口删会话 → 退出后查派生状态清理）、回归 `trash`（真删 + 撤销）与 `sessions`。**2026-09-17 S2–S6 轮次**：`contextsweep`（cost 1，三个回合：真实 pi 里第二个回合后 sweep 生效 + 模型真的 `context_recall` 取回原文 + 第三个回合确认召回正文被清成存根，见方案 §15.4），同批回归 `contextstate` 与 `trash`；随后用用户指定的 `YAN_TEST_MODEL=commandcode/longcat-2.0:free` 独立重跑并通过（bash 8893、recall `turn=2`、`expiredRecalls≥1`、0 error）。**2026-09-17「清理默认开」轮次**：同一场景改为**不设 `kinds`** 重跑通过 —— 验的就是默认接管集本身（bash 8893、归档 1 条、`ctx://` 指得回原始条目、`swept≥1`、模型真的 recall 取回原文 `tokens=2224`、`expiredRecalls≥1`、0 error），见方案 §15.5。不可用或触顶时备用 `commandcode/laguna-s-2.1-free`。**同日 N21-7 轮次**：`contextbudget`（cost 0）重跑通过 —— 第 7 节真实改设置 → 来源 `user`、界面工作集 = 主进程算的、设置面板回填与恢复默认；同场修正 2 条陈旧断言（`下一步` 应为清理、图例两格已接管）。**同日 S7（状态生成器）轮次**：`contextproduce`（cost 1，**已进 check**）真实通过 —— 真实回合调 bash → 诊断 `stage=producer, hook=committed` 1 次且 0 错误、状态文件 `revision=1` / `objective` 非空 / `commands=1`、下一回合 `injectedTaskState=true`、状态文件过主进程 `loadContextState` 校验；同批回归 `contextsweep`（cost 1，**默认 kinds 下没有 producer 行** —— 验证“默认不花钱”）与 `contextstate` / `contextswitchguard` / `contextbudget`（cost 0）全通过。**同日（N01 拖拽排序）轮次**：`test:live -- railreorder`（cost 0，**已进 check**）37 条断言全绿 —— 合成 PointerEvent 走真实拖拽路径、回读 `yan.getSettings()` 验落盘、跨组拒绝、折叠态自动展开、搜索态禁用、click 被吞、无残留类名；同批回归 `live` / `grouprename` / `railsearch` / `projectlimit` / `railmini` / `railtitle` 六个侧栏场景全通过；另做了**两次反向验证**（去掉同组限制 → 跨组两条变红；不消费 click → click 那条变红，均已还原）。**2026-09-17 晚（N21-5 前置硬化）轮次**：`contextgate`（cost 1，新场景，**已进 check**）全绿 —— gate 被评估 1 次 / judged `too-early` / `committed` 0 次 / 状态文件 0 份，即「短会话不花钱」在真实链路成立；`contextproduce`（cost 1）适配 gate 后全绿，含 `task-state-injected{freshness:partial, sourceHead:6, tokens:119}`、`episodes 为空`、`gate 当场激活`；同批回归 `contextsweep`（cost 1，默认 kinds）/ `contextstate` / `contextswitchguard` / `contextbudget` / `context`（最后一条顺带修了一处陈旧 fixture，见 [归档 §1.11](../archive/2026-09-17-已完成归档.md)）。**同日第四轮复核轮次**：按外部意见改掉两处（Sweep 不得绕过最低回合数；`inject` 的语义写死为「允许 TaskState 参与任何模型可见上下文」），并落地「落后 1 条未 settled 的 user 视为 fresh」（`pendingUserOnly` + `freshView`），单测到 1394；`contextproduce` 重跑 7 次：**前 6 次里 5 次是免费模型侧失败**（`aborted` ×3 / `not-json` ×1 / `error` ×1，均已核实不是代码问题），**第 7 次成功且全绿** —— 拿到的关键证据是 `{"freshness":"fresh","sourceHead":6,"tokens":141,"gap":0,"turnsGap":1,"pendingOnly":true,"tail":["session_info","user"]}`（`pendingOnly:true` ↔ `freshness:fresh`，而 `turnsGap` 仍为 1）。 **2026-09-17 晚（N21-11 CJK 估算）轮次**：新口径下重跑 `contextsweep`（cost 1，默认 kinds）✓ 与 `contextgate`（cost 1）✓（前者 `swept>=1`，后者短会话仍 `too-early` / 0 提交 / 0 状态文件）；cost 0 四场景 `context` / `contextstate` / `contextbudget` / `contextswitchguard` ✓；`contexttakeover` 顺带修好了它的**静默失败**（探针现在先跑预热回合、发够大的消息、并在等压缩前断言「回合真的跑起来了」+ 打印 `pi 用量`），实测用量 1940 > 1500、**接管真的触发**（`triggeredBy: policy` / `policyStage: compact`），但压缩那一步调模型时撞上 **longcat 当日 100 次免费额度用尽（429）**、`laguna-s-2.1-free` 上游不可用 —— **改用用户指定的 `deepseek/deepseek-v4.1-flash` 后，`contextsweep` 与 `contexttakeover` 都取到绿**：后者 `pi 用量=31019` → 压缩 `completed`、`beforeTokens=31019` → `afterTokens=120`、`triggeredBy: policy` / `policyStage: compact`、界面「最近一次工作集 · 已完成」（场景本身也修好了：单个大回合 + `keepRecentTokens:1`，预算 180s → 420s，见 [方案 §18.8](../design/active/方案-上下文工具内的自动压缩-2026-09-15.md)）；**`contextrefresh`**（cost 1，新场景，已进 check）在策略 `{minTurns:1, minTokens:1e8, refreshRatio:1e-6}` 下命中 `near-window`，诊断 `{reason:"near-window", activated:true, window:1000000}` 证明 `ctx.model.contextWindow` 在真实链路可用（方案 §20）；**同模型下 `contextproduce` 也全绿** —— 生成器 1 次提交 0 错误、注入 1 次且 `freshness="fresh"`（`pendingOnly:true`）、gate 当场激活、状态文件 `revision=1` / `episodes 为空` / 主进程校验 ok、`stateOverhead=4.6%（low，分母改为只算本场景会话）；**同日 provenance 轮**：`contextproduce` 全绿且带回证据分布 `{"observed":1,"derived":1,"hypothesis":4,"total":6}`（模型真的引用）、注入 `tokens` 141 → 329（`inferred` 标记真的进了注入块）、状态文件过主进程校验（新的 `kind:tool + derived` 组合合法），`stateOverhead = 6.4%（low）`；**同日 superseded 轮**：注入诊断新增 `items:{active,skipped}`（真实运行 `{"active":7,"skipped":0}`），并用真实状态文件 + 真实注入链验证 superseded 不进注入块（`skipped=1` 渲染与注入均不含它，证据层级=模块级，见[归档 §1.17](../archive/2026-09-17-已完成归档.md)）；**同日模型级 override 轮**：`contextbudget`（cost 0，预算 90s → 180s）第 8 节真的 `setModel` 换到 `deepseek/deepseek-v4-flash`，模型级 override 当场失效（来源 `model` → `default`、工作集 321k → 240k），切回又生效（[归档 §1.18](../archive/2026-09-17-已完成归档.md)）；**同日结构化摘要轮**：新场景 `contexttakeoversummary`（cost 1）在**真实落盘的状态文件**上跑真实 `buildStructuredSummary` —— 逐类非空 4 类（task/constraints/unresolved/nextActions）、摘要 863 字符、两个块都在（[归档 §1.19](../archive/2026-09-17-已完成归档.md)）。**同一轮曾误报一个缺陷（已撤回）**：当时以为 `session_before_compact` 一次都没被调到，实际是**检查里的过滤条件写错了**（compact 系 trace 没在 payload 写 `stage`，而 `diagnostic` 只把第一参数放进 `hook`）；给 compact 系补上 `stage` 后 `contexttakeover` 实测 `{entered:1, fallback:1}` —— 钩子确实被调到，fallback 原因是 `inject-off`（该场景没开 `episode-fold`，符合设计）。「状态存在 + 水位可用 → 真的接管」那一次成功分支**已闭环**（同日）：新场景 `contexttakeoverstate`（cost 1）实测 **`takeover 1 次 / fallback 0 次`**（`tier=stale-hard`、`before=36397 → after=108`）—— 这是 `hook:'takeover'` 第一次在真实链路出现（[归档 §1.21](../archive/2026-09-17-已完成归档.md)）。**同日 N21-8 Deep Context 落地**：新模块 `context-deep.js`（216 行）+ `context.js` 的 ④ 挂接，单测 **1498/1498**；`contextdeep`（cost 1）全绿 —— Pass 1 `ms=3627 / outputChars=177`（真调了模型）、`injectedWorkingTrace:true`（注入真的进了这一轮）；反向验证在 `contexttakeoversummary` 里（没开则 **0 条 deep 记录**）；**默认关，且「可手动开」已闭环**：设置面板「上下文」页有开关（`ctx-deep`），传递链是「渲染端 → 主进程 → `desktop.json` → 扩展读文件」（不是 env，所以改完立即生效、不用重建实例）；视觉证据 `matrix-ctxsettings-1440x900-100-{dark,light}-2026-09-17.png` 已看图；界面路径的 live 证据是 `contextdeeppref`（cost 1）—— 扩展读到了开关并停在门槛上（`below-threshold`），真正的注入由 `contextdeep` 用测试通道降门槛验（[归档 §1.20](../archive/2026-09-17-已完成归档.md)）。**同日 P2-7 轮**：新场景 `contextfoldpref`（cost 1，**已进 check**）全绿 —— 从设置面板关掉之后，`desktop.json` 真的落 `contextFold.enabled:false`、诊断里 0 条生成动作但有 1 条 `hook:skipped / reason:kind-off`（带 `kinds=["tool-sweep","recall","compaction"]`，即扩展真的读到了关闭且只关了一项）、0 次注入、0 份状态文件；同日同模型的 `contextfolddefault` 是反向对照（同样条件下会生成）（[归档 §1.23](../archive/2026-09-17-已完成归档.md)）。**同日 N21-4 剩余项轮**：`contextproduce` 重跑全绿 —— 加了阶段节流后真实链路仍然「生成 → 落盘 → 注入」（[归档 §1.24](../archive/2026-09-17-已完成归档.md)）。**同轮 EpisodeState 切片**：新场景 `contextepisode`（cost 1，已进 `check`）全绿 —— 真实回合里 `hook:'episode-window'` 两次（`4条/837tok`）、模型给出 Episode 并落盘（id `ep-…` / `sourceRange` 指回原始条目 / `unresolved` 为 0）、`task.episodeRefs` 里没有它（shadow）、状态文件过主进程校验（[归档 §1.25](../archive/2026-09-17-已完成归档.md)）。**同日孤儿进程检查**：`test-live` 在所有场景跑完后新增一道进程表检查（命令行含 `--mode rpc` 且**父进程已不在表里**）—— `sessionrunners`（cost 0）实跑输出「✓ 没有残留」；反向验证：构造的真孤儿被检出（2 个），同时用户环境里正在跑的 5 个真实 pi 实例**全部未被误报**（父进程链在）。` |
| 视觉 | **2026-09-19（实施-07 S4）**：新增 `sourcesearch` 状态 —— `matrix-sourcesearch-1440x900-100-{dark,light}-2026-09-19s4.png`（**两张已看图**，溢出 0px）：来源菜单里的搜索入口与手工添加网址同屏。**2026-09-19（实施-09 S2 第七批，N04）**：`matrix-reasoninglive-1440x900-100-dark-2026-09-19s2d.png`（**已看图**，真实中英混排推理流 + 默认裁剪态 + 「展开全部」）与 `...-s2c.png`（对照：同命令未写语言要求 → 整段英文推理）。**2026-09-19（实施-09 S2 第六批）**：新增 `subagentfailed` 状态 —— `matrix-subagentfailed-1440x900-100-{dark,light}-2026-09-19s2b.png`（**两张已看图**，溢出 0px）：子代理列表行 `✕` + 红字原因、详情卡「失败」+ meta 原因。**2026-09-19（实施-09 S2 第五批）**：本片无 UI 变化，不新增截图。**2026-09-19（实施-05 S5b-4）**：新状态 `chainjoin`（`YAN_MATRIX_ONLY=chainjoin YAN_MATRIX_STAMP=2026-09-19s5b4`）→ `matrix-chainjoin-1440x900-100-{dark,light}-2026-09-19s5b4.png`（**两张已看图**，溢出 0px）：左栏只有代表段（标题来自链首段）+ 一条对照会话；消息区最下面一条是交接正文，接在 fixture 旧消息之后 —— 两段在同一条时间线上。⚠️ 过滤逻辑归主进程，图只证明渲染形态。同一次运行把 8 组都跑了（全 ✓；`chainjoin` 只在组 0/1 出图），并顺带重拍了 3 张引导层图（新 stamp，旧图未动）。**2026-09-19（实施-09 S1）**：`YAN_MATRIX_ONLY=railmini,fsnarrow YAN_MATRIX_STAMP=2026-09-19s1` → `matrix-railmini-940x620-100-dark-2026-09-19s1.png`（**窄窗收起，48px 缺陷的形态对照位**：消息区贴到窗口左缘、无竖条）、`matrix-railmini-1440x900-100-{dark,light}` 与 `matrix-fsnarrow-1440x900-100-dark`（组 0/1/3 全绿、溢出 0px，**三张已看图**）。⚠️ 修复前的旧批次截图**不能当对照**（隔着其它改动，像素比对显示差异不在「少一列」上）→ 改动前后的判据改用 A/B 数值实测（见「本轮」小节）。旧图未覆盖。**2026-09-18（实施-02 S5）**：`YAN_MATRIX_ONLY=taskhost,taskcard YAN_MATRIX_STAMP=2026-09-18s5` 跑组 0/1/4 → `matrix-taskhost-1440x900-100-{dark,light}-2026-09-18s5.png`、`matrix-taskcard-1440x900-100-{dark,light}-2026-09-18s5.png`、`matrix-taskcard-900x520-100-dark-2026-09-18s5.png`（共 5 张，溢出 0px，已看图：右栏任务/历史折叠、工具卡来源徽标、窄窗截断）。本片无 UI 改动，这一栏是 S1–S4 界面成果在新取证批次下仍成立。**2026-09-18（实施-02 S4）**：新增 `taskcard` 状态（内置来源工具卡）→ `matrix-taskcard-1440x900-100-{dark,light}-2026-09-18s4.png` 与 `matrix-taskcard-900x520-100-dark-2026-09-18s4.png`（窄窗）；`settingspkg` 扩断言并重跑 → `matrix-settingspkg-1440x900-100-{dark,light}-2026-09-18s5.png`（未跑 registerIpc，给 `yan:capabilities:builtin` 补了桩）。**5 张已看图，溢出 0px**；看图改掉一处文案错误（内置能力区移到已装列表之后，「下面」→「上面」）。**2026-09-18（方案 S1）**：`envlinks` 重跑成来源菜单（筛选、图片缩略图、文件、网页、「文件不在了」的异常态、边界文案）；`matrix-envlinks-1440x900-100-dark-2026-09-18p.png`（溢出 0px，已看图）。**这张图又抓出一次真问题**：`src-*` 那一整块样式我忘了写，标题与「已关联」粘在一起、缩略图占不到位置 —— 新组件没有样式时不会报错，只会难看。**2026-09-18（方案 P2）**：新增 `settingspkg` 状态（目录入口 / 安装区 / 已装列表三种状态：用户级、项目级、「磁盘上找不到」/ 生效时机）。**这张图抓出两个真问题**：① 视觉矩阵**不跑 `registerIpc`**、全靠桩，漏了 `yan:packages:*` 就在界面上渲染成 `No handler registered`；② `.set-row` 是 **grid**（两列），只写 `flex-direction: column` 完全无效 —— 内容被留在第二列、整块跑到右半边（改成显式 `display: flex` 才对）。图：`matrix-settingspkg-1440x900-100-dark-2026-09-18n.png`（溢出 0px）。**2026-09-18（方案 H1 / G3）**：新增 `envlinks` 状态（菜单滚到底：在网上比较 · github.com、关联外部任务的一条 + 两个输入 + 边界文案）；`matrix-envlinks-1440x900-100-dark-2026-09-18j.png`（溢出 0px，已看图）。**2026-09-18（方案 W2）**：`envworktrees` 状态重跑（`matrix-envworktrees-1440x900-100-dark-2026-09-18i.png`，溢出 0px，已看图）。分支名原来被挤成 `feat/git-re...` —— 改成允许换行 + 名字保底 96px（分支名是这个区里最需要看全的东西，要拿它去终端里敲）。**2026-09-18（方案 W1）**：新增 `envworktrees` 状态（工作树区：主工作树**没有**移除按钮、砚创建的带标记、同时删分支、新分支名与目标目录两个输入）；`YAN_MATRIX_ONLY=envworktrees` 跑组 0/1 → `matrix-envworktrees-1440x900-100-{dark,light}-2026-09-18g.png`（2 张，溢出 0px，已看图）。**2026-09-18（方案 G2）**：新增两态 —— `reviewwrite`（文件行「暂存 / 取消暂存」+ 头部批量按钮 + 底部提交区）与 `envbranches`（环境菜单展开分支列表 + 当前分支标记 + 新建分支输入 + 拉取 / 推送 ↑N）；`YAN_MATRIX_ONLY=reviewwrite,envbranches` 跑组 0/1 → `matrix-{reviewwrite,envbranches}-1440x900-100-{dark,light}-2026-09-18f.png`（4 张，溢出 0px，已看图）。**2026-09-18 深夜（方案 G1）**：新增两个状态 —— `envmenu`（环境菜单：变更/本地+打开复制/分支/PR 不可用/比较分支）与 `review`（审查面板：范围+统计+两列行号 diff+未修改区+变更树+已查看进度+图片对照）；`YAN_MATRIX_ONLY=envmenu,review` 跑组 0/1 → `matrix-{envmenu,review}-1440x900-100-{dark,light}-2026-09-18e.png`（4 张，溢出 0px，已看图）。**截图当场拍出两个真问题**（审查面板与工具栏争空间、「本地」点了却打开审查），已修并重拍。此前：**2026-09-18 深夜本轮**：组 0 **全绿**（**24 个状态**、溢出 0px）—— 新增 `pendingcards`（待投递卡片）、`railsessions`（项目会话折叠），`railmini` 重拍成「左栏完全消失」；证据 `matrix-{pendingcards,railsessions,railmini}-1440x900-100-dark-2026-09-18.png`（已看图）。**同日更早一轮**：新增 `autonomous` 状态（自主模式双光带），跑组 0 全绿，产出 `matrix-{autonomous,main,modelmenu}-1440x900-100-dark-2026-09-18.png`。此前：`npm run visual:matrix` **组 0/1 追加 `usageturn` 通过**（R03 证据：`matrix-usageturn-1440x900-100-{dark,light}-2026-09-17.png`，溢 0px；`YAN_MATRIX_ONLY=usageturn` 跑组 0/1）。此前：**8 组全绿、40 张截图**（37 个状态 + 3 张引导层） | 组 0/1 重跑（深/浅共 26 张，含 `usageelapsed`）；每张带溢出 ≤ 1px 与关键元素硬断言。**2026-09-17 追加批次**（`STAMP=2026-09-17`）：只重跑受「Tool Sweep 默认开」影响的 3 张 —— `matrix-contextbudget-{dark,light}` 与 `matrix-ctxnarrow-dark`（`YAN_MATRIX_ONLY=contextbudget,ctxnarrow` 跑组 0/1 全绿、溢出 0px）：新图里「下一步」已变成**清理旧工具输出（约 168k 时）**、清理阶段标记为已接管；旧批次（`-2026-09-16`）原样保留。**整组**重跑仍受本机 GPU/Network 崩溃影响（组 0 跑到 10 分钟看门狗），与本次改动无关。**同日 N21-7 追加批次**：`YAN_MATRIX_ONLY=ctxsettings` 跑组 0/1，产出 `matrix-ctxsettings-1440x900-100-{dark,light}-2026-09-17.png`（设置面板「上下文」tab，溢出 0px）。**同日（N01 拖拽排序）追加批次**：`YAN_MATRIX_ONLY=railreorder` 跑组 0/1，产出 `matrix-railreorder-1440x900-100-{dark,light}-2026-09-17.png`（截图停在**拖拽进行中**：被拖行半透明 + 目标位置 2px 插入线；溢出 0px；已裁剪放大逐张核对深浅两套对比度）。**同日 P2-7 追加批次**（`STAMP` 起可由 `YAN_MATRIX_STAMP` 覆盖，旧批次原样保留）：`YAN_MATRIX_ONLY=ctxsettings` 跑组 0/1 → `matrix-ctxsettings-1440x900-100-{dark,light}-2026-09-18.png`（新增 `ctx-fold` 开关行，溢出 0px，已裁剪放大看图核对「已开启」按钮与中英文案）。**同日 N03 追加批次**：新增两个状态 —— `toolgroup`（折叠组展开、组内行保持一行）与 `toolterm`（命令行的终端窗口，只有命令类工具会渲染 `.term`）；`YAN_MATRIX_ONLY=toolgroup,toolterm` 跑组 0/4 → `matrix-toolgroup-1440x900-100-dark`、`matrix-toolterm-1440x900-100-dark`、`matrix-toolgroup-900x520-100-dark`（**窄窗口**）三张，溢出 0px，已裁剪放大核对 |
| 应用与包 | **2026-09-21 最新复核**：`dist:dir` + `test:packaged`、便携版 `--exe`、全新 NSIS 安装后 EXE `--exe` 均通过完整运行探针；`npm run dist` 已重建三产物与 `SHA256SUMS.txt`，`npm run test:upgrade` 仍以真实用户数据副本验证且原目录 60 个文件逐字节不变。此前“安装包未跑安装流程 / 全量 check 未跑”是旧状态，不再作为当前限制。其余历史包证据保留如下：**2026-09-19（实施-09 S4/S5）**：`vendor:pi:check` ✓；包内开发日志污染已修（`files` 改白名单，无本机路径）。**2026-09-19（实施-05 S6）**：解包态交接恢复与包内静态索引全绿。**P0-8 已完成（2026-09-18，六步走完）** |
| 已知偶发 | 免费模型可能因日配额或供应商状态返回空文本/零 usage；这会让 `tokens` `subagent` `contexttakeover` 等需要真实 usage 的场景变红 | 先用 `YAN_TEST_MODEL=commandcode/longcat-2.0:free`；不可用或触顶时换 `YAN_TEST_MODEL=commandcode/laguna-s-2.1-free`，再分辨「模型当时不可用」还是「代码回归」。**2026-09-17 晚实测**：同一夜连跑 `contextproduce` 6 次只有 1 次成功，失败形态分别是 `aborted`（20s 生成超时）/ `not-json`（返回空文本）/ `error`；换备用模型也一样。**2026-09-17 深夜已确证原因**：`commandcode/longcat-2.0:free` **当日 100 次免费额度用尽**（pi 原样报回 `429 You've used all 100 free LongCat 2.0 requests for today`，配额 `2026-09-18T00:00:00Z` 重置），换 `laguna-s-2.1-free` 则报上游暂不可用。**规则**：看到 429 就直接停手（每跑一次都是在烧剩余额度，而且拿不到结论）。**换模型**：用户指定 `YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash`（1M 窗口、支持思考）后，`contextsweep` / `contexttakeover` 均真实通过 —— 免费模型不可用时的首选替代。**另一个易踩的坑**：探针变慢以后没同步加 `budget`，进程会在打印前被 kill，而 `buf` 为空又被报成「应用可能启动失败」（`contexttakeover` 就此白查三轮，现已在提示里区分这两种情况） |

### 本轮增量（2026-09-22）· 实施-04 S6b-2：用户授权外部 Skill 整链与恶意内容审查

| 六栏 | 证据 |
|---|---|
| 实现 | `src/shared/skill-security.ts` 是无 IO / 网络 / 执行副作用的纯静态扫描器；Skill 文件在 staging 前与 active 前各审查一次。prompt injection、凭证读取、凭证外发组合、破坏性操作、提权 / 绕过和代码执行模式为 high 并 fail-closed；命令、网络、环境变量模式保留为 medium 提醒。审查回执写入 transaction / receipt；用户指定候选也不跳过审查。带 `pi.skills` 的 `pi-package` 在离线 smoke 和已安装包 active 复核前也走审查器，high / 审查截断 fail-closed。另修正 Skill 调度器的一次重载、`session_start` 新上下文、延迟重试和忙碌 runner 不阻塞探针边界。 |
| 自动检查 | `npm run typecheck`、`npm run build`、`npm run test:unit` **4347/4347**、`npm run test:skill-files`、`npm run test:skill-source`、`npm run audit:refs`、`git diff --check`，以及相关脚本 `node --check` 均通过；构建只有既有第三方 Rollup annotation warning。 |
| 真实运行 | `npm run test:live -- skillacquire` 全绿（cost 1，`commandcode/deepseek/deepseek-v4.1-flash`）：候选 `skill-directory:futurediffusion/filesystem#98812f139d731776fc9d138c59139cb868b520a0`，commit `98812f139d731776fc9d138c59139cb868b520a0`，raw `SKILL.md` SHA-256 `fe67575862006d083eaaab95378588c4cda801821c359525da306feabc4367b9`；1 个文件 / 1030 bytes，0 high、3 个 medium `command-execution` 提醒。operation `75d4176fa0a7f4f171633031` 最终 `resumed`，历史含 `verifying → activated → resumed`；隔离 active 文件、精确授权、goal-resume 消费证据和无孤儿 pi 均核对通过，测试没有执行 Skill 正文。 |
| 视觉验收 | `YAN_MATRIX_ONLY=settingspkg YAN_MATRIX_STAMP=2026-09-22-skill-security npm run visual:matrix` 通过，10 组退出码均为 0；深 / 浅 `settingspkg` 均 `溢出=0px`，截图为 [`matrix-settingspkg-1440x900-100-dark-2026-09-22-skill-security.png`](../design/preview/matrix-settingspkg-1440x900-100-dark-2026-09-22-skill-security.png) 与 [`matrix-settingspkg-1440x900-100-light-2026-09-22-skill-security.png`](../design/preview/matrix-settingspkg-1440x900-100-light-2026-09-22-skill-security.png)，已目视检查；文案改动未造成布局回归。 |
| 应用与包 | 当前源码 build 通过；`npm run test:live -- pkgs` 在隔离 fixture 中完成真实包的安装 → 列表 / 详情 → 卸载闭环，并核对无 OS 沙箱与 Skill 高风险拒绝文案。本片未重新生成 `dist:dir`、便携包或 NSIS 安装包，因此不把普通构建或 `pkgs` 开发态探针写成包内安全审查证明。既有三种包形态运行证据仍有效，但其它资源类型的外部候选包级证据和最终发布重跑仍未完成。 |
| 剩余限制 | 这是启发式静态审查，不是 OS sandbox；通用 pi 包 / MCP 包仍以当前用户权限运行。Skill 文件本次只做固定来源、hash、审查和激活链，未执行 Skill 脚本；外部 SkillMD 内容仍可能变化，固定 commit / raw hash 是本次边界。`pi-package` / `mcp-package` 的其它外部候选包级整链及 09 最终发布门槛仍待完成。 |

### 本轮增量（2026-09-21）· 真实外部 Skill 目录只读发现

> 本片只验证“外部目录 → 精确候选元数据”的发现边界，不自动安装、激活或执行第三方 Skill。目录请求通过显式 `YAN_SKILL_DIRECTORY_URL` 开启，默认仍不联网；现场来源为 [SkillMD 机器 API](https://skillmd.com/docs) 的公开搜索接口。

| 六栏 | 证据 |
|---|---|
| 实现 | `src/main/capabilities/discovery/discover.ts` 新增对 SkillMD `items` 列表的适配：搜索条目缺少精确 commit 时，只按 raw URL 的同源路径构造详情地址，校验同源 HTTPS 后读取详情固定 `commit_sha`；再读取同源 `raw_url`，以限长 UTF-8 文本计算 SHA-256，映射为 `skill-files` 候选。单页条目并行读取但逐条失败闭合；目录未配置时不产生额外联网请求。新增 `scripts/probe/skill-directory.js` 与非默认 `skilldirnet` 场景。 |
| 自动检查 | `npm run typecheck`、`npm run build` 通过；`npm run test:unit` **4347/4347**；`npm run test:skill-source` 与 `npm run test:skill-files` 通过。 |
| 真实运行 | `npm run test:live -- skilldirnet` 全绿：真实 Electron → `yan capabilities discover --query-text "futurediffusion filesystem"` → SkillMD `items` → 同源详情 commit `98812f…` → raw `SKILL.md` SHA-256 `fe6757…` → `skill-directory:futurediffusion/filesystem#…` 候选；候选为 `installKind=skill-files`、`verification=metadata-only`，且探针确认 `discover` 不返回可执行接入结果。`npm run test:live -- discnet` 也回归通过，npm / MCP 各返回 40 条并保持 `metadata-only` 与未知 acquire 拒绝。两条 live 场景均无残留 Pi 进程。 |
| 视觉验收 | 不适用：本片只改主进程发现 / 测试探针，没有渲染端行为或布局改动。 |
| 应用与包 | `typecheck` / `build` 已验证普通构建链；本片未重跑 `dist:dir` / `test:packaged`，也没有把外部 Skill 写入真实用户目录或包内资源。 |
| 剩余限制 | 本片 `skilldirnet` 仍只证明“发现 + 来源 / commit / hash 固定”；同日的 `skillacquire` 另行证明了一个用户授权 Skill 文件候选的整链。独立来源默认关闭；SkillMD 搜索结果是外部可变数据，`skilldirnet` / `skillacquire` 不纳入默认 `check`。npm 包缺依赖时仍 fail-closed，纯自定义工具若 RPC 不报告 command / Skill 路径仍不能确认 active；Android UI / APK 仍按用户决定最后处理。 |

### 本轮（2026-09-20）档案与计划整理（非工程片，不填六栏）

> 用户要求「整理档案，还有计划」。这一轮没有产品行为改动，只有一处**探针脚本的真缺陷**要修。

1. **探针不再污染仓库根（真缺陷）**：[`scripts/probe/capability-cli.js`](../../scripts/probe/capability-cli.js) 与
   [`scripts/probe/mcp-register.js`](../../scripts/probe/mcp-register.js) 的请求文件写在会话 cwd（= 仓库根），
   实测已在仓库根留下 `cap-query.json` / `cap-scope.json` / `mcp-reg-call.json`。改成写**系统临时目录**
   （与 `mcp-cli.js` 同一处置；路径由 node 算，不依赖 `$TEMP` 展开）。
   同时删掉仓库根的 6 个遗留垃圾（3 个测试 json + 3 个 0 字节误产物 —— `25%、矛盾率三档）。` 等，
   mtime 都是 2026-09-19 12:51 的跑批笔误）。
   **验证**：`npm run test:live -- capcli mcpregister` 全绿，跑完仓库根未跟踪垃圾为 **0**。
2. **主题归档（§5 规则）**：`实施-03-项目知识与旧记忆清理` 与 `实施-07-Git与环境菜单收尾` 加 `-已完成` 后缀
   —— 两者都没有剩余可做项（03 是 S0–S6 全 ✅；07 是 S1–S4 + S2b 五片全 ✅，其余「已定不做」）。
   加后缀前先把 **07 §3 的 W2 行回填成当前事实**（它停在「四个重绑定本体仍未做」，而 S2b-2…S2b-5
   正是那四个；不回填就会拿过时状态当待办）。全仓库 15 个文件的引用同步更新（含 `AGENTS.md` 里三处
   简写引用改成完整文件名）；`npm run audit:refs` 断链 **0**。
3. **计划对齐**：`plan/README` 的 06 行补上真实剩余（N21-9 的 A/B 要**先抬高 A 组丢失率再重跑**，
   不是接着加样本 —— 此前该行读完像「已完结」）；03/07 行标注后缀。
   另：[`docs/archive/evidence/证据-04-S6-技术预检.md`](../archive/evidence/证据-04-S6-技术预检.md) 此前是**孤儿证据**
   （全仓库无任何文档引用），已在实施-04 §12 的 S6 行补上链接。
4. **查过但按规则不动的**：`docs/archive/README.md` 索引已覆盖全部 26 份归档件（不需补）；
   [`编排-并行代理分工-2026-09-19.md`](../plan/active/编排-并行代理分工-2026-09-19.md) 自己写明「不记录完成度」，
   且文件域信息（`agent.ts` / `capability-server.ts` / `yan.mjs` 三件套是共享热点）仍然有效 → 保留在活动区；
   `audit:refs` 的 `missingTracked: scripts/probe/autonomous.js` 是**归档文档（历史快照）**里的提及，
   按规则不改归档件，留作已知噪音。



### 本轮增量（2026-09-21）· 04-S7 能力设置、策略与 MCP 连接控制

| 六栏 | 证据 |
|---|---|
| 实现 | 新增能力设置页与安全 IPC：页面明确区分内置能力、已加载 Skill、MCP 服务和目录搜索；模式策略为「仅现有能力 / 搜索并推荐 / 自动接入」，页面打开不自动联网、不自动连接。设置快照只返回脱敏后的来源 / 状态 / 工具数量，不返回命令、参数、环境变量、凭证引用或完整 URL。MCP 核验仅由用户点击触发，取消绑定当前 runner + generation + operationId，并使迟到握手不能覆盖 `disconnected`；项目私有 MCP 继续按 runner 项目身份过滤，无身份时 fail-closed。 |
| 自动检查 | `npm run typecheck`、`npm run build` 通过；`npm run test:unit` **4149/4149**。新增连接管理器的取消 / 迟到握手 / 超时清理回归，以及能力 IPC / 类型 / 策略接线覆盖。脚本语法检查通过，`package.json` 的 `check` 已包含 `capsettings`。 |
| 真实运行 | `npm run test:live -- capsettings` 全绿：真实 Electron 主进程 / 渲染端设置页、MCP 安全快照、显式核验后工具数与 ready 状态、无敏感字段；`mcpcli` 全绿（stdio / HTTP、工具错误、schema 变化、超大结果）；`capcli` 全绿；均无孤儿 Pi 进程。`YAN_SHOW_WINDOW=1 npm run test:live -- capsettings` 也通过。 |
| 视觉验收 | **已通过**：`visual:matrix` 的真实 Electron 窗口生成并核对深 / 浅主题截图：`matrix-capabilities-1440x900-100-{dark,light}-2026-09-21-cap2.png` 证明策略 / 搜索 / 内置能力和布局；`matrix-capabilitiesmcp-1440x900-100-{dark,light}-2026-09-21-cap2.png` 证明当前 Skill / MCP 服务卡和检查入口；4 张均溢出 `0px`，已实际看图。 |
| 应用与包 | `npm run dist:dir` + `npm run test:packaged`、便携版 `--exe` 与全新 NSIS 安装后 EXE `--exe` 均已通过：解包 / 便携 / 安装态真实应用启动，内置 pi / 随包 CLI / IPC / asar 资源、能力快照脱敏、能力策略 / 搜索 / 内置能力 / MCP 区域和远程服务边界均绿。 |
| 剩余限制 | S7 的实现、自动检查、真实运行、视觉证据与三种包形态的运行级证据已补齐。此前 portable wrapper / NSIS 安装态未继承隔离变量的问题已通过新的临时沙盒探针解决；此前写入 `release/砚数据` 的现场按用户数据边界保留，未清理、覆盖或回滚。S6b-2 已取得一个用户授权 Skill 文件候选整链证据，但其它资源类型的外部候选与包级证据仍未覆盖；纯自定义包若 RPC 不报告 Skill 路径仍会 fail-closed。Android S1+ 仍等待范围确认。 |

### 本轮增量（2026-09-21）· S6b-2 本地 `mcp-package` 接入边界

| 六栏 | 证据 |
|---|---|
| 实现 | 新增 `mcp-package` 的精确 npm 包 staging 入口：只解析包内明确的 `bin`，拒绝绝对路径、`..`、glob、link 与非文件入口；使用受信任的应用 Node runtime 启动本地 stdio MCP。接入事务现在会在同一个项目范围内执行真实 `tools/list` smoke，原子写入 `mcp-servers.json` 与受管记录，支持重放 / 复核 / 工具表漂移检测；stdio 子进程环境改为 allowlist 加显式配置变量，不再把整个宿主环境传入候选进程。 |
| 自动检查 | `npm run test:unit` **4149/4149**；新增 `scripts/test-mcp-package.mjs`（官方 MCP SDK 客户端真实握手 / `tools/list`、入口解析、多入口拒绝与 `main`-only 拒绝）以及 `test-mcp-registration.mjs` 的 stdio 项目隔离、幂等、冲突和复核回归；新增受保护环境变量拒绝与超时清理回归；`typecheck` / `build` 仍通过。 |
| 真实运行 | 单测在临时目录中真实启动本地 Node MCP fixture 并通过官方 SDK `tools/list`，随后走项目范围登记与复核路径；没有运行未获授权的第三方候选，也没有调用真实业务工具。 |
| 视觉验收 | 不适用：本片没有渲染端改动。 |
| 应用与包 | 新代码已进入普通构建链；`skillacquire` 已取得一个 Skill 文件候选的开发态 Electron acquire → staging → runner 激活 → 原目标续接证据，但本片不覆盖 `pi-package` / `mcp-package` 外部包候选，也未取得外部候选在便携 / NSIS 安装态的 renderer 探针证据。 |
| 剩余限制 | `skill-files` 独立来源已接线并由 `skillacquire` 取得一个真实候选整链证据；其它外部候选的包内验收仍缺。历史批次曾用本地模型 `local/qwen3-local` 在 `127.0.0.1:8081` 完成真实响应与工具调用核验；本机服务随后按用户要求停止。Android S1+ 仍需范围确认。 |

### 本轮增量（2026-09-21）· acquisition staging 的精确文件集复核

| 六栏 | 证据 |
|---|---|
| 实现 | `AcquisitionService.verifyStaged()` 除逐文件重算 hash 外，现校验 manifest 版本 / operationId / 路径 / 字节数 / SHA-256 / 总量与数量上限；枚举 payload 实际文件并比对 manifest，拒绝额外文件、缺失文件、符号链接与特殊文件，避免冒烟 / 安装消费 manifest 未登记的内容。 |
| 自动检查 | `npm run typecheck`、`npm run build` 通过；`npm run test:unit` **4117/4117**。新增真文件回归：向已通过复核的 staging 注入 manifest 外 `.js` 文件时失败，移除后重新通过。 |
| 真实运行 | `node scripts/probe/pi-package-smoke.js` 重跑通过：真实启动随包 Pi 的离线 RPC，扩展资源 glob / 排除、`session_start` 与环境隔离均通过；单测另在系统临时目录做真实文件写入、枚举与 hash 复核。未运行 Electron / 外部包代码。 |
| 视觉验收 | 不适用：无渲染端改动。 |
| 应用与包 | 本轮 build 通过；未重跑解包 / 便携包验收。 |
| 剩余限制 | 这是 staging 完整性加固，不解决未随 tarball 提供依赖的可复现解析 / 授权问题；Skill 文件候选开发态整链已由同日 `skillacquire` 取得，本片仍不覆盖 `pi-package` / `mcp-package` 外部包候选或包内落位、启动、激活和续接验收。 |

### 本轮（2026-09-20）实施-04 S6b-2 · Electron 调度接线与 Pi 离线 smoke（仍待获授权候选验证）

> 本轮把 npm `pi-package` 从“调度内核 + 假端口”推进到真实 Electron 适配器，并以本地自写 fixture 验证 Pi 的隔离启动协议。授权服务、Pi 持久信任、项目包清单、固定版本安装、精确 runner 选择 / 重载、目标快照与续接收据均已接线；**没有**运行第三方候选，也没有授权联网下载或真实安装，因此不把这记作端到端闭环。

| 六栏 | 证据 |
|---|---|
| 实现 | 保留 npm exact-version + SRI 下载、受管 staging、幂等事务与 runner / goal / source HEAD / continueId 固定绑定。新增 [`pi-package-activation-host.ts`](../../src/main/capabilities/pi-package-activation-host.ts) 并在 [`index.ts`](../../src/main/index.ts) 接入真实 `AcquisitionService`、精确候选授权、项目持久信任、Pi 包清单、受管项目级 `pi install`、实际 runner 空闲 / 身份读取、定向 `restartOne` 与 GoalStore 续接槽；settled / proc / runner 状态变化触发去抖调度。新增 [`pi-package-smoke.ts`](../../src/main/capabilities/pi-package-smoke.ts)：只从 hash 已复核的 staging 读 `package.json`，按 Pi 规则展开包内相对资源 glob 与 `!` 排除并排序，仍拒绝越界路径 / 符号链接 / 未随包提供的依赖；使用无会话、离线、无工具、无上下文文件、无继承凭证的临时 Pi。本地临时目录不是 OS 沙箱，候选仍以当前用户权限执行。 |
| 自动检查 | `npm run typecheck` / `npm run build` 通过（构建只有 zod / virtua 既有 Rollup 注释告警）；`npm run test:unit` **4115/4115**。新增 Pi 资源 glob / `!` 排除 / globstar / 越界拒绝覆盖，既有调度器覆盖忙碌、授权撤销、goal / source 漂移、smoke 失败、重载崩溃恢复与单飞。 |
| 真实运行 | `node scripts/probe/pi-package-smoke.js` 使用临时受管 staging 与本轮自写、无副作用的内部扩展 fixture，真实启动随包 Pi 的离线 RPC；fixture 用包资源 glob 加 `!` 排除一个导入即报错的文件，烟测通过证明排除生效；同时确认 `session_start` 哨兵与父进程 sentinel 凭证变量隔离，退出码 0。**没有**真实联网下载、外部候选授权、外部候选代码运行、`pi install`、项目 runner 激活 / 重载或 goal 续接。 |
| 视觉验收 | 不适用：无渲染端改动。 |
| 应用与包 | 本轮 `npm run build` 通过；尚未做 asar / 解包 / 便携版运行级断言，因此未证明此适配器随包可用。 |
| 剩余限制 | S6b-2 仍未端到端闭环：没有获授权真实 candidate 的 Electron acquire → staging → smoke → 项目安装 → 精确 runner 激活 → 原目标续接实测；没有包内断言。未随 tarball 提供的依赖仍 fail-closed（依赖安装脚本 / 运行时依赖审查需另行完成）；激活后只能用 Pi RPC 的命令 / Skill 路径证明包路径，纯自定义工具且不暴露 command / Skill 路径的包会保持失败。MCP 本地包与独立 Skill 文件来源仍未接线。 |

### 本轮增量（2026-09-20）· runner reload 后的续接唤醒

| 六栏 | 证据 |
|---|---|
| 实现 | [`resources/pi-extensions/goal-resume.js`](../../resources/pi-extensions/goal-resume.js) 新增 `session_start` 监听：runner 重载或会话恢复时，复用既有延迟空闲检查、用户活动取消与先写消费凭据再发 custom 消息的路径。原来只有 `message_end` 能排入检查；包激活主动重启空闲 runner 后没有这个事件，因此持久续接请求可能一直留在磁盘。调度器核对不再把 runner id / generation 当跨进程稳定身份；恢复按 `cwd + sessionFile + projectId`，冷启动若 Pi 已加载包但新 runner 尚未消费续接，会写入快照并定向重载一次以触发钩子。 |
| 自动检查 | `scripts/test-handoff-request.mjs` 以临时 `YAN_DATA_DIR` 和假 Pi API 验证 `session_start(reason=reload)` 会发送 `yan-goal-continue`、`triggerTurn=true`，并在发送前落 `continueId` 消费文件；`scripts/test-pi-package-scheduler.mjs` 新增新 runner id / generation 重置后的冷启动恢复分支，`scripts/test-runners.mjs` 覆盖精确 session / cwd / project 匹配与 project 漂移拒绝；`npm run typecheck` / `npm run build` / `npm run test:unit` **4098/4098**。 |
| 真实运行 | 未运行 Electron / 真 Pi runner 重载；当前只证明扩展钩子合同及消费顺序，不证明真实进程生命周期已接通。 |
| 视觉验收 | 不适用：无渲染端改动。 |
| 应用与包 | 未验证包内扩展加载与 restart 行为。 |
| 剩余限制 | 此小节最初登记时 runtime scheduler 尚未接通；当前状态见上方 S6b-2 总表。仍未下载或执行任何外部候选包。 |

### 本轮（2026-09-20）实施-04 S6b-1 · 远程 MCP 自动登记闭环

> 起因：S6a 只把事务推到 `pending-boundary`（「能建事务但什么都不装」）。
> 本片把 §10 里**不经过下载器**的那条路做完：`remote` 候选从「目录线索」变成
> 「宿主真的连得上、并且写进了受管配置的服务」，并且登记完**当场可用**。
> 下载器 / `pi install`（`pi-package` / `mcp-package` / `skill-files`）是 **S6b-2** ——
> 本片不联网下载、不装包、不碰用户已有安装。

| 六栏 | 证据 |
|---|---|
| 实现 | 新增 [`src/shared/mcp-registration.ts`](../../src/shared/mcp-registration.ts)（纯逻辑：从候选里取**显式端点** / 服务 ID（可读 + 短哈希防撞） / 配置草案与 URL 安全（仅 https 或 loopback http、拒 userinfo、拒非 http(s)） / 授权匹配与去重 / 受管记录形状）与 [`src/main/capabilities/registration-service.ts`](../../src/main/capabilities/registration-service.ts)（真文件：**真连核验 → 原子写 `YAN_DIR/mcp-servers.json` → 写受管记录**；核验失败一个字节不写、写记录失败只撤回本次、同名不同端点拒绝覆盖、`{servers:[…]}` 形态与手写条目原样保留、`authorizations.json` 为 host 级持久策略、`reverify` 复核端点与工具表）。[`src/main/capabilities/acquisition-service.ts`](../../src/main/capabilities/acquisition-service.ts) 新增 `markAcquiring` / `markVerifying` / `markResumed`，`activate` 与 `resumeCheck` 支持注入 `verify`（远程走「再连一次」而不是 staging hash）；[`src/main/agent.ts`](../../src/main/agent.ts) 的 `capabilities.acquire` 分三档（`needs-auth`/`unsupported` 直接停、`remote` 真登记、其余仍 `pending-boundary`），新增 `--authorize`；[`src/shared/discovery.ts`](../../src/shared/discovery.ts) 给候选加**显式 `remoteUrl`**（不再从 `sourceUrls` 猜端点，否则自建 / 本地目录会把目录自己当成服务），[`discover.ts`](../../src/main/capabilities/discovery/discover.ts) 的两个目录 URL 支持 `YAN_MCP_REGISTRY_URL` / `YAN_NPM_SEARCH_URL` 覆盖（测试隔离），[`resources/yan-cli/yan.mjs`](../../resources/yan-cli/yan.mjs) 文案改成当前事实。 |
| 自动检查 | 单测 **3948/3948**（本片 **+58**：[`scripts/test-mcp-registration.mjs`](../../scripts/test-mcp-registration.mjs) —— 端点选取 5 / 服务 ID 4 / 草案边界 12 / 授权匹配 9 / 真文件 18（含“核验失败不写配置” / “手写条目与 `{servers:[…]}` 形态不被改写” / “同名不同端点拒覆盖后原配置未变” / “工具变少或端点被换时复核不放行”）/ 真协议 3（真起 Streamable HTTP MCP fixture，走官方 SDK 握手 + `tools/list`））；`npm run typecheck`（含 CSS 约定 / layer 自检）与 `npm run build` 干净；`npm run audit:refs` 无断链。 |
| 真实运行 | 新场景 **`mcpregister`**（cost 0，**已进 `check`**）全绿 —— 从「确认未配置」开始：真目录 fixture（`YAN_MCP_REGISTRY_URL` 指向本地）→ `discover` 拿到候选 → `prepare` 停在 `needs-authorization` → 未授权 `acquire` **不登记** → `--authorize` 后**真核验**（官方 SDK 的 Streamable HTTP MCP fixture）并 `resumed`（工具 `echo`/`boom`）→ `capabilities search` **当场可见**（`mcp:<server>/echo`，`availability=ready`、`effect=unknown`）→ `yan mcp call` 返回值真的来自 fixture（`http:hello-register`）→ 同一计划重放 `replayed:true`；链路自始至终**不调模型**。回归 `capcli` / `mcpcli` 全绿（2/2），孤儿进程检查 ✓。**反向验证**：把授权门槛去掉（未授权也直接登记）→ 场景恰好 4 条断言变红并整体失败，还原后全绿。 |
| 视觉验收 | 不适用 + 原因：本片没有渲染端 / 样式改动，不产生用户可见状态（授权与登记都是宿主侧，界面入口留到 S7）。 |
| 应用与包 | 未涉及：新模块随主进程构建进包，但**能证明它进包的断言**留到 S7（「视觉与包」那一栏），本片不加包内断言。 |
| 剩余限制 | ① **S6b-2 未做**：下载器 / `pi install` / 本地 MCP 包 / Skill 文件仍是 `pending-boundary`；② 授权只有 CLI `--authorize`，§9 的三档策略设置**尚未接界面**；③ 远程端点核验在公司路径会连**两次**（登记一次、复核一次）—— 正确性优先，真实远程服务会多一次握手；④ 受管记录已落盘，但**卸载入口**还没接（只删自己登记的，接口已就绪）。 |



### 本轮（2026-09-20）实施-04 S6a · 接入事务内核与受管 staging（+ `capabilities.acquire` 接通）

> 起因：S5 只到「生成计划、不执行」，`capabilities.acquire` 是 `not_implemented`。
> 本片把**执行的前半段**做完：策略判定、受管 staging、归档校验、receipt 与恢复复核。
> **下载器 / 安装器（`pi install`、远程 MCP 登记）是 S6b** —— 本片不联网、不装包、不碰用户已有安装。

| 六栏 | 证据 |
|---|---|
| 实现 | 新增 [`src/shared/acquisition.ts`](../../src/shared/acquisition.ts)（纯逻辑：状态机与合法迁移 / 确定性 `operationId` / 归档上限与路径校验 / 失败分类 / receipt 匹配 / 重试策略 ≤2 次）与 [`src/main/capabilities/acquisition-service.ts`](../../src/main/capabilities/acquisition-service.ts)（真文件：受管 `YAN_DIR/capabilities/staging/<operationId>/payload` + `manifest.json` 原子写、`verifyStaged` 重算 sha256、`activate` 前必过复核、`resumeCheck` 以 receipt+hash 为准、`rollback` 只删本次、事务日志 `capabilities/acquisition.json` 原子写）。[`src/main/agent.ts`](../../src/main/agent.ts) 接通 `capabilities.acquire`（计划缓存 10 分钟 TTL，模型只能回传 `planId`）+ [`resources/yan-cli/yan.mjs`](../../resources/yan-cli/yan.mjs) 文案改成当前事实。 |
| 自动检查 | 单测 **3890/3890**（本片 **+47**：[`scripts/test-acquisition.mjs`](../../scripts/test-acquisition.mjs) 66 条断言 —— 状态机 9 / 事务与重试 12 / receipt 3 / 归档校验 12 / 失败分类 6 / 真文件 24）；`npm run typecheck`（含 CSS 约定 / layer 自检）与 `npm run build` 干净。**反向验证**：把 symlink 检查关掉 → 恰好「校验：符号链接被拒」一条红（3887/3888），还原后全绿。 |
| 真实运行 | `npm run test:live -- capcli` 全绿（含 4 条新断言：缺 `--plan` / 未知计划都非零退出且给可读原因、不再是 `not_implemented`）；回归 `discnet` + `mcpcli` 全绿（`discnet` 仍真实联网检索）。真文件证据在单测的临时受管目录里：落盘内容与 sha256、篡改后复核报不一致、被拒后 staging 目录不存在。顺便修掉两条**过时断言**（`discovery-cli.js` / `capability-cli.js` 里「acquire 必须回 not_implemented」——S6a 之后它变成假要求）。 |
| 视觉验收 | 不适用 + 原因：本片没有渲染端 / 样式改动，不产生用户可见状态。 |
| 应用与包 | 未涉及：新模块随主进程构建进包，但**能证明它进包的断言**要等 S6b 把链路接到包内可验的形态（本片不加包内断言，避免「文件在包里」冒充「功能可用」）。 |
| 剩余限制 | ① **S6b**：下载器 / `pi install` / 远程 MCP 登记 / 隔离冒烟 / 运行中激活 / 原目标续接都未实现 —— 本片只把事务推到 `pending-boundary`；② 计划缓存只有 10 分钟 TTL（与候选一致），跨轮要重新 `prepare`；③ §9 的三档自动接入策略设置尚未接界面。 |

### 本轮（2026-09-19）实施-07 / 09 · 包内「审查面板」运行证据 + 两处过时状态回填

> 起因：实施-09 §4 S4 的逐项核对表里 07 还剩半句话 —— Git **写操作**的运行证据已在二轮补上，
> 「审查面板」（只读链路）当时只有字符串断言；而实施-07 §3 与 plan/README 09 行还停在「未做」。
> 本片把缺口补到运行级，并把三处过时描述改回当前事实。

| 六栏 | 证据 |
|---|---|
| 实现 | [`scripts/probe/packaged.js`](../../scripts/probe/packaged.js) 的 Git 段改成**先读后写**：`git.snapshot`（未暂存范围）→ `git.patch`（`tracked.txt`）→ `git.content(side:'new')`，断言的是**内容**（新增行 `two` / 增 1 删 0 / 新侧正文 `one\ntwo\n`），之后才执行原有的 `stage`；[`scripts/test-packaged.mjs`](../../scripts/test-packaged.mjs) 在 2a 由 Node 侧算一次夹具基准（`git diff --numstat` = `1<TAB>0<TAB>tracked.txt`，不符直接失败），4a 注释写明「只读这半在探针断言、基准在 Node 侧」的分工。文档回填三处（见上）。 |
| 自动检查 | `npm run dist:dir`（重新构建 + 解包）→ `npm run test:packaged` **全绿**；`npm run test:packaged -- --exe=release/砚-0.2.0-portable.exe` **全绿**；`npm run typecheck`（含 CSS 约定 / layer 自检 10 用例）与 `npm run audit:refs` 干净。**两次反向验证**：把新增行判据改成 `three` → 只有「审查补丁拿到真实 hunk」变红且整体失败；把新侧内容判据改成 `one\nthree\n` → 只有「显示完整文件」那条变红。夹具自检本身也红过一次（首次把 `numstat` 期望写反 → `numstat = "1\t0\ttracked.txt"` 当场失败），随后修正。 |
| 真实运行 | 包内（解包形态）探针输出：`git.state = {repo:true,branch:"master"}`、`git.snapshot = {ok:true,files:["tracked.txt"],...}`、`git.patch = {ok:true,additions:1,deletions:0,added:["two"]}`、`git.content = {ok:true,side:"new",bytes:8}`、`git.action(stage) = {ok:true,failure:null}`；Node 侧核对 `git status --porcelain` = `M  tracked.txt`（改动真的进了 index）。便携版同一组断言同样全绿。**2026-09-20 复核重跑**：`dist:dir` 产物时间戳 = 本次（`app.asar` / `砚.exe` 16:30），解包与便携版各再跑一次全绿，反向验证（新增行判据改 `three`）再红一次并已还原。 |
| 视觉验收 | 不适用 + 原因：本片只改包内验收脚本与文档，没有渲染端 / 样式改动，不产生新的用户可见状态。 |
| 应用与包 | **本片就是这一栏**：07 的「审查面板」从「只有字符串断言」变为**运行级**（解包 + 便携版各跑一次）；配合二轮已补的 Git 写操作运行证据，实施-09 §3 核对表里 01–08 的「应用与包」栏**无剩余缺口**。 |
| 剩余限制 | ① 便携版用的是本轮之前 `npm run dist` 产出的 `砚-0.2.0-portable.exe`（未重新 `dist:portable-fast`）—— 本次没有改应用代码，验证的是同一份 `app.asar` 的旧产物形态，结论不受影响；② 包内审查只覆盖**文本文件 + 未暂存范围**（图片前后对照 / 二进制 / `range` 范围仍由开发态 `gitreview` 覆盖）；③ 解包断言用的是本轮 `dist:dir` 的新产物。 |

### 已完成（2026-09-19，v7 定稿后重跑）实施-09 S5 · 最终发布门槛

> 本轮从「不知道门槛能不能过」变成「过了一遍，并且把阻碍门槛全绿的三类问题全查清」。
> 重跑命令：`YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash npm run check`（日志 `/tmp/check-final.log`）。

| 六栏 | 证据 |
|---|---|
| 实现 | 本片是**流程验收 + 测试基础设施修正**，共改了 3 处测试代码：① `test-live.mjs` 新增场景级 `visible: true`（单个场景要求可见窗口）并给 `perf` / `virtual` / `outlinepos` 启用；② 探针 `fs-edge.js` 的大目录分页**期望算法修正**；③ 探针 `capability-cli.js` 把一条**已过时的断言**（“S2 时 discover 必须回 not_implemented”）换成当前事实（`prepare` 缺 `--candidate` 必须明确报错） |
| 自动检查 | **`npm run check`：2/96 场景失败**（首次是 28/96 → 带日志 13/96 → 全量修正后 2/96）。typecheck / build / 单测 **3823/3823** / vendor:pi:check / measure:design 全过。剩余两条：`contextstate`（退出后检查：状态文件 16 / 期望 15）、`askbackground`（左栏找不到 B 行）—— **两条单独跑均绿**，判为**批量运行时相互干扰**（未定位根因，已登记） |
| 真实运行 | ① `npm run dist` **三产物全出**（04:44）：`砚-0.2.0-setup.exe` 125,649,380 B / `砚-0.2.0-portable.exe` 125,416,233 B / `砚-0.2.0-portable-fast.zip` 168,347,683 B；② 重写 `release/SHA256SUMS.txt`（旧一份存为 `SHA256SUMS-pre-s2b-2026-09-19.txt`），新哈希：`A844445F…0031` / `82774785…8E9D` / `42932A39…BE30`；③ `npm run test:upgrade` ✓（打包实例读回 cwd/lang/theme/projects/凭证/localStorage，且 **`release/砚数据` 60 个文件逐字节未变**）；④ `npm run test:packaged` **解包形态 ✓** + **便携版 ✓**（`--exe=砚-0.2.0-portable.exe`；断言全绿，退出后清理临时目录偶尔 `EPERM` —— 本机句柄占用已知问题） |
| 视觉验收 | 本片不产生新界面；几何类断言（`outlinepos` / `virtual` / `fsedge`）改为**可见窗口**后转绿，等于是把“看得见才算数”写进了场景配置 |
| 应用与包 | **包内审计**：asar 条目 **239**（与上次修完一致），本机绝对路径 `C:\Users\YuDaTou` **0 次**、测试沙箱名 `yan-test-` **0 次**、开发日志 `dev.log` **0 次**；`sk-` 命中 77 次**全是 `task-` 类误命中**（`sk-` 后跟 ≥20 位字符的真 key：**0 条**），`DEEPSEEK_API_KEY` 只是环境变量名 |
| 剩余限制 | ① `check` 未全绿（2/96，两条均为批量偶发，单独跑绿）；② `perf` / `virtual` / `outlinepos` 现在**必须上屏**（`visible: true`）—— 门槛跑的时候会弹窗，这是为了量到真实耗时；③ cost 1 场景必须显式给 `YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash`（默认免费档 `commandcode/longcat-2.0:free` **不调工具**，会让 5 个依赖工具的场景必红 —— 已用本地模型交叉验证）；④ 安装版本轮未重跑（S5 已单独验过安装/卸载流程）；⑤ **对外发版仍等 04-S6/S7**（属 04 范围）|

**三条环境事实（比数字更值钱，写在这里免得下次再踩）**：
1. **隐藏窗口会把定时器节流到 1 秒** —— 性能/几何断言在 `YAN_PROBE_HIDDEN=1` 下必红（实测 1000.1ms / 1000.2ms / 1000.4ms 这种整数秒）。修法是给这类场景开 `visible: true`，不是放宽阈值。
2. **默认免费模型不调工具** —— `check` 里所有需要“模型真的调用了工具”的场景（`contextsweep` / `contextproduce` / `contextepisode` / `contextfoldpref` / `subagent`）会整片变红；换 `deepseek/deepseek-v4.1-flash` 或本机本地模型即绿。
3. **有过时断言会阻止门槛** —— `capcli` 那条“discover 必须回 not_implemented”是 S2 时期写的，S5 把 discover 真的做出来之后它就成了**假要求**（继续留着只会把功能完成当成失败）。

### 历史（2026-09-19 首次跑通）实施-09 S5 · 安装包安装与卸载流程验证

### 本轮（2026-09-19）实施-06 S2 · N21-9 基准定稿（任务集重做 + 3 轮校准 + 48 次四组对照）

### 本轮（2026-09-19）实施-06 S2 · N21-9 基准定稿（任务集重做 + 3 轮校准 + 48 次四组对照）

> 主产出：[证据-06-S2-N21-9基准](../archive/evidence/证据-06-S2-N21-9基准-2026-09-19.md) §6；口径真源：`src/shared/context-bench.ts` / `scripts/bench/context-tasks.mjs` / `scripts/bench/context-bench.mjs`。

| 六栏 | 证据 |
|---|---|
| 实现 | 任务集**重做两次**（约束换成**被动型**：`[P0]` 标记 / `owner:` 字段 / 「共 N 条」小计 / 具体数值 500ms・30s；噪音 6→8→**12 条**）；编排重写（`buildPrompt`：约定**只在一句 `echo` 的工具输出里出现一次**，末尾交付**不点名**它们）；`CONSTRAINT_SLOT`（夹在噪音中间）删除 |
| 自动检查 | 单测 **3823/3823**（任务集改了 → 18 条约束的 `kept`/`violated` 样例全过判分规则自检）；`typecheck`✓；`npm run bench:context -- --mock` 装置校验通过 |
| 真实运行 | **3 轮 A 组校准**（12 次：10.0% → 8.3% → 8.3%）+ **v7 定稿 48 次**（四组 × 3 任务 × 4 次，全部 `exit=0`、成功率 100%）：A **11.1%** / B **6.9%** / C **9.7%** / D **8.3%**；主判据 A→C、C→D 均 `not-supported` **48 次里所有丢失的 `hit` 都是 `null`（无一条假阳性）** |
| 视觉验收 | 不适用（无界面改动；本片产出是数据与口径） |
| 应用与包 | 不适用（跑批工具不进包） |
| 剩余限制 | ① 基线丢失率只抬到 **11%**——“抬到 20–40%”这个目标被证伪（丢失由**任务**而非策略决定）；② 本次能可靠分辨的是 **≥6pp** 量级的差异，判定更小效应需每组 ≥100 次，而方向本身不稳（B 最低）→ 再加样本不会把结论从“不成立”变成“成立”；③ 结论只适用于**该策略在当前实现下**，不得反推“未来载体必须是 pi extension”或用于削减白名单 |

**这次拓到的三条可复用结论**（比数字本身更值钱）：

1. **丢失由任务决定，不由策略决定**：26 条次丢失全部集中在 `naming-format`，另两个任务 144 条次**零丢失** —— 比之前“四组差异是噪声”更硬的结论。
2. **「不提醒就不会写」的约束才会丢**：「魔数/安全开关/缩进」这类模型本来就会写的，36 次里一条没丢；
   能丢的始终是 `batch-3`（一次最多 3 条）、`count-line`（共 N 条）、`iso-date`（YYYY-MM-DD）。
3. **判分口径干净了**：v7 没有一条假阳性（全部 `hit: null`）——§3 那两条教训已经落进任务集。

### 本轮（2026-09-19）实施-07 S2b-5 · 附件不迁移（只数、只如实说）

> 主题文档：[实施-07](../archive/plan/实施-07-Git与环境菜单收尾-已完成.md) §4；判据：[决策记录-07-S2b](../archive/plan/决策记录-07-S2b-工作树会话形态-2026-09-19.md) §3（附件 P1：第一版不迁移、如实说明）。

| 六栏 | 证据 |
|---|---|
| 实现 | [`fork-rebind-service.ts`](../../src/main/fork-rebind-service.ts) 的 `forkContext` 多读一次源会话，数**用户消息里的图片附件**（`images` 累加；数不到时返回 `null`，与“真的一个都没有”分开），交给 [`fork-context.ts`](../../src/shared/fork-context.ts) 写一段：「N 个图片附件没有带过来（附件不迁移），需要哪张就在新会话里重新添加 —— 不要去猜它们的内容」。**不做任何搬运动作**；`null` 或 `0` 时一个字也不写（不编造）。测试用 `explicitAttachmentCount` 注入（与 `explicitRefs` 同性质） |
| 自动检查 | **单测 3823/3823（+6）**：无附件/0 附件都不写这一段、有附件时写出个数且只说“没有带过来”、**正文里不得出现任何「附件已带过来」的说法**（正则挡）、必须给出口（重新添加）而不是让模型猜图片内容；`typecheck`✓、`build`✓ |
| 真实运行 | `npm run test:live -- gitwrite`（cost 0）全绿，新增 5 条断言：沙箱源会话无图片 → 计数 0、正文里不出现“附件”字样；显式给 2 → `attachments=2` 且正文写“2 个图片附件”、且 /没有带过来/ |
| 视觉验收 | `matrix-forkdraft-1440x900-100-{dark,light}-2026-09-19s2b5.png` **已看图**：草稿尾部能看到附件那一段（包含“附件不迁移”与“不要去猜它们的内容”），深浅两主题都正常；矩阵状态脚本同时加了“滚到草稿尾部”（输入框高度有限，而这张图要证的就是靠后的那几行） |
| 应用与包 | 无新增文件/资源（只改主进程模块与共享纯逻辑）；**包内断言待下一步一起补** |
| 剩余限制 | 只统计**图片**附件（`kind: 'file'` 的文件引用表现为路径，已由 S2b-3 的对照盖住）；不做“一键把源会话的图重新加进来”（那是附件搬运，属于明确不做的那一类） |

### 本轮（2026-09-19）实施-07 S2b-4 · Fork 的语义注入（接手上下文草稿 + 环境状态在新工作树重算）

> 主题文档：[实施-07](../archive/plan/实施-07-Git与环境菜单收尾-已完成.md) §4；判据与反模式：[决策记录-07-S2b](../archive/plan/决策记录-07-S2b-工作树会话形态-2026-09-19.md) §3。

| 六栏 | 证据 |
|---|---|
| 实现 | 新增 [`src/shared/fork-context.ts`](../../src/shared/fork-context.ts)：正文构造（标记行 + 「源会话历史没带过来」+ **在目标工作树重读的环境状态** + S2b-3 的文件对照 + 交接包里的可迁移知识）；[`src/main/fork-rebind-service.ts`](../../src/main/fork-rebind-service.ts) 加 `forkContext()`（环境状态一律 `readRepoState(worktree)` 重读，**接口里没有“源会话状态”这个入参**）+ IPC `yan:fork:context`（交接包从 `HandoffStore` 注入）。渲染端在「派生新会话」成功后把它当**输入框草稿**注入（`injectComposerText`），**不自动发送** |
| 自动检查 | **单测 3817/3817（+34）**：标记行/证据检测边界、环境状态只来自传入 `env`（含 detached、无 upstream 时不写 `+0/-0`）、**没有交接包时不许编造**、空列表不产生空标题、引用对照三类问题分说；`typecheck`✓、`build`✓ |
| 真实运行 | `npm run test:live -- gitwrite`（cost 0）全绿，新增 7 条断言：草稿有标记行、写的是这个工作树、如实说历史没带过来、**草稿没被自动发送**（消息列表里没有它）、主进程能独立算出正文、**分支取自目标工作树**（`live-carry` vs `live-carry`）、没有交接包时 `hasPackage=false` |
| 视觉验收 | 新增矩阵状态 `forkdraft`：深浅两张 `matrix-forkdraft-1440x900-100-{dark,light}-2026-09-19s2b4.png` **已看图**（草稿与输入框、光带共存正常）；文案更新后的 `matrix-envworktrees-*-2026-09-19s2b4.png` 也**已看图** |
| 应用与包 | 注入路径只用了已有的 `editor-text` push 通道与主进程模块，无新增资源；**包内断言待下一步一起补** |
| 剩余限制 | ① 「按需回读源历史」目前是**正文里的一句话约定**（告诟模型去 `yan` / 读文件），**没有**做成一键召回的界面入口；② 交接包只有源会话**生成过**才有（沙箱里平时没有），没生成时正文就只说“没有” |

### 本轮（2026-09-19）实施-07 S2b-3 · 文件引用的仓库相对路径重绑定

> 主题文档：[实施-07](../archive/plan/实施-07-Git与环境菜单收尾-已完成.md) §4；判据：[决策记录-07-S2b](../archive/plan/决策记录-07-S2b-工作树会话形态-2026-09-19.md) §3（反模式）。

| 六栏 | 证据 |
|---|---|
| 实现 | 新增 [`src/shared/fork-rebind.ts`](../../src/shared/fork-rebind.ts)（**纯函数**：绝对→相对、三态/四态解析、Windows 大小写与分隔符归一、`@` 引用提取）+ [`src/main/fork-rebind-service.ts`](../../src/main/fork-rebind-service.ts)（读**当前会话**里 `@` 过的仓库内文件 → 拿到目标工作树根下重新解析）+ IPC `yan:fork:fileRefs`；界面在每个工作树行显示「源会话 N 个文件引用 · M 个能对上 · K 个对不上」（**无引用则不显示**，与 S4 来源搜索同一口径），明细在 `title` 里分四类说人话 |
| 自动检查 | **单测 3783/3783（+37）**：三态/四态边界、`..` 与仓库外、同前缀兄弟目录、大小写不敏感返回原拼写、`@` 提取（`foo@bar.com` / `@scope/pkg` / URL / 全角括号 / 尾标点 / 去重）；`typecheck`（含 CSS 约定 + layer 自检）✓、`build` ✓、`audit:refs` 干净 |
| 真实运行 | `npm run test:live -- gitwrite`（cost 0）全绿，新增 6 条断言：仓库根算对、四条不静默丢、`missing`、`..` → `outside`、**源仓库的绝对路径仍是 `outside`（没做前缀替换）**、相对引用不是 `outside`；另走一次**真实提取**路径（不虚构引用） |
| 视觉验收 | 矩阵 `envworktrees` 深浅两张 `matrix-envworktrees-1440x900-100-{dark,light}-2026-09-19s2b3.png` **已看图**（「源会话 3 个文件引用 · 2 个能对上 · 1 个对不上」就位、无溢出）；矩阵里为该 IPC 加了桩 |
| 应用与包 | 纯逻辑进渲染 bundle、服务进主进程，均在 asar 白名单内；**本片未单列包内断言**（与 S2b-4/5 一起在下一次包验收里补） |
| 剩余限制 | ① 输入源是「**用户**消息里的 `@` 引用」与显式列表 —— **交接包的 `files` 尚未接进来**（S2b-4 做 `FORK_CONTEXT` 时一起）；② 只统计、不代替用户做决定（对不上不一定意味着要重做，可能那个文件本来就不该跟过去） |

### 本轮（2026-09-19）实施-07 S2b-2 · 项目信任在工作树目录上重新建立（顺带修掉设置写入的并发缺陷）

> 主题文档：[实施-07](../archive/plan/实施-07-Git与环境菜单收尾-已完成.md) §4；判据与切片：[决策记录-07-S2b](../archive/plan/决策记录-07-S2b-工作树会话形态-2026-09-19.md)（§4 切片 / §5 顺带修掉的真缺陷）。

| 六栏 | 证据 |
|---|---|
| 实现 | 新增 [`src/main/project-trust.ts`](../../src/main/project-trust.ts)：读 pi 的 `trust.json`（判定复用 `projectTrustedFrom`，向上查找规则与 pi 一致）与**用户显式信任一个目录**（原地改已有条目为 `true`，tmp + rename 原子写）；IPC `yan:trust:status` / `yan:trust:allow`；工作树行上显示「信任这个目录」→ 成功后变「已受信任」；**不自动继承**（源目录信任 ≠ 工作树信任）。**另修一个真并发缺陷**：`patchSettings` 加写入串行队列（下面单说） |
| 自动检查 | `typecheck`（含 CSS 约定 + layer 自检）✓、`build` ✓、单测 **3746/3746**（i18n 单测当场拓到文案里的 `**` 加粗记号，已改）；`audit:refs` 干净 |
| 真实运行 | `npm run test:live -- gitwrite`（cost 0）**连续两次全绿**，新增 7 条断言：① 主仓库初始未受信任；② 显式信任主仓库成功；③ 主仓库现在受信任；④ **工作树目录没有跟着被信任（不自动继承）**；⑤ 工作树行上有入口；⑥ 点一下变「已受信任」；⑦ 主进程侧也确认。**Node 侧再读盘**核对 `trust.json` 里至少两条且值都为 `true` |
| 视觉验收 | 矩阵 `envworktrees` 深浅两张 `matrix-envworktrees-1440x900-100-{dark,light}-2026-09-19s2b2.png` **已看图**（「信任这个目录」与「派生新会话」同排、Fork 两行说明在下方、溢出 0） |
| 应用与包 | 新增的是主进程模块与 IPC，随 asar 进包；**本片未单列包内断言**（与 S2b-3/4/5 一起在下一次包验收里补） |
| 剩余限制 | ① **未用真实 pi 调用**观察到「它真的因此读了项目设置」—— 现在的证据是「判定复用 pi 的规则函数 + `trust.json` 真的写入 + 界面按它显示」；② 未做「信任整个 Git 仓库含所有 linked worktree」这条便利策略（属于放宽安全边界，默认不做，待真实使用后再说） |

**顺带修掉的真缺陷（值得单独记）**：`patchSettings()` 的「读盘 → 合并 → 写盘」不是原子的，两个并发调用会互相**整份覆盖**，
中间那次读盘还会把旧内容写进 `cached` 让后续读取一直拿旧值。真实症状：工作树创建后要 `patchSettings({projects:[…已有, 新工作树]})`，
而信任查询同时在 `getSettings()` —— **新建的工作树从项目列表里消失**（git 侧工作树其实建好了）。
定位过程：先怀疑自己的新增断言（跳过 12b 后仍失败 → 排除）→ 再临时停掉新加的信任查询（**通过了** → 锁定触发条件）→ 推出竞态。
修法：`settings.ts` 加 `writeQueue` 串行写入 + 两个信任句柄**不再读 settings**（调用方传目录）。修前 3/3 稳定复现，修后连续两次全绿。

### 本轮（2026-09-19）实施-07 S2b-1 · 工作树派生会话的 Fork 语义与文案

> 主题文档：[实施-07](../archive/plan/实施-07-Git与环境菜单收尾-已完成.md) §4（切片）；判据：[决策记录-07-S2b](../archive/plan/决策记录-07-S2b-工作树会话形态-2026-09-19.md)。

| 六栏 | 证据 |
|---|---|
| 实现 | i18n（zh/en）新增 `env.worktreeForkTitle` / `-Carry` / `-Skip`，改写 `env.worktreeOpenNote` 与 `env.worktreeOrigin`；[`EnvironmentMenu.tsx`](../../src/renderer/src/components/review/EnvironmentMenu.tsx) 把原来一句免责声明改成**两行清单**（`env-worktree-fork-carry` / `-skip`），注释里写入形态判据与「每片完成后同步文案」的纪律；[`review.css`](../../src/renderer/src/styles/review.css) 新增 `.env-fork-note/-title/-carry/-skip`（「会带」比「不带」亮一档 —— 它是这条路径唯一的正向价值） |
| 自动检查 | `typecheck`（含 CSS 约定 + layer 自检）✓、`build` ✓、单测 **3746/3746** |
| 真实运行 | `npm run test:live -- gitwrite`（cost 0）**109 条断言全绿**，其中新增 4 条：分两行列出、「会带」写的是来源关系、「不带」逐项覆盖历史 / 权限 / 附件、文案真的可见 |
| 视觉验收 | 矩阵 `envworktrees` 深浅两张 `matrix-envworktrees-1440x900-100-{dark,light}-2026-09-19s2b1.png` **已看图**（溢出 0；文案完整、两行颜色有区分、「派生新会话」按钮就位） |
| 应用与包 | 文案随 renderer bundle 进包（asar `files` 白名单已覆盖 `out/renderer`）；**本片未单列包内断言** —— 它是界面文案，与 S2b-2…5 的实现一起在下一次包验收里补 |
| 剩余限制 | 这两行文案**必须与真实能力同步**：S2b-2…5 每完成一片，就要把对应项从「不带」移到「带」（已在 `EnvironmentMenu.tsx` 的注释里写明）—— 文案说得比实际能做是多，就是误导用户 |

### 本轮（2026-09-19）实施-06 S2 后半 · N21-9 五轮真实对照（历史：v1–v6，**结论已被 v7 取代**，见上面那节）

> 主题文档：[实施-06](../plan/active/实施-06-上下文管理收尾.md) §2（N21-9）/ §4（S2）；数据与诊断：[证据-06-S2](../archive/evidence/证据-06-S2-N21-9基准-2026-09-19.md)。

| 六栏 | 证据 |
|---|---|
| 实现 | 新增 [`scripts/bench/context-bench.mjs`](../../scripts/bench/context-bench.mjs) + `npm run bench:context`（`--mock` / `--live` / `--repeats=N`）：四策略 × 任务集各跑一次 `pi --print`（加载随包 `context.js`，`YAN_CONTEXT_POLICY` 传 `kinds`），收交付物 → 调已冻结的判分与对比 → 写报告；prompt 编排把约束**夹在噪音指令之间**（末尾不重提）；报告带诊断（`deliverableSample` / `lostHits` / 压缩诊断行数） |
| 自动检查 | 单测 **3746/3746**（任务集自证仍绿）；`typecheck` / `audit:refs` 干净；mock 全量 12 次全 `exit=0`（装置） |
| 真实运行 | **五轮 live 共 132 次调用，全部 `exit=0`、成功率 100%**；逐轮 LCR：v1 23.1/7.7/23.1/23.1 → v2 0/7.7/0/0 → v4 2.6/0/7.7/5.1 → v5 3.1/0/1.5/1.5 → v6 1.5/1.5/1.5/0。**三轮判定方向互相翻转**（C→D：`supported`→`not-supported`→`supported`）→ 信号低于噪声。v6（判分已干净）780 条次里只剩 **3 条次**真丢失 |
| 视觉验收 | 不适用 + 原因：只有脚本与数据，**界面零变化** |
| 应用与包 | 不适用 + 原因：`scripts/bench/` **不进包**（asar `files` 白名单只有 `out/main` / `out/preload` / `out/renderer`）；跑批器不新增运行依赖 |
| 剩余限制 | ① **基准结论未得出**：本任务集下基线丢失率只有 0–3%，四组差异不可信（**不能**据此削减或扩张白名单）；② 下一步先把 A 组丢失率抬到 20–40%（约束更琐碎、交付要求更远、每组 ≥10 次）；③ 132 次调用用的是用户已授权的 `deepseek/deepseek-v4.1-flash` |

**本片最实在的产出 —— 两条可复用结论**：

1. **自然语言交付物上的「禁止类」约束不能用字符串规则判**。两次踩到：v1 的「不许出现 `git reset`」把模型的「不要用 `git reset`，改用 `git revert`」判成违反；v5 以为留一条「模型不会主动提」的真禁止（`coming soon`）就安全，**结果一样**（模型写「明确拒绝 `coming soon` 这类空头承诺」）。→ 判分一律写成**正向标志**（「必须提到 `git revert`」），想覆盖 `must-not-match` 分支就放单测，不要放进需要模型自由表述的任务集。
2. **先把基线丢失率抬起来，再比策略**。v3 只把噪音加到 6 条仍测不出（约束堆在开头且标着「必须遵守」，摘要必然保留）；v4 改成“夹在噪音中间”后才有非 0 差异，但仍被随机波动主导。**先预跑校准 A 组**（目标 20–40%），不要拿 0–3% 的差去做决策 —— 本片三轮走过的弯路就在这里。

### 本轮（2026-09-19）实施-09 S4 · 「应用与包」栏逐项补齐（01–08）

> 主题文档：[实施-09](../plan/active/实施-09-交付与验收收尾.md) §3（逐项核对表）/ §4（S4）。
> 这一片发现的实质问题是：01–05 在包内**早就有**断言，而 06/07/08 的「应用与包」栏
> 一直只是「随 09」这句声明 —— **没有任何包内证据**。

| 六栏 | 证据 |
|---|---|
| 实现 | 只改验收装置：[`scripts/probe/packaged.js`](../../scripts/probe/packaged.js) 新增「上下文策略设置项」一节（`workingSetCap` 写 123456 → 读回一致 → 再写 200000 仍生效）与「Git 写操作」一节（按项目列表找到夹具仓库 → `git.state` → `git.action(stage)`）；[`scripts/test-packaged.mjs`](../../scripts/test-packaged.mjs) 新增：沙箱里**建一个真 git 仓库并注册为项目**、asar 字符串断言（`context-state` / `src-websearch` / `worktree-links.json` / `/remote/v1/health`）、**远程默认不监听**探测、**另一个实例显式开启远程**后验 `/health` 200 / 无 token 401 / 带 token 200、以及退出后 `git status --porcelain` 回读（`M  tracked.txt`） |
| 自动检查 | `typecheck` / `build` / `audit:refs` 干净；单测 **3746/3746**（本片无纯逻辑改动）；`test:packaged` 新增 **13 条断言**全绿 |
| 真实运行 | `npm run test:packaged`（解包目录）✓、`--exe=release/砚-0.2.0-portable.exe`（单文件真实自解压）✓、**`--exe=<静默安装到临时目录后的 砚.exe>`** ✓ 三次全绿；远程：默认态 `ECONNREFUSED`，开启态 200 / 401 / 200；git：`M  tracked.txt` 真的进了 index。**三次反向验证**：① `YAN_REMOTE_ENABLE=1` 透传 → 「默认不监听」变红；② 探针 `kind` 换成 `unstage` → 「写进了 index」变红；③ 探针第一版写「改回原值」时撞上主进程「值等于默认就清掉覆盖」的归一化（`预算视图 = null`）—— 改成「再改一次仍生效」才真正证到“设置项在包内可写可读” |
| 视觉验收 | 不适用 + 原因：本片只改验收装置与断言，**界面零变化** |
| 应用与包 | **本片就是这一栏**：产出[逐项核对表](../plan/active/实施-09-交付与验收收尾.md)（01–09 每行都指向包内真跑过的断言）；06/07/08 从「无证据」变为「有断言」，其中 **07 的 Git 写操作与 08 的「显式开启可启动」都补到了运行级**。**安装包也真装了一次**（`/S /D=<临时目录>` → 装出的应用 `conn=ready`）。⚠️ **卸载未验成**（`Uninstall 砚.exe /S` 返回 0 但目录未删），已登记 |
| 剩余限制 | ① **静默卸载会“延迟生效”**：命令立即返回 0 时目录还在（当次误判为失败），随后文件才被删完 —— 所以验收时不能拿“返回 0 后立刻看目录”当判据（已写进实施-09 §3.5）；临时目录留一个空壳删不掉，注册表一条 `砚 0.2.0` 卸载项不确定归属、未动；② **`npm run check` 全量未跑**（含 cost 1 场景，需额度）；③ 远程开启态验的是 `/health` 与 `/status`，未逐条跑全部路由 |

### 本轮（2026-09-19）实施-06 S2 前半 · N21-9 口径与任务集冻结（**真实跑批仍待额度**）

> 主题文档：[实施-06](../plan/active/实施-06-上下文管理收尾.md) §2（N21-9）/ §4（S2）。
> N21-9 是**架构决策基准**（决定 [01] 那份钩子白名单的长度），所以它要求「冻结现实现、
> 只跑既定四组与既定指标」。本片做的是**把口径与任务集冻成代码**，不是宣称跑过对照。

| 六栏 | 证据 |
|---|---|
| 实现 | 新增 [`src/shared/context-bench.ts`](../../src/shared/context-bench.ts)（纯函数）：**四组策略只用 `kinds` 区分**（A `[]` / B `[compaction]` / C `+episode-fold` / D `+tool-sweep+recall` = 产品默认集）、规则式判分（四种检查 + `flags`）、主判据 `compareStrategies`（LCR 相对下降 ≥ 25% 且成功率不低于基线 −3pp，并区分 `supported` / `not-supported` / `inconclusive`）、副指标 `stateOverhead`（关注线 25%）与矛盾率三档；新增 [`scripts/bench/context-tasks.mjs`](../../scripts/bench/context-tasks.mjs)（3 个任务 / 13 条约束，每条自带 `kept` / `violated` 两个最小样例） |
| 自动检查 | 单测 **3683 → 3746**（本片 **+63**：四组策略的合法性 / 单调包含 / D = 默认集、判分四型与 `flags`、主副指标边界、任务集自检）；`typecheck` / `build` / `audit:refs` 干净 |
| 真实运行 | **没跑真实对照，也不拿单测冒充** —— 四策略 × 3 任务 × 多回合要真实额度，跑批器（收集交付物 → 判分 → `compareStrategies`）要另做一片。**可复用的通道证据**：`contexttakeoverstate`（cost 1）已经在用同一个 `YAN_CONTEXT_POLICY.kinds` 通道并断言接管发生 |
| 视觉验收 | 不适用 + 原因：本片只有纯逻辑与数据，**界面零变化** |
| 应用与包 | 不适用 + 原因：`scripts/bench/` 不进包（asar `files` 白名单只有 `out/main` / `out/preload` / `out/renderer`）；算法在 shared 里也不新增依赖 |
| 剩余限制 | ① **真实跑批未做**（含「再补一次真实长会话」）；② 跑批器未实现（本片只冻结任务与判分）；③ 任务集只有 3 个任务 / 13 条约束 —— 真正跑批前可能要再扩（若基线 LCR = 0，口径会判 `inconclusive` 而不是「没收益」，这是故意的） |

**自检拓到的错（已修）**：任务集的 13 条约束第一次跑自检就有 **4 条红** —— 3 条用了 `(?m)` / `(?i)` 内联标志（那是 PCRE 写法，JS 的 `RegExp` 不认，会**静默**变成永远不匹配），1 条「禁止 `--force`」自己的正例里就含 `--force`。这正是「每条约束自带双样例」这条设计的目的：这类错在跑批报告里是**看不出来**的。

### 本轮（2026-09-19）实施-09 S4/S5 · 发布门槛流程一次跑通（含修掉包内开发日志污染）

> 主题文档：[实施-09](../plan/active/实施-09-交付与验收收尾.md) §3（实跑表）/ §6（当前证据）。
> 它“不是从零开始，而是每次合入后要重跑的门槛流程”—— 本片先能把流程跑通并得到硬证据，
> 同时把手上散落的发布动作脚本化。⚠️ **最终发布仍等前置**（04-S6/S7、06-S2）齐后重跑一遍。

| 六栏 | 证据 |
|---|---|
| 实现 | 新增 `npm run test:upgrade`（[`scripts/test-upgrade-read.mjs`](../../scripts/test-upgrade-read.mjs) + 探针 [`scripts/probe/upgrade-read.js`](../../scripts/probe/upgrade-read.js)）：把 `release/砚数据/` 整份复制到临时目录、用**打包产物**起一个实例读回设置 / 项目 / localStorage / 凭证，结束后用**目录树 sha256 指纹**证明原目录逐字节未变（以前这一步是手动的）。**修一个真问题**：[`electron-builder.yml`](../../electron-builder.yml) 的 `files` 原本是 `out/**`，会把 `out/` 根上的开发期日志（`build.log` / `tc.log` / `typecheck.log` / `audit-*.log|json`）与 `out/scratch/` 连**开发机绝对路径**一起打进 `app.asar`；改成显式三目录（`out/main` / `out/preload` / `out/renderer`） |
| 自动检查 | `typecheck` / `build` / `audit:refs` 干净；单测 **3683/3683**（本片无纯逻辑改动）；包内静态审计：asar 条目 253 → **239**，无 `.log` / `.json` 散件、无 `scratch` / `out/test`、extract 后搜本机路径**零命中** |
| 真实运行 | `vendor:pi:check` ✓（0.85.1 + RPC 握手）→ `dist:dir` + `test:packaged` ✓ → 便携版 `test:packaged --exe=release/砚-0.2.0-portable.exe` ✓（单文件真实自解压，交接态 `{autoCommit:true,threshold:2}`）→ `dist` 三产物 + `SHA256SUMS.txt` 重写（`E2932E82…` setup 125,635,953 B / `8C20EC40…` portable 125,402,878 B / `6CF4E65F…` zip 168,343,161 B）→ `npm run test:upgrade` ✓（cwd/lang/theme/projects 与副本 `desktop.json` 一致、`signedIn:false` 不伪造、`auth count=1`、`conn=ready`、localStorage theme/onboarded 还在、**原目录 60 文件逐字节未变**）。修完 `files` 后再跑 `test:packaged` + 便携版 + `test:upgrade` 全部重绿 |
| 视觉验收 | 不适用 + 原因：本片只动打包配置与验收脚本，**界面零变化**，不新增截图（不拿旧图充新证据） |
| 应用与包 | **本片就是这一栏**：目录包 / ZIP / 安装包三者分别产并分别验（目录包与便携版跑了真窗口探针，ZIP 与安装包只验存在与哈希 —— ZIP 与 asar 同源、安装包未跑安装流程，如实登记）；升级读取用副本并证明原目录未变；包内无测试产物、无本机路径 |
| 剩余限制 | ① **`npm run check` 全量未跑**（本轮只跑了受影响部分 + 全部新场景）；② 安装包（`setup.exe`）**没跑真实安装流程**（只产包 + 哈希；便携版才是真启动过的那个）；③ 升级读取验证覆盖的是**设置 / 凭证 / localStorage / 项目清单**，不是「旧版本会话历史能打开」这条语义（那需要一份旧版会话集）；④ 最终发布门槛要等 04-S6/S7、06-S2 齐后**再跑一遍** |

### 本轮（2026-09-19）实施-07 S4 · 来源搜索入口（「有则出现、无则隐藏」）

> 主题文档：[实施-07](../archive/plan/实施-07-Git与环境菜单收尾-已完成.md) §3「S1-搜索」/ §5 S4。
> 它的硬条件是「只在已发现兼容搜索能力时启用」且**不自造搜索后端**，所以这一片的产物是
> **发现 + 如实暴露**，不是搜索本身。

| 六栏 | 证据 |
|---|---|
| 实现 | 新增 [web-search.ts](../../src/shared/web-search.ts)（纯函数：`isWebSearchCapability` / `pickWebSearchCapability` / `webSearchAvailability`；**内置能力一律不算**，否则内置的 `knowledge.search` 会让入口在每台机器上都出现）；`AgentController.webSearchAvailability()`（把能力目录交给判定，取不到就当没有）；只读 IPC **`yan:sources:webSearch`**（装、连、搜三件都不做）+ preload + `shared/ipc.ts`；`SourceMenu.tsx` 按结果**条件渲染**那枚入口，点下去只把一段草稿**注入输入框**（不代发、不执行）；`store.ts` 新增 `injectComposerText` —— 它修的是一个真坑：外部写 `setSessionDraft` 时输入框**不会跟着变**（草稿只在切会话时同步一次，2026-09-19 实测撞到，已写进注释）；fixture 工具表加 `web_search`；新场景 `sourcecap`；新矩阵状态 `sourcesearch` |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` / `audit:refs` 干净；单测 **3665 → 3683**（判定真值表 17 条 + fixture 工具表 1 条）；`sourcecap`（cost 0）已进 `check` |
| 真实运行 | **`sourcecap`（cost 0）全绿**：场景给一份真实 MCP 配置（官方 SDK 的 stdio fixture，工具表里真的多了 `web_search`）→ 宿主报 `available:true` 且带 `location=yan mcp describe --server fixture --tool web_search` → 环境菜单里出现 `src-websearch`、没输词时按钮禁用 → 输词点击后输入框拿到草稿（含关键词 + 能力名 + 调用形状）、**没有**任何消息被发出、菜单自己关掉。**反向验证**：把 fixture 里那个工具的名字与描述都去掉搜索语义 → `available:false`、菜单里只剩 `src-url`/`src-title`/`src-add-web`（入口真的消失）。回归 `mcpcli`（cost 0）全绿 —— fixture 多一个工具不影响原有断言 |
| 视觉验收 | `YAN_MATRIX_ONLY=sourcesearch YAN_MATRIX_STAMP=2026-09-19s4 node scripts/visual-matrix-run.mjs 0 1` → `matrix-sourcesearch-1440x900-100-{dark,light}-2026-09-19s4.png`（**两张已看图**，溢出 0px）：来源菜单里「搜索关键词（交给会话里的搜索能力）」+ 「用 fixture · web_search 搜索」就在已关联列表与手工添加网址之间。⚠️ 图里那枚入口来自**桩**（矩阵不跑 registerIpc），真链路证据是 live 的 `sourcecap` |
| 应用与包 | 不适用 + 原因：没新增随包资源（判定是纯函数、IPC 是只读查询）；包内一致性随 **09-S4/S5** 统一验 |
| 剩余限制 | ① 判定是**启发式**（名字 / 标题 / 描述），不是白名单：一个描述里写「搜索网页」但实际不搜的服务会被误认（弱证据规则要求「搜索词 + 网页/联网」同时出现，这是刻意的折中 —— 宁可多显一次，也不要让功能永远不可达）；② 命中后只有「写草稿」这一步，**没有真正的搜索调用链**（那是模型用该能力做的事，宿主不该代调）；③ 它与 04 的 `capabilities.discover`（去找“该装什么”）是两件事，**没有自动接线** —— 用户装好之后能力目录里自然出现，入口随之出现 |

### 本轮（2026-09-19）实施-09 S2 第七批 · N04「真实长中英混排推理流」截图（**09-S2 收尾**）

> 主题文档：[实施-09](../plan/active/实施-09-交付与验收收尾.md) §2「N04 推理流」/ §4 S2（分批）。
> 前六批把 N12 / N10 / L03 补齐，这批补 S2 表里最后一条：真实 thinking 模型的长中英混排推理流截图。

| 六栏 | 证据 |
|---|---|
| 实现 | 新增 `scripts/shot-setup/reasoning-live.js`（`YAN_SHOT_SETUP` 的前置脚本，**首次使用者**）：关引导 → 等 pi 就绪 → 用主进程的 `cycleThinking`（与快捷键同一入口，不伪造档位）确保档位不是 `off` → 发一条要求「分 8 步、每步中文分析 + 一句 English summary」的消息 → 轮询顶层 `messages` 等到推理够长且 `thinkingLive` 为真 → 返回摘要。**没有改产品代码** |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` / `audit:refs` 干净；单测 **3665/3665**（本片无纯逻辑改动）；本片不进 `test:live`（要真调模型且需要上屏，属人工视觉验收路径） |
| 真实运行 | 真模型 `commandcode/deepseek/deepseek-v4.1-flash`（档位 `medium`，界面「标准」）三跑：第 1 跑读错字段（`session.messages` 恒空，诊断打印 `n:0` ——**消息在顶层 `messages`**）；第 2 跑读到 1276 字符、`streamingAtCapture=true`、`reasonOpen=true`；第 3 跑（消息里明写「思考用中文、术语保留英文」）988 字符、同样在流式中。会话 JSONL 交叉核对：assistant 消息带 `thinking` 内容（首次 3558 字符），`thinking_level_change=medium` |
| 视觉验收 | `YAN_SHOT` + `YAN_SHOT_SETUP`（1440×900、深色）→ `matrix-reasoninglive-1440x900-100-dark-2026-09-19s2d.png`（**已看图**）：真实中英混排推理（中文分析 + `English summary: …` + `grapheme cluster / code unit / unbounded lookahead` 等英文术语），推理块处于**默认裁剪态**（顶部渐隐、贴底显示最新一行）且带「展开全部」出口；`...-s2c.png`（也已看图）是**未写语言要求**的同一条命令：模型整段用英文推理 —— 它作为「推理语言是软约束」的对照保留（不删不覆盖）。两次跑主进程都没报溢出 |
| 应用与包 | 不适用 + 原因：截图脚本与前置脚本都不进包（`electron-builder.yml` 不含 `scripts/`）；包内一致性随 **09-S4/S5** 统一验 |
| 剩余限制 | ① 推理语言是**软约束**：要求写「思考用中文」也不保证一定混排（第 2 跑就是全英文）—— 这与产品边界一致（AGENTS 第五节），不做强制；② 只覆盖深色一张；浅色形态由 `visual:matrix` 的 `reasoning` 注入态图覆盖（真实模型下的浅色未重拍）；③ `YAN_SHOT_SETUP` 这条路径不进 `check`，靠本文档里的命令复现 |

### 本轮（2026-09-19）实施-09 S2 第六批 · L03「模型失败 / 启动超时」的恢复（顺带修一个真缺陷）

> 主题文档：[实施-09](../plan/active/实施-09-交付与验收收尾.md) §2「L03 子代理审阅」/ §4 S2（分批）。
> 上一批把 N12 的退出变体补齐，这批补 L03 表里唯一还剩的那条：模型自身失败 / 超时。

| 六栏 | 证据 |
|---|---|
| 实现 | **修了一个真缺陷**：`src/main/subagents.ts` 以前在 `agent_settled` 时无条件 `status='done'` —— 而 pi 的模型失败**也会走到 settled**（错误只体现在 assistant 消息的 `stopReason` 上），后果是详情面板显示「已完成」、`error=null`（实测打印：`status=done` / `latestActivity="已完成"` / 转录里那条 assistant 自己带着 `error="模型返回错误"`）。现在 `message_*` 时记住 `stopReason`，settled 时据此落 `status=error` + 可读原因。另外给运行上限加 `YAN_SUBAGENT_TIMEOUT_MS` 覆盖（与 `YAN_AUTO_CONTINUE` 同一先例，真实验证等不起 10 分钟），提示文本在**排定时**按实际上限拼（不再是写死的「超过 10 分钟」）。场景：新增 `scripts/probe/subagent-fail.js` + `subagentfail`（cost 0，已进 `check`）+ `afterExit: subagentFail`；`runnerfailed` 加 `fixtureSub: 'repo'` 与第 4 节（坏 pi 入口下的子代理） |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` / `audit:refs` 干净；单测 **3653 → 3665**（+12：模型失败终态 3 + `stopReason=stop` 对照 2 + pi 起不来 4 + 运行超时 3）；新场景 `subagentfail` 已进 `check` |
| 真实运行 | **`subagentfail`（cost 0）全绿**：坏模型名（上游 400、不产生用量）→ 终态 `error` / `error="模型返回错误（这一轮没有产出可用结果）"` / `latestActivity="模型返回错误"` / 转录里 assistant 带 error；等 `diff` 出现后 `review=none`、`diffFiles=0`；退出后归档元数据 `status=error` / `review=none` / 有起止时间，临时目录无残留。**反向验证**：把 `modelFailed` 写死 `false` → 前三条断言红（并看到修前的 `status=done`），而「转录里 assistant 带 error」仍绿。**`runnerfailed` 第 4 节也全绿**：同一条坏入口下子代理 `status=error` / `error="pi 子进程提前退出"` / `review=none`。孤儿进程检查：✓ 没有残留 |
| 视觉验收 | **新增状态 `subagentfailed`**（`YAN_MATRIX_ONLY=subagentfailed YAN_MATRIX_STAMP=2026-09-19s2b node scripts/visual-matrix-run.mjs 0 1`）→ `matrix-subagentfailed-1440x900-100-{dark,light}-2026-09-19s2b.png`（**两张已看图**，溢出 0px）：输入区上方的子代理行是 `✕` + 红字原因，右侧详情卡状态写「失败」、meta 行带同一段原因；深、浅两套对比度都能读。⚠️ 图只证明渲染形态，真实链路证据是 live 的 `subagentfail` |
| 应用与包 | 不适用 + 原因：未新增随包资源（新增的是探针与矩阵状态，不进包）；包内一致性随 **09-S4/S5** 统一验 |
| 剩余限制 | ① 「模型失败」只取了**上游 400 / 模型名不存在**这一种形态；429 / 内容过滤 / 网络中断都归到同一个 `error` 文案，没有分开—— UI 文案没为它们区分（如实登记，不在本轮扩大）；② **运行超时**的真实链路仍不可达（要造「模型挂着」需假 provider 接到应用里；实测走的是单测 + 覆盖值），真实侧只覆盖了「pi 起不来」这条启动失败；③ 「失败 + 有部分改动」的样本没造（那种情况下 `review=pending`、worktree 留给用户审阅，代码路径与本文档里的正向路径共用），本批只验了无改动那条 |

### 本轮（2026-09-19）实施-09 S2 第五批 · N12「退出变体」（保存 / 中断 / 重复）

> 主题文档：[实施-09](../plan/active/实施-09-交付与验收收尾.md) §2「N12 会话运行」/ §4 S2（分批）。
> 前四批补了 N12 的未读 / 等待输入 / 失败态与 N10 光带，这批把 N12 最后缺的**退出变体**补上。

| 六栏 | 证据 |
|---|---|
| 实现 | 产品代码两处小改（都在 [index.ts](../../src/main/index.ts)）：① `requestExit()` 在**已经进入退出流程**时返回 `already-exiting`（以前返回 `interrupt-exit` —— 而 preload / `ipc.ts` 的联合类型写的正是 `already-exiting`，主进程从没返回过那一档，重复点托盘会被界面显示成「已按中断退出」）；② 随之把 `ExitResult` / `exitRequestInFlight` 的联合类型补上这一档。场景侧新增 `scripts/probe/exit-save.js` / `exit-interrupt.js` + `afterExit: exitSnapshot`（[test-live.mjs](../../scripts/test-live.mjs)） |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` / `audit:refs` 干净；单测 **3653/3653**（本片无纯逻辑改动，条数不变）；新场景 `exitsave` / `exitinterrupt`（cost 0）已进 `package.json` 的 `check` |
| 真实运行 | **两个场景全绿，且是两次反向验证之后的绿**。`exitsave`：首次请求 `save-and-exit` → 重复请求 `already-exiting` → `lifecycle.quitting=true`；退出后沙箱 `data/exit-snapshot.json`：`version=1` / `mode=save` / `at` 与探针时刻同毫秒 / `runners` 1 条（与窗口里 `runners=1` 一致，`r1@ready`）/ 每条带 `cwd`+`conn`+`running` / 无消息正文字段 / 无 `.tmp` 残留。`exitinterrupt` 同一套断言、`mode=interrupt`。**反向验证**：① 把重复请求改回 `interrupt-exit` → 只有那条断言红（其余仍绿）；② 把写盘 `mode` 写死成 `save` → `exitinterrupt` 的 mode 断言红。全局孤儿进程检查：✓ 没有残留的 pi 进程 |
| 视觉验收 | 不适用 + 原因：本片只改退出分支的返回值与测试设施，**没有任何 UI 变化**（对话框是系统原生框，probe 替身跳过它），所以不新增截图 —— 不拿旧图充新证据 |
| 应用与包 | 不适用 + 原因：未新增随包资源（而是把已有的退出链路的取证补齐）；包内一致性随 **09-S4/S5** 统一验 |
| 剩余限制 | ① **真实 busy + 原生对话框期间**的重复请求（`exitRequestInFlight` 去重那一支）在探针里**不可达** —— probe 替身不 `await` 对话框，那条路径只能靠代码审阅；② 「中断退出真的掐断一个正在跑的回合」在本批不能直接观测（场景里的实例是 `ready` 而非 `running`），由 `stopAll` 的既有证据 + 全局孤儿进程检查兜；③ 本批没有造「有 busy 实例时保存快照」的样本（那需要真调模型让他挂着）—— 快照**内容**的字段级断言已覆盖，但「忙时退出」的场景仍缺 |

### 本轮（2026-09-19）实施-09 S2 第四批 · 运行实例「失败」态的真实证据

> 主题文档：[实施-09](../plan/active/实施-09-交付与验收收尾.md) §2「N12 会话运行」/ §4 S2（分批）。
> 前两批补 N12 的未读与等待输入，第三批补 N10 光带，这批补 N12 的**失败**。

| 六栏 | 证据 |
|---|---|
| 实现 | 产品代码只动一行：[Rail.tsx](../../src/renderer/src/components/rail/Rail.tsx) 的失败槽加 `data-testid="rail-failed"`（与 `rail-unread` / `rail-waiting` 同一条理由）。**没改行为**；场景侧新增 `brokenPi` 字段（把 `YAN_PI_BIN` 指到沙箱里一个立即 `exit(3)` 的文件） |
| 自动检查 | `typecheck` / `build` 干净；单测 **3653/3653**（无纯逻辑改动）；新场景 `runnerfailed`（cost 0）已进 `package.json` 的 `check` |
| 真实运行 | **`runnerfailed`（cost 0）全绿**，且是**真实故障**而不是 mock：坏 pi 入口 → 主进程侧 `failed=true` / `conn=exited`（真源判据 `conn === 'error' || conn === 'exited'`）→ 渲染端 `conn` 同步落到 `exited` → 输入区模型选择器显示「模型未就绪」→ 发消息时弹出「pi 启动超时（20s）。点「详情」看 stderr…」并把 `send` 判失败。**发现一条真实边界**：启动时的主实例挂在一条**空会话**上（`doStartAgent` 不带 restore），而空会话不进 `listSessions` —— 于是这个形态下**左栏没有那一行**，失败槽无处可画；探针显式打印原因并**跳过**该断言（不伪造绿） |
| 视觉验收 | `matrix-railwaiting-*-2026-09-19s12`（深 / 浅，**已看图**）：同一张图里两条状态槽同屏 —— 「会话 2 · 后台等你回答」带 `?` + 1m，「会话 3 · 实例起来了又崩了」带红色 `alert-circle` + 2m，溢出 0px。做法是往 `runners` 注入 `waiting: true` 一条、`failed: true`（`conn: 'exited'`）一条 —— 正是 Rail 渲染这两个槽的判据；`AFTER_STATE` 撤掉假实例 |
| 应用与包 | 不适用 + 原因：只加了一个 DOM 属性与场景设施，不新增随包资源 |
| 剩余限制 | ① **「已存在会话在运行中崩掉」仍未取证** —— 那条路径要在运行期杀掉 pi 子进程，渲染端拿不到 pid；这也正是「左栏失败槽」唯一能出现的地方（探针里留了条件断言，等将来具备该能力时自动开始生效）。② 启动失败时**没有 error 级提示**（`notices` 为空），用户看到的是「模型未就绪」+ 操作时的「pi 启动超时」——文案说的是「超时」而实测进程是**立即退出**，措辞不够准；是否要给启动失败一条更明确的提示属产品决定，未擅自改。③ 退出变体（保存 / 中断 / 取消 / 重复）仍缺 |

### 本轮（2026-09-19）实施-09 S2 第三批 · 自主模式「光带运行中」的证据

> 主题文档：[实施-09](../plan/active/实施-09-交付与验收收尾.md) §2「N10 自主模式」/ §4 S2（分批）。
> 前两批补 N12 的未读与等待输入，这批补 N10 缺的那条。

| 六栏 | 证据 |
|---|---|
| 实现 | 产品代码**没改**（本批只补证据、加测试与截图状态） |
| 自动检查 | `typecheck` / `build` 干净；单测 **3653/3653**（无纯逻辑改动）；`workmode`（cost 0）在 `check` 里 |
| 真实运行 | **`workmode`（cost 0）全绿**，探针新增三条断言：两条光带动画都挂在输入框上（实得 2）、两条都是 `playState === 'running'`（实得 2）、**隔 450ms 两次采样 `currentTime` 都在增长**。只断言 `animation-name` 不够 —— `paused` / 祖先 `display:none` / media query 都能让名字还在而画面不动；真源是⾳动画器本身（`getAnimations()` 也返回伪元素的动画） |
| 视觉验收 | 新状态 `autonomousrunning`（深 / 浅两张，**已看图**，批次 `2026-09-19s11`）：自主模式 + 一回合在跑 —— 输入框上沿有光带、右下角是「中止」形态、左栏那一行显示运行中、工作模式按钮写「自主」，溢出 0px。与 `autonomous`（刚切过去、什么都没发生）的区别就是这张要证的东西；配 `AFTER_STATE` 撤掉注入的假实例与模式 |
| 应用与包 | 不适用 + 原因：本批没有产品代码改动，也不新增随包资源 |
| 剩余限制 | ① 静态图只能证「这一瞬有光带」，**证不了它在跑** —— 所以把「在跑」交给上面那条动画器断言，两者合起来才算这一项过关。② 光带目前是**常驻**的（只要在自主模式就播放，不区分有没有任务在跑）—— 这是当前实现的语义，截图脚本注释里写明了；将来若要改成「只在跑时亮」，`autonomousrunning` 与 `autonomous` 两张图会开始有区别，那时需要同步改 MUST_HAVE 与这里 |

### 本轮（2026-09-19）实施-09 S2 第二批 · 后台会话「等待输入」的真实窗口证据

> 主题文档：[实施-09](../plan/active/实施-09-交付与验收收尾.md) §2「N12 会话运行」/ §4 S2（分批）。
> 上一批补的是**未读**，这批补 **等待输入**；剩下「失败」为什么难补写在实施-09 §2 末段。

| 六栏 | 证据 |
|---|---|
| 实现 | 产品代码只动一行：[Rail.tsx](../../src/renderer/src/components/rail/Rail.tsx) 的 `?` 状态槽加 `data-testid="rail-waiting"`（与上一批的 `rail-unread` 同一条理由：这个槽只用一个字符表达状态，没有 id 就只能靠 title 文案断言）。**没改行为** |
| 自动检查 | `typecheck` / `build` 干净；单测 **3653/3653**（无纯逻辑改动）；新场景 `askbackground`（cost 1）已进 `package.json` 的 `check` |
| 真实运行 | **`askbackground`（cost 1）全绿**：A 上发出「请用 question 工具问我」→ 主进程收到 pi 的 `extension_ui_request`（`uiRequests=1`）→ **实例侧 `waiting=true`**（主进程真源，不是前端算的）→ 提问面板渲染 → 左栏 A 行出现 `?`；**切到 B 后 A 行仍然是 `?`**（`{running:true, waiting:true, conn:'ready'}`），且 B 行**没有**该槽（证明状态是按会话分的，不是全局一个开关）。断言的是「`?` 这一行是否属于 A」，不是「页面上有没有一个 `?`」 |
| 视觉验收 | 新状态 `railwaiting`（深 / 浅两张，**已看图**）：左栏第二行「会话 2 · 后台等你回答」右侧显示 `?` 与相对时间，溢出 0px。做法是往 `runners` 里注入一条 `waiting: true` 的实例 —— 这正是 Rail 渲染该槽的**唯一判据**，所以静态图与真实链路是同一条代码路径；配 `AFTER_STATE` 在截图后撤掉假实例（同一组共用窗口，不撤会污染后面的图）。批次 `2026-09-19s10` |
| 应用与包 | 不适用 + 原因：只加了一个 DOM 属性、一条场景与两张图，不新增随包资源 |
| 剩余限制 | ① **失败（`runner.failed`）**：需要人为制造实例起不来 / 连接失败，要么改主进程要么断网，都会把场景变成“测注入”；失败渲染目前只有注入式的 `sessionrunners`（cost 0）覆盖。② 本场景**不回答问题**（问题面板留着随实例退出）—— 它证的是“等输入”这个状态，不回填链路（回填由 `ask` 覆盖）。③ 两点前提已写进 TESTING：工作模式必须标准（自主模式下 `question` 不发 UI 请求，是设计不是故障）；`waitFor` 的谓词是 async，必须 `await fn()`（第一版写成 `if (fn())`，Promise 恒真 → 只试一次就返回 `null`，表现成“链路根本没通”） |

### 本轮（2026-09-19）实施-09 S2 第一批 · 后台会话「未读」的真实窗口证据

> 主题文档：[实施-09](../plan/active/实施-09-交付与验收收尾.md) §2「N12 会话运行」缺的那三态 / §4 切片 S2（分批）。
> 本批只做 **未读** 那一态；等待输入与失败为什么难补，写进了实施-09 §2 末段。

| 六栏 | 证据 |
|---|---|
| 实现 | 产品代码只动一行：[Rail.tsx](../../src/renderer/src/components/rail/Rail.tsx) 的未读点加 `data-testid="rail-unread"`（`running` / `waiting` / `failed` 三个状态槽此前也都没有 testid，探针靠 title 文案判断；未读点是唯一只靠“一个点”表达的状态，加 id 才能稳定断言）。**没改任何行为** |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` 干净；单测 **3653/3653**（本片无纯逻辑改动，条数不变） |
| 真实运行 | **`sessionab`（cost 1）全绿**，新增两节：**3.5 未读**（窗口无焦点 → A 在后台**自然跑完** → 左栏那一行出现 `rail-unread`）与 **4 的收尾**（点左栏那一行回去 → 未读点消失）。这一节踩了三个坑，都是“假红 / 假绿”，已写进注释：① 用 `stopRunner` 制造“跑完”**不行** —— 它把实例移出注册表，而 `runnersSeen` 比的是「同一实例 running 从 true 变 false」，被移除的实例不会再被比较（第一版就是这样，标记永远不出现）；② 切回会话要**点左栏那一行**，不能 `store.switchSession` —— 清未读在 `select()` 里（第一版用 action，导致“切回后消掉”这条**假绿**）；③ 退出后检查里原来写死 `sleep 90`，而这一批为控制场景时长把它改成了 30 → 改成匹配 `/sleep d+/` |
| 视觉验收 | **由真实窗口里的 DOM 断言覆盖，不出静态图**，理由：N12 要的是「真实窗口证据」而不是截图，而未读点在**静态**视觉矩阵里注入不了 —— `useSidebarValue` 只在组件挂载时读一次 `localStorage`，运行中写存储不会重渲染；走真实的 `runnersSeen` 路径注入两次 runners 快照也没画出来（判定里还有 `!document.hasFocus()`，矩阵窗口的焦点状态不受我们控制）。评估后**撤回了**视觉矩阵里的注入尝试（不留半生效的桩），把代价与结论记在这里 |
| 应用与包 | 不适用 + 原因：本片只加了一个 DOM 属性与探针断言，不新增随包资源 |
| 剩余限制 | ① **等待输入（`rail.waiting`）**：真源是「这个会话有还没回答的提问面板」，要出真实证据得让**后台**会话弹问题 —— 只有 `ask`（cost 1）能让模型主动提问，而那个场景里提问的是前台会话；补它需要一条“A 触发提问 → 切到 B → 断言 A 行显示 `?`”的流程，留下一批。② **失败（`runner.failed`）**：需要人为制造实例起不来 / 连接失败，要么改主进程要么断网，都会把场景变成“测注入”；失败渲染目前只有注入式的 `sessionrunners`（cost 0）覆盖。③ 退出变体（保存 / 中断 / 取消 / 重复）仍缺（实施-09 §2 的 N12 行已如实标注）。④ **本会话的一处失误（已修）**：跑整组视觉矩阵时没给 `YAN_MATRIX_STAMP`，而它的默认值是写死的 `2026-09-18` —— 于是把那一批 **~28 张旧图原地覆盖了**（它们本来就该凭“另存新名”保留）。这些图的内容是**当前代码**的真实截图（不是伪造），但违反了 AGENTS 的“不覆盖”规则，**没有自作主张用 `git checkout` 回滚**（工作区常年带未提交改动，那可能抹掉用户的改动）—— 需要恢复时请显式操作：`git checkout -- docs/design/preview/matrix-*-2026-09-18.png`。默认值已改成带**时分**（`YYYY-MM-DD-HHmm`），下次不带环境变量只会新增文件 |

### 本轮（2026-09-19）实施-09 S3 · 「每个项目最后一个会话」的恢复判据

> 主题文档：[实施-09](../plan/active/实施-09-交付与验收收尾.md) §3「N05 项目切换」/ §4 S3 的口径段。
> 出口原文：「给会话补 `lastOpenedAt` 元数据 + 启动 / 切回时按目录扫描推导（**不新增
> `lastSessionId` 之类的第二份真源**）」。

| 六栏 | 证据 |
|---|---|
| 实现 | [project-session.ts](../../src/renderer/src/state/project-session.ts)：排序从「比 `lastActivityAt`」改成 `compareRecency` —— **有 `lastOpenedAt` 的整类排在只有活动记录的之前**，同类内再各自比时间，两者都没有才回落 `updatedAt`（**始终不碰文件 mtime**）。为什么不能直接混比两个时间戳：`lastActivityAt` 会被后台续行 / 子代理写回 / 另一个窗口发消息刷新，混比会让「项目最后一个会话」变成「最近被模型碰过的会话」。**[Rail.tsx](../../src/renderer/src/components/rail/Rail.tsx) 修掉一个真缺陷**：`switchProject` 在决策前**没有刷新会话列表**，而 `lastOpenedAt` 是切会话之后才写进索引的 —— 缓存里那份根本没有这个字段，等于新排序永远读不到输入。现在决策前 `await store.refreshSessions()`。**承载位置**：`lastOpenedAt` 落在**已有的** `YAN_DIR/session-layout.json` 条目（写入口径本来就是这套 `rememberSession`）；**没有** `project→sessionId` 映射，索引删掉只影响「先选哪个」 |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` / `audit:refs` 干净；单测 **3648 → 3653**（本片 **+5**，[test-project-session.mjs](../../scripts/test-project-session.mjs)：打开过的优先于活动更新的 / 两条都打开过比打开时间 / 都没记录回落活动时间 / 有记录 vs 无记录混选 / **很旧的打开记录仍赢过今天还在后台活动的会话**）；新场景 `projectopened`（cost 0）已进 `package.json` 的 `check` |
| 真实运行 | **`projectopened`（cost 0）全绿 12 条 + 退出后 5 条**：前提成立（`hot` 消息时间比 `opened` 新）→ `hot` 没有 `lastOpenedAt` → 打开 `opened` 后主进程回读出现 `lastOpenedAt` → 视图真的切过去 → 停掉全部实例（`runners=0`）→ 决策选 `opened` 而不是 `hot`；退出后读 `data/session-layout.json`：`opened` 有 `lastOpenedAt`、`hot` 没有。**反向验证（真做了两轮）**：把排序换回纯 `lastActivityAt` → 断言变红（选中 `hot`）；还原 → 绿。⚠️ **第一轮反向验证假绿**，原因有两个，都已修在探针里：① 探针只停了「同 cwd 且 running」的实例，而 `pickProjectSession` 的实例分支**不要求 `running`**，于是一直在验实例分支；② 探针直接调 store action，**没有先 `refreshSessions()`**，决策输入里两条都没有 `lastOpenedAt` —— 排序怎么改都选不出区别。现在探针会先打印「决策输入」（runners 数 + 每条候选的 act/open），这一行就是为此加的 |
| 视觉验收 | 不适用 + 原因：本片**无界面改动**（只改了「选哪个会话」的排序与一个刷新时机），没有新的视觉状态可拍；也没有旧状态因它变化（`projectswitch` 的界面形态不变） |
| 应用与包 | 不适用 + 原因：纯渲染端逻辑 + 已有索引文件，不新增随包资源。按 [实施-09](../plan/active/实施-09-交付与验收收尾.md) 的统一口径，包验收在 S4 一次做 |
| 剩余限制 | ① **口径偏离（如实记录）**：`lastOpenedAt` 没有写进会话文件，而是落在已有的 `session-layout.json`。理由是 pi 的 JSONL 没有宿主可安全写入的元数据位（`custom` entry 会被 pi 装进聊天、`role:'custom'` 的 message 会进模型上下文、`session_info` 由 pi 独占）—— 依据是 pi 运行时的解析分支（读 bundle 得出），**未做真模型实验**；口径的实质要求（不新增 `project→sessionId` 映射）满足了。② 索引整份丢失时行为退化为「按活动时间选」——这正是设计意图（可重建），但没有单独的场景覆盖“索引被删”，只有单测覆盖回落分支。③ `compareRecency` 的「分类优先」是**产品语义决定**：一条三周前打开过、之后没人动的会话，会赢过一小时前后台跑过一句的会话；如果将来觉得该反过来，要连同 `projectopened` 的断言一起改，别只改函数 |

### 本轮（2026-09-19）实施-07 S2a · 工作树「来源关系落盘」（W2 的追溯那一半）

> 主题文档：[实施-07](../archive/plan/实施-07-Git与环境菜单收尾-已完成.md) §3「W2-重绑定」/ §5 切片 S2。
> **本片是 S2 的前半**：W2 的出口有两半 ——「新会话能正确读到工作树内的相对路径与授权附件」与
> 「源 / 目标关系可追溯」。这里做的是**后者**（可追溯）；四个重绑定本体
>（项目权限 / 相对文件路径 / 附件授权 / 上下文派生）是 **S2b**，降级文案继续保留。

| 六栏 | 证据 |
|---|---|
| 实现 | 新模块 [worktree-links.ts](../../src/main/worktree-links.ts)：`WorktreeLinkStore`（清洗 / 加载 / 登记 / 按新会话取回），落盘 `YAN_DIR/worktree-links.json`（先写 `.tmp` 再 `rename`，写入按 `tail` 串行；上限 2000 丢最旧）。**为什么不复用会话链**：`session-chains.json` 的语义是「**同一条会话**的多个段」且有「一个段只属于一条链」的硬不变式，而这里是「A 派生出**新**会话 B」—— 侧栏也必须当成两条，塞进去会同时破坏不变式与界面语义。IPC：`yan:git:worktreeLink` / `yan:git:worktreeLinks` + preload + `WorktreeLinkView`。渲染端：[store.ts](../../src/renderer/src/state/store.ts) 的 `newSession` 改为返回 `{ok, sessionId, runId}`（调用方此前都忽略返回值，向后兼容；**需要它是因为不能去猜 `session` 什么时候刷新**）；[EnvironmentMenu.tsx](../../src/renderer/src/components/review/EnvironmentMenu.tsx) 在「开新会话」里**先取源会话再切**（切完再读就把新会话与自己比了），之后登记；工作树区显示 `env-worktree-origin`「这个会话是从工作树 X 派生的（目录）—— 不带走源会话的历史、权限与附件授权」；i18n `env.worktreeOrigin` |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` / `audit:refs` 干净；单测 **3626 → 3648**（本片 **+22**，全在 [test-worktree-links.mjs](../../scripts/test-worktree-links.mjs)：真读 `worktree-links.json`、`forSession` 方向不反、重复登记就地更新、缺身份字段被清洗掉、坏时间戳回落 0、上限 2000 丢最旧、坏文件当空表、**换一个实例能读回**）；`test-unit.mjs` 加了 esbuild 条目与一节输出 |
| 真实运行 | **`gitwrite`（cost 0，已进 `check`）全绿 106 条**（新增 5 条：登记真的出现 / 来源会话就是点按钮之前那个 / 分支记下来 / 环境菜单显示来源行 / 显示的是真实分支而不是模板文案）+ **退出后 12 条**（新增 6 条：探针报告、磁盘上确实有 `data/worktree-links.json`、会话 id 对得上、工作树目录对得上、源会话记下来且**与新会话不是同一条**、带正时间戳）。探针在**点按钮之前**读源会话 id —— 晚一步这条断言就变成「拿新会话与自己比」，永远绿 |
| 视觉验收 | `YAN_MATRIX_ONLY=envworktrees YAN_MATRIX_STAMP=2026-09-19s8` 跑组 0/1 → `matrix-envworktrees-1440x900-100-{dark,light}-2026-09-19s8.png`（**2 张已看图**，溢出 0px）：工作树列表顶部是那行蓝色来源说明（分支名 + 目录 + 三句不带走什么），深浅对比度正常。设施改动：stub 加 `yan:git:worktreeLinks`（一条，`sessionId: 'sess-1'`）、`envworktrees` 状态脚本把当前会话 id 固定成 `sess-1`（否则那一行永远不出现）、`MUST_HAVE` 加 `env-worktree-origin` 硬断言；`envworktrees` 同时补进组 1（浅色）—— 原来只在组 0 出图 |
| 应用与包 | 不适用 + 原因：本片只新增一个**数据目录下的文件**与界面文案，不新增随包资源、不改启动路径。按 [实施-09](../plan/active/实施-09-交付与验收收尾.md) 的统一口径，包验收在 S4 一次做 |
| 剩余限制 | ① **四个重绑定本体仍未做**（S2b）：项目权限 / 相对文件路径 / 附件授权 / 上下文派生状态都**不跟着走**，降级文案「不带走历史、权限与附件授权」继续保留，界面上**不显示**「无缝继续」；② 表里只记「新会话从哪来」，没有反向索引（「这个工作树有哪些会话」要遍历全表）—— 表最多 2000 条，遍历一遍可接受；③ **会话被删时这张表不清理**（界面按当前会话 id 查不到就不显示，上限会自然淘汰旧的）；④ 「创建并打开」不登记 —— 它只登记项目、并不开新会话（方案 §6.2 的有意行为） |

### 本轮（2026-09-19）实施-07 S3 · 来源「定位消息」（关联落盘 + 跳转）

> 主题文档：[实施-07](../archive/plan/实施-07-Git与环境菜单收尾-已完成.md) §3「S1-定位消息」/ §5 切片 S3。
> 出口原文：「来源菜单里能从一条来源跳到它参与的那条消息；需要落盘关联（当前无此数据）」。

| 六栏 | 证据 |
|---|---|
| 实现 | **数据**：[sources.ts](../../src/main/sources.ts) 新增 `SourceLink` / `listLinks` / `linkSources`（形状校验：sourceId 必须带类前缀、messageId 只收可安全放进 `[data-msg-id="…"]` 的字符；幂等；每会话上限 500 条丢最旧；文件坏了当空表）。每会话一张 `<YAN_DATA_DIR>/sources/<会话>/links.json` —— 与图片副本同目录同生命周期，**不写进会话 JSONL**（与任务日志同一条理由）。IPC：`yan:sources:link` + `sources.list` 一并带回 `links`（preload / `SourceLinkView` 同步）。**绑定时机**（[store.ts](../../src/renderer/src/state/store.ts)）：`send` 前把附件换算成来源 id 排队（图片 = 内容指纹，渲染端自己算 sha256；文件 = 主进程 `verifyFiles` 给的 id），收到 pi 写出的那条 user 条目（`msg-add`）时绑队首 —— **消息 id 在发送那一刻并不存在**，所以才要排队；失败/形状不对如实出队，不让一个坏 id 卡住后面所有批次。**跳转**：`locateMessage` 按 `[data-msg-id="…"]` 找节点 → `scrollIntoView` → 加 1.8 秒高亮 class（[chat.css](../../src/renderer/src/styles/chat.css) 的 `.msg-located`，用现有 `--accent-soft`/`--accent-line` 令牌）；[SourceMenu.tsx](../../src/renderer/src/components/review/SourceMenu.tsx) 只给**有落盘关联**的来源渲染「定位消息」按钮；i18n `src.locate` / `src.locateHint` |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` / `audit:refs` 干净；单测 **3614 → 3626**（本片 **+12**，全在 [test-sources.mjs](../../scripts/test-sources.mjs)：真读 `links.json`、幂等、一批多份只去重不报错、形状不对进 `skipped`、消息 id 不安全即拒、`list` 带回关联、坏文件容错、500 条上限丢最旧）；新场景 `sourcelink`（cost 0）已进 `package.json` 的 `check` 列表 |
| 真实运行 | **`sourcelink`（cost 0）全绿**（13 条 + 退出后 5 条）：图片落盘 → 登记关联（重复一次 `added=0`）→ 主进程 `list` 回读 → 菜单出现「定位消息」→ 点击后**那一条** `m0` 被高亮、1.8s 后自己掉；退出后从 Node 侧找到 `data/sources/yan-ab-a-mu…/links.json`，内容与探针登记的那条逐字段一致且只有一条。**`sourcelinklive`（cost 1，固定 `deepseek/deepseek-v4.1-flash`）全绿**：附件进输入区 → `send` → 自动生成的关联指向的正是**刚发出去那条**（文本 `YAN-SOURCELINK-LIVE …` 对得上）；退出后同样的磁盘核对。⚠️ 场景需要「在 git 项目里 + 带消息」的会话：来源区只在「这是 git 项目」那个分支里渲染，所以开了 `abSessions`（`yan-ab-a` 的 cwd = fixture/repo 且带 user 消息）—— 这一条踩过两次（先用 `fixtureSub: 'repo'` → 非 git 目录整块不渲染；再切到 plain fixture → cwd 是家目录） |
| 视觉验收 | `YAN_MATRIX_ONLY=envlinks YAN_MATRIX_STAMP=2026-09-19s7` 跑组 0/1/4 → `matrix-envlinks-{1440x900-100-dark,1440x900-100-light,900x520-100-dark}-2026-09-19s7.png`（**3 张已看图**，溢出 0px）：图片来源那一行右侧是「定位消息 / 复制路径 / 移除」，深浅对比度正常，窄窗 900×520 下三按钮仍在一行、没有换行挤压。`MUST_HAVE.envlinks` 加了 `src-locate` 硬断言（缺了这张图就没意义）；`envlinks` 同时补进组 1（浅色）与组 4（窄窗）的 states —— 原来只在组 0 出图。⚠️ **既有设施缺陷（不是本片引入）**：整组跑时 `envbranches` / `envworktrees` / `envlinks` 会红（状态脚本返回 `no-branches` / `no-worktrees` / `no-links`），因为组内前一个状态 `envnotgit` 把 Git 桩切到非 Git 模式后，渲染端 store 里的 `repo` 没被刷新回来；`YAN_MATRIX_ONLY=envlinks` 单独跑组 0/1/4 **全绿**。这条与本片无关，但会让人误判，故如实记在这里 |
| 应用与包 | 不适用 + 原因：本片只新增渲染端界面与一个**数据目录下的文件**（`links.json`），不新增随包资源、不改启动路径。按 [实施-09](../plan/active/实施-09-交付与验收收尾.md) 的统一口径，包验收在 S4 一次做 |
| 剩余限制 | ① **网页来源拿不到自动关联**：网页不进附件流（只能手填），`collectSourceIds` 只看附件 —— 所以它的「定位消息」入口只在有手工/未来的关联时出现；② **文件被改过就当另一份来源**：`file:` 的 sourceId 含 `size:mtime`，改过的文件是新 sourceId，旧关联仍留给旧 id（历史事实不抹掉），菜单上那条新条目不会显示定位入口；③ 高亮是**瞬时动画**（1.8s），静态截图只能证明入口存在，落点正确性由探针按 `data-msg-id` 断言；④ 「已读取 / 本轮已参与上下文」两个状态**仍然不显示**（方案 §8 的产品边界，未变） |

### 本轮（2026-09-19）实施-05 S5b-3b · 交接事务接线（建目的会话 / 同 cwd 租约 / resume 与消费去重 / 启动恢复）

> 主题文档：[实施-05](../archive/plan/实施-05-工作模式与长任务续接-已完成.md) §8（S5b-3b 落地段）/ §10 切片 S5b-3b。
> 出口原文：「建目的会话 / `runners.ts` 同 cwd 租约 / 发 resume / `link` 会话链」+「崩溃不双写」。

| 六栏 | 证据 |
|---|---|
| 实现 | **新增** [shared/handoff-resume.ts](../../src/shared/handoff-resume.ts)（标记行 / 正文构造 / 消费证据检测，正文与检测**同一份定义**）与 [main/handoff-runner.ts](../../src/main/handoff-runner.ts)（执行器，依赖全注入）；[handoff-transaction.ts](../../src/shared/handoff-transaction.ts) 新增 `resumeAttempts`（发送**之前**记，防「盲发两遍」）；[handoff-transaction-service.ts](../../src/main/handoff-transaction-service.ts) 新增 `noteResumeAttempt` / `latestForSession`，并把会话键比较**归一化**；[index.ts](../../src/main/index.ts) 接上 `SessionChainStore` + `HandoffTransactionStore` + 触发点（`commitHandoff`）+ 启动恢复（`recoverHandoffs`）+ `openHandoffSession`（走 `runners.select`，不绕同 cwd 防线）；`yan:getHandoff` 增 `transaction` / `autoCommit`（沿链回首段查包与计数）。顺序：**停源 → 建目的 → `setDestination`/`destination-created` → 写链 → `committed` → 发 resume → 等磁盘证据 → `resumed`**；失败（建会话 / 链 / 落盘）一律记 `failed` 并回源；发送失败或证据未到**不记 failed**（留在 `committed` 等下次启动核对）。**默认开**（用户 2026-09-19 拍板；`YAN_HANDOFF_COMMIT=0` 关，解析在 `handoffCommitEnabled` 且有单测钉默认值）；恢复不受开关影响 |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` 干净；单测 **3581/3581**（本片 **+75**：`test-handoff-resume.mjs` 33 条 + `test-handoff-runner.mjs` 42 条 —— 顺序 / 幂等 / 建会话失败回源 / 链拒绝不算成功 / 发送失败与证据未到停在 `committed` / 崩溃恢复四种处置（含 `attempts>=2` 不重发）/ 落盘失败抛）；`node --check` 过 `test-live.mjs` 与探针；回归 `workmode`（cost 0）/ `live`（cost 0）全绿 |
| 真实运行 | **新场景 `handoffcommit`（cost 1，`YAN_HANDOFF_THRESHOLD=0` + `YAN_HANDOFF_COMMIT=1` ⚠️「显式打开」是**当时**的口径，S6 起默认开、场景不再设它，见上方 S6 一轮；固定 `deepseek/deepseek-v4.1-flash`）全绿** + `afterExit: handoffCommitPersisted`：探针侧 —— 八个断言全绿（包生成 → 事务 `committed → resumed` → 当前视图切到目的段（`sessionKey === destinationSession`）→ 目的与源是两份文件 → 界面照常渲染）；磁盘侧 —— `handoff-transactions.json` 里 `resumed(attempts=1)` 且**五阶段一个不缺**（`snapshot,validated,destination-created,committed,resumed`）、`session-chains.json` 一条链两段且目的段 `handoffId` 一致、**目的会话文件里真有 `[yan-handoff-resume:<id>]`**（4439 字符）且是交接正文、源会话与 `handoffs.json` 的包都还在、请求/结果目录已清空 |
| 视觉验收 | 不适用 + 原因：本片无界面改动（侧栏只列代表段 + 历史按段拼接是 S5b-4）。交接后的界面现状是「同一实例继续渲染」，已由 `handoffcommit` 的「界面不在流式中 / 目的会话能渲染」两条断言覆盖 |
| 应用与包 | 不适用 + 原因：新增的是主进程 TS 与薄层无关的模块，随既有打包链进包；包验收随 **09**（S6）统一做 |
| 剩余限制 | ① **默认关**（⚠️ 当时；**S6 起已改为默认开**）：是否默认自动交接需用户拍板（§7）。② 交接包里的 `goal` 状态**不迁移**到目的会话（新片段从 rev0 开始，模型靠 `yan goal report` 重建）—— S6 已定下口径。③ resume 会**真的起一轮模型**（这是设计：接手会话要开始干活），所以代价是一次模型回合；④ `resumeAttempts >= 2` 仍无证据时不再自动重发，需人工确认目的会话（界面提示已有，但没有专门入口，见 S5b-4） |

**三个真实链路抽到的真问题**（都已修，且都是「单测不会发现」的类型）：

1. **事务查询没归一化会话键** —— 事务里的 `destinationSession` 是 pi 给的原始路径（Windows 反斜杠），
   调用方的键来自 `workModeKeyFor`（已归一化）→ 刚交接完的会话**查不到自己的事务**：
   界面看不到进度、重启恢复也认不出它。改成用 `normalizeChainKey` 比较。
2. **`yan:getHandoff` 只按当前段查计数与包** —— 交接后当前实例跑在目的段上，
   于是「已压 N 次 / 包写好了没有」当场归零（看上去像功能坏了）。改成**沿链回到首段**取。
3. **`SessionChainStore.link` 的「拒绝」返回值被当成成功** —— 目的段已属于另一条链时它返回**那条链**
   （而不是 `null`），只看返回值非空会把「写链根本没发生」当成功 → 前端会出现两条会话。
   改成校验「这条链上真的有源与目的两段」。

另外补一轮**诊断设施教训**：探针的输出是**整体返回**的，第一版把各段等待都挂在同一个 300s 预算上，
第一步卡住就变成「一句输出都没有」（最难排查的失败形态）。现在每段**各自限时、失败立即收尾**。

### 本轮（2026-09-19）实施-05 S5b-4 · 前端仍是「一条会话」（侧栏代表段 + 历史按段拼接 + 删除按链）

> 主题文档：[实施-05](../archive/plan/实施-05-工作模式与长任务续接-已完成.md) §9（前端口径）/ §10 切片 S5b-4。
> 出口原文：「侧栏只列代表段 + 历史按段拼成一条时间线 + 删除 / 导出按链」。

| 六栏 | 证据 |
|---|---|
| 实现 | **新增** [main/session-history.ts](../../src/main/session-history.ts)：`readChainMessages(headFile, chains)` —— 按 `planHistoryRead` 从旧到新读每段并拼成一条时间线，**不改写任何 JSONL**，链上读不到的段**如实计入 `missing`**（不静默丢段），全部读不到才返回 `null`（调用方回退 `get_messages`）。接线：① [agent.ts](../../src/main/agent.ts) 新增可注入的 `readHistory`（默认单文件），`hydrate` 改走它 —— agent 不认识「链」，那是宿主的关系；② [session-chain-service.ts](../../src/main/session-chain-service.ts) 新增 `forget(sessionFile)`（删链、幂等）；③ [index.ts](../../src/main/index.ts)：侧栏 `yan:listSessions` 只列**代表段**（旧段隐藏，代表段无标题时用链首段标题顶上）、`yan:peekSession` 与远程历史接口改链感知、`yan:deleteSession` **按链整体删**（多个 token 用 `|` 拼给界面）且删后 `forget`、`yan:restoreSession` 支持多 token 整链撤销 |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` / `audit:refs` 干净；单测 **3600/3600**（本片 **+19**：`test-session-history.mjs` —— 无链单文件 / 两段顺序与合计 / 从旧段也能读全 / 缺一段如实计数 / 全读不到 → null / `forget` 幂等与落盘）。**一次性把探针诊断也改了**：`historyswitch` 的 messages 变化日志现在带 `runner` 与 `sid`（下面那条缺陷就是靠它定性的） |
| 真实运行 | **`handoffcommit`（cost 1）扩出 4b 节并全绿**：`window.yan.listSessions()` 里当前这条会话**只出现一次**、链上的旧段**没有单独出现**；界面 `messages` 里同时有源段消息（「这是一次功能自测」）与 resume 那条交接消息 —— 两段真的拼成了**同一条时间线**（共 3 条）。**回归**：`sessions`（切会话 / 新建）、`trash`（删除撤销）、`historyswitch`（旧段/新段一致性）均绿 |
| 视觉验收 | **新状态 `chainjoin`**（`YAN_MATRIX_ONLY=chainjoin YAN_MATRIX_STAMP=2026-09-19s5b4`，组 0/1）：`matrix-chainjoin-1440x900-100-{dark,light}-2026-09-19s5b4.png`，**两张已看图**，溢出 0px。图里：左栏只有「长任务续接 · 导入提速」（代表段，标题来自链首段）+「另一个会话」对照；消息区最下面一条是交接正文，接在 fixture 的旧消息之后 —— 渲染层确实把两段排成了一条时间线。⚠️ 过滤逻辑归主进程（图只是形态，真证据是上面的 `handoffcommit` 直调 IPC） |
| 应用与包 | 不适用 + 原因：新增的是主进程模块与既有渲染层，随既有打包链进包；包验收随 **09 / S6** 统一做 |
| 剩余限制 | ① **导出 / 复制仍是单段**（pi 的 `export_html` 与 fork / clone 都是单文件语义）—— 界面上没有声称「导出整条链」，但也没做，属已知限制；② 删除按链有单测（`forget`）+ `trash` 回归覆盖，但没有一个「链上两段一起删」的专门场景（造链 fixture 成本高，值不值得再做看后续）；③ 未读 / 搜索的「按链算」只在列表层生效（代表段即链）；④ `chainjoin` 图用的是注入数据，只证明渲染形态 |

**顺手修掉一条真实缺陷（与本片无关，但挡住了回归）**：`historyswitch` 探针稳定报
「铺上内容之后没被打回 0（不闪空白）」，实测序列 `0→482（peek 铺上）→ 482→0（runners 投影）→ 0→482（sync）`。
定性靠两件事：① **A/B 反向验证** —— `YAN_NO_CHAIN_HISTORY=1` 关掉链感知后**照样红**，说明不是本片引入；
② 探针新加的 `runner=` / `sid=` 显示「请 0 的那一帧 session 已经切到目标会话」，
即 `applyPush` 的 `runners` 分支把**实例的空缓存**投影了上来。
修法：新增 `projectSnapshotKeepingPeek` —— 缓存里 `messages` 为空且界面正拿着 peek 内容（`peekedPath`）时，
**不覆盖 `messages`**（stats / todos / queue 照常投影）。空快照只说明「实例还没收到 sync」，
不等于「这条会话没有历史」。四处投影（`syncRunners` / `runners` 推送 / 托盘切会话 / `switchSession`）全部改走新函数。
修完 `historyswitch` 全绿（只剩 `0→482` 一次变化）。

### 本轮（2026-09-19）实施-05 S6 · 联调与包（05 收尾）

> 主题文档：[实施-05-工作模式与长任务续接-已完成.md](../archive/plan/实施-05-工作模式与长任务续接-已完成.md) §10 切片 S6。
> 出口原文：「六栏齐备；解包 / 便携版事务状态持久化，无开发路径依赖」。

| 六栏 | 证据 |
|---|---|
| 实现 | ① **自动交接默认开**（用户 2026-09-19 拍板）：[shared/handoff.ts](../../src/shared/handoff.ts) 新增 `handoffCommitEnabled`（默认开；`YAN_HANDOFF_COMMIT=0` / `false` / `off` / `no` 关），[index.ts](../../src/main/index.ts) 改用它 —— 「打开」只是允许，实际仍要过四条资格（够数 + 目标在推进 + 自主档 + 不忙）。② **联调口径**：交接成功后 `inheritWorkMode` 把源会话的工作模式复制到目的段（模式是「用户对这条会话的意图」，掉回默认档会让自主续接 S3c 当场失效）；**goal 不迁移**（§8：不能把旧总结升级成事实），改为在 resume 正文里要求模型「先 `yan goal status` 再 `yan goal report` 把目标重新登记（新会话从 rev0 开始，不照搬进度）」。③ **包验收设施**：[test-packaged.mjs](../../scripts/test-packaged.mjs) 新增 app.asar 静态索引（4 条）、[probe/packaged.js](../../scripts/probe/packaged.js) 新增解包态交接断言（3 条） |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` / `audit:refs` 干净；单测 **3610/3610**（本片 **+10**：`handoffCommitEnabled` 默认值与显式关闭共 9 条 + resume 正文要求 1 条）；`node --check` 过两个改动的脚本 |
| 真实运行 | **`handoffcommit`（cost 1）全绿，而且本场景不再设任何开关** —— `autoCommit=true` 本身就是「默认开真的生效」的断言；新增一条「目的会话继承了自主档（实际 autonomous）」。磁盘侧照旧全绿（五阶段 / 链两段 / 消费证据 / 源与包都在）。**包验收**：`npm run dist:dir` + `npm run test:packaged` **全绿** —— 静态：`app.asar` 里含 `yan-handoff-resume` / `handoff-transactions.json` / `session-chains.json` / `resumeAttempts`；运行时：解包态 `yan:getHandoff()` 读回 `{autoCommit:true, threshold:2, transaction:null, pending:false}` —— **装完即默认开，且不依赖开发目录** |
| 视觉验收 | 不适用 + 原因：本片无界面改动（交接后的界面形态由 S5b-4 的 `chainjoin` 两张图 + `handoffcommit` 的 4b 节覆盖） |
| 应用与包 | **已做**（见上）：`dist:dir` + `test:packaged` 全绿。未跑便携版 `--exe`（S6 的出口是「解包 / 便携版」，解包已验；便携版与解包共用同一份 app.asar，P0-8 已验证过它能自解压启动，本次新增的断言在解包态已取证）—— 如实记为范围限制 |
| 剩余限制 | ① 导出 / 复制仍是**单段**（pi 的 `export_html` / fork 是单文件语义），界面不声称「导出整条链」；② 自动交接**没有界面开关**（默认开，关要靠 `YAN_HANDOFF_COMMIT=0`）—— 普通用户够不到这个开关，要不要加设置项需要产品拍板；③ `resumeAttempts >= 2` 仍无证据时不再自动重发，需人工确认目的会话；④ 交接后 goal 由模型重建，**模型不调 `goal report` 时新会话的目标仍是空的**（这是有意为之：不把旧总结升级成事实） |

### 本轮（2026-09-19）实施-06 S4 前半 · 压缩接管的档位可达性

> 主题文档：[实施-06](../plan/active/实施-06-上下文管理收尾.md) §2「N21-6 尾」/ §4 切片 S4（前半）。
> 出口原文：「每档至少一次真实接管或明确的降级记录（`stale-hard` 仍允许接管是**设计**，不是漏洞）」。

| 六栏 | 证据 |
|---|---|
| 实现 | 新探针 [probe/context-takeover-tier.js](../../scripts/probe/context-takeover-tier.js)（回合 1 造 evidence + 等状态落盘 → 回合 2 越线；与 `contexttakeoverstate` 同一时序）+ 新场景 `contexttakeovergap` + 退出后检查 `checkContextTakeoverGap`（[test-live.mjs](../../scripts/test-live.mjs)）。检查函数除断言接管/档位/摘要外，还**打印本会话的条目序列**（`type:role`），因为 `gap` 只看数字无法回答“那几条是什么”。另：给三条 takeover 场景（`contexttakeoverstate` / `contexttakeovergap`）**固定 `deepseek/deepseek-v4.1-flash`** —— 默认免费档 LongCat 已退役（403），不固定会让它们假红 |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `audit:refs` 干净；单测 **3614/3614**（本片未改产品代码，条数不变）；`node --check` 过 test-live 与探针 |
| 真实运行 | **`contexttakeovergap`（cost 1）全绿**：接管 1 次 / 降级 0 次、`tier=stale-hard`、`gap=3`、摘要 `fields={task:true,constraints:true,…}`；会话条目序列 `session \| model_change \| thinking_level_change \| user \| assistant \| toolResult \| assistant \| session_info \| user \| assistant \| compaction \| session_info \| session_info`。**两种构造都试过、结果一样**：① 让 pi 用 `reserveTokens = 窗口 − 25k` 中途压（`reason=threshold`、`beforeTokens=47928`）→ 仍是 `stale-hard gap=3`；② 回合 2 明确禁止工具调用 → 仍是 `stale-hard gap=3`。结论：压缩总在**回合结束之后**，水位后至少已有 `user + assistant + compaction` 三条 |
| 视觉验收 | 不适用 + 原因：本片无界面改动 |
| 应用与包 | 不适用 + 原因：只改仓库内测试设施，不进包 |
| 剩余限制 | ① **`fresh` / `stale-soft` 在真实链路里不可达**（实测结论，不是未做）—— 它们的判定正确性由 `test-context-producer.mjs` 的 `applyFreshness` / `pendingOnly` 单测钉住；场景与文档都写明了机制原因，不再声称“每档都有真实数据点”。② 检查函数里的档位结论是**打印 + 软断言**（硬断言只要求“可接管的真实档位、gap ≥ 1、摘要有目标”）：将来实现变了（真的能命中 `fresh`）不该假红，但需要回写文档 —— 函数里已提示 ── 但这意味着“不可达”这个结论本身**不会被自动拦住**，靠文档与人工复核 |

### 本轮（2026-09-19）实施-06 S3 · 20+ 回合压力测试 + 门槛标定 + `symbolsTouched` 决策

> 主题文档：[实施-06](../plan/active/实施-06-上下文管理收尾.md) §2「N21-4 尾」/ §4 切片 S3。
> 出口原文：「压力测试产出一份真实数字；标定结果写进 `DESIGN` / 方案；`symbolsTouched` 要么实现要么明确不做」。

| 六栏 | 证据 |
|---|---|
| 实现 | ① 新探针 [probe/context-pressure.js](../../scripts/probe/context-pressure.js)（跑 22 个真实回合，每轮一条 `seq 1 2000` ≈ 3k token 的工具输出；在渲染端读 pi 的 `contextUsage.tokens` 与 `lastCompaction`，探针内直接断言“维持在工作集附近 / 压缩真的多次发生”）。② 新场景 `contextpressure`（工作集 20000，pi `keepRecentTokens=1`）与低线变体 `contextpressurelow`（工作集 6000）；退出后检查 `checkContextPressure`（[test-live.mjs](../../scripts/test-live.mjs)）只读磁盘：请求诊断条数 / physical 与 abort / 最小余量 / 会话文件里 22 条用户消息与大块原文都在 / 0 条扩展 error。③ **拓出并修掉一个真缺陷**：[shared/context-policy.ts](../../src/shared/context-policy.ts) 新增 `rearmAfterCompaction`，[agent.ts](../../src/main/agent.ts) 在 `setCompaction` 里于**策略发起的压缩成功结束**时重新上膛 —— 原来 `armed` 只能靠“用量回落到工作集 × 0.9 以下”或 5 分钟窗口恢复，而系统提示 + 工具定义的基线开销（本机约 10k）本身就压在工作集线上时，第一条永远不成立。④ 文档：[方案](../design/active/方案-上下文工具内的自动压缩-2026-09-15.md) §12.11 第 10 条 / §12.12 P2 标定表 / §13.1 第 23 条（`symbolsTouched` 不做）/ 剩余限制；[PROJECT.md](../PROJECT.md) 阶段 4 行 |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` / `audit:refs` 干净；单测 **3614/3614**（本片 **+4**：`test-context-policy.mjs` 新增 `rearmAfterCompaction` 一组 —— 未上膛→上膛、幂等、不动 `lastTriggerAt`，以及“即使 tokens 仍高于工作集，重新上膛后过冷却就能再压”）；`node --check` 过 test-live 与探针 |
| 真实运行 | **`contextpressure`（cost 1）全绿**：22 个真实回合、带工具调用 **22/22**、用时 ~2.5 分钟；两次运行 —— **压缩 2–3 次**（20869→1224 / 20964→1096 / 20557→1503；复跑 21162→715 / 21804→829），**usage 峰值 20964–21804 = 工作集的 1.05–1.09×**；退出后 —— 44–52 条请求诊断、**0 次 physical / 0 次 budget-abort**、最小余量 > 985k token、会话文件里 22/22 条用户消息 + 565–581 行大块原文仍在、0 条 error。**`contextpressurelow`（cost 1）全绿**：压缩 **5 次**、峰值 16782（工作集低于基线开销，比率不作判据）。**A/B 反向验证**：临时注掉 `rearmAfterCompaction` 并重构建后重跑低线场景 —— 压缩降到 **1 次**、峰值升到 **46710（7.8×）**、探针断言真的变红；恢复后重跑回到 5 次 |
| 视觉验收 | 不适用 + 原因：本片无界面改动（压力测试与策略上膛都在主进程 / 扩展侧）。已有的上下文设置页与工作集刻度图未受影响 |
| 应用与包 | 不适用 + 原因：新增的是 shared / main 的主进程模块与测试设施，随既有打包链进包；包验收随 **09**（S4/S5）统一做 |
| 剩余限制 | ① 「另跑一次**真实长会话**（默认 240k 工作集、不用测试参数）」**未做** —— 需要一个真的几十万 token 的会话，成本高；登记为剩余项（方案剩余限制）。② 工作集**低于基线开销**时“维持在工作集附近”物理上做不到（压无可压），比率由基线决定 —— 属参数超出策略有效域，已写进 §12.11 的口径修正。③ `episodes.minEntries/minTokens` 未标定（22 回合样本里 episode 候选区始终为空），保留保守初值；`20s` 超时与 `6000` token 硬上限也未标定。④ 两条场景都 cost 1，单场约 2.5 分钟，**未加入 `npm run check`**（门槛里的 cost 1 场景都是 2–3 回合的短回合；压力测试一场 22 回合、两场会让全量门槛再长 5 分钟），作为手动场景运行（TESTING.md 已登记） |

### 本轮（2026-09-19）实施-06 S4（部分）· `compactionstatus` 陈旧场景处置

> 主题文档：[实施-06](../plan/active/实施-06-上下文管理收尾.md) §2 表格最后一行 / §4 切片 S4。
> 出口原文：「二选一：① 改成用 `YAN_CONTEXT_POLICY` 驱动（与 `contexttakeover` 合并成一条）；② 从手动清单降级为说明。**不能两条都留**」。

| 六栏 | 证据 |
|---|---|
| 实现 | **选项 ②**（降级为说明）。场景条目与探针**保留在原处**（[test-live.mjs](../../scripts/test-live.mjs) 的 `CASES.compactionstatus`、`scripts/probe/compaction-status.js`），顶部写明**前提已过期**（pi 0.85.1 不再按 `reserveTokens` 在回合结束自动压）与替代覆盖。选 ② 而非 ① 的理由：① 只是把同一个「阈值自动压缩」换个驱动源再验一次，而砚侧那条链路由 `contexttakeover`（`YAN_CONTEXT_POLICY` 驱动）取证；场景里**独有**的手动压缩成功 / 失败与 D21/D22 的 pi 设置生效值，分别由 `test-compaction-status.mjs`（60+ 条）与 `projectTrustedFrom` 单测覆盖，不值得再烧一次 cost 1 |
| 自动检查 | 本片是**文档 + 测试条目注释**改动，无产品代码改动；`node --check scripts/test-live.mjs` 通过；单测 **3103/3103**（与基线一致） |
| 真实运行 | 不适用 + 原因：处置方式就是「不再跑它」；已有的真实证据保留在归档与 `contexttakeover`（`triggeredBy: policy`、`beforeTokens=31019 → afterTokens=120`）/ `contexttakeoverstate`（`takeover 1 / fallback 0`）里 |
| 视觉验收 | 不适用 + 原因：无界面改动 |
| 应用与包 | 不适用 + 原因：只改仓库内测试设施，不进包 |
| 剩余限制 | **S4 只完成一半**：N21-6 的 `fresh` / `stale-soft` 两档各取一次真实接管（或明确的降级记录）仍需 cost 1 真跑，未做 |

### 本轮（2026-09-19）实施-07 S1 · 非 Git 目录取证 + 三条已知限制复审

> 主题文档：[实施-07](../archive/plan/实施-07-Git与环境菜单收尾-已完成.md) §3「非 Git 目录视觉」/ §5 切片 S1。
> 出口原文：「补一张真实截图（fixture 的 `cwd` 永远是仓库，需要另造状态）」+「复审三个已知限制的文案是否与实现一致」。

| 六栏 | 证据 |
|---|---|
| 实现 | **本片无产品代码改动** —— 非 Git 分支（[EnvironmentMenu.tsx](../../src/renderer/src/components/review/EnvironmentMenu.tsx) 的 `env-notgit`、[ReviewPanel.tsx](../../src/renderer/src/components/review/ReviewPanel.tsx) 的 `review-notgit`、两条 i18n 文案）早已实现，缺的只是取证。设施改动全在 [visual-matrix.mjs](../../scripts/visual-matrix.mjs)：新增两个状态 `envnotgit` / `reviewnotgit`，主进程侧加一个 `stubNonGit` 开关（`yan:git:state` / `yan:git:snapshot` 在该状态下返回 `repo: null`），以及各自的 `MUST_HAVE` 与 `AFTER_STATE` |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` 干净；单测 **3103/3103**（本片未改产品代码，条数不变，重跑确认基线）；`node --check scripts/visual-matrix.mjs` 通过；`audit:refs` 通过。视觉矩阵本批次**组 0/1/4 全绿、溢出 0px**，关键元素硬断言都在（`env-notgit` / `review-notgit` / `env-menu` / `review-panel` / `review-scope`） |
| 真实运行 | 不适用 + 原因：这是**视觉取证片**。非 Git 目录的数据层（`git-service` 的 `findRepo` 返回 `null`）与文案覆盖已有单测与审阅；本片补的正是「没有真实窗口截图」这一条，故以视觉矩阵为准 |
| 视觉验收 | **5 张截图，逐张已看图**：`matrix-envnotgit-1440x900-100-{dark,light}-2026-09-19g1.png`、`matrix-reviewnotgit-1440x900-100-{dark,light}-2026-09-19g1.png`、`matrix-envnotgit-900x520-100-dark-2026-09-19g1.png`。环境菜单：「未使用 Git / 这个目录不在 Git 仓库里」，**没有**变更数 / 分支 / 写操作入口；审查面板：「未使用 Git —— 这个目录不在 Git 仓库里，没有改动可审查」+ 右侧「没有匹配的文件」。窄窗同样 0px 溢出 |
| 应用与包 | 不适用 + 原因：本片只改截图脚本（不进包），未改打包配置与资源 |
| 剩余限制 | ① 视觉矩阵用的是**合成数据**，证明的是「界面在 `repo: null` 时的形态」，不是「真实非 Git 目录下主进程返回什么」（后者归数据层与单测）；② 试验记录：起初把 `session.cwd` 改成另一个目录来造非 Git 状态，结果渲染端挂住（矩阵的 `executeJavaScript` 再也不返回）—— 改用主进程开关后正常。这只是**截图设施的坑**，不代表产品在真实切 cwd 时会挂（那里走的是完整切会话链路） |

**三条已知限制的文案与实现复审**（[实施-07 §4](../archive/plan/实施-07-Git与环境菜单收尾-已完成.md)）：

| 限制 | 复审结论 |
|---|---|
| 「来源」菜单不显示「已读取」与「本轮已参与上下文」 | **一致**：`SourceMenu.tsx` 顶部注释写明这是有意的（方案 §8「证据不足时不显示」）；i18n 里只有 `src.linked`（已关联），没有「已读取」这类键 |
| 「已查看」存在渲染端 `localStorage`，键含仓库 / 工作树 / 范围 / 两侧内容指纹 | **一致**：`useViewedStore` 读写 `localStorage`；`viewedKey()` = `repoId` / `worktreeId` / `scope` / `path` / `oldPath` / `oldFingerprint` / `newFingerprint` 拼接 |
| 展开上下文一次最多 300 行 | **一致**：`DiffViewer` 的 `MAX_GAP_LINES = 300`，`shown = min(count, 300)`，剩余行用 `review.gapMore` 提示还有多少 |

### 本轮（2026-09-19）实施-04 S5 · 联网发现（候选 / 排名 / 接入计划）

> 主题文档：[实施-04](../plan/active/实施-04-能力自主选择-MCP与Skill.md) §7.2 / §8。
> 出口原文：「**真实目录检索证据**（不能只用 fixture 断言排名）」。
> 证据单独成文：[证据-04-S5-联网发现](../archive/evidence/证据-04-S5-联网发现.md)。

| 六栏 | 证据 |
|---|---|
| 实现 | **新增** [shared/discovery.ts](../../src/shared/discovery.ts)（候选 / 计划契约、**检索词脱敏**、排名、截断、稳定指纹、计划生成）；[capabilities/discovery/discover.ts](../../src/main/capabilities/discovery/discover.ts)（两个适配器 + 编排：并行、单源失败不影响另一个、每源最多两页、候选最多八项）；[agent.ts](../../src/main/agent.ts) 新增 `capabilities.discover` / `capabilities.prepare`（候选只由宿主缓存 10 分钟，模型只能回传 ID）；[yan.mjs](../../resources/yan-cli/yan.mjs) 补用法与 `required.prepare` |
| 自动检查 | 单测 **3103/3103** 全绿（新增 46 条：脱敏 10、排名 5、截断与上限 3、适配器映射 10、失败路径 8、指纹与计划 8）；`typecheck` / `build` 干净 |
| 真实运行 | **新场景 `discnet`（cost 0，已进 check）全绿**：真 CLI → 真宿主 → **真目录**。实测两个源各返回 **40 条**（2 页 × 20）—— 不是「源可达但 0 条」；候选标 `metadata-only`、带可回溯来源；`prepare` 生成固定版本的 `needs-authorization` 计划；未知候选 / `acquire` 都回可读的非零退出。**离线时如实跳过**（与 `probe:chrome` 同一口径），不假装验过 |
| 视觉验收 | 不适用 + 原因：本片无渲染端改动（发现结果只在 API 层，没有候选列表 UI） |
| 应用与包 | 本片未新增依赖（用全局 `fetch`）与资源，未重跑打包；S3/S4 的打包结论不受影响 |
| 剩余限制 | ① 只有**两个目录源**（官方 MCP Registry + npm），且它们的 `search` 都是偏精确匹配（长句会搜不到）；② 候选**不缓存到磁盘**（同一轮内不重复请求，跨轮重新拉）；③ `sources` 的 endpoint / 认证 / 缓存期限**还不能配置**（§7.2 要求可配置）；④ 每轮「两次查询改写」目前是**上限常量已就位、自动改写未实现**（模型自己改写检索词）；⑤ 联网发现**没有界面**（§11 属 S7）；⑥ MCP 候选的认证一律 `unknown`（registry 不声明）；⑦ `acquire` 仍是明确的 `not_implemented`（S6） |

**两条实测教训**：

1. **「源 ok」不等于「查到了东西」。**
   第一版检索词 `filesystem storage tools` 在 npm 拿到 40 条、在 MCP Registry 拿到 **0 条** ——
   它的 `search` 偏精确匹配。所以断言必须分开写：源可达 + 该源 `candidateCount > 0`，
   否则一个永远返回 0 条的源也能让场景全绿。
2. **回执会落盘，stdout 只是摘要。**
   候选一多，`yan` 就把完整 data 写进 `resultFile`。探针不读它就会拿到
   `{ok, operationId, summary, resultFile}` 这层壳，然后把「没读到」当成「离线」。

### 本轮（2026-09-19）实施-04 S4 · 模型自主发现 MCP 工具（发现 → describe → call）

> 主题文档：[实施-04](../plan/active/实施-04-能力自主选择-MCP与Skill.md) §12 S4。
> 出口原文：「工具**不直接出现在初始 prompt 也能用**」。

| 六栏 | 证据 |
|---|---|
| 实现 | [catalog.ts](../../src/main/capabilities/catalog.ts) 新增 `McpCatalogEntry` / `mcpToolCapability`，`buildCatalog` 接第二个参数（MCP 工具进目录，id = `mcp:<server>/<tool>`）；[connection-manager.ts](../../src/main/mcp/connection-manager.ts) 新增 `listServerIds()` 与 **TTL 工具表缓存** `listToolsCached`（断线 / schema 变更即失效，否则会拿到过期 schema）；[agent.ts](../../src/main/agent.ts) 新增 `collectMcpCatalog()` 与 `withCatalogTimeout()`（**3s 硬超时** —— 不能因为一个服务挂着就把整次 search 拖死），`capabilities search` 回执新增 `mcpServers` 状态段与 `schemaRevision`；stdio fixture 新增 `compute` 工具（**BigInt** 计算 + 服务端写 MARKER 物证） |
| 自动检查 | 单测 **3059/3059** 全绿（新增 15 条 MCP 目录断言：§13.1「**两个同名工具不合并**」、缺描述也要补齐归属、effect 默认 `unknown`、schemaRevision 透传、location 是可直接执行的命令形状）；`typecheck` / `build` 干净 |
| 真实运行 | **cost 1 场景 `capmcp` 9/9 全绿**（新场景）：提示词**不含服务名 / 工具名 / MCP 字样**，模型自己 `yan --help` → `yan capabilities search`（命中 `mcp:fixture/compute`）→ `yan mcp describe`（拿到 `schemaRevision`）→ `yan mcp call`；回复给出 `121932631112635269`，且**服务端 MARKER 文件**留下 `compute:mul:121932631112635269`。两条证据同时成立才算过 —— 回复里的数字可能是模型编的 |
| 视觉验收 | 不适用 + 原因：本片无渲染端改动（`mcpServers` 状态段还没进 UI） |
| 应用与包 | 本片未新增依赖 / 资源（只加 TS 代码），未重跑打包；S3 已验证 SDK 内联进 `out/main`，本片改动在该 bundle 内部 |
| 剩余限制 | ① 目录收集**每次 search 都连服务**（只有 60s TTL 缓存，不是常驻）；② MCP 工具 `effect` 一律 `unknown`（没有「受信配置声明效果」的通道）；③ `mcpServers` 状态段只在 API 里，**渲染端没有展示**；④ 多了服务时会并行收集，但总超时下仍可能漏列慢服务的工具；⑤ 联网发现（S5）未开工 |

**一条实测教训**：

- **模型的第一动作是 `--help`，不是搜索。**
  `capmcp` 的 bash 序列是：`yan --help` → `yan capabilities --help` → `yan capabilities search` →
  `yan mcp --help` → `yan mcp describe` → `yan mcp call`。
  也就是说 **用法文案本身就是发现链的第一环** —— 命令在用法里写不清，模型就会走错路，
  而它在单测里永远看不出来（单测直接调函数，不经过 help）。

### 本轮（2026-09-19）实施-04 S3 · MCP 连接（stdio + HTTP）

> 主题文档：[实施-04](../plan/active/实施-04-能力自主选择-MCP与Skill.md) §4（目录契约）、§5（MCP 接入）。
> S1 预检已核实 **pi 完全不内置 MCP**（文档 / 依赖树 / bundle 归属 / CLI+RPC 面四条证据），
> 所以连接必须由砚自建；本片落地 stdio 与 HTTP 两条传输的真连接。

| 六栏 | 证据 |
|---|---|
| 实现 | **新增** [`src/shared/mcp.ts`](../../src/shared/mcp.ts)（稳定 ID `mcp:<server>/<tool>`、参数最小校验、schema 指纹、工具错误 vs 协议错误分类）；[`src/main/mcp/config.ts`](../../src/main/mcp/config.ts)（宿主文件 `YAN_DIR/mcp-servers.json`，坏条目跳过**并报原因**）；[`src/main/mcp/connection-manager.ts`](../../src/main/mcp/connection-manager.ts)（懒连接 + 并发去重 + 硬超时 + **跟随分页** + 断线复位 + `close()`）；[`src/main/mcp/tool-service.ts`](../../src/main/mcp/tool-service.ts)（describe / call、`invalid_arguments` / `schema-changed` / `tool_not_found`、大结果落盘、`toolError`）。**改** [agent.ts](../../src/main/agent.ts)（`mcp.describe/call` 接线 + stop 时关连接管理器）、[yan.mjs](../../resources/yan-cli/yan.mjs)。**新增依赖** `@modelcontextprotocol/sdk@1.30.0`（`--save-exact`：先验 API 再固定） |
| 自动检查 | 单测 **3047/3047** 全绿（本片新增两组：契约纯逻辑 + **真连** stdio fixture 与 **真连 HTTP fixture**）；`typecheck`（含 CSS 约定 / layer 自检）/ `build` 干净 |
| 真实运行 | **新场景 `mcpcli`（cost 0，已进 check）全绿** —— 真 CLI → 真宿主 → **真 MCP 服务**（官方 SDK stdio server，`scripts/lib/mcp-stdio-fixture.mjs`）：`describe` 给出 `schemaRevision` 与完整 `inputSchema`；正常 `call` 回结果；**工具级失败是 `toolError:true` 的结果而不是崩溃**（命令仍退出 0，不吐堆栈）；`invalid_arguments` / `schema-changed` / `tool_not_found` 三类错都可读可分支；大结果落盘并回报 `resultFile` 与字节数。**HTTP 在单测里真起服务**（`StreamableHTTPServerTransport`，随机端口 + TCP 轮询就绪）：listTools / callTool / 工具错误均验 |
| 视觉验收 | 不适用 + 原因：本片**无渲染端改动**（MCP 的设置界面属 §11 / S7），没有新增可见状态 |
| 应用与包 | **`dist:dir` + `test:packaged` 全绿**（含新增 4 条 MCP 断言：用法可发现、无宿主时报**可读原因**且不吐堆栈）。⚠️ 本片修掉一个**只在打包态才会暴露的真缺陷**：`electron-builder.yml` 的 `!node_modules/**` 加上 `externalizeDepsPlugin()`，会让 externalize 的 SDK **根本不进包** —— 而它是 **ESM 静态 import**，装出来的应用主进程会**直接起不来**（不是功能降级）。修法：`externalizeDepsPlugin({ exclude: ['@modelcontextprotocol/sdk'] })`，把它 bundle 进 `out/main`（633KB → 1333KB） |
| 剩余限制 | ① 只做了 **stdio + HTTP** 两条传输；OAuth / `authRef` 只是配置字段，**取凭证的链路未实现**；② MCP **没有界面**（设置页「能力」页属 §11 / S7）；③ 连接是**按需**的，没有保活 / 后台重连（断了等下次调用重连）；④ 工具表**不缓存**（每次 describe 重拉）；⑤ SDK 的旧版 SSE 传输未接；⑥ **packed 态真连 MCP 未单独验** —— 间接证据是主进程启动成功（SDK 已内联）。dev 态真连由 `mcpcli` + 单测覆盖 |

**两条实测教训**：

1. **引入 main 侧第一个运行时依赖，会连带改到三处构建面。**
   `out/test/agent.mjs`（esbuild 打包 agent.ts）必须把 SDK 设为 `external` ——
   否则 CJS 依赖（cross-spawn）内联进 ESM 会抛
   `Dynamic require of "child_process" is not supported`（这正是选择
   「electron-vite 侧 bundle、esbuild 侧 external」的依据：两边对 CJS 互操作的处理不同）。
2. **无状态 HTTP 的每个请求都要新建 server + transport。**
   共用一份 transport（`sessionIdGenerator: undefined`）会直接 **500** ——
   首次冒烟就踩到了；fixture 现在每次请求新建，与官方示例一致。
3. **探针不许把中间文件落在工作区。**
   首跑 `mcpcli` / `capsearch` 各自在仓库根丢了一批 `mcp-*.json` 与
   `capability-probe.txt` —— 它们看着像「待提交的新文件」，会污染每个后续代理的
   `git status`。现在探针用 node 算 `os.tmpdir()` 写临时目录（`$TEMP` 在 pi 的
   bash 通道里**不保证被展开**，实测直接失败），技能正文也改成「系统临时目录」。

### 本轮（2026-09-19）实施-04 S2 · 能力目录与已装 Skill（`yan capabilities search` / `yan skill read`）

> 主题文档：[实施-04](../plan/active/实施-04-能力自主选择-MCP与Skill.md) §4（能力目录契约）、§6（Skill 发现 / 选择 / 执行）。
> 上一片 S1 是**零代码**技术预检（[证据-04-S1](../archive/evidence/证据-04-S1-技术预检.md)）：运行时 pi 0.85.1、RPC 33 命令、
> **无**工具面 / **无** MCP 面 / **无**技能正文面。这一片只做**已装范围**的目录与按需读正文；
> 联网发现（S5）与 MCP（S3/S4）仍未开工。

| 六栏 | 证据 |
|---|---|
| 实现 | **新增** [`src/shared/capabilities.ts`](../../src/shared/capabilities.ts)：`Capability` 契约（kind / availability / effect / source / projectScope / schemaRevision）+ 纯逻辑（词法切分、打分、项目隔离、**稳定排序**、同 ID 去重与冲突、描述质量门）。**新增** [`src/main/capabilities/catalog.ts`](../../src/main/capabilities/catalog.ts)：13 条内置能力（`yan` 命令族，每条写适用目标与**可直接执行**的 location）+ 组装去重。**新增** [`src/main/capabilities/skill-service.ts`](../../src/main/capabilities/skill-service.ts)：从 pi `get_commands` 投影技能、frontmatter 剥离、路径边界、按需读正文 + sha256。**改** [`src/main/agent.ts`](../../src/main/agent.ts)：`rawCommands()`（读 pi 原始命令面）+ `capabilities.search` / `skill.read` 实现 + `scope` 校验。**改** [`resources/yan-cli/yan.mjs`](../../resources/yan-cli/yan.mjs)：`capabilities` / `skill` 分组的用法表与动作表 |
| 自动检查 | 单测 **3006/3006** 全绿（新增两组：能力目录纯逻辑 + 技能服务**真文件**读写 —— 项目隔离 / 稳定排序 / 冲突去重 / 空描述门 / frontmatter（正文里的 `---` 不被吃）/ `..` 逃逸拒绝 / 正文变化 → hash 变化）；`typecheck`（含 CSS 约定 / layer 自检）/ `build` 干净 |
| 真实运行 | **新场景 `capcli`（cost 0，已进 check）全绿 22 条** —— 真 CLI → 真 `CapabilityServer` → 真技能文件：`search` 命中技能（`considered: 14` = 13 内置 + 1 技能）、`kind/availability/owner/effect` 与 SKILL.md 绝对路径都对、`skill read` 回 **sha256 contentHash** 与正文（含技能里独有的标记）、错误四类（不存在的技能 / 不支持的 scope / `discover` 回 `not_implemented` / 打错子命令）**都可读且可分支、不吐堆栈**。**新场景 `capsearch`（cost 1，deepseek-v4.1-flash）全绿** —— 提示词**不给命令名也不给技能名**：模型自己找到 `yan` 入口 → 敲 `yan capabilities search`（拿到 ok 回执）→ 读到技能正文 → 按正文产出回执（标记只存在于技能文件里）。回归：`capabilityload` / `slashcmd` 未受影响 |
| 视觉验收 | 不适用 + 原因：本片**没有渲染端改动**（能力目录还没有界面；设置页「能力」页属 §11，未开工），无新增可见状态可截 |
| 应用与包 | 不适用 + 原因：未改打包配置。`yan-cli` 早就在 `extraResources`（01-S4b 已验）；本片只是在既有启动器里多两条分组用法，随包分发路径未变 |
| 剩余限制 | ① **只覆盖已装 / 已加载范围** —— `capabilities.discover/prepare/acquire` 与 `mcp.describe/call` 仍回 `not_implemented`（S3–S6）；② 内置能力清单是**静态维护**的 13 条，新增 `yan` 命令时必须同步，否则目录里查不到（`KNOWN_COMMANDS` 与它有重叠但**不是**同一份真源）；③ 技能 `owner` 一律记 `user` —— pi 的 `get_commands` 给了 `scope: user\|project`，但没进 `CommandDescriptor`，本片未细分；④ 同名技能去重是「先到先得 + 报告 conflicts」，没有让模型按来源选的交互（§4 的「用稳定 ID 选择」只做到 ID 唯一化）；⑤ 技能声明的依赖缺失 **未解析**（`missing-dependency` 只是契约里的枚举值，没有生产者）；⑥ `schemaRevision` 在契约里预留但 S2 没有产生者（技能无参数 schema） |

**两条实测教训（已钉进回归断言）**：

1. **pi 把技能路径放在 `sourceInfo.path`，不在顶层 `location`。**
   早期版本用 `command-registry` 归一化过的 `CommandDescriptor`（只读顶层 `location`），
   结果**全部技能被当成「没有路径」丢掉** —— 目录里只剩 13 条内置能力，`considered` 恒等于内置条数
   （首跑 `capcli` 的红就是它：`ids` 里一条 `skill:` 都没有）。现在 `skill-service` 直接读 pi 的原始条目。
2. **模型读完技能正文走的是 pi 原生 `read` 工具，不会主动敲 `yan skill read`。**
   这不是缺陷，是 [证据-04-S1](../archive/evidence/证据-04-S1-技术预检.md) §4.3 记录的两条官方路径之一
   （system prompt 里就给了 SKILL.md 的绝对路径）。所以 `yan skill read` 的价值是
   **确定性入口 + contentHash + 来源追踪**，不是「模型读技能的唯一方式」；
   两片的分工照 `browsercli`（cost 0 验链路）/ `browserclimodel`（cost 1 验模型行为）来切。

### 本轮（2026-09-19）实施-05 S5b-3a · 交接事务状态机与事务日志

> 主题文档：[实施-05](../archive/plan/实施-05-工作模式与长任务续接-已完成.md) §8（事务状态机的七步与崩溃恢复）与 §10 的 S5 行。
> S5b-2 把包准备好了；这一片把「包准备好之后怎么走」变成可恢复的事实。
> ⚠️ **本片只做状态机与日志，不接建会话 / 切活动段 / 发消息**（那是 S5b-3b，
> 且 §7 明写「先完成真实长任务验证后再开启默认值」—— 默认是否自动交接需要用户拍板）。

| 六栏 | 证据 |
|---|---|
| 实现 | **状态机** [`shared/handoff-transaction.ts`](../../src/shared/handoff-transaction.ts)：阶段 `pending → snapshot → validated → destination-created → committed → resumed`（+ `failed`）；`canAdvance`（固定顺序：不许跳步 / 不许倒退 / 终态不再前进；**硬前提**：没有包不能 `validated`、没有目的会话不能 `destination-created`/`committed`）；`advance`（幂等 + 步进日志）；`attachDestination`（**锁定**：换另一个目的会话则拒，已提交后不许再改 —— 那会把用户指向一个没有任务上下文的会话）；`attachPackage`（只挂一次；`snapshot` 阶段拿到包顺手前进到 `validated`）；**`recoveryAction`**（§8 第 6/7 条：`committed` + 有磁盘证据 → `complete`；无证据 → `resend`（消费去重挡住重复）；`destination-created` 及更早 → `abandon` 回源）；`transactionSummary`。**日志** [`main/handoff-transaction-service.ts`](../../src/main/handoff-transaction-service.ts)：`YAN_DIR/handoff-transactions.json`（按 `handoffId` 索引 —— 一次交接连着源与目的两个会话，不能用会话键）；`begin`（幂等）/ `step` / `setDestination` / `setPackage` / `get` / **`activeForSession`**（源或目的任一侧）/ **`openTransactions`**（崩溃恢复的输入）；串行队列 + 原子写 + **落盘失败抛并回退内存态**；trim **只丢已终结**的事务（丢掉未终结的等于把「下次启动该恢复什么」一起丢了）|
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` 干净；单测 **3506/3506**（本片 **+59**：阶段顺序与硬前提 12 / 推进与幂等 5 / 目的会话锁定 5 / 包与自动前进 4 / **崩溃恢复全矩阵** 8 / 事务日志 12（幂等 begin / 跳步被拒 / 每步落盘 / 重启读回 / activeForSession 两侧 / 终态退出 / 脏文档丢弃 / 坏 JSON / 落盘失败抛））|
| 真实运行 | 不适用 + 原因：**这一层没有任何外部动作**（不建会话、不切活动段、不发消息），所以没有可跑的真实链路 —— 它存在的意义正是把那些动作的顺序与恢复先钉死。现有真实链路未受影响（本片未改任何既有调用路径，只新增两个模块 + 单测注册）。**取证安排**：接线（S5b-3b）时用 `handoffpack` 场景 + 测试通道跑一次完整交接，那时恢复矩阵才有活体证据 |
| 视觉验收 | 不适用 + 原因：无渲染端改动（事务还没有界面入口；§9 的「已续接至」已被用户口径改成「前端一条会话」，见 S5b-1/S5b-4）|
| 应用与包 | 不适用 + 原因：未改打包配置与依赖；`handoff-transactions.json` 只在真的开始交接时写入（默认零占用），与其它 store 同一套原子写 |
| 剩余限制 | ① **未接线**（S5b-3b）：真实链路还不会开始事务 —— `begin/step` 还没有调用方，`runners.ts` 的同 cwd 执行租约也未接；② **默认是否自动交接未定**：§7 要求「先完成真实长任务验证后再开启默认值」，需要用户拍板（与 S5c 的开关同一类问题）；③ **消费证据的口径已定但未实现**：`resumed` 必须由目的会话 JSONL 里那条 resume 驱动，而「怎么认那条消息」要等接线时与 `session-reader` 对齐；④ `steps` 上限 40 条（超过丢最旧）—— 足够诊断，但不适合当完整审计日志；⑤ `MAX_TRANSACTIONS = 200` 且只丢已终结事务，极端情况下未终结事务会堆积（现实中一个会话同时只能有一条）|

### 本轮（2026-09-19）实施-05 S5b-2 · 交接包由模型生成

> 主题文档：[实施-05](../archive/plan/实施-05-工作模式与长任务续接-已完成.md) §8（交接包与事务）与 §10 的 S5 行。
> 用户 2026-09-19 拍板：交接包**由模型写**（一次额外模型调用），宿主只给提示与校验。
> 上一片（S5b-1）建好了会话链数据层；这一片把「包从哪来」接上。

| 六栏 | 证据 |
|---|---|
| 实现 | **契约** [`shared/handoff.ts`](../../src/shared/handoff.ts)：`HANDOFF_SYSTEM_PROMPT` / `HANDOFF_PACKAGE_MAX_TOKENS` / `HandoffRequest` + `sanitizeHandoffRequest` / `HandoffResult` + `sanitizeHandoffResult` / **`parseHandoffOutput`**（去围栏 + **括号平衡扫描**取第一个完整对象 —— 「第一个 `{` 到最后一个 `}`」在模型多吐一句时会把两份 JSON 连起来而整份失败）/ `handoffFileKey`（与薄层 `safeKey()` **交叉校验**）/ `HANDOFF_REQUEST_TTL_MS`；`handoffEligibility` 新增 `threshold` 覆盖（默认仍是常量）。**存储与文件交换** [`main/handoff-service.ts`](../../src/main/handoff-service.ts)：`handoffRequestPath` / `handoffResultPath`（`YAN_DIR/handoff-request|result/<runnerId>.json`）、`buildHandoffRequest` / `buildHandoffResult`、`HandoffRequestStore`（原子写、脏 JSON 当没有、清请求/结果；**无内存态** —— 写方是另一个进程）。**薄层** [`resources/pi-extensions/handoffs.js`](../../resources/pi-extensions/handoffs.js)（新，约 170 行）：`agent_settled` 时读请求 → TTL 检查 → operationId 幂等 → `ctx.modelRegistry.complete(...)` → 写结果（**无论成败都写**）。**接线** [`main/index.ts`](../../src/main/index.ts)：`maybeArmHandoff`（忙则早退 + 1s 节流 → 资格判定 → 渲染提示词 → 写请求 → 1s 轮询结果）/ `collectHandoffResult`（三道闸门：id 对得上 → 能解析 → 清洗过；不过就丢掉并告知用户，**不把半份包写进事务**）/ `abandonHandoff`（90s 超时清现场）；触发点两处：压缩完成（`observeCompaction`）与**回合结束**（`state` 推送里 `isAgentRunning === false` —— `goal report` 发生在回合中途，那一刻实例是忙的，资格会正确地拒掉）；只读 `yan:getHandoff`（`HandoffView`）+ preload。`agent.ts` 加载新扩展（`--extension handoffs.js`） |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` / `audit:refs` 干净；单测 **3447/3447**（本片 **+69**：文件名清洗与薄层**真·交叉校验** 9 / 请求契约 13 / 结果契约 4 / 模型输出解析 10（含围栏 / 前后夹话 / 多个对象 / 数组 / 半截 JSON）/ 阈值覆盖与资格 8 / 真目录上的文件交换 9（含半截文件、跨实例可见、清理）/ **全链路（无模型）** 8（请求 → 结果 → 解析 → 清洗 → 落盘 → 重启读回）） |
| 真实运行 | **新场景 `handoffpack`（cost 1，已登记 `CASES`，固定 `deepseek/deepseek-v4.1-flash`）全绿**：自主档 + `yan goal report`（让「目标在推进」成立）+ `YAN_HANDOFF_THRESHOLD=0` → 回合结束后宿主判资格并写请求 → 探针用 `yan:getHandoff` 等到包出现：`goal` / `deliverable` 两栏非空、`generator=model`、`sourceSession` 指回会话文件、`sourceHead` 有值、`mode=autonomous`。`afterExit: handoffPackPersisted` 再核对磁盘：包真的在 `handoffs.json` 里、八个列表栏都是数组、**计数仍是 0**（阈值覆盖不改计数）、`handoff-request/` 与 `handoff-result/` **已清空**；扩展日志给出决定性时间线 —— `check hasRequest:false` → `check hasRequest:true` → **`produced ms=4753 chars=1203 error=null`**（证「薄层真的调了一次 completion」，而不是文件交换假装成功）。**回归**：`contexttakeover`（cost 1，真实压缩：计数照常 `count=1`、阈值 2 下**没有**误 arm 交接包）、`live` / `workmode` / `sessions` / `autocontinue`（cost 0）全绿 |
| 视觉验收 | 不适用 + 原因：本片**无渲染端改动**（`yan:getHandoff` 只给探针与后续 S5b-4 用，界面还没有「交接」入口）；用户在生成期间会看到一条 `notify`（「正在为跨会话交接写一份交接包…」/「交接包已生成：…」） |
| 应用与包 | 不适用 + 原因：未改打包配置；`handoffs.js` 在随包 `resources/pi-extensions/`（整目录随包）；请求 / 结果文件都是**短命**的（生成完即清），`handoffs.json` 里的包只在真的发生时写入 |
| 剩余限制 | ① **事务未做**（S5b-3）：包写好了但还不会建目的会话、不会 `link` 会话链 —— 目前只是「把包准备好」；② **界面看不到**（S5b-4）：`yan:getHandoff` 已经有了，但侧栏 / 详情页没接；③ **失败不自动重试**：解析失败 / 缺栏就丢掉并告知用户（宁可重做，不要半份包），要重做需下次资格成立；④ 提示词里的「最近用户消息」取的是**界面历史**（压缩过的会话只剩尾巴），没有从 JSONL 重读全量；⑤ `sourceHead` 用的是界面消息 id（与 pi 的 entry id 不同域），S5b-3 要比对水位时要注意同一口径；⑥ `YAN_HANDOFF_THRESHOLD` 是测试通道（生产不该设）—— 文档与注释里都标了，但没有运行时告警 |

### 本轮（2026-09-19）实施-05 S5c · 模型出错后的自动继续

> 主题文档：[实施-05](../archive/plan/实施-05-工作模式与长任务续接-已完成.md) §5（末尾 S5c 段）与 §10 的 S5c 行。
> 需求原话：「有时候模型会报错」（界面停在一行红色的「模型返回错误」），要一个**自动继续**。
> 与 S3b / S3c 的关系：那两个治的是「模型报告了进展之后接着干」，这一个治的是
> **模型压根没回话** —— 两条触发源、两个消息标签，必须各证各的。

| 六栏 | 证据 |
|---|---|
| 实现 | **契约** [`shared/auto-continue.ts`](../../src/shared/auto-continue.ts)：`classifyModelError`（额度 / 限流、认证 / 权限、上下文超限、用户取消**四类拦下**，认不出的当可重试 —— 有上限与退避兜着时这个方向的错判成本更低）/ `AUTO_CONTINUE_LIMIT = 3` / `AUTO_CONTINUE_DELAYS_MS = [3s, 10s, 30s]` / `planAutoContinue`（**用户停止优先** → 不值得重试 → 到上限 → 继续）/ `retryResumeSummary`（custom 消息正文，必须提醒「**先检查再动手**」防重复副作用）/ `isDuplicateError`（2 秒窗口，两个来源会同时报同一件事）/ `sanitizeAutoContinueOptions`（`YAN_AUTO_CONTINUE` 测试通道）。**存储** [`main/auto-continue-service.ts`](../../src/main/auto-continue-service.ts)：`YAN_DIR/auto-continue.json`（按会话文件路径、串行队列、原子写、落盘失败抛并回退内存态；计数语义 = 继续 +1 / 到上限保持 / 不值得重试归零）。**触发源** [`agent.ts`](../../src/main/agent.ts)：新推送通道 `agent-error`（`auto_retry_end {success:false}` 带 `finalError`；assistant `stopReason === 'error'` 带空文本）—— [`shared/ipc.ts`](../../src/shared/ipc.ts) 的 `MainPush` 新增成员，**不靠匹配提示文案**（改一句文案就静默失效）。**接线** [`index.ts`](../../src/main/index.ts)：`handleModelError`（分类 → 计数 → 不重试只提示 / 可重试则提示 + 安排）/ `scheduleAutoContinue`（`setTimeout` 退避后写 `kind=retry` 续行快照；带 token 防「取消之后还是发了」）/ `resetAutoContinue`（用户发言 `yan:send`、用户停止 `yan:abort`、一轮真的产出 `msg-update` 三处归零）；定时器 `unref()` 不阻退出。**薄层** [`pi-extensions/goal-resume.js`](../../resources/pi-extensions/goal-resume.js)：`kind → customType` 映射新增 `retry → yan-auto-continue`（无 `kind` 的旧快照仍当 `ready`）。**新场景** [`probe/auto-continue.js`](../../scripts/probe/auto-continue.js) + [`test-live.mjs`](../../scripts/test-live.mjs) 的 `autocontinue`（通用 `env` 字段：`YAN_AUTO_CONTINUE` 把退避压到 1.2s）与 `afterExit: autoContinuePersisted` |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` 干净；单测 **3378/3378**（本片 **+79**：错误分类（中英关键词 / 优先级 / 保留原文）、计划与退避（三次推进 / 到上限 / 四类不值得重试 / 用户停止优先 / 覆盖值）、续行正文、重复上报去重、env 覆盖解析、存储（幂等去重 / 计数推进 / 到上限保持 / 归零 / 重启不忘记 / 脏值降级 / 落盘失败抛）） |
| 真实运行 | **新场景 `autocontinue`（cost 0，已登记 `CASES`）全绿** —— 模型名故意写坏（`deepseek/deepseek-s5c-nonexistent`）：pi 不拒启动（只 warn），上游回 400（**请求被拒，不产生用量**），错误文本不含额度 / 认证 / 上下文关键词 → 判可重试。探针先关掉 pi 自带重试（`setAutoRetry(false)` —— 验的是砚这一层），然后**只发一条**消息：3 条标错助手（初次 1 + 自动继续 2）、**全程用户消息只有 1 条**、收尾后不在流式中。`afterExit: autoContinuePersisted`：`auto-continue.json` 计数 **`attempts=2`（停在上限，没有无限重试）**、会话里 2 条 `yan-auto-continue`（角色不是 user，且**没有**混入 `yan-goal-ready` / `yan-goal-continue` —— 触发源没搞错）、`goal-resume/r1.consumed.json` 有 operationId、扩展日志两条 `kind=retry` 的 `resume_sent`。**回归**：`goal`（S3b，cost 1，deepseek 一闪）+ `goalloop`（S3c，cost 1）+ `workmode` / `live` / `sessions`（cost 0）全绿。**一条实测教训**：`goal` 首跑红（0 次 `bash`、助手文本空）—— 是**免费模型侧偶发**没调工具，重跑即绿，与本片改动无关；这正好说明「模型侧不稳」是常态，S5c 要治的就是它 |
| 视觉验收 | 不适用 + 原因：本片**无渲染端改动**，复用已有的 `notify` 提示通道（「模型出错（原因），3 秒后自动继续（第 1/3 次）」/「连续 3 次都没成功，已停止自动继续」）；**也没有新增设置开关**（默认开，见剩余限制①）—— 所以没有新的可见状态可截 |
| 应用与包 | 不适用 + 原因：未改打包配置；`auto-continue-service.ts` 在应用代码内（`src/main`，随包天然包含）；`auto-continue.json` 只在真的发生错误时写入（默认零占用），与其它 store 同一套原子写 |
| 剩余限制 | ① **没有界面开关**：默认开，上限与退避是常量（`YAN_AUTO_CONTINUE` 只在测试里用）—— 要「一键关掉自动重试」得进设置页（与 `autoRetry` 开关同一处），未做；② **只看 `stopReason` / `auto_retry_end`**：模型正常结束但**内容为空**（免费模型常见）不算错误 —— 有意保守（空回复可能是「无话可说」），但那一类仍会停在那里等用户；③ 分类靠关键词：认不出的错误会被当可重试（上限 3 次兜着），未来供应商换文案需要补词表；④ 到上限后**只有提示**，没有「再试一次」按钮（用户发一句话即重新计数）；⑤ 退避期间关掉应用 → 那一次自动继续就没了（定时器不落盘；重启后下一次错误重新计数）；⑥ 探针用的坏模型是 **400 类**错误，「上游 5xx / 网络断开」只有单测与分类覆盖（真造 5xx 需要可控的假上游，不在本片范围）|

### 本轮（2026-09-19）实施-05 S5b-1 · 会话链数据层（后台多段、前端一条）

> 主题文档：[实施-05](../archive/plan/实施-05-工作模式与长任务续接-已完成.md) §9（已按用户口径改写）与 §10 的 S5 行。
> 用户 2026-09-19 拍板（原话）：「**会话在后台切为两份，但是在砚的前端显示为同一段会话**」——
> 这条**覆盖**了 §9 原先的「源会话显示已续接至… / 新会话显示接续自…」。

| 六栏 | 证据 |
|---|---|
| 实现 | **新** [`shared/session-chain.ts`](../../src/shared/session-chain.ts)：段（`SessionSegment`）/ 链（`SessionChain`）/ `normalizeChainKey`（与 `main/work-mode-service.ts` 的 `normalizeSessionFileKey` **同语义**，单测交叉校验）/ `createChain` / `appendSegment`（幂等、只向后接）/ `chainRepresentative`（代表 = 最后一段）/ `chainForFile` / **`isRepresentative`**（旧段在侧栏不显示）/ **`planHistoryRead`**（读历史按段从旧到新）/ `sanitizeSessionChain(s)`（一个段只属于一条链）/ `chainSummary`。**新** [`main/session-chain-service.ts`](../../src/main/session-chain-service.ts)：`YAN_DIR/session-chains.json`（旁挂关系，**不改写任何 JSONL**）、`link(from, to, handoffId)`（四种情形：链上追加 / 首段建链 / 目标已属另一条链则拒 / 键不可用返 null）、`isRepresentative` / `representativeOf`（发送目标 = 代表段）、串行队列 + 原子写 + 落盘失败抛。**新** [`scripts/test-session-chain.mjs`](../../scripts/test-session-chain.mjs) |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` / `audit:refs` 干净；单测 **3299/3299**（本片 **+55**）；其中 **8 条是与 `work-mode-service` 的键归一化交叉校验**（两边不一致的后果是「侧栏按 A 判、历史按 B 找」）|
| 真实运行 | 不适用 + 原因：链记录由**交接事务**（S5b-3）写入 —— 本片只把它建成可用的数据层，事务没接之前磁盘上不会出现第二段，也就没有可跑的真实链路。**现有真实链路未受影响**（本片未改任何既有调用路径，只新增两份模块）|
| 视觉验收 | 不适用 + 原因：同理 —— 真正要看的是 S5b-4（侧栏只列代表 + 历史拼成一条时间线）。本片把判定函数（`isRepresentative` / `planHistoryRead`）先定下来，就是为了让那一步只需要接线、不再需要拿主意 |
| 应用与包 | 不适用 + 原因：未改打包配置与依赖；`session-chains.json` 只在真的发生交接时写入（默认零占用），与其它 store 同一套原子写 |
| 剩余限制 | ① **没有写入方**：`link` 还没接到事务上（S5b-3），当前磁盘上永远是空链 → 界面行为与今天一致（每条会话各自一条）；② **历史拼接与侧栏过滤未接线**（S5b-4）；③ **fork 只能落在单段**（pi 的 fork 是单文件语义）——从旧段 fork 与从代表段 fork 的差异要在 S5b-4 里写明；④ 删除 / 导出按链整体处理的接线未做（现在删除仍只动单段文件）；⑤ 链记录没有上限之外的清理策略（链数量上限 2000）|

### 本轮（2026-09-19）实施-05 S5a · 交接计数与资格（+ 交接包契约）

> 主题文档：[实施-05](../archive/plan/实施-05-工作模式与长任务续接-已完成.md) §7 / §8 / §10 的 S5 行。
> 用户 2026-09-19 拍板：交接包**由模型写**（一次额外模型调用），宿主只给提示与校验。
> 这一片先把**不需要模型**的那一半做完 —— 计数不准，后面整个交接都不可信。

| 六栏 | 证据 |
|---|---|
| 实现 | **新** [`shared/handoff.ts`](../../src/shared/handoff.ts)：`HANDOFF_AUTO_COMPACT_THRESHOLD = 2`；`isCountableCompaction`（`status='completed'` 且 `triggeredBy='policy'` 或原生 `threshold`/`overflow`；手动 / 失败 / 取消 / declined 一律不计）；`compactionKeyOf`（有摘要条目 id 用它，否则「起止时间 + 原因」合成 —— 挡 `state` 推送对 `lastCompaction` 的重放）；`applyCompactionTally`（幂等、不封顶、键上限 50）；`resetTallyForNewSegment`；`handoffEligibility`（够数 / 有在推进的目标 / 自主档 / 不忙，不满足时给可读原因）；交接包契约 `HandoffPackage` + `sanitizeHandoffPackage`（两栏必填、列表宽容读法、**来源字段由宿主覆盖**）+ `renderHandoffPrompt` + `handoffSummary`。**新** [`main/handoff-service.ts`](../../src/main/handoff-service.ts)：`YAN_DIR/handoffs.json`（按会话文件路径索引、串行队列、原子写、**未计数时不落盘**、落盘失败抛错并回退内存态、脏文档降级、旧文件兼容）。[`main/index.ts`](../../src/main/index.ts)：`observeCompaction` 接在 `pushFrom` 的 `state` 分支上（只有 `completed` 才往 store 走；计数失败不影响会话）|
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` 干净；单测 **3244/3244**（本片 **+62**：计入规则 9（三种自动 / 手动 / 四种非完成态 / 空）/ 去重键 4 / 计数幂等与上限 7 / 新片段归零 3 / 资格四条件 7 / 交接包清洗 7 / 提示与摘要 5 / 存储 20）|
| 真实运行 | `YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash npm run test:live -- contexttakeover`（cost 1）全绿：真实工作集压缩照常（`beforeTokens=31158 → afterTokens=98`、`triggeredBy: policy`），且 afterExit 新增的两条断言拿到 —— `handoffs.json` 里该会话 `count=1`、去重键已落盘。**为何借这个场景**：计数要真的发生必须先有**一次真实压缩**，而它就是唯一的 cost 1 压缩场景（不值得为这一条再烧一次额度）|
| 视觉验收 | 不适用 + 原因：本片无渲染端改动（`handoffs.json` 与资格判定都还没有界面入口；「已续接至…」属 S5b 的 UI）|
| 应用与包 | 不适用 + 原因：未改打包配置与依赖；`handoffs.json` 只在真的有自动压缩时写入（默认零占用）|
| 剩余限制 | ① **交接包的生成链路未做**：契约、清洗与提示都就位了，但「宿主 arm → 薄层调 `ctx.modelRegistry.complete` → 写包 → 宿主校验落盘」是 S5a-2；② **事务全未做**（S5b）：建目的会话、同 cwd 执行租约、`resumeId` 发送与消费去重、失败恢复；③ **界面上看不到**：计数到了阈值也没有提示，「已续接至… / 接续自…」都没有；④ 片段标识 `segmentId` 目前恒为 `initial`（只有 S5b 的移交才会换新）；⑤ 去重键在**没有** `entryId` 且时间戳相同的极端情况下会归并成一条（宁可少计一次，不重复计）|

### 本轮（2026-09-19）实施-05 S4 · 请求前预算诊断与硬闸门

> 主题文档：[实施-05](../archive/plan/实施-05-工作模式与长任务续接-已完成.md) §6 / §10 的 S4 行。
> S1 已经证明两条手段可用（`before_provider_request` 能改写请求体、`ctx.abort()` 能让下一个请求真的不发）；
> 这一片把它们变成**每一次请求前都跑**的判定。证据全文：[证据-05-S4](../archive/evidence/证据-05-S4-请求前预算门.md)。

| 六栏 | 证据 |
|---|---|
| 实现 | **新** [`resources/pi-extensions/context-budget.js`](../../resources/pi-extensions/context-budget.js)：预算公式 JS 版（`budgetOf`，与 `shared/context-policy.ts` **交叉校验**）/ 请求体估算（`estimateRequestTokens`：messages + 工具表 + 顶层 system）/ 三档判定（`requestBudgetLevel`：`normal` / `soft` / `physical`）/ `YAN_CONTEXT_POLICY` 的预算字段解析（非法值整项忽略）。**新** [`scripts/test-context-budget.mjs`](../../scripts/test-context-budget.mjs)（交叉校验 + 边界）与 [`scripts/probe/budget-gate.js`](../../scripts/probe/budget-gate.js)。[`context.js`](../../resources/pi-extensions/context.js)：新增 `before_provider_request`（每轮记诊断 `request-budget-<level>`；`physical` → `pi.appendEntry('yan-budget-abort')` + `ctx.abort()` **不发送**）；`context` 钩子里的 Tool Sweep 在**过工作集线时跳过收益门槛**（`overWorkingSet` → `minReclaimTokens/minReclaimRatio = 0`，并记 `sweep-forced-by-budget`）。[`hook-probe.mjs`](../../scripts/hook-probe.mjs)：新模式 `budget` / `budget-soft`（加载**真正随包**的 context.js，预算走产品自己的 env 通道）；[`mock-provider.mjs`](../../scripts/lib/mock-provider.mjs)：请求日志新增 `bodyChars`（用来校准估算）；[`test-live.mjs`](../../scripts/test-live.mjs)：新场景 `budgetgate` + `afterExit: budgetGate` |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` 干净；单测 **3182/3182**（本片 **+51**：公式交叉校验 8（6 个窗口 × 工作集/兜底/预留/余量 + 三条触发线 + 覆盖值）、默认值一致 2、覆盖值解析 7、估算口径 10（中文 / toolCall / 工具结果 / 工具表 / 顶层 system）、三档边界 11（线下一 token / 正好在线 / 正好等于窗口 / 多一 token / 负值 / 窗口未知）、产品接线 4（**清扫成对对照**：窗口未知不清 · 过线时跳过门槛真清出墓碑；`requestBudgetFor` 两条））；三个改动脚本 `node --check` 干净 |
| 真实运行 | **假 provider 两组对照（cost 0，不联网）**：`hook-probe budget` —— 工具产出 40 万字符 → 第 2 个请求判 `physical`（诊断：估算 13621 + 预留 195000 = 208621 > 窗口 200000）→ `ctx.abort()` → 假 provider **只收到 1 个请求**，会话里多一条 `custom: yan-budget-abort`；`hook-probe budget-soft`（对照）—— 同一份消息与同一个大结果 → **2 个请求全发、0 abort**，且第 2 个请求 `bodyChars=55054` ↔ 估算 13621 token（4 字符/token 口径偏差 **~1%**）。**真实模型（cost 1）**：新场景 `budgetgate` 全绿 —— 工作集线压到 3000 → `request-budget-soft`（`window=1048576` 在 `before_provider_request` 里真读到）出现，`physical` / `budget-abort` **都是 0**（未误拦）。**回归**：`contexttakeover`（cost 1，真实压缩链路照常：`beforeTokens=31158 → afterTokens=98`、`triggeredBy: policy`）、`contextbudget` / `context`（cost 0）、`hook-probe abort` / `workmode` |
| 视觉验收 | 不适用 + 原因：本片**无渲染端改动**；预算档位目前只在诊断日志与会话 `yan-budget-abort` 留痕里，界面上没有指示（明列入剩余限制④） |
| 应用与包 | 不适用 + 原因：未改打包配置（`electron-builder.yml` 整目录随包 `resources/pi-extensions/`）；`context-budget.js` 是随包源码的新文件，无新依赖、无新数据文件 |
| 剩余限制 | ① `physical` 的确定性证据只来自假 provider（真实窗口 1M 构造不出）；② soft 的「先清旧工具结果」在真实链路里没取到「真清了」的证据（单次 `--print` 只有一个原子单元，往前的回合不可切），产品接线由单测成对对照覆盖；③ 估算**无缓存 / 无增量**，每轮 O(体积) 遍历，大上下文的 CPU 成本未测；④ 界面看不到 `normal / soft / physical`（S6 的联调范围）；⑤ 图片 / 超长单行 / 非 ASCII 混合的体积口径未逐一标定（physical 线留了完整输出预留当缓冲）；⑥ **默认测试模型 `commandcode/longcat-2.0:free` 已退役**（`403 permission_error`，与本片无关）—— 不带 `YAN_TEST_MODEL` 的 cost 1 场景会变红 |

### 本轮（2026-09-19）实施-05 S3c · 自主档「大任务自己往下推」

> 主题文档：[实施-05](../archive/plan/实施-05-工作模式与长任务续接-已完成.md) §5（自主持续执行）与 §10 的 S3 行。
> 需求原话：「给 agent 下达一个非常大的任务时，可以让模型自己去规划完成」。
> S3a/S3b 做完的是「目标状态 + 澄清就绪的**一次性**开工」；这一片补的是
> **没有人再发消息，也能一轮轮往下走** —— 这是「大任务」与「一轮问答」的分界。

| 六栏 | 证据 |
|---|---|
| 实现 | **契约** [`shared/goal.ts`](../../src/shared/goal.ts)：`ResumeKind`（`ready` / `continue`）/ `AUTONOMOUS_CONTINUE_LIMIT = 8` / `resumeKindOf`（旧记录一律当 `ready`）/ `isActiveGoalPhase` / `goalContinueSummary`（正文只给阶段、未完成步骤、已有证据与续接口径）。**存储** [`main/goal-service.ts`](../../src/main/goal-service.ts)：`GoalEntry.autoContinues`；新 `armContinue`（终态不 arm、`revision<=0` 不 arm —— 否则自主档里一场普通对话会被无限叫醒、到上限返回 `reason:'limit'`）/ `resetAutoContinues`；`report` 进终态时**同一次落盘**清续行 + 计数归零（否则那条「继续」会在目标完成后才发出去）；`stop` 归零；`sanitizeResume` 给旧记录补 `kind`；快照带上 `kind`。**接线** [`main/index.ts`](../../src/main/index.ts)：`goal.report` 成功且当前是自主档 → `armContinue` → `applyGoalResume`（先落盘再告诉薄层）；回执 `data.note` 明确「已安排第 N 次续接，收尾吧」/「已达上限，这轮把事情交代清楚」；`yan:send` → `resetAutoContinues`（用户说一句话就重新计数）。**薄层** [`pi-extensions/goal-resume.js`](../../resources/pi-extensions/goal-resume.js)：按 `kind` 选 `yan-goal-ready` / `yan-goal-continue`，`appendEntry` 与诊断行带 `kind`。**提示** [`pi-extensions/question.js`](../../resources/pi-extensions/question.js)：自主档加「大任务先登记 `steps`」与「报完就收尾，宿主的 control 消息会把你叫回来，**绝不**等用户说继续」 |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` 干净；单测 **3131/3131**（本片 **+28**：契约 10（上限 / 阶段判定 / `kind` 兼容 / 续接正文五项）、快照 `kind` 2、存储 14（未报告不 arm、序号、连续到上限、用户归零、完成清续行、停止作废、旧文件从 0 计数）、旧文件兼容 2）；三个改动脚本 `node --check` 干净 |
| 真实运行 | **新场景 `goalloop`（cost 1，已登记 `CASES`，固定 `deepseek/deepseek-v4.1-flash`）全绿**：切自主档 → 探针**只发一条**用户消息（要求模型跑一次 `yan goal report` 就收尾）→ 目标 `executing`（rev1）→ 第一轮真空闲后**自动起了新回合**（助手 2→3）→ 续接轮把目标推到 `completed`（rev2）。`afterExit: goalLoopPersisted` 磁盘核对：`goals.json` rev2 / 报告 2 条、会话文件里有 `yan-goal-resume`（消费证据）与 **`yan-goal-continue`**（控制消息，角色不是 user）、`goal-resume/r1.json` + `r1.consumed.json`、扩展日志有 `kind=continue` 的 `resume_sent`。**回归**：`goal`（S3b 就绪续行，cost 1）与 `workmode`（cost 0）全绿。**实测教训**：默认免费模型 `longcat-2.0:free` 收到指令后只回文本、一次 `bash` 都没调（目标停在 rev0）→ 固定 deepseek 一闪，与 `browserclimodel` / `capsearch` 同一处置 |
| 视觉验收 | 不适用 + 原因：本片**无渲染端改动**；控制消息仍不进界面历史（与 S3b 同一取舍，见剩余限制①），自主档光带 / 工具卡形态沿用 S3a/S3b 的已看图 |
| 应用与包 | 不适用 + 原因：未改打包配置；`goal-resume.js` 在随包 `resources/pi-extensions/`（整目录随包）；`autoContinues` 是同一份 `goals.json` 里的字段，无新文件 / 新依赖 |
| 剩余限制 | ① 控制消息**不进界面历史**（S3b 遗留；把 `custom_message` 渲染成「砚 · 控制消息」卡片仍是后续小活）；② 到上限（8 次）时只有 `goal.report` **回执**告知模型，**界面没有提示**；③ 上限是**常量、不可配置**（§7 对 handoff 要求可配置，这里没有）；④ 触发源是「模型主动报告」—— 完全不报告的会话不会被续行（这是有意的不误伤，代价是模型得先说一句进展）；⑤ 续行只在**同一会话**内（跨会话交接是 S5、撞预算的硬保护是 S4，都未开工）；⑥ 探针用指令式提示验链路，「真实大任务连续 5+ 轮自主」未取证 |

### 本轮（2026-09-19）实施-05 S3b · 跨轮自动续行（澄清 → 标准之后自己开工）

> 主题文档：[实施-05](../archive/plan/实施-05-工作模式与长任务续接-已完成.md) §4（转移后的「内部 resume 一次」与三个防护）。
> 上一片（S3a）把就绪转移做成了原子提交；这一片把「提交完就开工」接上。证据汇总：[证据-05-S3a](../archive/evidence/证据-05-S3a-门禁与就绪转移.md)。

| 六栏 | 证据 |
|---|---|
| 实现 | **新** [`pi-extensions/goal-resume.js`](../../resources/pi-extensions/goal-resume.js)：`message_end`（无工具调用）→ **1.8s 二次确认**（期间用户又发话 / 又调工具则放弃）→ 写消费证据 → `pi.appendEntry` 留痕 → `pi.sendMessage({customType,content,display},{triggerTurn:true})` 发一条 **`custom` 角色**消息触发回合。`main/goal-service.ts`：`resume` 记录**与转移同一次落盘**、`clearResume`、`writeGoalResumeSnapshot`（按 runnerId 命名，与 `work-mode/<runnerId>.json` 同约定）。`shared/goal.ts`：`ResumeRecord` / `readyResumeSummary` / `shouldResume`（纯函数）。`main/index.ts`：就绪成功后写快照；`yan:abort` 与 `yan:setWorkMode`（切成非标准档）**抦销未发续行**（§5 用户停止优先）。`agent.ts` 加载新扩展 |
| 自动检查 | 单测 **2966/2966**（本片 **+17**：续行记录与正文 / 与转移同一次落盘 / `clearResume` 落盘 / 停止作废续行 / 快照写与抦销 / `shouldResume` 四种情形）；`typecheck` / `build` 干净 |
| 真实运行 | `YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash npm run test:live -- goal`（cost 1）第 7 节 + `afterExit` 全绿：续行**真的起了一个新回合**（探针等的是真 idle，不是两层请求间的空档）；会话文件里同时有 `yan-goal-resume`（消费证据）与 `yan-goal-ready`（**控制消息，角色不是 user**）；`goal-resume/r1.consumed.json` 记下 operationId。扩展日志时间线（决定性证据）：`message_end(assistant, turnEnd=true)` → 1.8s → `check hasResume=true` → `resume_sent` → `message_end(role=custom)`。**回归**：`workmode`（切档路径）/ `todos` / `queue`（abort 路径）/ `ask` 全绿 |
| 视觉验收 | 不适用 + 原因：控制消息**不进界面历史**（`session-reader` 只读 `type:"message"` 条目）——它的留痕在会话文件与模型上下文里，界面能看到的是续行带来的新回合。这是已知取舍，见剩余限制① |
| 应用与包 | 不适用 + 原因：未改打包配置；`goal-resume.js` 在随包 `resources/pi-extensions/`（整目录随包）；`goal-resume/<runnerId>.json` 只在发生过转移时写入 |
| 剩余限制 | ① 控制消息**在界面历史里看不到**（把 `custom_message` 渲染成「砚 · 控制消息」卡片是后续小活；现在要看留痕得读会话文件）；② 续行是**延迟触发**（1.8s 二次确认），所以「本轮收尾」与「下一轮开工」之间有一小段空档；③ **崩溃窗口**：先写消费证据再发送 —— 极端情况下会**少发一次**（目标停在 executing，用户再说一句就继续）—— 这是有意选的失败方向（宁可少发，不重复执行）；④ 目标级「用户停止」（标 `stopped`）仍无界面入口（`GoalStore.stop()` 有实现与单测）；⑤ 续行只靠 `message_end` 近似「回合结束」（pi 没有 agent_end 钩子）—— 二次确认就是为这个不精确性加的保险 |

### 本轮（2026-09-19）实施-05 S3a · 澄清档门禁与就绪转移

> 主题文档：[实施-05](../archive/plan/实施-05-工作模式与长任务续接-已完成.md) §4 / §5。证据全文：[证据-05-S3a](../archive/evidence/证据-05-S3a-门禁与就绪转移.md)。
> 这一片把「澄清档」从「只是一句提示」变成**有硬门禁 + 能原子转标准**的一档。
> 切分：**S3a（本轮）** = 门禁 + 就绪转移 + 目标状态机 + 通道；**S3b（待接）** = 跨轮自动续行 + 用户停止接线。

| 六栏 | 证据 |
|---|---|
| 实现 | **新** [`shared/goal.ts`](../../src/shared/goal.ts)：阶段集合 / 就绪校验（五栏 + 置信度 0.95 + 无未决 + 两种 revision 不过期）/ 报告校验（`completed` 要证据、`blocked` 要原因、`stopped` 不许模型自报、已完成不许回退）/ 推进（同一失败签名连续两次**强制** blocked）/ CLI 参数归一（内联与请求文件两形态）。**新** [`main/goal-service.ts`](../../src/main/goal-service.ts)：`YAN_DIR/goals.json`，幂等记录**先于**校验、提交返回前已落盘、脏 JSON 不抛、落盘失败**必须抛**、多会话不串。**新** 薄层 [`pi-extensions/work-mode.js`](../../resources/pi-extensions/work-mode.js)：澄清档把非只读工具从表里拿掉 + `yan goal …` 形状白名单（禁 shell 元字符）+ `tool_call` 兜底。`capability-server` 登记 `goal.ready|report|status`；`yan.mjs` 新增 goal 组（含**内联参数**用法）；`index.ts` 新增 `goalCapabilityHost`（校验 → 落盘 → 切模式 + 推送）与**只读** IPC `yan:getGoal`；`question.js` 澄清档/自主档提示补上提交与报告口径；`shared/tool-origin.ts` + `ToolRow` 认「目标 · 砚内置」 |
| 自动检查 | `typecheck` / `build` 干净；单测 **2949/2949** —— 新增 `test-goal.mjs`（契约 + 存储 **66** 条）、yan CLI 目标组三条登记检查（动作表 / 用法文案 / KNOWN_COMMANDS）、tool-origin 目标识别 11 条 |
| 真实运行 | **门禁三组对照**（`node scripts/hook-probe.mjs workmode\|workmode-standard\|workmode-allow`，**cost 0、不联网**）—— 澄清档下工具表 `[bash,read,write,edit]` → `[bash,read]`，而且**假 provider 收到的请求里也没有 write/edit**（不是只改了内存）；同一条写文件命令在对照组**真写了** marker、在澄清组被拦（marker 不存在 + `Tool execution was blocked`）；`yan goal status` 被放行并**真的跑到了 CLI**（回 `identity_mismatch`：命令执行了，只是假环境没绑身份）。**端到端** `YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash npm run test:live -- goal`（cost 1）：澄清档 → 模型敲**内联** `yan goal ready` → 模式**自动切标准**（rev2）、目标 `executing`（rev1）、工具卡标「目标 · 砚内置」；退出后磁盘核对：`goals.json` 一条、`transitions` 一条（幂等键就是模型给的）、五栏（含验收）完整。**回归**：`workmode` / `todos` / `layout` / `slashcmd` / `ask` 全绿，无残留 pi 进程 |
| 视觉验收 | 不适用 + 原因：本轮**没改视觉**（工具卡沿用任务卡那套 `trow-src` 样式，只是多一个来源标签与 i18n 文案）；`goal` 场景的 DOM 断言已覆盖「标签真的渲染出来且写着目标」（`data-origin="yan-goal"` + 文案含「目标」） |
| 应用与包 | 不适用 + 原因：未改打包配置；`work-mode.js` 在随包 `resources/pi-extensions/`（`electron-builder.yml` 整目录随包），`scripts/` 不进包；`goals.json` 只在真的有目标时写入（默认零占用） |
| 剩余限制 | ① **跨轮自动续行未接**：提交完就绪后回执告诉模型「本轮仍只读、下一轮开始执行」，实际执行靠下一轮（§4 路径 B 的后半段）；② **用户停止目标没有界面入口**（`GoalStore.stop()` 有实现与单测，停止后旧 revision 报告会被拒）；③ 真实多轮模糊请求的**逐步澄清**没做成场景（提示词与提问通道已改）；④ 契约里的 `pendingMode` 仍未用；⑤ 澄清档的 bash 白名单是**文本形状**判定 —— 与任务卡归属同一类取舍（允许列表 + 禁元字符，不是权限边界；真正的硬边界是工具表） |

### 本轮（2026-09-19）实施-05 S1 · 钩子能力边界与安全点（D0）

> 主题文档：[实施-05](../archive/plan/实施-05-工作模式与长任务续接-已完成.md) §4 / §6 的两处「S1 必须先验证」。
> 证据全文：[证据-05-S1](../archive/evidence/证据-05-S1-钩子与安全点.md)。
> **本片不写产品代码** —— 它的产出是**结论 + 可重跑的实测设施**，S3 / S4 直接照结论实现。

| 六栏 | 证据 |
|---|---|
| 实现 | **无产品代码改动**。新增三个实测设施：`scripts/lib/mock-provider.mjs`（**假 provider**：OpenAI chat-completions 最小实现，把「第几次请求回什么」写死，并把每个到达的请求追加进 JSONL）、`scripts/lib/hook-probe-ext.mjs`（探针扩展，除指定那一件事外不改行为）、`scripts/hook-probe.mjs`（编排：隔离 `PI_CODING_AGENT_DIR` → 起假 provider → 跑 `pi --print` → 打印请求清单 / 钩子时序 / 会话 JSONL / marker）。**为什么值得留**：预算门与压缩时序的判据是「请求发没发出」+「请求体长什么样」，真实模型答不了、也看不见网络层 |
| 自动检查 | `node --check` 两个脚本干净；不改 `src/`，单测仍 **2879/2879**；`audit:refs` 无断链。**不是** `test:live` 场景：它不启 Electron、**不连真实模型**（假 provider 在 127.0.0.1），所以自然在 `check` 之外，靠证据文档里的命令复现 |
| 真实运行 | 五组对照实验（每组一次 `pi --print`，耗时 400–600ms）：① **`block`** —— `tool_call` 返回 `{block:true}`：同一命令在 `abort` 组**真写了** marker 文件、在 `block` 组**没写**（工具真不执行）；会话里落的是 `Tool execution was blocked` + `isError:true`，**我返回的 content/isError 被忽略**；循环**不停**（第 2 个请求照发）。② **`abort`** —— `before_provider_request` 第 2 次调 `ctx.abort()`：假 provider **只收到 1 个请求**（第 2 个真没发），`exit=1` / `Request aborted`，会话完整（多一条空 assistant）。③ **`compact`** —— `tool_call` 里 `ctx.compact()` 返回 `undefined` 并**把当前 run 弄坏**（工具结果 `Operation aborted` + isError，`session_before_compact` 根本没触发）。④ **`payload`** —— 钩子返回新 payload：钩子内看到 2 条消息，假 provider 收到 **3 条**（多一条注入的 system）→ 返回的 payload **真的替换了发出去的请求体**。⑤ `plain` 对照。结论：**「拦住」有三条手段且语义不同** —— 改工具表（最干净）/ 改写 payload（能救预算）/ `ctx.abort()`（最粗暴，整轮结束）；**没有安静的暂停**，`ctx.compact()` 不是安全点 |
| 视觉验收 | 不适用 + 原因：本片不碰 UI（不改任何渲染端文件、不新增界面状态），没有可看的视觉变化 |
| 应用与包 | 不适用 + 原因：未改打包配置；两个脚本位于 `scripts/`，`electron-builder.yml` 的 `files:` 只有 `out/**` / `build/icon.png` / `package.json`，**不会进包**（也不属于随包 `resources/`） |
| 剩余限制 | ① 只在 **Windows + 内置 pi 0.85.1** 上实测，升级 pi 后要重跑（命令见证据文档）；② 假 provider 只覆盖「一轮里两次请求」，**多轮连续 block / 连续 abort** 未测（S3 真做门禁时应在 live 场景覆盖）；③ 真实模型在 `block` 后的行为（会不会反复重试被拒工具）未测 —— 这也正是「以工具表为主、不靠 block 反复拒绝」的理由之一；④ 实验里的 `bash` 命令必须写**相对路径**（绝对路径的反斜杠会被当转义吃掉，踩过一次）；⑤ `ctx.compact()` 在**空闲时**能不能用没测（不需要：宿主侧走 RPC，已在用） |

### 本轮（2026-09-19）实施-05 S2 · 会话级工作模式（标准 / 澄清 / 自主）

> 主题文档：[实施-05](../archive/plan/实施-05-工作模式与长任务续接-已完成.md) §2 / §3（S2 出口：真 Electron 按键与焦点；A/B 两会话模式互不影响）。
> 这一片把「自主模式」从一个**全局布尔**改成**按会话**的工作模式，并把提问行为接到它上面。
> 真实运行抽到**两个真缺陷**（模式键不稳定、已回答的 UI 请求会“复活”），均已修 + 有回归网。

| 六栏 | 证据 |
|---|---|
| 实现 | **新** [`shared/work-mode.ts`](../../src/shared/work-mode.ts)：三档顺序 / `WorkModeState`（`mode` + `revision` + 可选 `pendingMode`）/ `normalizeWorkMode` / `nextWorkMode` / `migrateLegacyAutonomous`（新字段优先、幂等）/ `isWorkModeTabShortcut`。**新** [`main/work-mode-service.ts`](../../src/main/work-mode-service.ts)：`YAN_DIR/work-modes.json`（按会话、CAS 提交、pending → 稳定键 `adopt`、上限 2000、原子写 + `rename` 失败退化直写）+ `writeWorkModeSnapshot`（写 `work-mode/<runnerId>.json` 给薄层扩展）+ `normalizeSessionFileKey`。`settings.ts`：`defaultWorkMode` 迁移（**读文件原值**，不能用 DEFAULTS 合并值，否则旧 `autonomous:true` 永远迁不过来）+ `workModeTab` 默认态不落盘。`ipc.ts` / `preload`：`getWorkMode` / `setWorkMode` + `work-mode` 推送（带 `runtime` 封套）。`main/index.ts`：`resolveWorkMode` / `pushWorkMode`（写快照 + 推送）/ 两个 handler，接在 `pushRunnerSnapshot` 上 —— 启动 / 切会话 / 新建都覆盖。`agent.ts`：`YAN_SESSION_ID` / `YAN_PROJECT_ID` **无条件注入**（原来只跟着能力服务走；扩展读不到自己是哪个实例就找不到模式快照）。`resources/pi-extensions/question.js`：三档提示 + 自主档 `execute` 不弹窗 + 回退链（快照 → `defaultWorkMode` → 旧 `autonomous` → 标准）+ `YAN_QUESTION_EXT_LOG` 诊断行。渲染端：`Composer#WorkModePicker`（菜单三档 + 一句说明 + ↑↓/Enter/Space/Esc/Tab 离开）、`Tab` 快切（IME / 补全候选 / 长文模式一律让路）、无补全 `Esc` 把焦点送到模式按钮；`session-runtime.ts` 缓存 `workMode`；设置页新增「新会话默认模式」与「Tab 快切」；i18n 中英各 **+9** 键；`.auto-toggle` 样式换成 `.mode-*` |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` 干净；单测 **2879/2879** —— 本片新增 `test-work-mode.mjs`（契约 20 条 + 存储 24 条：CAS / pending 迁移 / 脏文档 / 快照覆盖）、`test-question.mjs` 改写成三档 + 回退链 + 自主档不弹 UI、`test-session-runtime.mjs` **+3**（`uiRequests` 可由缓存补丁清空） |
| 真实运行 | **新场景 `workmode`（cost 0，已进 `check`）全绿**：旧配置迁移（case 预置只有 `autonomous:true` 的 `desktop.json`）/ 菜单三档与一句说明 / 方向键与 `Esc` 焦点回退 / **`Tab` 用主进程真按键**（`sendInputEvent`，并断言焦点没被移走）/ A-B 两会话各自切档后互相切回都不串 / 退出后核对 `work-modes.json` 两条、`work-mode/<runnerId>.json` 快照、旧字段未被抹掉、关掉再开的开关不在磁盘留键。**`ask`（cost 1，deepseek）也全绿**：第 6 节现在有两道证据 —— 探针断言不弹窗 + 退出后诊断 `execute mode=autonomous`（模型真的试着提问、被扩展拦下），不再靠“模型恰好没问”蒙过去。回归：`slashcmd` / `atPath` / `settings` / `sendkey` / `hotkeys` / `dialog` / `todos` / `pending` / `queue` / `layout` / `vheight` / `symmetry` / `narrow` 全绿，每次跑完无残留 pi 进程。**缺陷 1（模式键）**：pi 对**同一份**会话文件切走再切回会报**新** `sessionId` → 模式当场丢回默认值；改用会话文件路径作键（`normalizeSessionFileKey`），把旧写法改回去时相关断言当场变红。**缺陷 2（UI 请求复活）**：`answerUi` / `dismissRequest` 只清顶层 `uiRequests`，而 `runners` 推送（每次 `state` 推送都带一条）会把会话缓存里的旧请求投影回顶层 → 已回答的问题又冒出来（`ask` 第 6 节抓到的面板 id 还是第 1 节那条）；两处现在同时清缓存，并补了 3 条单测 |
| 视觉验收 | `YAN_MATRIX_ONLY=autonomous,workmodemenu YAN_MATRIX_STAMP=2026-09-19wm` 跑组 0/1/4 → `matrix-autonomous-1440x900-100-{dark,light}-2026-09-19wm.png`、`matrix-workmodemenu-1440x900-100-{dark,light}-2026-09-19wm.png`、`matrix-workmodemenu-900x520-100-dark-2026-09-19wm.png`（**5 张，溢出 0px，已逐张看图**）；另 `YAN_MATRIX_STAMP=2026-09-19wmset` 重拍 `matrix-settings-1440x900-100-{dark,light}` 与 `900x520-100-dark`（**3 张**，新增两行：三段默认模式、Tab 快切开关）。矩阵状态新增 `workmodemenu` 并跟 `autonomous` 一起进组 0/1/4 |
| 应用与包 | 不适用 + 原因：未改打包配置 / 启动参数；`resources/pi-extensions/question.js` 是**整目录随包**（`electron-builder.yml`），落位由既有 `test:packaged` 的扩展加载与启动器断言覆盖；`desktop.json` 的新字段只在用户改动时才写入（迁移结果会在**下一次写设置时**一并固化） |
| 剩余限制 | ① **澄清档的自动开工不在本片**：`clarify` 目前只有提示与「照常提问」，不承诺「就绪后自动转标准并开始」（那是 S3 的原子转移 + 只读白名单）；② 契约里的 `pendingMode` 暂未使用 —— 运行中切档的语义靠「下一轮生效」，界面上没有单独的 pending 标记；③ `work-modes.json` **不随会话删除清理**（孤儿条目无害，且有 2000 条上限）；④ `workmode` 虽是 cost 0，但需要 pi 连上才拿得到会话身份（探针会轮询 `conn === 'ready'`），首枚按键用 `YAN_PROBE_KEYS_DELAY` 推到 15s；⑤ 迁移不主动改写用户设置：`autonomous` 原样保留，`defaultWorkMode` 在下次写设置时固化 |

### 本轮（2026-09-19）实施-03 S6 · 跨会话 / 项目 / 工作树隔离 + 包与便携数据

> 主题文档：[实施-03](../archive/plan/实施-03-项目知识与旧记忆清理-已完成.md) §4 / §7（S6 出口：无开发目录依赖；解包实例读写隔离；旧用户数据逐字节不变）。
> 这一片把项目知识从「一条会话能读能写」推到「**换会话 / 换项目 / 换工作树 / 重启进程都不串**」。
> 它不只是补齐验证：真实运行**抓到一个真缺陷并修掉**。

| 六栏 | 证据 |
|---|---|
| 实现 | `src/main/index.ts` 新增 `knowledgeProjectId()`：登记优先；**未登记时不再裸回退 `legacyProjectId`**，而是走 `projectIdForCwd(cwd, isTaken)` 的碰撞退路（该 id 已被别的 cwd 占着就换整条路径的哈希）。两处调用点（`AgentController.capability.projectId` 与 `yan:knowledge:*` 的身份推导）统一走它 —— 之前两处都是 `projectIdForCwd(settings, cwd) ?? legacyProjectId(cwd)`。**缺陷**：旧 `legacyProjectId` 只取路径前 **27 字节**，`<repo>` 与 `<repo>-worktrees/iso` 派生出**同一个 id**；而工作树会话在设置里没有登记（`yan:selectSession` 不登记 cwd），于是工作树**直接读到主仓库的知识**（设置页 + `yan knowledge` + 注入一起漏），违反 §4「工作树默认是独立项目知识空间」。测试面：`scripts/test-live.mjs` 新增 CASE `knowledgeisolation` + `seedKnowledgeIsolation` / `checkKnowledgeIsolation`，并新增**通用的 `restart` 能力**（第一次启动跑主探针 → 退出 → 用同一份 `YAN_DATA_DIR` 再启动跑第二个探针）；新增 `scripts/probe/knowledge-isolation.js` / `knowledge-isolation-restart.js`；`scripts/test-packaged.mjs` + `scripts/probe/packaged.js` 加旧数据哨兵与打包态知识读取 |
| 自动检查 | `typecheck`（含 CSS / layer 自检）/ `build` 干净；单测 **2820/2820**（本片 **+3**：工作树与主仓库同前缀碰撞的前提、未登记工作树不共用 id、退路是整条路径的哈希） |
| 真实运行 | **新场景 `knowledgeisolation`（cost 0，不调模型）全绿**，两次启动共 **40+ 条断言**：① 主仓库 A 只看到 `kn-iso-a`（设置页卡片 + 页面 projectId 与列表一致）；② 切到已登记项目 B 只看到 `kn-iso-b`；③ 切到 A 的**真 git 工作树**（未登记）`counts.all = 0`、设置页空状态、**看不到 A 的条目**；④ **重启**后 A / B 条目仍在、工作树仍空、三个 cwd 的 projectId 与上一次**逐一相同**（`restart={aHasEntry:true,aSameId:true,bHasEntry:true,wEmpty:true,wSameId:true}`）；⑤ 退出后回读磁盘：A / B 各一个目录、各只有自己那条、正文指纹与 fixture 一致，工作树**没有**知识目录；⑥ **旧用户数据逐字节不变**（`pi-agent` 与 `data` 两处各放 `memory.json` / `soul.md` 哨兵）。**反向验证**：把未登记回退改回裸 `legacyProjectId` → 工作树那 6 条断言当场变红（工作树 projectId 与主仓库相同、读到 `kn-iso-a`、设置页也画出 A 的卡片）—— 缺陷与修复的因果当场闭合。回归 `knowledgetab`（cost 0）与 `live`（cost 0）全绿；每次跑完「✓ 没有残留的 pi 进程」 |
| 视觉验收 | 不适用 + 原因：本片**无界面改动**（只改身份推导与测试件）。设置页的外观由 03-S5 的 4 张截图覆盖；这一片验的是「同一页在不同 cwd 下渲染出**不同**内容」的身份边界，属数据正确性，不是样式 |
| 应用与包 | **`dist:dir` 重产 + `test:packaged` 全绿**（新增 9 条）：项目知识写在隔离的 `YAN_DIR` 下、fixture 条目仍读得到（打包探针真的走了一次 `knowledge.list`，`project-YzpcdXNlcn…/kn-packaged`）、**安装目录里没有被写进 `project-knowledge`**、**开发仓库根目录里也没有**、旧用户数据逐字节不变（`pi-agent` / `data` × `memory.json` / `soul.md`）；同一批次顺带把「`yan --help` 里能看到 `knowledge search`」补成断言（此前只验到 `tasks apply`） |
| 剩余限制 | ① 两个**都未登记**且路径同前缀的目录仍会共用 legacy id —— 当前设计里活跃 cwd 会被 `settings.sanitizeProjects` 自动登记，所以实际路径已被覆盖；要彻底消除需要一个「未登记目录的 cwd → id」登记表，本片不做，登记在案；② `restart` 是通用测试能力，目前只有这一条场景在用；③ 旧数据哨兵只证明「不被改写 / 删除」，不证明「一次都不读」（实施-03 §9 只要求前者）；④ `knowledgeisolation` 是 cost 0（不调模型），所以**注入链**在工作树下的行为没在这一条里取证 —— 注入身份与设置页身份同源（同一个 `knowledgeProjectId`），且 `knowledgeinject` 已覆盖注入链本身；⑤ 工作树的 `git worktree add` 失败时会退化成普通目录（路径前缀不变，碰撞前提仍成立），输出里会明说 |

### 本轮（2026-09-19）实施-03 S5 · 项目知识设置页

> 主题文档：[实施-03](../archive/plan/实施-03-项目知识与旧记忆清理-已完成.md) §6（UI 口径）。到这一片，项目知识
> **从存储走到能看的界面**：开关、三种筛选、来源、确认 / 编辑 / 替代 / 删除 / 导出。

| 六栏 | 证据 |
|---|---|
| 实现 | **新** `src/shared/project-knowledge-view.ts`（纯函数视图层：`toKnowledgeView` / `countKnowledge` / `knowledgeMarkdown`；「需复核」= 分支漂移 / 路径失效 / 来源会话被删，**信息不足时不误报**；导出只含当前状态）；**新** `src/renderer/src/components/settings/KnowledgeTab.tsx`（开关 + 三筛选 + 条目卡就地展开的操作 + 导出）+ 设置面板新增 `knowledge` tab；**新** 四个 IPC `yan:knowledge:list/action/export/sourceSession`（`main/index.ts`）：**身份按当前会话推导**（与 `yan knowledge` 同一表达式 `projectIdForCwd ?? legacyProjectId`）、写操作全带 `expectedRevision`（CAS）、确认是唯一 `hostCheck.userConfirmed` 入口、永久删除需 `mode:'permanent'` + `userAction`、导出**不自动改写仓库**；i18n **+60 键 × 2**；`settings.css` 新增 `kn-*` 一段（无新设计令牌） |
| 自动检查 | `typecheck`（含 CSS / layer 自检）/ `build` 干净；单测 **2817/2817**（本片 **+30**：视图转换、三种复核原因、分支未知不误报、计数、导出（含墓碑不回流 / 空库 / 不可回读标注）/ 文案表）。**回读本轮真实缺陷**：首版把同一条正文同时放在标题行与正文行，截图里看着像两条 —— 视觉矩阵看出来的，已改为「类型 · id」标题 |
| 真实运行 | **新场景 `knowledgetab`（cost 0，不调模型）**全绿：设置页真的从主进程读到 fixture（1 active + 1 candidate）→ 计数对得上 → **候选确认**（从待确认消失、出现在已确认）→ **编辑**改正文并保存 → **逻辑删除**（先问一句再从列表消失）→ 另一条 fixture 不受影响。**来源跳转也真跑到了**：点那条会话来源后设置面板关闭、当前会话换成 fixture 会话（探针断言了切换后的文件名）。退出后回读沙箱：`manifest revision=4`，被删的那条 `status=deleted rev 4`（逻辑删除保留正文），另一条 `active rev 1` **完全没被动过**。回归：`live` / `context` / `pending` / `subagent`（cost 0）绿；`contextfoldpref` / `subagent` 首轮是**默认模型抖动**（没调工具、转录里没回复），指定 `YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash` 后两者全绿 —— 与本次改动无关 |
| 视觉验收 | `docs/design/preview/matrix-knowledgetab-1440x900-100-{dark,light}-2026-09-19kd.png` + `-940x620-100-light-` + `-900x520-100-dark-`（**4 张，已逐张看图**）：开关、默认关说明、项目 id、三筛选计数、条目卡（类型 · id / 状态 / 置信类 / 正文 / 标签 / 来源（文件 + 会话 + 「不可回读」）/ 有效范围 + 需复核 / 更新于 + rev）、编辑与删除的就地展开、导出区；窄窗口（900x520）与深浅主题下**溢出 = 0px**。`YAN_MATRIX_ONLY=knowledgetab` 只拍这一态；同一 stamp 的其余 233 张自产图已清理（只留这 4 张） |
| 应用与包 | 不适用 + 原因：未改打包配置，没有新资源路径 —— 视图层进 `out/renderer`，脚本只是测试件。**锁定与便携数据完整性是 S6 的验收项**，这里的结论不能代替它 |
| 剩余限制 | ① **「导出到项目文档」未做**：§6 要求「展示目标文件与 diff」的单独动作，现在只有复制 / 另存为 Markdown（都不改仓库）；② **永久删除主进程支持、界面只给逻辑删除**（有意为之，防误操作）——要永久删除目前只能走 CLI / 后续入口；③ 「需复核」的路径判定是相对 cwd 的 `existsSync`，未做符号链接 / 大小写归一；④ 列表**没有分页**（条目多时一次全渲染）；⑤ 导出的 Markdown 文案固定中文（与界面语言无关） |

### 本轮（2026-09-19）实施-03 S4 · `yan knowledge search/read/propose`

> 主题文档：[实施-03](../archive/plan/实施-03-项目知识与旧记忆清理-已完成.md) §6（工具面口径）。这一片把 S3 的检索能力
> 接给模型 —— 与 `yan browser` / `yan subagent` 同一条路：**不注册 pi 工具**，走随包 CLI + 宿主校验。

| 六栏 | 证据 |
|---|---|
| 实现 | `capability-server.ts` 的 `KNOWN_COMMANDS` 加 `knowledge.read` / `knowledge.propose`（`knowledge.search` 早先已登记）；`agent.ts` 新增 `runKnowledgeCommand`（search / read / propose）与路由分支；`resources/yan-cli/yan.mjs` 加 `knowledge` 分组（`GROUP_SPECS.required.read = ['id']`）。**命令面计数（2026-09-19 已核对）**：`KNOWN_COMMANDS` 共 **35 条**（`browser.*` 19 / `subagent.*` 4 / `knowledge.*` 3 / `capabilities.*` 4 / `mcp.*` 2 / 其余 3），未实现**差集 7 个**（`capabilities.*` 4 + `skill.read` + `mcp.*` 2，全归 04）—— 04-S1 证据 §8.1 已就地加了增量注（原记录保留）。三条硬口径：**身份只取宿主绑定**（请求里不同的 `projectId` → `knowledge_project_mismatch`）、**`propose` 不传 `hostCheck`**（新条目只能落 `candidate`，模型不能自证 `user-confirmed`）、**证据 `file` 必须过 `isSafeRelativeRef`**（绝对路径 / `..` / NUL 全拒） |
| 自动检查 | `typecheck`（含 CSS / layer 自检）/ `build` 干净；单测 **2787/2787**（本片 **+14**：能力服务三个命令已登记、`yan knowledge --help`、动作表与用法一致性、`isSafeRelativeRef` 八条边界）。**同轮踩到并修掉一个真错误**：`GROUP_USAGE.knowledge` 里嵌了反引号 → 整个 CLI 语法错误（与 02-S3 同一个坑，靠 `node --check` + 真跑 `--help` 的既有断言当场拦住） |
| 真实运行 | **新场景 `knowledgecli`（cost 1，deepseek）**全绿：模型自己执行 `yan knowledge search --query-text "发布流程怎么走"`（回执里出现 fixture 条目 `kn-deploy`）、`yan knowledge propose --kind fact --text …`（落成候选）、`--projectId proj-other` **被拒**（回执里带可读错误）。退出后回读沙箱：manifest `revision=2`、共 2 条（active 1 / candidate 1）—— **工具执行了 ≠ 写进去了**两边都看了。回归：`knowledgeinject`（cost 1）与 `subagent` / `pending`（cost 0）重跑绿 |
| 视觉验收 | 不适用 + 原因：本片无界面改动（设置页 / 知识列表是 03-S5） |
| 应用与包 | 不适用 + 原因：未改打包配置；`resources/yan-cli/yan.mjs` 的落位由既有 `test:packaged` 的「CLI 真跑」断言覆盖（本片只改它的内容） |
| 剩余限制 | ① **设置页与候选确认 UI 未做（S5）**：候选条目现在只能靠宿主 / 后续 UI 升为 active；② `propose` 的「越界来源」只有纯函数单测与实现层校验，**没有 live 断言**（要模型手写带 `evidence.file` 的请求文件，不稳定；第一道门 `isSafeRelativeRef` 已单测）；③ 没有 `knowledge confirm/delete` 子命令（删除与确认要用户动作，归 S5 的界面路径）；④ `knowledgecli` 是 cost 1，不进 `npm run check` |

### 本轮（2026-09-19）实施-03 S3 · 项目知识检索与注入

> 主题文档：[实施-03](../archive/plan/实施-03-项目知识与旧记忆清理-已完成.md) §5（读取口径）。这一片把 S2 的存储接成
> 「宿主检索 → 每会话一份注入文件 → 薄层钩子放到用户消息之前」；**UI 与 `yan knowledge` CLI 仍属 S4/S5**。

| 六栏 | 证据 |
|---|---|
| 实现 | **新** `src/shared/project-memory-search.ts`（字符 bigram + ASCII 词 + 标签加权、只取 `active`、`top 8` / 2k 预算 / 单条上限、无相关项零注入、`renderKnowledgeBlock`）；**新** `src/main/project-knowledge.ts`（宿主检索 → 原子写 `YAN_DIR/project-knowledge/_inject/<会话键>.json`，**关闭/无项目/无命中都写空块**；`readProjectKnowledgeEnabled` 直读 `desktop.json`，**不经 Electron `app`**）；**新**薄层 `resources/pi-extensions/project-knowledge.js`（`before_provider_request`，位置同 `language.js` 的实测结论）；`agent.ts` 新增 `prepareKnowledge`（send / steer / followUp 里 await）+ `projectKnowledgeExtension` 选项与 `--extension`；`settings.ts` / `shared/ipc.ts` 加 `projectKnowledge` 字段（默认关）；`index.ts` 路径注入 |
| 自动检查 | `typecheck`（含 CSS / layer 自检）/ `build` 干净；`audit:refs`：`brokenDocLinks: []`；单测 **2773/2773**（本片 **+75**：检索纯逻辑 39 + 注入链 36）——包括「无关查询零注入」「`candidate`/`superseded`/`deleted` 连打分都不参与」「预算装不下宁可不注入」「关闭后文件被覆盖为空」「会话键里的路径分隔符被替换」「扩展幂等 / 空块 / 缺会话键都不动 payload」 |
| 真实运行 | **新场景 `knowledgeinject`（cost 1，deepseek）**全绿，三回合：① 开启 + 中文查询 → 诊断 `inject` 3 次且 ids 含 `kn-deploy`、注入块 152 字符；② 从设置里关掉 → 下一轮 `injected:false`；③ 重新开启 + 无关查询（数据库连接池）→ 注入文件 `reason=no-match` / `block` 0 字符（**开启着也不注入**）。每次跑完「✓ 没有残留的 pi 进程」。**真实链路抓出三个真问题**：① `yanThinExtensionPaths()` 只是**诊断清单**，真正传给 pi 的是 `AgentController` 的逐项选项 —— 新扩展没接进 `--extension`，于是「注入了 0 次」；② 会话键不一致（宿主 `state.sessionId` vs 扩展 `YAN_SESSION_ID`）→ 宿主写 `<稳定 id>.json`、扩展读 `r1.json`；③ Windows 上 `rename` 覆盖已存在文件偶发失败且被 `catch` 吞掉 —— 注入文件永远停在第一轮的 `enabled:true`（开关看起来生效而磁盘没生效）。三处都已修并重跑验证 |
| 视觉验收 | 不适用 + 原因：本片**无界面改动**（开关的设置页是 03-S5）。注入效果不在截图里，而在扩展诊断与注入文件中——两部分都已作为 live 证据列出 |
| 应用与包 | 不适用 + 原因：未改打包配置 / 启动参数；`resources/pi-extensions` 是**整目录随包**（`electron-builder.yml`），新扩展自动包含，落位由既有 `test:packaged` 的启动器与扩展加载断言覆盖 |
| 剩余限制 | ① **开关目前只能手改 `desktop.json` 的 `projectKnowledge.enabled`**（设置页 S5、`yan knowledge` CLI S4）；② 检索结果的「需复核」标记需要当前分支 / 路径，本片**没有传**（`reviewNeeded` 恒为 false）——接入点是 `prepareProjectKnowledgeInjection` 的 `current`；③ 知识条目目前只能由测试 fixture 写入（写入通道归 S4）；④ `knowledgeinject` 是 cost 1，**不进 `npm run check`**；⑤ 注入对**新请求**生效（符合 §6 的「下一请求必须生效」，不追改已发出的请求） |

### 本轮（2026-09-19）子代理委派：模型 `yan subagent …` + 输入区显式入口

> 这一轮把已有的子代理进程管理接成**三条发起路径共用同一条运行**：输入区按钮 / `/subagent` /
> 模型侧 `yan subagent …`。顺带修掉两处被并行改动带出来的回退（`yan` CLI 的校验顺序、
> `runners` 快照刷新）—— 两者都是**已有契约被破**，不是新需求。

| 六栏 | 证据 |
|---|---|
| 实现 | 能力面三件套成对登记：`capability-server.ts` 的 `KNOWN_COMMANDS` 加 `subagent.{start,list,get,stop}`；`agent.ts` 新增 `SubagentCommandHost` / `SubagentCommandContext` + `runCapabilityCommand` 的 `subagent.` 分支（**不注册模型工具**）；`resources/yan-cli/yan.mjs` 加 `GROUP_SPECS` / `GROUP_USAGE`。宿主实现是 `index.ts` 的 `subagentCapabilityHost`（与 UI 共用同一个 `SubagentController`，不暴露 merge/discard），说明文案加进 `capability-guide.js`。UI：`SubagentList.tsx` 加显式「调用子代理」入口（任务面板 + 只读开关 + Ctrl+Enter），详情卡改为**主工作区内联**（`.sp-main`，限高 `min(28vh, 260px)`），`RightPanel` 不再承载子代理详情；`shared/subagent-command.ts` 收拢 `/subagent` 解析（前置/尾置 `--read-only` 等价）。子代理不再是会话级状态：`session-runtime.ts` / `store.ts` 的快照投影去掉 `subagents`，只留全局 store。**能力面计数**：`yan` 已登记命令从 10 增至 **14**（新 4 个都真实现），未实现差集仍是 8 个（04-S1 记录的地基数字需要按这个增量读） |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）与 `build` 干净；单测 **2698/2698**。**修掉两条真回退**：① `yan.mjs` 曾在参数校验之前就检查 `YAN_CLI_*` 身份，导致 `yan browser navigate`（漏 `--url`）报「宿主不可用」（3）而不是用法（2）—— 已把身份检查移回**本地校验之后**，并补一条「子代理每个动作都在用法里」的断言；② 单测里「动作表」断言抓的是**第一个** `actions:`，新增 subagent 组后误抓成它的动作表（4 条红），已改为**按组名**取 |
| 真实运行 | `test:live -- live pending`（cost 0）✓；**`pendingreal`（cost 1，deepseek）✓** —— `runners[active].running` 在回合结束后真的刷成 `false`、待定消息自动按 `followUp` 投出（若不带回 `pushFrom` 里那句 `pushRunners()`，这一条必红）；`subagent`（cost 0，真起 pi 子进程）✓ —— 新入口三条断言（按钮 / 面板 / 输入）+ 停止路径照旧；**`subagentmodel`（cost 1）✓**（首跑抓出「模型启动的 run 不会自动打开详情」，修掉 store 的 `subagent` 分支后重跑全绿）—— 模型自己 `yan subagent start` → `yan subagent get`，列表与详情都实时出现。每次跑完都是「✓ 没有残留的 pi 进程」 |
| 视觉验收 | `YAN_MATRIX_ONLY=subagentlaunch,subagent YAN_MATRIX_STAMP=2026-09-19sb` 跑全 8 组 → `matrix-subagentlaunch-1440x900-100-{dark,light}-2026-09-19sb.png`、`matrix-subagent-1440x900-100-{dark,light}-2026-09-19sb.png`（4 张，溢出 0px，**已看图**：入口行 + 上浮面板 + 只读开关 + 两个动作；详情卡含任务 / cwd·模型·隔离 / 父会话 / 变更审阅 / 转录 / 停止）。首拍（stamp `2026-09-19sa`）当场抓出**状态串味**（上一态的委派面板没关，遮住详情卡）—— 已修并重拍，旧批次原样保留。两张新状态已进组 0/1 |
| 应用与包 | 不适用 + 原因：未改打包配置 / 启动参数；`yan.mjs` 仍在 `extraResources` 的既有落位里（由 `test:packaged` 的启动器与 CLI 真跑断言覆盖），本轮未产出新产物 |
| 剩余限制 | ① 详情卡在输入区上方，运行时会把消息区压窄（`.sp-main` 限高 `min(28vh, 260px)`，长转录只能在卡内滚动）—— 这是当前落位，若要改回右栏或独立窗口需要新片；② 子代理是全局资源：**非 active 会话**里启动的 run 也会出现在当前视图的列表里（有意，但列表还没按会话分组）；③ `subagent` 场景标 `cost: 0`，但它真起一个子代理 pi 进程、会调一次模型；④ `yan subagent start --model` 只校验长度，模型名是否可用由子代理进程回传；⑤ `subagentmodel` 是 cost 1，**不进 `npm run check`**（照既有约定） |

### 本轮（2026-09-19）用户报的 1 条 —— 待定消息在回合结束后自动投递

> 用户原话：「当模型结束输出时 发送的消息应该直接发出」。
> 现象：用量条已经显示「用时 8.0s」（回合已结束），但待定卡片还挂着「插话 / 排队」。

| 六栅 | 证据 |
|---|---|
| 实现 | `src/main/index.ts` 的 `pushFrom`（所有 agent 事件的**唯一出口**）：每条 `ch: 'state'` 推送顺带刷一次 `runners` 快照。改一处 + 写清「为什么不比对变化再推」 |
| 自动检查 | `typecheck`（含 CSS / layer 自检）/ `build` 干净；单测 **2684/2684**（本片无纯逻辑改动，条数不变） |
| 真实运行 | **新增 cost 1 场景 `pendingreal`**（`scripts/probe/pending-real.js`）走真实链路：真模型回合 → 跑着时按 Enter 悬起 → 回合结束 → 自动按 `followUp` 投出。断言 **7/7**，其中「回合结束后 `runners[active].running` = false」是修复点的直接证据（修复前会停在 true），投递方式实测 `[null, "followUp"]`。回归 `pending`（cost 0）通过、无残留 pi 进程 |
| 视觉验收 | 不适用 + 原因：无视觉元素变化（卡片样式与按钮未改，改的是「什么时候不再是插话时机」） |
| 应用与包 | 不适用 + 原因：未改打包配置 / 启动参数 / `resources/` |
| 剩余限制 | ① 只在**当前 active 实例**路径上取证：多实例并行时，非 active 实例的 `running` 仍只在生命周期事件里刷（左栏状态槽可能要等下一次切会话才对得上）；② 新增的 `pendingreal` 是 cost 1，**不进 `npm run check`**（照既有约定，付费场景手动跑） |

**根因**：`runners[active].running` 是渲染端判断「回合还在跑」的依据（`Composer` 的待定
消息自动投递、`QueueStack` 的「插话 / 排队」二选一），但这个快照原先**只在实例生命周期
事件里推**（起停 / 切会话 / 删除）。回合结束（`agent_settled` → `setAgentRunning(false)`）
只走 `state` 通道 —— 快照一直停在 `running: true`，于是待定消息永远等不到自动投递。

**为什么老探针测不出来**：`pending`（cost 0）直接把 store 的 `runners` 改掉来伪造
「回合结束」，绕过了主进程推送链 —— 它验的是探针自己的假设，不是产品链路。
**教训**：探针自己伪造上游状态时，被测的往往是探针的假设；这条 bug 是真实链路
（`pi -p` 子代理派发）跑出来的。

### 本轮（2026-09-19）并行编排 W1 · 四个子代理片（01-S4b / 03-S2 / 04-S1 / 08-S0）

> 编排方式见 [并行代理编排](../plan/active/编排-并行代理分工-2026-09-19.md)。这三片由**本机 `pi -p` 非交互子代理**
> 并行完成（同一工作区，靠**文件域隔离**）；主编排者已核对文件域与 mtime（未碰该文 §0.2 的五个热点）。
> 证据取自各自的产出文档与子代理报告；**`build` 未由编排者复跑**（当时 01-S4b 正占用 `out/`）。

#### 01-S4b · `browser.js` 模型工具 → `yan browser …` CLI（**P0 硬阻塞，已解除**）

> 主题文档：[实施-01](../plan/active/实施-01-默认pi架构迁移.md) §4/§5（矩阵 browser 行已改判「已等价」）；证据：[证据-01-S4b](../archive/evidence/证据-01-S4b-browser-CLI迁移.md)。

| 六栏 | 证据 |
|---|---|
| 实现 | `resources/pi-extensions/browser.js` **零注册**（16 个 `browser_*` 工具 + 1 个 pi 斜杠命令全部移除，留空占位）；`src/main/capability-server.ts` 登记 **19 个 `browser.*`**（`browser.evaluate` **有意不登记**，403 语义保留）；`src/main/agent.ts` 新增 `BrowserCommandHost` + `runBrowserCommand`（19 个动作，**直接调宿主 `BrowserController`，不再绕 loopback bridge**）+ `CapabilityCommandError` 错误分流；`src/main/browser.ts` 五个动作 `private` → public + 新增 `public screenshot()`（**仅可见性，权限 / 网络边界一行未动**）；`resources/yan-cli/yan.mjs` 加 `yan browser` 用法与本地校验；`src/main/index.ts` 注入 `browserHost` |
| 自动检查 | `typecheck` / `build` 干净；单测 **2684/2684**（新增 17 条：`browser.js` 零注册、`browser.*` 已登记、`browser.evaluate` 仍 `unknown_command`、CLI help / 错误码 / 退出码分层） |
| 真实运行 | `test:live -- browsercli`（cost 0，默认不上屏）**全绿**；`YAN_SHOW_WINDOW=1` 补 `scroll`（347ms）/ `screenshot`（PNG 1564B，魔数正确）；**`test:live -- browserclimodel`（cost 1）通过两次** —— 模型自己 `yan --help` → `yan browser --help` → `navigate` → `state` → `observe` 并答出 URL（**端到端最小闭环**）；回归 `browser` / `browserboundary`(L04) / `slashcmd` **3/3 通过**（边界未放宽）；错误全是**带 code 的可读 JSON**（`browser_not_open` / `missing_ref` / `invalid_number` / `USER_CONTROL_ACTIVE`），未知子命令退码 2、无堆栈 |
| 视觉验收 | 不适用 + 原因：无界面改动（内置浏览器面板 UX 未动） |
| 应用与包 | 不适用 + 原因：打包归 09-S4（`yan.mjs` 在 extraResources 的落位由既有 `test-packaged` 覆盖） |
| 剩余限制 | ① `click` / `type` **无常驻自动断言**（需带元素的本地页面 fixture，**待拍板**）；② **隐藏测试窗口下 `mouseWheel` / `captureScreenshot` 不返回**（20s 超时）—— **迁移前就存在**，本片只记录复现，建议另开片；③ `ElementRegistry.ts` / `browser.ts` 的 `STALE_ELEMENT` 文案仍含旧工具名（非本片文件域，`agent.ts` 已把回给模型的文案改写成 `yan browser observe`；**2026-09-23 S5d 已把内部文案也改掉**）；④ `browsercli` 尚未加入 `npm run check` 清单（那一行在 `package.json`）；⑤ 空占位 `browser.js` 与已失效的 loopback bridge 建议 01-S5 一并清理 —— **对 S5 的能力影响：零**（**2026-09-23 S5d 已一并删除**） |

**卡面数字纠正**：实施-01 §4/§5 写「18 个 `browser_*`」，实测是 **15 处 `registerTool` = 16 个工具 + 1 个 pi 斜杠命令**（已在证据文档登记）。

#### 03-S2 · 项目知识存储层

> 主题文档：[实施-03](../archive/plan/实施-03-项目知识与旧记忆清理-已完成.md)；证据：[证据-03-S2](../archive/evidence/证据-03-S2-项目知识存储.md)（检索 S3 / CLI S4 / UI S5 **未开工**）。

| 六栏 | 证据 |
|---|---|
| 实现 | **新** `src/shared/project-memory.ts`（契约 + 纯逻辑：严格校验 / 文本指纹 / `projectId` **只认项目登记** / CAS + 状态迁移 + 墓碑）；**新** `src/main/project-memory-store.ts`（`YAN_DIR/project-knowledge/<projectId>/`：不可变 revision + 原子 manifest + 备份 + 索引重建 + 排他锁 + 落盘失败保留上一版）；`src/main/paths.ts`（**只加** `PROJECT_KNOWLEDGE_ROOT` / `projectKnowledgeDir()`）；**新** `scripts/test-project-memory.mjs`；`scripts/test-unit.mjs`（只加本片登记）。未碰 `agent.ts` / `capability-server.ts` / `yan.mjs`（S4 能力面），未新增 pi 扩展 |
| 自动检查 | `typecheck`（含 CSS / layer 自检）/ `build` 干净；单测 **2667/2667**（本片 **+153**，14 节）。五条出口全是**真实文件**断言：CAS 冲突（`stale_revision` + 交回 `latest`/`latestManifest` + manifest 逐字节未变）· 磁盘写失败（正文阶段 / manifest 阶段各一次 → manifest 保持上一版且版本没涨）· 崩溃恢复（截断 / 形状不对 → 从 `manifest.json.bak` 恢复上一版；两边都删 → 由 revision 重建并跳过写了一半的 `r99.json`；都坏且不可重建 → `unreadable` 且拒写）· 删除后旧候选不复活（逻辑 / 永久两种，永久删除后整个项目目录搜不到正文；同指纹再提 → `revives_deleted`）· 过期锁核实进程后回收（真子进程拿已死 pid；**活着的 pid 即使 TTL 过期也不抢**） |
| 真实运行 | 本片**没有可运行的用户路径**（检索 S3 / CLI S4 / UI S5）；取证方式 = 单测在临时目录**真写 / 真坏 / 真恢复** + 回归 `test:live -- live`（cost 0）✓（无残留 pi 进程） |
| 视觉验收 | 无新视觉元素（存储层，无 UI 入口）；项目知识页在 S5 |
| 应用与包 | 未做（随 01-S5 / 09）；**不新增运行期资源**（数据写在 `YAN_DATA_DIR`，`resources/` 与 electron-builder 未改） |
| 剩余限制 | 无检索（索引只有「指纹 → 指针」，n-gram 归 S3）；无调用方（只被单测调用）；逻辑删除**还没有 restore API**（数据层可恢复，`listKnowledge({includeDeleted:true})` 读得到）；孤儿 revision 无 gc（只清 `*.tmp`）；同机 pid 复用时锁只能等（出口是删 `lock.json`）；别的主机的锁只按 TTL + 宽限回收（`kill(pid,0)` 不跨机）；未做双进程抢锁压力测试；`validFor` 的「需复核」判据还没有真实会话喂过它 |

#### 04-S1 · 技术预检（能力自主选择的地基）

> 主题文档：[实施-04](../plan/active/实施-04-能力自主选择-MCP与Skill.md)（S2–S7 **未开工**）；证据：[证据-04-S1](../archive/evidence/证据-04-S1-技术预检.md)。
> 本片**只产证据、零模型调用、零产品代码改动**。

| 六栏 | 证据 |
|---|---|
| 实现 | **无产品代码改动**。新增 `docs/archive/evidence/证据-04-S1-技术预检.md`；`src/**` / `resources/**` / `scripts/**` 一行未动 |
| 自动检查 | 不适用 + 原因：无代码改动，`typecheck` / `build` / `test:unit` 的输入未变（当时另有代理在构建）。代之以可复现探针：`npm run upgrade:pi -- --check`、`npm run vendor:pi:check -- --if-present`（内置 0.85.1 + RPC 握手正常） |
| 真实运行 | ① 真 pi × 2 种 `execPath`：`resolvePi()` → `source=bundled`、版本 **0.85.1**（node 与 electron 一致）；② 真 RPC 会话（隔离 agentDir，零模型调用）：`get_commands` 拿到技能名 + 绝对 `SKILL.md` 路径；**`get_tools` / `set_active_tools` / `mcp_list` 全部 `Unknown command`**；③ 真 `CapabilityServer` × 真 `yan.mjs` 7 条调用（`not_implemented` / `unknown_command` / `ok:true` / `identity_mismatch` + 退出码 1/0/1）；④ 附带发现：改副本 `package.json` 版本号后 `--version` 跟着变但仍能 RPC 握手 → **内置运行时的 `--version` 读的是 vendor 生成的 `package.json`，不是完整性证明** |
| 视觉验收 | 不适用 + 原因：无 UI / 渲染端改动 |
| 应用与包 | 不适用 + 原因：未改打包产物。记录两条与包有关的实测：`resolvePi` 在 Electron `execPath` 下仍解析到 `resources/pi-runtime`（未退回全局 pi）；随包 SDK 入口 `bundle/index.js`（151 导出，`VERSION=0.85.1`） |
| 剩余限制 | 只钉接口面，**未做真模型验证**（技能选择 / `yan` 调用是 04-S2/S4 的 cost 1 出口）；技能正文只做**代码级**确认，未真跑 `/skill:<name>`；技能发现的项目信任门未构造场景；**MCP 官方 SDK 不在任何 lockfile**（S3 必须新增依赖并自行验证版本） |

**本片固定的地基**：运行时 pi **0.85.1** / RPC 命令 **33 个**（**无**工具面、**无** MCP 面、**无**技能正文面）/ `yan` 命令面 **10 个已登记**，其中只有 `operations.status` 与 `tasks.apply` 真实实现（**差集 8 个**：`capabilities.{search,discover,prepare,acquire}` / `skill.read` / `mcp.{describe,call}` / `knowledge.search`）。
**待拍板**：① 主进程是否改用官方 SDK（`bundle/index.js` + `RpcClient`）—— 与「主进程不 import pi 内部模块」的纪律冲突；② `yan skill read` 是否还要做（若走 `get_commands` 发现 + `/skill:<name>` 展开，它可能永远用不上，但会出现在 `/` 补全里）。

#### 08-S0 · 连接状态机与能力边界冻结

> 主题文档：[实施-08](../plan/active/实施-08-安卓远程管理.md)。**零代码、零产物**；结论要喂 08-S1 / S3。

| 六栏 | 证据 |
|---|---|
| 实现 | 新增 [远程-连接状态机-2026-09-19.md](../design/active/远程-连接状态机-2026-09-19.md)（版本 `RC-SM/1`，526 行）：六态词表、**21 事件 × 6 态 = 126 格**迁移表（含非法迁移、幂等 `(i)`、不适用 + 理由）、授权轴（5 态，与连接态**正交**）、`pairing` / `auth` / `transport` 抽象状态、能力可用性矩阵（11 能力 × 6 态 + 可求值的前置条件模型与**唯一**失败原因优先级）、断线语义（重连退避形状 / 进行中操作三类 / **写操作 `uncertain` 绝不自动重发** / 按 `epoch` + 水位路由迟到响应）、错误分类（8 类，含「401≠403」「503 未就绪≠网络故障」）。同步 `REMOTE-CONTROL.md` 增一节。**未改任何 `src/**` / `resources/**`** |
| 自动检查 | 不适用 + 原因：本片零代码，没有可执行检查对象。文档内已定义 S1 要落地的两条可断言不变量：① 全部 126 个 `(状态, 事件)` 调用归约函数不抛异常且结果落在六态内；② 所有 `✘` 组合返回状态与输入状态完全相同 |
| 真实运行 | 不适用 + 原因：无运行时代码；现有 `/remote/v1/*` 行为与证据不变 |
| 视觉验收 | 不适用 + 原因：无界面改动（协议无关原型属 08-S3）。本文只对原型施加约束：前置不满足的能力默认隐藏、降级必须显式标注、§10 的实现选择画法不得出现在原型里 |
| 应用与包 | 不适用 + 原因：未改打包配置 / 启动参数 / `release/`；远程服务「默认关闭」口径未变，仍归 09 |
| 剩余限制 | 本文是**设计冻结，尚无实现**：`pairing` / `permission` / 撤销 / 定向 `runId` 停止 / 事件 id 与重放全部缺失（逐项差距见该文 §11），归 S1/S2。**三项留给人拍板**：能力清单是否免鉴权、撤销时缓存清除的执行位置、自动重试上限与退避数值（形状不改，数值可调）。**本片附带发现两个现有缺陷（未修）**：`POST /sessions/:id/messages` 隐式 `select` 抢走电脑当前视图；`POST /runs/abort` 没有目标 `runId` |

### 本轮（2026-09-19）实施-03 S0 / S1 · 边界复核 + 旧记忆残留清理
> 本片是**清理与说明校正**，不改行为 —— 所以没有新 live 场景（理由见「真实运行」栏）。

| 六栅 | 证据 |
|---|---|
| 实现 | `src/main/agent.ts`（去掉「与 remember 处理同一套路」的过时类比，改为「旧扩展 `panel_todos` 与宿主 `yan tasks apply` 在同一次刷新里汇合」）；`src/main/paths.ts`（历史叙述→**数据目录职责**，保留「旧 `memory.json` / `soul.md` 不主动删」）；`scripts/test-live.mjs` / `scripts/test-packaged.mjs`（隔离文案改成「会话、派生状态与 localStorage」）；`docs/ARCHITECTURE.md`（边界补「项目知识是独立新功能、**尚未实施**」）；`docs/dev/CODE-MAP.md`（`paths.ts` 改为当前职责）；`docs/design/DESIGN.md`（空状态那一行的「记忆现状」改成实际实现）；实施-03 §2 新增**保护集**表 |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）/ `build` 干净；单测 **2510/2510**（本片只改注释与文案，无纯逻辑改动）；`audit:refs`：`brokenDocLinks: []`、`docScripts.unknown: []` |
| 真实运行 | 本片的出口是**检索类**的，不是行为类：全仓 memory 关键词逐项归类（代码侧命中里**只有 1 处**是要改的过时类比，其余全是保护集）；**旧入口零 import**（无 `memory` 模块 import）；保护集逐项查活：`context_recall` 2 文件 / `rememberSession` 2 / `rememberCursor` 1 / `capability-guide` 5。**未新增 live 场景** —— 本片不改任何行为，为「注释是否准确」造 probe 不如直接把归类结果与 grep 证据写下来 |
| 视觉验收 | 无新视觉元素（`DESIGN.md` 改的是**描述性文字**，且改为与 `EmptyStream.tsx` 实际一致；**未动任何设计令牌**）。空状态的视觉证据沿用既有 `matrix-main` 系列 |
| 应用与包 | 未做（随 09-S4）；本片不改运行期资源 |
| 剩余限制 | 「保护集」是**人工判定**（关键词归类），以后新增代码命中同类词时**复用这张表**而不是重新猜；`docs/archive/**` 里的历史叙述**故意未改**（§2 规定历史证据不批量改写）；03 的新功能（S2–S6：存储 / 检索 / CLI / UI / 跨会话）**完全未开工** |

### 本轮（2026-09-19）实施-09 S1 · 两条遗留缺陷（窄窗 48px 残留 + fs 键盘导航）

> 主题文档：[实施-09](../plan/active/实施-09-交付与验收收尾.md) S1。两条都是 2026-09-18 核查时发现、当时只有
> 「待修」结论的真缺陷（见下文「六」节）。本片把它们修到有根因、有反向验证。

| 六栏 | 证据 |
|---|---|
| 实现 | `src/renderer/src/styles/layout.css`（两处窄窗媒体查询里 `.app.rail-off .workspace` 的 `--w-rail: 48px` → `var(--w-rail-collapsed)`）；`src/renderer/src/components/toolbar/FileTree.tsx`（新增 `visibleSet`，`TreeLevel` 改按集合渲染、删掉跨层级 `budget`）；`scripts/probe/narrow.js`（断言从「意图级」收回硬值 0）；`scripts/probe/fs.js`（End 诊断现在区分「焦点在根行」与「焦点掉到 body」；3c 改用 `mouseClick` 模拟真实鼠标聚焦 + 条件轮询） |
| 自动检查 | `typecheck`（含 CSS 约定 / layer 自检）、`build` 干净；单测 **2510/2510**（本轮无纯逻辑改动，条数不变） |
| 真实运行 | **cost 0**：`fs` **全部通过**（此前稳定红的 3 条全清）；`narrow` 三档窗口（1456×1000 / 1002×700 / 940×700）全通过，收起后实测 `rail=0px`；回归 `railmini` / `toolgroup` 全绿 —— 后者顺带补上上一轮「工具组高度改成 25 条后没重跑」的尾巴（第 6 节「组展开后有显示范围」） |
| 视觉验收 | `matrix-railmini-940x620-100-dark-2026-09-19s1.png`（窄窗收起：消息区贴到窗口左缘、无竖条，**已看图**）、`matrix-railmini-1440x900-100-{dark,light}-2026-09-19s1.png`、`matrix-fsnarrow-1440x900-100-dark-2026-09-19s1.png`（文件树层级 / `noperm` 无权限态 / 「已隐藏」均正常，**已看图**）。⚠️ **修复前的视觉对照不可靠**（旧批次隔着其它改动，像素比对显示差异落不到「少一列」上）→ 改动前后的判据改用 **A/B 数值实测**（见下） |
| 应用与包 | 未做（随 09-S4 统一补）；本片不改运行期资源清单 |
| 剩余限制 | 48px 那条只有**数值对照**、没有同环境的「修复前」截图；fs 那条第 3 条红（鼠标收起）确认是**测试没有模拟真实鼠标聚焦**（合成 `MouseEvent` 不触发浏览器默认聚焦），产品行为本身正确 |

**两条缺陷的根因与反向验证**（写清楚，避免后人再踩）：

1. **窄窗 48px 残留**：窄窗媒体查询里那条 `.app.rail-off .workspace { --w-rail: … }`（特异性 0,3,0）
   **必须留着** —— 它要压过同媒体查询里 `.workspace` 自己的 `min(--w-rail-user, …)` 声明（否则收起会退回展开宽度）；
   但值写死了**旧紧凑图标轨的 48px**，轨删了它却留下。修法是值改走同一个真源 `--w-rail-collapsed`。
   **A/B 反向验证**：临时改回 48px → 1002×700 与 940×700 两档实测 `rail=48px`、硬断言变红（宽窗口那档仍是 0）；
   改回 `var(--w-rail-collapsed)` → 三档全 `0px` 通过。
2. **fs 文件树键盘导航**：`allVisiblePaths` 是严格 DFS，而渲染截断用的是跨层级 `budget`
   —— 父层 `TreeLevel` 的循环**先把自己那一层的额度扣完**，子层是 React 之后才递归渲染的，于是成了**两套顺序**。
   超限时被切掉的位置不同：`End` 取到的 `visiblePaths[49]` 根本没渲染
   （逐帧观测日志 `{"path":"src/main/subagent-isolation.ts","found":false}`，而 DOM 最后一行是根层的 `tsconfig.web.tsbuildinfo`），
   `focus()` 找不到节点就静默失败、焦点留在原处，`focusPath` 被设成幽灵路径后**所有行 `tabIndex` 都成 -1**（连带 roving 那条）。
   修法是渲染直接以 `visibleSet`（由 `visiblePaths` 派生）为准，顺序天然只有一份；
   修后同一条日志变成 `found:true / after=row:src/main/subagent-isolation.ts`。

### 本轮（2026-09-18）实施-02 S5 · 真实运行与验收（02 收尾）

> 主题文档：[实施-02](../archive/plan/实施-02-任务工具内置化-已完成.md)；证据：[证据-02-S5](../archive/evidence/证据-02-S5-真实运行与验收.md)。
> 本片**不新增业务代码** —— 它把 S1–S4 的成果放到真实模型 + 真实窗口 + 真实安装包里验。

| 六栏 | 证据 |
|---|---|
| 实现 | 新场景 `scripts/probe/taskplan.js` + `CASES.taskplan` + `afterExit: taskPlanMultiStep`（退出后逐条比对界面与磁盘）；`taskcli` 新增「取消」一节；新 fixture `scripts/fixtures/task-ext/notes-panel.ts`（**无关扩展**）+ `taskext` 4 条新断言；`test-packaged.mjs` 新增 11 条（静态落位 / 启动器 5 / CLI 真跑 3 / 无宿主可读错误 3）；`test-unit.mjs` 新增 9 条「证据链前提」；**真问题修复**：`test-live` 与 `test-packaged` 现在都剥掉 `YAN_CLI_URL/TOKEN/SESSION_ID/PROJECT_ID`（以及 `ELECTRON_RUN_AS_NODE`） |
| 自动检查 | `typecheck`（含 CSS / layer 自检）/ `build` 干净；单测 **2510/2510**（本片 **+9**）；`dist:dir` 后 `test:packaged` **11 条新断言全绿** |
| 真实运行 | **cost 1**：新场景 `taskplan` 一次全绿 —— 模型自写请求文件、5 次 `yan tasks apply`、建出 `step-1/2/3.txt`、界面 3/3 完成；`revision` 1→2→3→4；**界面与磁盘日志逐条相同**；会话 JSONL 无任务条目。`taskcli` 回归 + 取消 4 条。**cost 0**：`taskext`（旧扩展 + 无关扩展共存）、`slashcmd`、`todos`、`todonew`、`sessions`、`historyswitch` 全绿 |
| 视觉验收 | `matrix-taskhost-1440x900-100-{dark,light}-2026-09-18s5.png`（任务 + 历史折叠区）、`matrix-taskcard-1440x900-100-{dark,light}-2026-09-18s5.png`、`matrix-taskcard-900x520-100-dark-2026-09-18s5.png` —— **5 张已看图、溢出 0px**；旧图未覆盖 |
| 应用与包 | `npm run dist:dir` → 安装目录 `resources/` 下 `app.asar` / `pi-extensions` / `pi-runtime` / **`yan-cli`** 四件齐全；`test:packaged` 验了启动器生成与内容指向、**解包里 CLI 真跑 `--help`**、无宿主时 `tasks apply` 退码 3 且报可读原因 |
| 剩余限制 | **包里「模型触发任务工具」未验**（要真实凭证进隔离 piDir；等价覆盖是开发态两条 cost 1 场景，打包带来的差异已单独验过）；**磁盘错误与两个快速 add 只有单测**（在 Electron 里不可复现，造偶发场景比没场景更糟）；`taskplan` 依赖模型照做（提示给死形状，无强制机制，红时先看探针打印的「工具调用序列」）；失败恢复四类有证据、一类只有等价覆盖（证据 §5 逐项列了） |

### 本轮（2026-09-18）实施-02 S4 · UI 与命令接线

> 主题文档：[实施-02](../archive/plan/实施-02-任务工具内置化-已完成.md)；证据：[证据-02-S4](../archive/evidence/证据-02-S4-UI与命令接线.md)。

| 六栏 | 证据 |
|---|---|
| 实现 | **新** `src/shared/tool-origin.ts`（`yan tasks apply` 的文本判定 + 一行化摘要）；`ToolRow.tsx` + `chat.css`（来源徐标）；`shared/ipc.ts`（`hiddenInMenu` / `BuiltinCapabilityView` / `YanBridge.builtinCapabilities`）；`command-registry.ts`（`/panel` 隐藏但保留）；`Composer.tsx`（补全过滤 + 兼容分支改为「保留草稿与附件 + 推提示」）；`store.ts`（`notify`）；`extensions-inventory.ts`（`builtinCapabilities()` + 诊断文案改成当前事实）；`index.ts`（抽出 `yanThinExtensionPaths()` + `yan:capabilities:builtin`）；`preload`；`PackagesTab.tsx`（「砚内置能力」区，无卸载按钮）；双语 i18n；**修** `resources/yan-cli/yan.mjs` 的语法错误 |
| 自动检查 | `typecheck`（含 CSS / layer 自检）/ `build` 干净；单测 **2501/2501**（本片 **+48**：工具来源 27 + 命令注册表 8 + 内置能力与诊断 9 + 随包 CLI 真跑 4） |
| 真实运行 | `taskcli`（cost 1，deepseek 全绿）新增 4 条：工具行被标为砚内置任务计划 / 标记的仍是 bash 卡 / 徐标写「任务计划」/ 展开后能看到原始命令；`slashcmd`（cost 0）第 20 节：手打 `/panel` 后草稿逐字符未变、合成附件仍在、两句话说明原因、没发给模型；回归 `todos` / `taskext`（cost 0）全绿 —— 后者刚好覆盖「用户扩展也注册 `/panel`」：两条并存、命中兼容那条 |
| 视觉验收 | 新增 `taskcard` 状态（内置来源工具卡）→ `matrix-taskcard-1440x900-100-{dark,light}-2026-09-18s4.png` 与 `matrix-taskcard-900x520-100-dark-2026-09-18s4.png`（窄窗）；`settingspkg` 扩断言并重跑 → `matrix-settingspkg-1440x900-100-{dark,light}-2026-09-18s5.png`。**5 张已看图，溢出 0px**；看图改掉一处文案错误（内置能力区移到已装列表之后，「下面」→「上面」） |
| 应用与包 | 未做（随 01-S5 / 09）；本片不新增运行期资源（新 IPC 是只读查询，清单从既有 `--extension` 路径派生） |
| 剩余限制 | 工具卡来源是**文本判定**（`echo "yan tasks apply"` 也会被打标，已被单测显式记下）—— 不改变写入语义与权限，要精确得等 pi 把 toolCallId 给到子进程；只认 `tasks apply`，其余 `yan` 子命令仍是普通 bash 卡（属于 04）；`/footer` 只统一了反馈，没有迁移语义；`hiddenInMenu` 只影响补全、不影响 `commands` 列表（来源分布与同名断言仍能看到它） |

### 本轮（2026-09-18）实施-02 S3 · 宿主任务服务 + `yan tasks apply`

> 主题文档：[实施-02](../archive/plan/实施-02-任务工具内置化-已完成.md)；证据：[证据-02-S3](../archive/evidence/证据-02-S3-宿主任务服务.md)。

| 六栏 | 证据 |
|---|---|
| 实现 | **新** `src/main/task-plan-store.ts`（`YAN_DIR/task-plans/<sessionId>.jsonl`：只追加 + 同会话串行 + 从磁盘 CAS/幂等 + `fsync` + 回读校验）；`src/main/agent.ts`（`tasks.apply` handler、`refreshTodos` 合并宿主日志 + 旧条目、`currentUserRound`）；`src/main/capability-server.ts`（`CapabilityCommandError`：业务错误带 `code`、附件落文件）；`src/shared/task-plan.ts`（日志行读写 + `taskPlanLogEntry`）；`resources/yan-cli/yan.mjs`（help 补 `operationId` 重试语义）；`tools.css`（修历史任务条目「一列一个字」） |
| 自动检查 | `typecheck`（含 CSS / layer 自检）/ `build` 干净；单测 **2453/2453**（本轮 **+53**：store 35 条 + 日志行与条目形状 12 条 + 归并 6 条） |
| 真实运行 | 新场景 `taskcli`（cost 1，**不进 `check`**）全绿：模型敲 `yan tasks apply` → 界面 3 条 → `complete` 勾上 → 切走清空 → **切回从磁盘读回**；**退出后**核对日志 2 行 / `revision` 1→2 / 每行带 `schemaVersion`+`round`+`at` / 会话 JSONL 里**没有**任务条目。回归 `todos` + `taskext`（cost 0）全绿；`capability`（cost 1，`YAN_TEST_MODEL=deepseek/deepseek-v4.1-flash`）全绿 |
| 视觉验收 | 新状态 `taskhost`（组 0/1）：`matrix-taskhost-1440x900-100-{dark,light}-2026-09-18.png`，溢出 0px，**两张都已看图**。**这张图抓出并修掉一个既有缺陷**：历史任务条目的文字被挤成竖排单字（`.rp-box` 的通用 `grid-column: 2` 与历史条目的 2 列网格冲突），补 `.rp-hist-todo .rp-box { grid-column: 1 }` 后重拍正常 |
| 应用与包 | 未做（随 01-S5 / 09）；**不新增运行期资源**（任务日志写在 `YAN_DATA_DIR`） |
| 剩余限制 | 宿主日志**不在会话 JSONL 里**（pi RPC 没有写 entry 的命令，且 01 §5 禁止外部编辑在用的 JSONL）→ 用户用 pi 终端看不到这些任务；多 runner **真并行**未取证（单测已覆盖两会话隔离）；分叉（fork）后是否继承父清单未定也未测；`branchHead` 未落地（pi 的 fork ＝新会话 id，分支维度由会话 id 承担）；**`fs` 场景稳定红 3 条**（焦点 / roving tabindex，**AB 验证与本片无关**，待另行排查）；免费模型（longcat / laguna）本轮实测会空回复或不调工具，`deepseek/deepseek-v4.1-flash` 是可靠替代 |

**一个必须知道的实现偏差**：方案里写的「宿主日志」没规定物理落点，而 pi 的 RPC
**没有**「追加 custom entry」命令。而 01 §5 又明文禁止外部编辑正在使用的 JSONL、
也禁止用扩展 `appendEntry` 写新任务数据。所以落点是 `YAN_DATA_DIR/task-plans/<sessionId>.jsonl`，
界面把它按**与会话条目完全相同的形状**喂给同一套归并（规则只有一份）。
判定过程与代价登记在 [证据-02-S3 §1](../archive/evidence/证据-02-S3-宿主任务服务.md)。

### 本轮（2026-09-18）实施-02 S2 · 任务计划纯逻辑

> 主题文档：[实施-02](../archive/plan/实施-02-任务工具内置化-已完成.md)；证据：[证据-02-S2](../archive/evidence/证据-02-S2-任务计划纯逻辑.md)。

| 六栏 | 证据 |
|---|---|
| 实现 | `src/shared/task-plan.ts`（校验 / 六操作 reducer / 幂等 / 新旧载荷读写，517 行）、`src/main/todo-snapshots.ts`（改用 `normalizeTaskItems`，删掉本地别名表） |
| 自动检查 | `typecheck`（含 CSS / layer 自检）干净；单测 **2400/2400**（本轮 **+83**，新增 `test-task-plan.mjs` 10 节） |
| 真实运行 | 纯逻辑层**没有用户路径**（`yan tasks apply` 在 S3）；证据 = **真实临时文件往返**（读旧载荷 → `add` → 写新文件 → 读回三项/revision/operationId 一致，旧文件逐字节未动）+ 回归 `test:live -- todos taskext` 双绿 |
| 视觉验收 | 无新视觉元素（纯逻辑） |
| 应用与包 | 未做（随 01-S5 / 09）；不新增运行期资源 |
| 剩余限制 | 还没有写入方；幂等目前只在内存成立（跨进程/重启要 S3 从会话文件读回 `revision`/`operationId` 再比）；并发由 S3 的宿主服务串行保证；`toTaskPlanEntryData` 假定入参来自 reducer（S3 不要绕过） |

**本片相对前一版契约收紧四条**（都是「宁可不猜」）：`done` 非 boolean 报错（旧扩展 `Boolean('false')` → `true` 的坑）、
长度按 **code point** 数、超上限**不截断**、`uncomplete` 把 `status` 置回 `pending`
（否则右栏会继续显示「正在进行」——它以 status 优先）。

### 本轮（2026-09-18）实施-02 S1 · 兼容性与契约定稿

> 主题文档：[实施-02](../archive/plan/实施-02-任务工具内置化-已完成.md)；证据与契约定稿：[证据-02-S1](../archive/evidence/证据-02-S1-兼容性与契约.md)。

| 六栏 | 证据 |
|---|---|
| 实现 | `src/shared/task-plan.ts`（契约：精确标识 / 操作 / 上限 / 数据形状）、`src/main/todo-snapshots.ts`（收紧为精确标识 + 同轮宿主日志优先）、`src/main/extensions-inventory.ts`（扩展来源诊断）、`src/main/index.ts`（`ready-to-show` 之后推诊断）、`scripts/fixtures/task-ext/left-info-panel.ts`、`scripts/probe/taskext.js` |
| 自动检查 | `typecheck`（含 CSS / layer 自检）干净；单测 **2317/2317**（本轮 **+24**：白名单与宿主优先 6 条 + 来源诊断 18 条） |
| 真实运行 | `test:live -- taskext`（cost 0，**已进 `check`**）全绿：旧扩展真的被加载（`source=extension`）、启动通知降级、诊断三行、任务读自会话文件、切走清空、退出后前缀字节一致；`todos` 回归全绿（并挂上同一道退出后检查） |
| 视觉验收 | 新状态 `extdiag`（组 0/1）：`matrix-extdiag-1440x900-100-{dark,light}-2026-09-18.png`，溢出 0px，已看图（三行诊断完整可见、无裁切） |
| 应用与包 | 未做（随实施-01 S5 / 09）；本片不新增运行期资源，fixture 旧扩展只在 `scripts/fixtures/` 里、不进包 |
| 剩余限制 | 「宿主日志优先」目前只有单测（S3 才开始写）；旧扩展**仍被 pi 自动加载**（等 01-S5 + S3 收敛）；手打 `/panel` 仍会清空草稿且无反馈（S4）；诊断只列目录条目，不解析扩展、不判能否加载 |

**顺带修掉一个既有测试脆弱**（不是产品缺陷）：`todos` 第 6 节四条断言依赖探针**合成**的「回合运行中」状态，
而第 4 节刚连续切过会话 —— pi 的 hydrate 迟到地推一次真实 `state`（整体替换 `session`）把它清成 false，四条全红
（诊断打印过现场：`isAgentRunning=false`、`sessionId` 是刚切过去的无任务会话）。改为注入前**等一次静默**
（连续 1.5s 没有新 `session` 对象），不是加固定 `sleep`；AB 验证过（临时注释掉本轮新增代码，四条照旧红）。

### 本轮（2026-09-18 深夜）用户报的 5 条（上一条的**反向修正**也在里面）

用户原话逐条：**① 用户发送的消息默认悬浮在输入框上方 让用户自己选择是插话还是排队；② 项目文件夹应该默认显示前五个会话 其余进行折叠；③ 左边栏变为完全折叠 不要留下一个边框；④ 模型调用的工具和命令保持默认折叠 但是展开时应该有一个固定的范围 或者在最上方显示折叠回去的按钮（推理过程同理 但是推理过程的胶囊还是保留）**。

| 项 | 决定 / 根因 | 改法与证据 |
|---|---|---|
| ① 待投递悬浮 | **推翻上一轮的“默认插话”**：那次只是把主进程的默认值从 `followUp` 改成 `steer`，用户仍然没有选择权。现在消息先悬在输入框上方（**只存在于渲染端**），点「插话」或「排队」才投递 | IPC 链路加 `mode`（`agent.send(text, images, mode)` / `yan:send` / preload / `shared/ipc.ts`），主进程只在回合级 `agentRunning \|\| isStreaming` 时才带 `streamingBehavior`，`mode` 缺省仍兜底 `steer`（防 pi 报“Specify streamingBehavior”）。store 新增 `pendingSends` + `holdSend`/`releaseSend`/`restoreSend`（**失败不移除卡片**，不假装成功）；切会话 / 新会话 / 分叉 / 复制都会清空。判据是**回合级** `runners[active].running`（`session.isStreaming` 在工具执行期间是 false，正是用户最想插话的时刻）；回合结束后悬着的消息**自动按「排队」发出**（插话时机已过，且不能把消息丢掉） |
| ② 项目会话折叠 | 一个项目几十条会话时，展开态把下面的项目全挤出视野 | 新增 `SESSION_PREVIEW = 5` + 持久化的 `shownAllSessions`；「更多会话（N）」/「收起会话」两个出口。**当前会话落在折叠段里时自动多展开到它那一行**（`floor = max(5, currentIndex + 1)`）—— 不能把用户正待着的会话藏起来；只有真能收起来时才给「收起会话」（否则点了看着像没反应） |
| ③ 左栏完全折叠 | ⚠️ **产品边界变更**：N14 的 48px 紧凑图标轨（砚 / 搜索 / 新建 / 项目文件夹 / 设置）**已按用户要求删除**。它在深色主题下就是消息区左边一条颜色不同的竖条 —— 用户说的「边框」就是它 | `--w-rail-collapsed: 0px` + `.app.rail-off .rail { display: none }`；`Rail.tsx` 的 mini 轨 JSX（含 `miniMenu`/`miniHover`/`miniProjects` 与点外关闭的 effect）与 `rail.css` 的 `.rail-compact*` / `.rcm-*` 样式（150 行）一并删除。**展开入口只剩标题栏的开关**（`rail-toggle`）—— 项目入口退回「先展开左栏再切项目」 |
| ④ 展开要有固定范围 | **用户澄清后的准确范围**：他报的是「主动展开调用工具/命令栏的时候，给展开的条目一个显示范围，而不是铺开到整个界面」—— 指**工具组展开后那一长串调用条目**（他截图里那条组有 146 次调用），`.tgroup-body` 此前没有任何高度限制（第一次实现只做了单条详情，属于理解偏差）。同一条要求也落在单条详情与推理全文上 | **工具组**的高度按**条数**定：用户 2026-09-19 看过第一版（`min(70vh, 620px)`，900px 窗口下约 19–22 行）后要求「改为 25 条」，所以现在写的是 `min(625px, 80vh)`（行步进实测约 25px × 25 行 = 625px，确保第 25 行完整可见；不再挂 70vh，只在矮窗口下用 80vh 兜底）—— 列表的单位是“条”，就不再让它跟着 vh 跑。**单条详情** `.trow-body > :not(.term)`（**刻意排除终端窗口**：它自带高度与缩放手柄，套上会出现“终端外面还有一层滚动条”）与**推理全文** `.reason-body.clip.expanded`（原 `max-height: none`）是一段连续文本，“行”不是它们的自然单位，仍用 `min(70vh, 620px)`。三处卡住高度后 `tgroup-head` / `trow-head` / `reason-head` 都留在上方，**它们本身就是那个「折叠回去的按钮」**。⚠️ 这改掉了 AGENTS.md 里「展开全部不引入第二条滚动条」的旧边界 —— 那条是为**默认态**定的，展开全部是用户主动要看全文，已记入 DESIGN §3.5 |

**顺带修掉两个截图问题**：① `trashtoast` 视觉状态里那条合成会话时间戳较旧，新增的会话折叠把它藏了起来（`no-row`）—— 把 `railsessions` / `pendingcards` 排到组末（它们会改 `sessions` 与 `runners`，放中间污染后续 fixture）；② `toolgroup` 状态为了拍出“限高”要先造长组，但**不能整包替掉 `messages`**（后面 `wschanges` / `wsunknown` / `usageelapsed` 等 6 张图都靠 fixture 的消息，实测全变成缺件）—— 改成给已有的 assistant 消息**追加** toolCalls，并把长组放在页面靠上的那一条（放最后会有一大半截在视口外）。

| 六栏 | 证据 |
|---|---|
| 实现 | `src/main/agent.ts`（`send` 加 `mode`）、`src/main/index.ts`、`src/preload/index.ts`、`src/shared/ipc.ts`、`store.ts`（`pendingSends` + 三动作）、`Composer.tsx`（`roundRunning` 分支 + 待定卡片 + 自动投递 effect）、`Rail.tsx`、`composer.css` / `rail.css` / `layout.css` / `chat.css`、双语 i18n（`queue.hold` / `queue.steerNow` / `queue.queueIt` / `queue.sendNow` / `queue.restore` + tip、`rail.moreSessions` / `rail.foldSessions`）、`DESIGN.md` §3 / §3.5 |
| 自动检查 | `typecheck` / `build` 干净；**单测 1620/1620**（本轮没改纯逻辑） |
| 真实运行 | **新场景 `pending`（cost 0）**：空闲 Enter 直发 / 生成中 Enter 只悬着 / 插话=steer / 排队=followUp / 撤回回填草稿且不投递 / **工具执行窗口（running 真、isStreaming 假）也进待定区** / 回合结束自动按 followUp 投递 / 投递失败卡片留在原地 / **自动压缩期间（running 假、isCompacting 真）也进待定区，压缩结束自动 followUp**。重写 **`railmini`**（mini 轨已删）：默认只列前五条 + 更多会话 + 收起 + **当前会话在第 7 位时自动展开到 7 行** + 收起后 `display: none` / `--w-rail-collapsed = 0px` / `.workspace` 列宽 `0px …`。`reasoning` 展开后断言 `max-height` 有值 + 内部滚动 + **滚动时胶囊 top 不变**；`toolgroup` 新增**第 6 节**：造 60 条调用的组 → 上限生效 / 真的溢出（当时 `min(70vh,620px)` 下实测可视 548px、内容 1486px）/ **列表内部滚动时组头 top 不变**，并加“终端窗口没被上限套住”的反向断言。同批 16 个场景全绿（含 `sendkey` `layout` `vheight` `queuestack` `fs` `slashcmd` `queueretract` `autonomous` `modelnotready` `modelmenu` `settings` `trash`）；返工后又跑 11 个（含 `toolrow`）全绿。**随后用户要求把组高度「改为 25 条」**（当时暂写为 `min(623px, 80vh)`，后经实际行步进校正为当前 `min(625px, 80vh)`）—— 探针那条断言已同步改成“按实测行步进算可见条数、要求 ≥ 25”；该历史记录当时尚未重跑，现已由上方 2026-09-21 收尾复核补齐 |
| 反向验证 | ① 一次把四处改回旧行为（`if (roundRunning)` → 永假、`--w-rail-collapsed: 48px`、`.expanded { max-height: none }`、`SESSION_PREVIEW = 99`）→ `pending` / `railmini` / `reasoning` **3/3 变红**；② 去掉 `.tgroup-body` 上限 → `toolgroup` 第 6 节 **3 条红**（可视高度 1486px = 铺满）；③ 摘掉 `Composer` 里的 `isCompacting` 判据 → `pending` 第 9 节 **3 条红**：消息被**直接投出去**且 `mode` 为 `undefined`（正是改动前的裸 prompt 行为） |
| 视觉验收 | 视觉矩阵组 0 全绿（**24 个状态**）。新增两个状态 `pendingcards`（三张待定卡片：“待投递”标签 + 实心「插话」+「排队」+「撤回」，placeholder “生成中，Enter 插话”）与 `railsessions`（“会话 1–5 + 更多会话（3）”）；`railmini` 重拍后是**左栏完全消失、消息区贴到窗口左边**；`toolgroup` 重拍成 **62 条调用的长组**——图上看得到列表右自己的滚动条、组头“调用了 62 次工具/命令”留在上方（**另存新名**，没覆盖 N03 那张：`matrix-toolgroup-long-1440x900-100-dark-2026-09-18.png`，原名仍是 d94adf9 里那张）。`matrix-{railmini,railsessions,pendingcards}-1440x900-100-dark-2026-09-18.png` 与上面那张 long 已看图。⑤ 压缩期的待投递卡片**没有单独截图** —— 它与 `pendingcards` 的差别只是「插话 / 排队」两个按钮换成一个「发送」（压缩时模型没在生成，`QueueStack` 的判据不算 `isCompacting`），该形态由 `pending` 第 9 节的「卡片真的出现了」与元素断言覆盖 |
| ⑤ 自动压缩期间也要能发消息 | 压缩期间 pi 同样不接受裸 prompt，而**回合级判据漏了它**：`roundRunning` 只看 `runners.running`，但 pi 在**回合之间**自动压缩（threshold）时 `agent_settled` 早已发过、`running` 已经是 false —— 这时按 Enter 会把裸 prompt 直接投出去，pi 报「Agent is already processing」，而 `submit` 已经把输入框清空了，**用户的消息就这样丢了**（既发不出去、又没有留在框里） | `Composer` 的回合级判据加上 `isCompacting`：压缩期间按 Enter 与“生成中”走同一条路 —— 消息**悬到待定区**（不丢草稿），压缩一结束自动按「排队」投出去。`QueueStack` 里那个同名判据**故意不算压缩**：模型没在生成时“插话”没有意义，卡片只给一个「发送」（内部走 `followUp`）。主进程 `agent.send` 的 `streamingBehavior` 判据也补上 `isCompacting` 作兜底（别的调用路径漏判时也不会撞 pi）。探针 `pending` 新增**第 9 节**（cost 0）：摆出「running 假 + isCompacting 真」→ 按 Enter 不投递 / 进待定区 / 界面上看得见 / 压缩结束自动 `followUp` |
| 应用与包 | 未做（随 P0-8） |
| 剩余限制 | ① 待定消息**不持久化**（切会话即清），也不支持拖拽排序 —— 它本来就是“等一句话就要发出去”的临时状态；② 回合结束后自动投递是**不可关的行为**（用户不选也不会丢消息，但也就没有“一直挂着不发”的选项）；③ 左栏收起后项目快捷入口只能“先展开再切”（N14 的 mini 轨已删，这是用户拍的）；④ 展开上限：**工具组现在是 25 行**（`min(625px, 80vh)`；900px 窗口按当前字号与缩放至少可见 25 条）—— 矮窗口下会跌到 80vh（那时物理上放不下 25 行）；单条详情与推理全文仍是 `min(70vh, 620px)`（900px 窗口 = 548px）；⑤ 压缩期间的待定消息同样要**等压缩结束**才发（用户不能强制它立刻走），这是有意为之：压缩中 pi 本来就不接活 |

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

> 本节是**状态与证据**的索引。**执行口径（会话切片、出口、六栏验收）在 [实施计划](../plan/README.md)**，对应关系：
> N21 系列 → [实施-06](../plan/active/实施-06-上下文管理收尾.md)；P2 取证尾巴 / P0-8 / 两条遗留缺陷 → [实施-09](../plan/active/实施-09-交付与验收收尾.md)；
> 安卓 → [实施-08](../plan/active/实施-08-安卓远程管理.md)；Git 与环境菜单 → [实施-07](../archive/plan/实施-07-Git与环境菜单收尾-已完成.md)。
>
> **上一轮（2026-09-19 会话）做到哪 / 下一片建议**：本轮把 **05 整条主题收尾** ——
> **05-S6**（联调 + 包：自动交接**默认开**（用户 2026-09-19 拍板）、模式跟着会话走（`inheritWorkMode`）、
> 目标不迁移（§8：由模型按交接包重新登记）、`dist:dir` + `test:packaged` 全绿）与
> **05-S5b-4**（前端仍是「一条会话」）、**05-S5b-3b**（交接事务接线）
> —— 05 的 **S1–S6 全部完成**（文件名已加 `-已完成` 后缀）。
> 本轮单测 3600 → **3610**；顺手修掉切会话闪空（`projectSnapshotKeepingPeek`）这条真缺陷。
>
> **再下一轮（2026-09-19，本会话）**：完成 **06-S3** —— 20+ 回合压力测试（`contextpressure` /
> `contextpressurelow`）、门槛标定写进方案、`symbolsTouched` 明确不做；
> 并**修掉压力测试拓出的真缺陷**（策略压缩成功后不重新上膛 → 基线开销压在工作集线上时退化成 5 分钟一次；
> A/B：低线场景修复前 1 次 / 后 5 次，断言真的变红）。单测 3610 → **3614**。
> 随后又做完 **06-S4 前半**：`contexttakeovergap` 实测压缩接管的档位可达性 ——
> 两种构造都只得到 `tier=stale-hard`、`gap=3`（压缩总在回合结束之后），
> 因此 `fresh` / `stale-soft` 在真实链路**不可达**，两档判定交给单测；结论已写回实施-06 与方案 §17。
> 06 的 N21-9 A/B 与 S5 包验收已完成；当前只保留真实长会话证据限制，以及随 01-S5 收口的最终载体 / 唯一入口边界。
>
> ⏭️ **当前待办与建议顺序（2026-09-20，按实际工作树更新）**：
>
> **当前基线**：本轮已复跑 `typecheck` / `build` / 单测 **4158/4158**；独立 Skill 目录解析与逐文件来源 / hash 读取边界也通过 `test:skill-source`，`test:skill-files`、`capsettings`、`mcpcli`、`capcli` 真实 Electron / CLI 场景通过；新增 staging manifest 精确文件集复核与 MCP 项目私有服务 runner 隔离。Electron 调度适配已接线，本地 Pi 离线 smoke fixture（含资源 glob / 排除）通过；`mcp-package` 现已具备精确 bin 解析、官方 SDK `tools/list` smoke、项目范围 stdio 登记 / 复核 / 幂等重放；stdio 关键运行时环境变量覆盖会被拒绝，连接超时会主动清理。`audit:refs` 最近一次报告 `brokenDocLinks: []`，并保留既有删除 `scripts/probe/autonomous.js` 的审计提示。此前打包启动链发现并修复 `tar` 未随主进程进入包的问题；重新 `npm run dist` 后，便携版与全新 NSIS 安装版均已通过 `test:packaged --exe` 的完整运行探针（内置 pi / Git 写操作 / 项目知识 / 能力设置 / 远程服务默认关闭与显式开启 / 隔离哨兵均有运行证据）。安装器美化素材已由生图模型生成，转换为 `build/installerSidebar.bmp` 并接入 NSIS `installerSidebar` / `uninstallerSidebar`；素材尺寸为 164×314，已目视检查。便携测试仍只从临时沙盒副本启动，不直接触碰真实 `release/砚数据/`；本轮此前产生的临时目录按用户数据边界保留，未清理或覆盖。`git status --short` **260+ 项**（常年在建的未提交改动，**保留、不要清**）。
> 本轮新增 `test:skill-files` 与 `test-skill-files-scheduler`：固定本地项目相对路径的 Skill 文件已完成 staging、hash 复核、项目隔离 active 清单和下一次 runner 的 `--skill` 参数读取；安全边界 fixture 继续验证目标 runner、generation、cwd、项目 / 目标版本、来源 HEAD、空闲门禁、active 文件 hash、精确路径和 `continueId` 单次消费，并验证路径穿越、重复路径、篡改和跨项目读取均拒绝。新增独立 Skill 目录适配器与 `skill-source`：只接受带版本 / commit、逐文件 HTTPS URL、逐文件 SHA-256 的目录条目，接入时再做来源白名单、UTF-8、大小、跳转和 hash 复核；`test:skill-source` 已通过。它证明的是独立来源的安全边界，不是外部目录今日可用或外部候选整链已获授权。
>
> **2026-09-21 收尾复核**：`npm run check` 最近一次批量运行在工具组高度修正前为 **80/83**；其中 `taskext`、`streamwidth`、`perf` 已在批量中通过，`virtual` / `outlinepos` 在隔离与组合运行中通过，`toolgroup` 暴露的是当前真实行步进下 `623px` 只能显示 24 行的契约错误，已将当前实现、探针与文档统一为 `625px`。修正后 `npm run test:live -- toolgroup` 通过（25 行可见、内部滚动、组头固定），`npm run typecheck`、`npm run build`、`npm run audit:refs` 也通过；因此当前没有已复现的隔离场景红，但尚未把资源敏感的 83 场景批量运行重新宣称为全绿。重新构建后的解包版、便携版、全新临时 NSIS 安装版均再次通过 `test:packaged` 运行探针。
>
> 最近三片见上方「本轮」三节：07/09 包内审查面板证据、**04-S6a**（接入事务内核 + 受管 staging）、
> **04-S6b-1**（远程 MCP 自动登记闭环 —— `mcpregister` cost 0 已进 `check`）及本轮 **S6b-2 Electron 适配 + 本地 Pi smoke**；随后已补一个用户授权 Skill 文件候选的开发态整链，仍缺其它资源类型的包级候选证据。
>
> **按顺序待做**：
>
> **本轮校正**：下面第 1 项的 `4119/4119`、`4158/4158` 与第 2 项的“视觉 / 包验收未做”是本轮开始前的旧描述；当前证据已更新为单测 **4347/4347**，S7 视觉矩阵与三种包形态运行级验收已通过，且上方新增了一个真实用户授权 Skill 文件候选的完整链路与恶意内容审查证据。以下清单保留未完成主线，但以本段上方最新六栏和当前基线为准。
>
> **本轮校正（2026-09-22 晚）**：01-S5 的最后一段尾巴已闭合 —— **S5c** 把归档回读迁到宿主
> `yan context recall`，薄层 16 个文件里不再有任何 `pi.registerTool`（静态扫描 + 运行时假 pi 对象双断言），
> `contextsweep`（cost 1）实测模型侧 `context_recall` 工具调用 **0 次**、宿主 CLI 回执 `tokens=2224`。
> 同日晚还补齐了 **C-5 尾**（右栏档位名 + 容量来源，含真实截图），单测当前 **4370/4370**。
> 因此第 4 项「最终发布重跑（09-S5 + 01-S5）」里的 01-S5 只剩
> `browser.js` 空占位与包级重跑，**且用户已明确本轮暂无发布计划、不着急跑全量 `check`**。
> 1. **04-S6b-2（进行中）**：npm `pi-package` 的 Electron 适配已接通：精确候选授权、项目 trust、source HEAD、goal revision、同 cwd runner 空闲门禁；hash 复核后在临时 Pi 离线 smoke，再受管 `pi install -l`、核对包清单、定向重载并要求 `continueId` 消费证据。`pi.extensions` / `pi.skills` 的相对 glob、globstar、`!` 排除已实现并用离线 Pi fixture 取证；staging 复核现在要求 payload 文件集合与 manifest 精确一致，`pi.skills` 在 smoke / active 复核前还会经过同一恶意内容审查器。**本轮已补 `mcp-package`、固定项目内 `skill-files` 安全调度和独立 Skill 目录来源边界，并由 `skillacquire` 完成一个用户授权外部 Skill 文件候选的 acquire → staging → 恶意内容审查 → active → 原目标续接：**前者具备精确 npm staging、bin 解析、官方 SDK `tools/list` smoke、项目范围 stdio 登记 / 原子配置 / 受管记录 / 复核 / 幂等重放；固定 Skill 具备 staging → 空闲边界复核 → active 文件物化 → 同 runner 重建 → 精确 `--skill` / `continueId` / `resumed` 证据；独立目录只接受带版本 / commit、逐文件 HTTPS URL 与 SHA-256 的候选，接入时逐文件复核后才进入既有 staging。单测当前 **4347/4347**，`test:skill-source` / `test:skill-files` 通过。**剩余**：其它资源类型的外部候选 acquire → install → activation → resume 与包内整链验收；未随 tarball 提供的依赖仍 fail-closed；纯自定义工具且 RPC 不报告 command / Skill 路径的包暂不能确认 active。临时 Pi 不是 OS 沙箱，候选仍以当前用户权限执行。
>    ⚠️ 远程 MCP 登记与设置页 / 模式 / 取消重连主链均已完成；当前剩余是 S6b-2 的其它资源类型外部候选和包级证据，不包括已通过的 Skill 文件样本。
> 2. **04-S7（主要实现与包验收已完成）**：模式限制 / 项目隔离 / 取消与重连 / 视觉与包（MCP 与发现的界面）。服务端 runner 隔离、设置 UI、三档策略、显式 MCP 核验、用户取消 / 重连已实现并通过 `capsettings` / `mcpcli` / `capcli`；本轮 `typecheck` / `build` / 单测 **4347/4347**，视觉矩阵、解包应用能力页验收、便携运行探针和全新 NSIS 安装后 EXE 运行探针均已通过。安装器侧栏资源也已接入并随新产物构建。**剩余**：S6b-2 其它资源类型的获授权外部候选整链与包级证据，以及最终发布重跑；这不包括已通过的本地 / 解包 / 安装态包运行验收。
> 3. **06-S2（N21-9 A/B）已完成，不再重跑**：v7 的 48 次真实调用已证伪「把 A 组丢失率抬到 20–40%」这一校准目标（A=11.1%，丢失集中于单一任务）；差异不足以支持策略收益，不应继续加样本。详见 [证据-06-S2](../archive/evidence/证据-06-S2-N21-9基准-2026-09-19.md) §6。
> 4. **最终发布重跑（09-S5 + 01-S5）**：包运行态复核已齐；仍需在其它资源类型的外部候选 / 包级证据与本轮安全审查、文案改动稳定后，按最终范围重跑发布前门槛
>    `YAN_TEST_MODEL=<provider/model> npm run check`（全量含真实模型场景；**优先使用已注册且验证能调用工具的本地 llama.cpp 模型**；只有本地服务不可用时才可用已授权远程模型）。本轮在 pi `models.json` 找到本地注册项 `local/qwen3-local`，并实际发起了 `GET /v1/models` 与 `POST /v1/chat/completions` 检查；当前配置已切到 `127.0.0.1:8081` 的新 Qwen 27B GGUF，并完成本地推理 / 工具调用验证。
>    本轮已经手动启动 llama.cpp：`GET /v1/models` 返回 Qwen 27B，普通 `POST /v1/chat/completions` 返回 `READY`，强制工具调用返回 `finish_reason=tool_calls`；项目别名 `local/qwen3-local` 可直接调用。最终门槛改为使用该本地模型，不切换未授权远程模型。
>    本轮 `npm run dist` 已成功生成三产物，`release/SHA256SUMS.txt` 已按本轮文件重写；随后 `npm run test:upgrade` 已通过（从真实用户数据只读副本启动，60 个原目录文件逐字节不变）。包内敏感串审计仍沿用既有白名单验收，未把 checksum 单独当成运行验收。
> 5. **08-S1+（安卓客户端）**：依赖链最长，**开工前需要用户确认范围**（S0 状态机已冻结，零代码）。
> 6. **P0-8 / 安装包那半边**：已有解包 / 便携 / 全新 NSIS 安装态运行证据；不再单列为缺失，随最终范围重跑即可。
> 7. **08-S0 两条远程 API 缺陷已完成真实端到端复核**（2026-09-20）：`npm run test:live -- remoteroutes` 通过。隔离 Electron 上 health / 鉴权 / 新建会话 / 指定 `sessionId` 消息 / 指定 `runId` abort 全绿；目标在后台 runner 运行、桌面当前会话不变；Node 侧本机 provider 确认目标请求的流被取消。无上游调用，不读取真实 pi 凭证或模型配置。该 cost 0 场景已加入 `check`。
>
> **开工前三件事**（每次一样）：读本文件「当前未完成」→ [实施计划](../plan/README.md) 主题总表 →
> 目标主题的实施文档；`git status --short` 看现有改动并**保留**。
>
> **三个会浪费时间的坑**：① `test:live` **不会自动构建** —— 改完源码先 `npm run build`，
> 否则验的是旧 `out/`；② 跑 Electron 前确认环境里**没有** `ELECTRON_RUN_AS_NODE=1`
> （带着它 Electron 退化成纯 Node，报 `does not provide an export named 'BrowserWindow'`）；
> ③ 旧产物存在 ≠ 构建成功，下结论前看时间戳。

>
> **实施-02 已完成**（S1–S5，2026-09-18）：证据见本文「本轮」四节与
> [实施-02](../archive/plan/实施-02-任务工具内置化-已完成.md) 的完成记录；最后一片是
> [S5 证据](../archive/evidence/证据-02-S5-真实运行与验收.md)（真实多步任务三处一致 + 包）。
> **实施-01**：S4（迁移对照）**已登记完**（2026-09-19，结论表见
> [实施-01 §4](../plan/active/实施-01-默认pi架构迁移.md)）；S5（发布切换）仍等 04 / 06 的最终边界确认与发布重跑。
>
> ✅ **01-S4b（原硬阻塞）已完成（2026-09-19）**：`resources/pi-extensions/browser.js`
> 已**零注册**（实测是 **16 个 `browser_*` 工具 + 1 个 pi 斜杠命令**，卡面写的「18 个」不准），
> 等价物 **`yan browser …` 已登记 19 个命令**（`browser.evaluate` 有意不做）。
> **01-S5 的前置已满足** —— 移除默认扩展装载后浏览器能力不会丢（`test:live -- browserclimodel`，cost 1，
> 模型自己发现入口并完成 `navigate` → `observe`；L04 边界回归绿）。证据：[证据-01-S4b](../archive/evidence/证据-01-S4b-browser-CLI迁移.md)。
> 它占用过的 `agent.ts` / `capability-server.ts` / `yan.mjs` 三件套（[能力面串行队列](../plan/active/编排-并行代理分工-2026-09-19.md) §5）
> **已释放**；“下一位是 05-S2、再到 03-S4 / 04-S3”属于历史波次顺序，当前优先级以本文件 2026-09-22 待办段和实施计划为准。
>
> ✅ **05-S1 已完成（2026-09-19）** —— 钩子能力边界与安全点五组对照实测（假 provider，不联网不花钱）；
> 结论见 [证据-05-S1](../archive/evidence/证据-05-S1-钩子与安全点.md)：`tool_call` 的 `{block:true}` 是真门禁、
> `ctx.abort()` 能阻止下一请求但不是暂停、**钩子里不能压缩**（安全点是宿主 RPC `compact`）、
> `before_provider_request` 能真改写请求体。
>
> ✅ **05-S2 已完成（2026-09-19）** —— 会话级工作模式（标准 / 澄清 / 自主）、旧配置迁移、菜单与 `Tab` 快切、
> `question` 按会话模式工作；证据见本文「本轮 · 实施-05 S2」。它占用的
> `settings.ts` / `shared/ipc.ts` / `preload` / `store.ts` / `Composer.tsx` 已释放，
> 旧队列只作文件域追溯；当前未闭环切片见实施计划和各活动正文，不从旧队列判断完成度。
>
> ✅ **05-S3a / S3b 已完成（2026-09-19）** —— 澄清档硬门禁（工具表主 + `tool_call` 兑底，
> 薄层 `pi-extensions/work-mode.js` 执行）+ `yan goal ready|report|status` 通道 +
> 会话级目标状态（幂等、先落盘、同因两次强制 blocked）+ **跨轮自动续行**
> （`pi-extensions/goal-resume.js`：custom 控制消息 + `triggerTurn`，带消费证据与用户优先）；
> 证据见本文「本轮 · 实施-05 S3a / S3b」与 [证据-05-S3a](../archive/evidence/证据-05-S3a-门禁与就绪转移.md)。
> 同类的「薄层内注册模型工具」历史上有两处：`question.js` 的 05-S3 已在 2026-09-22 收口为宿主
> `yan question ask`，扩展只保留模式提示；`context.js` 的 `context_recall` 的 N21-9 A/B 基准也已完成，
> 但它仍是当前唯一需要继续登记 carrier / 未满足边界的模型工具例外。
> 详见 [实施-01 §4 的判定表](../plan/active/实施-01-默认pi架构迁移.md)。
>
> **实施-06**：S1（分支判定）**已完成**（2026-09-19）—— 结论 **分支 A 成立**：
> 薄层需要的五项钩子（`context` / `before_provider_request` / `before_agent_start` /
> `session_before_compact` / `agent_settled`）都在且载荷够用（`session_before_compact` 已由真实压缩的
> `takeover 1 / fallback 0` 取证），**没有任何一项落进止损表**（止损表降为「将来钩子被移除时的预案」）。
> 除 `context_recall` 外全部有落点；`context_recall` 是唯一「必须注册模型工具」的项，
> 已按出口 ③ 如实登记为未满足；N21-9 已完成，`question` 则已由宿主 CLI 承载。**剩**：真实长会话证据限制与 `context_recall` 最终边界记录。

### 本轮（2026-09-22）实施-01 S5a · 默认发现链收口

> 这是一片 **S5 的部分收口**，不是 01 主题完成证明。它先验证「用户目录里的旧扩展 / Skill 不会被砚默认 runner 自动带入」，并保留显式传入的砚薄层；`question` 随后已改走宿主唯一入口，`context_recall` 仍按 01 / 06 的最终边界处理。

| 验收栏 | 证据 |
|---|---|
| 实现 | `agent.ts` / `subagents.ts` 默认参数加入 `--no-extensions`、`--no-skills`；`index.ts` 的受管薄层路径在开发态读 `resources/pi-extensions`、打包态读 `resources/yan-thin`，并覆盖实际 10 个显式薄层文件；`electron-builder.yml` 的目标目录改为 `yan-thin`；扩展来源诊断改为「用户扩展可见但默认不加载」。 |
| 自动检查 | 默认发现切片的 `typecheck`、`build`、`audit:refs`、`git diff --check` 证据保留；question 收口后的当前单测为 **4347/4347**。`audit:refs` 的当前报告 `brokenDocLinks: []`；其余 orphan / archive 提示是既有审计信息，不在本片伪装成零提示。 |
| 真实运行 | `npm run test:live -- taskext` 通过（cost 0，`YAN_*` 隔离）：升级 fixture 中两个旧扩展都未加载，旧 `/panel` 没有回到默认命令来源，历史 4 条任务仍可读；退出后原会话 JSONL 逐字节不变、未追加任务快照；Electron 关闭后无孤儿 pi 进程。受影响的浏览器接线另以 `npm run test:live -- browser`（cost 0）复核通过，Google 标题 / 右栏 / 元素数 / 标签页 / 原生 bounds 均有回执。 |
| 视觉验收 | 未做新截图；本片无界面 / CSS / 布局修改，运行证据集中在 Electron 日志、命令来源和会话文件。 |
| 应用与包 | 打包配置与 `test-packaged` / 单测的 `yan-thin` 静态哨兵已同步；本片未重新打包，未把静态资源存在写成包内真实验收。最终包验收仍需覆盖 04-S6b-2 剩余的其它资源类型包级候选证据，并按 09 重跑。 |
| 剩余限制 | 01-S5 仍未完整闭环：`context.js` 的 `context_recall` 模型工具 carrier 尚未完成最终边界收口；`question` 已转为宿主 `yan question ask`；`browser.js` 空占位仍在；04 已有一个用户授权 Skill 文件候选的开发态 acquire → staging → 安全审查 → active → resume 整链，`pi-package` / `mcp-package` 的其它外部候选及包内整链仍未完成。 |

### 本轮（2026-09-22）实施-01 S5b · `question` 宿主唯一入口

| 面 | 证据 |
|---|---|
| 实现 | `question.ask` 已加入 `KNOWN_COMMANDS`、`yan.mjs` help / action 表和 `AgentController`；宿主承载输入、选项、自定义答案、取消 / 超时及请求关联；`question.js` 只保留 `before_agent_start` 模式提示，`work-mode.js` 只放行受限的 `yan question ask` 形状，扩展不再注册 `question` 模型工具。 |
| 自动检查 | `npm run typecheck`、`npm run build` 通过；`npm run test:unit` 当前 **4347/4347**；`scripts/test-question.mjs`、扩展清单断言、相关 Node 语法检查通过。 |
| 真实运行 | `npm run test:live -- questioncli`（cost 0）验证标准 / 自主两条宿主 CLI；`ask`（cost 1，`commandcode/deepseek/deepseek-v4.1-flash`）验证模型 → `bash` → CLI → 真实面板 → 答案回填；`askbackground` 验证 A/B 会话等待隔离。三条均无 `question` 模型工具调用、无孤儿 pi。 |
| 视觉验收 | 使用真实 `QuestionPanel` live 交互取证；没有 CSS / 布局改动，因此未新增视觉矩阵截图，也未把 fixture 当作视觉证据。 |
| 应用与包 | CLI 与薄层继续走显式受管路径；本轮未重新生成 `dist:dir` / 安装包，最终包门槛仍随 09 重跑。 |
| 剩余限制 | `context_recall` 仍是唯一未完成 carrier 的模型工具例外；question host CLI 的取消 / 超时实现已接线，但本轮 live 主要验证正常回答、自主不提问和后台等待；模式提示仍是软指导，不能替代模型行为保证。 |

### 代码与文档审阅（2026-09-17，R01–R04 已修复、D01–D06 已同步）

[审阅批注](../archive/2026-09-17-代码与文档批注.md)的 R01–R04 已全部修复，并补齐了失败路径证据；
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
| D04 | HANDOFF / PRIORITY 的待拍板项收敛为**只剩 `episode-fold` 默认开关** —— 该开关**已于 2026-09-18 拍板：进默认接管集**（[方案 §17.5.7](../design/active/方案-上下文工具内的自动压缩-2026-09-15.md) / [归档 §1.22](../archive/2026-09-17-已完成归档.md)），**待拍板项现在为零**；§13.5 三问标为已随实现定下（保留原文供回溯） |
| D05 | `scripts/test-live.mjs` 的 settings 注释改成当前设置布局 + 记忆移除边界 |
| D06 | `docs/WORKSPACE.md`：pi-extensions 职责补全（浏览器/提问/语言/详细度/上下文） |

[代码功能实现清单](../archive/2026-09-17-代码功能实现清单.md)按现有实现列出产品能力和上下文细项。

### 一、P1 · 上下文管理（N21 收尾与证据限制；不是新增大功能）

方案唯一真源：[design/方案-上下文工具内的自动压缩](../design/active/方案-上下文工具内的自动压缩-2026-09-15.md)
（§12 = 阶段 4 开工契约与验收，§13 = 对外部参考方案的对齐结论）。

> **N21-10（安全规则补三条）已于 2026-09-17 完成**：切成"正在使用的 diff / 用户约束 / reasoning 中间切割"
> 三条硬约束，落地为纯函数 `resources/pi-extensions/context-safety.js` + 42 条单测（**N21-4 直接调它**）。
> 明细见[已完成归档](../archive/2026-09-17-已完成归档.md) §1.7。

| ID | 状态 | 剩余工作 | 依赖 |
|---|---|---|---|
| **N21-4 多阶段与归档** | **✅ S1–S7 已交付并真实验证（2026-09-17）** | S1（State / Archive 基础设施）证据见[方案 §14](../design/active/方案-上下文工具内的自动压缩-2026-09-15.md#14-阶段-4--s1-落地记录state--archive-基础设施2026-09-17)；
S2–S6 证据见[方案 §15](../design/active/方案-上下文工具内的自动压缩-2026-09-15.md#15-阶段-4--s2s6-落地记录扩展执行层--recall--降级2026-09-17)：`context` 钩子做 Tool Sweep（墓碑 + `ctx://` 引用）、Task State 前置注入（水位一致才注入）、`context_recall`（预算 / TTL / 审计）、`session_before_compact` 接管闸门（缺字段/无状态一律降级回 pi 摘要），默认**清扫 + 可召回墓碑 + 压缩**（`kinds` 默认含 `episode-fold`（2026-09-18 拍板，见方案 §17.5.7），2026-09-17 用户拍板：清理默认开但保留必要引用；本回合正在动的文件不清扫）。**剩下**：① ~~EpisodeState 的语义生成~~ —— **已完成（2026-09-18，但两道门默认关）**：边界用 `episodeWindow` 的**确定性规则**算（尾部窗口之外 + 上一版终点），收束由模型的 `unresolved` 判（非空即不折），生成后**只落盘、不消费**（`episodeGenerate` / `episodeInject` 都默认关）；真实链路已验证位、落盘与 schema，见[归档 §1.25](../archive/2026-09-17-已完成归档.md)。**开它之前先要有质量数据**；② ~~`symbolsTouched`（需语言级解析，目前为空）~~ —— **已明确不做（2026-09-19，实施-06 S3）**：不为此在薄层引入语言级解析器，字段保留但刻意不填（方案 §13.1 第 23 条）；③ ~~§12.11 第 10 条 20+ 回合压力测试~~ —— **已完成（2026-09-19，实施-06 S3）**：`test:live -- contextpressure` / `contextpressurelow`，22 个真实回合、压缩 3 次、峰值 1.05×，并修掉“策略压缩成功后不重新上膛”的真缺陷（见下方「本轮」）。~~三阶段独立 Rearm / Cooldown~~ —— **已完成（2026-09-18）**：新模块 `context-stage-runtime.js` + `context.js` 的 sweep / fold 接线，30 条单测 + 3 次反向验证，见[归档 §1.24](../archive/2026-09-17-已完成归档.md)；~~增量 delta（现为全量快照）~~ —— **已决策不做**（方案 §18）。**另：S7（状态生成器）已于 2026-09-17 落地** —— 混合式（确定性 reducer 提供 files / commands / tests + 一次无工具 completion 产出语义字段，落盘前 reducer 覆盖模型返回的同名字段）、`revision` CAS、freshness 分档（gap 1–2 标 stale / 3–6 丢语义 / >6 不注入）、状态自身预算与裁剪；**默认在接管集里**（2026-09-18 拍板；但短会话由会话级门槛挡住，不是每轮都跑）。证据见方案 §17。以下为这批交付前的描述（供回溯）：EpisodeState / TaskState 的语义生成器（**扩展内即可完成** —— 方案 §16.1 更正了「扩展侧没有推理 API」的误判：`agent_settled` 事件 + `ctx.modelRegistry.complete()` 就能跑一次无工具归纳；实施级契约（coordinator/CAS/freshness/预算与裁剪/dirty 阈值/注入切分）见**方案 §16.6**，由第三轮外部评审经内置浏览器对话取得并经源码核查；开工前的三项待决中**第 1 项已定**：复用已验证的浏览器 loopback bridge 落盘，见方案 §16.6.3）、三阶段独立 Rearm/Cooldown（**已于 2026-09-18 完成**，见[归档 §1.24](../archive/2026-09-17-已完成归档.md)） | N21-3（已完成） |
| **N21-5～N21-9 状态化压缩** | **N21-5 / N21-6 / N21-7 / N21-8 / N21-9 全部完成（2026-09-17～19）**。N21-6 的接管**成功分支**已在真实链路取证（`contexttakeoverstate`：`takeover 1 次 / fallback 0 次`，[归档 §1.21](../archive/2026-09-17-已完成归档.md)）；N21-8 已闭环（默认关 + 设置面板开关 + 视觉证据，[归档 §1.20](../archive/2026-09-17-已完成归档.md)）。方案 §19 的结论仍然成立：pi **没有 system 注入通道**（`convertToLlm` 把 `custom` 一律映射成 user、`default` 直接丢弃），要做 system 级注入只能走 `before_provider_request` | 任务表见 [实施-06 上下文管理收尾](../plan/active/实施-06-上下文管理收尾.md)。**③ 阈值可配 + 模型级 override 已落地**（N21-7，见[归档 §1.8](../archive/2026-09-17-已完成归档.md#18-n21-7-上下文阈值可配置化--模型级-override2026-09-17已完成)：lookup `env > model(provider/model) > provider > user > default`、设置面板「上下文」tab、`contextbudget` 第 7 节 + 20 条单测 + 两张 `ctxsettings` 截图）。**剩余**：① ~~增量 delta（全量快照）~~ —— **已决策不做**（方案 §18：量化后收益 ≤900 token/次且已有硬 cap，成本是合并语义与新的正确性面；N21-5 不再是「未完成」）；② `episode-fold` 默认值：**2026-09-18 已取得第五轮外部意见，它修正立场为「现在默认关是对的」**（原文存档于 `docs/archive/reference/参考-episode-fold 默认策略（第五轮·ChatGPT·原文）-2026-09-18.md`）；它把 `supportingEntryIds`（provenance）定为默认开的前置，而本项目核查确认「语义递归经 `<previous_state>` 仍在」—— 与现状一致，**默认值保持关**（方案 §17.5.6）—— 2026-09-17 晚已取得**第四轮外部意见**并做完源码核查（§17.5），随后**把与开关无关的硬化项全部落地**（[归档 §1.11](../archive/2026-09-17-已完成归档.md)：synthetic 输入自净 / 注入 authority 契约头 / `generate`+`inject` 分路 / episode 旁路防线 / **回合口径修正** / 会话级 gate + 新增 `contextgate` 场景）；它用的三个 gate 信号里「settled turn 计数」已补上（`turnsSince`），另两个（离压缩还有多远）仍需主进程的工作集；**第四轮复核又定掉三条**（Sweep 不得绕过最低回合数 / `inject` 的语义写死为「允许参与任何模型可见上下文」/ 「落后 1 条未 settled 的 user 算 fresh」，见方案 §17.7）；③ Deep Context Mode 默认关闭、开工前先做两项前置调查（其中「扩展侧到底能不能自己调模型」已在方案 §16.1 更正并核实）。方案 §13.5 的开工前三问与 §16.4 的四个拍板点，除②（等价于 §16.4 的默认值项）外都已随实现定下，原文保留仅供回溯；外部评审提的改进项（字段级 freshness、ancestry + 有界陈旧、富墓碑等）已登记在方案 §16.2（**待评估、未排期**）；另有一轮**本机 Codex** 的第三方核对（一致处与分歧见方案 §16.5，它额外指出 TaskState 自适应裁剪、生成器重入/迟到结果 CAS、归档回滚三项硬要求） | N21-4；用户拍板 |

### 二、P2 · 已取证项的尾巴（历史基线；09-S2 已完成批量收口，不再作为当前待办）

| ID | 已取证的部分（历史基线） | 当时还差什么（历史记录） |
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

界面与功能规划见 [Android UI 方案](../design/active/ANDROID-UI-PLAN-2026-09-18.md)：六类页面、移动视觉候选、断线/双端交互与协议依赖已形成设计提案；**S0 已将「连接状态机与能力边界」冻结**（见下表），尚无可交互原型、Android UI 或 APK，工程状态保持下表口径。

| 项 | 当前状态 | 已有证据 | 剩余限制 |
|---|---|---|---|
| **Android 远程管理第一阶段** | **电脑端 API 已落地；S0（连接状态机与能力边界）已冻结；Android UI 尚未开始** | `src/main/remote-server.ts` + `src/main/index.ts`；`typecheck` / `build` / 单测 / `audit:refs` 通过；`test:packaged` 证明服务默认不监听、显式开启可启动。**2026-09-20**：`remoteroutes` 隔离 Electron + 本机 provider 全绿：health / 鉴权 / 新建 / 定向发送 / 指定 runId 中止；目标 runner 运行时桌面视图不切换，目标流被取消；cost 0、不读真实凭证。**S0（2026-09-19，零代码）**：[远程-连接状态机-2026-09-19.md](../design/active/远程-连接状态机-2026-09-19.md)（`RC-SM/1`：六态词表 + 126 格迁移表 + 授权轴正交 + 11 能力 × 6 态矩阵 + 断线语义 + 8 类错误分类） | 当前是 HTTP + SSE、环境变量 token；尚无二维码配对、设备密钥、TLS/中继、Android APK、视觉验收和正式包验收；详见 [REMOTE-CONTROL](REMOTE-CONTROL.md) |

### 四、Git 审查与环境菜单（方案 G1 + G2，2026-09-18）

方案唯一真源：[Git 审查与环境菜单及插件视觉规划（已归档，剩余项见实施-07）](../archive/2026-09-18-Git审查与环境菜单及插件视觉规划.md)
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

**已知布局遗留（真问题）已修（2026-09-19）**：窄窗口（≤1002px）下左栏收起后曾**稳定停在 48px**
（宽窗口是 0）—— 那是紧凑轨移除时没清掉的那一列宽度（写死在窄窗媒体查询里）。
已改成跟 `--w-rail-collapsed` 同一个真源，`narrow` 的断言也从「意图级」收回**硬值 0**，
三档窗口实测全 `0px`，A/B 反向验证见「本轮（2026-09-19）实施-09 S1」。

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
- 非 Git 目录的界面形态已补**真实窗口截图**（2026-09-19，07-S1）：`matrix-envnotgit-*` /
  `matrix-reviewnotgit-*` 五张，见本文「本轮 · 实施-07 S1」
- 展开上下文一次最多 300 行，超出只提示还有多少行
- 切换分支的阻断判据是「该 cwd 有 running 的 runner」；**别的进程**（终端里的
  git、编辑器）不受我们控制，只能由 git 自己的 lock / 检查兜住

### 六、核查时新发现的两条真问题（2026-09-18；**不是**方案这一轮引入的）

核查「待办是否全部完成」时逐个跑了红着的场景，分离出两条**真正的缺陷**
（区别于上面那些过时断言）。两条都确认与方案这一轮的改动无关 —— 改动清单里
没有文件树，也没有左栏的列定义。

| 项 | 现象与已查到的线索 | 状态 |
|---|---|---|
| **fs 文件树的键盘导航** | `End` 从根出发时焦点掉到 **body**（不是"没渲染"—— 探针里那行诊断打出 `DOM行数=50`、最后一行 `tsconfig.web.tsbuildinfo` 就在 DOM 里）。同一节里「Home 回到树根」「ArrowRight 从已展开目录移动到下一可见节点」**都通过** —— 所以**从已聚焦行出发**的移动是好的，问题只出在「先 focus 另一行、再派发按键」这条路径：`row.focus()` → `onFocus` → `setFocusPath` → 重渲染，而 `focusTreePath` 的焦点恢复写在 **`requestAnimationFrame`** 里，查到/聚焦的可能是被替换掉的节点。**试过的方案（已撤回，用备份文件还原，没动 git）**：把 `focusTreePath` 改成 `useLayoutEffect` + 键盘意图哨兵 → `End` 仍然红，而 `ArrowRight` **反而变红** —— 说明焦点链上**还有别的参与者在改焦点**，这不是单点问题。反正在**这次撤销**里学到的是：改焦点管理必须先有逐帧观测（打 activeElement 的时间线），否则「修一处坏一处」。诊断行已留在 `scripts/probe/fs.js` | **已修（2026-09-19）** |
| **窄窗口下左栏收起的 48px 残留** | 见上一节末尾。宽窗口收起是 0，**窄窗口（≤1002px）稳定停在 48px** —— 紧凑轨移除时没清掉那一列宽度 | **已修（2026-09-19）** |

> 两条的**真实根因**与反向验证见「本轮（2026-09-19）实施-09 S1」。
> fs 那条的「焦点管理/节点被替换」是当时的假说，逐帧观测推翻了它：
> 真正的判据是 **`visiblePaths`（严格 DFS）与渲染截断（父层先扣额度）用了两套顺序**，
> 键盘能走到没渲染出来的行；`focus()` 找不到节点不报错、只是静默失败。

### 五、P3 · 外部条件阻塞（不排期）

代码签名（证书）｜macOS / Linux 包（构建环境）｜扩展 `registerShortcut`（pi 0.85.1 RPC 无枚举/执行接口）｜
`image` 场景视觉验收（需视觉模型）｜Yan 自有账号与跨设备同步（产品与服务端）。

> **2026-09-21 移出一条**：「Command Code 月度额度（缺账户权威字段）」不再是外部阻塞 ——
> 已用「`weekly.cap × 2` 反推总额度 + 界面明标『推算』」落地，见上面的额度增量。

## 当前产品边界

遵循 [AGENTS.md 第五节](../../AGENTS.md)：**任务面板保持现状**（只放开任务工具的提供方，见 [实施-02](../archive/plan/实施-02-任务工具内置化-已完成.md)）；
**旧记忆系统与 `get_tree` 浏览链路不恢复**（「项目知识」是独立新功能，见 [实施-03](../archive/plan/实施-03-项目知识与旧记忆清理-已完成.md)：
**S0–S2 已完成**（残留清理 + 保护集 + 存储层），**S3–S6 新功能未开工**）；
推理块默认展开但限高省略（`--reason-max-h`）且永远保留模型原文；本地档案不冒充登录
（只有 ChatGPT `openai-codex` 能在应用内登录）；深浅主题、设置面板、模型接入、Windows 打包、
内置浏览器与本机 Chrome 接入**都已实现**。
「Yan 自有账号登录」与「ChatGPT 模型接入登录」是两条不同能力，不要混称。

**pi 边界（2026-09-18 拍板）**：完成版**只包含默认 pi**，不预装 pi 插件、不暗中装回、不改名冒充原生；
**允许保留一个砚自有薄适配层** —— 只承载宿主无法通过 CLI / RPC 表达的**生命周期桥接与策略执行**
（不注册模型工具 / 命令、不加用户可见功能、不改 pi 默认工具集）。准入按**语义契约 5 条**判定
（缺契约且**必须注册模型工具** → 直接判「做不到」，**不塞进薄层**），约束与白名单见
[实施-01 §1](../plan/active/实施-01-默认pi架构迁移.md)。两个可选入口（`pi config` 启用 / 禁用、
GitLab / Bitbucket PR）**已定不做**。**01-S1 仍是所有迁移的共同前提**，且必须包含
**端到端最小闭环**（模型 → 本机 CLI → 结构化结果 → 继续一轮）。
[实施计划](../plan/README.md) 是接下来做什么的唯一活入口。

## 更新状态的方法

在对应任务行链接证据，按[工程清单第 6 节](ENGINEERING-CHECKLIST-2026-09-15.md)补齐：
**实现 / 自动检查 / 真实运行 / 视觉验收 / 应用与包 / 剩余限制**。不适用项注明原因；
不能仅凭源码、mock、探针 ok 或旧产物勾选完成。**做完一项就从本页删掉**（明细进归档），
本页只留"现在还没闭环的"。

通用排障经验见 [MAINTENANCE](MAINTENANCE.md)，不再向本页追加「本轮已落地」流水账。
