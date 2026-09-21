# 实施计划 · 唯一活入口

> 2026-09-18 建立。本文**取代** [未完成工程排期](../archive/2026-09-15-未完成排期.md)（已归档）的「活入口」地位。
> 本文只回答两件事：**还没做什么**、**每件事怎么切成一次会话能做完的片**。
> 当前状态、验证基线与已取证证据仍然只在 [HANDOFF](../dev/HANDOFF.md) 维护；两者分工不重叠：
> **HANDOFF 说「现在是什么样」，本目录说「接下来一次会话做什么」。**

## 0. 怎么用

1. 先读根目录 [AGENTS.md](../../AGENTS.md)，跑 `git status --short` 并保留已有改动。
2. 从下面的表里选一份实施文档；按它的「会话切片」顺序做，**每片做完就停下来登记**。
3. 每片完成必须补齐**六栏**（实现 / 自动检查 / 真实运行 / 视觉验收 / 应用与包 / 剩余限制），
   口径见 [工程清单 §6](../dev/ENGINEERING-CHECKLIST-2026-09-15.md)，证据写回 [HANDOFF](../dev/HANDOFF.md)。
4. 测试命令、隔离变量与花费约定只看 [TESTING](../dev/TESTING.md)；打包只看 [RELEASING](../dev/RELEASING.md)。
5. **判断「某项是否真的未完成」**：以 [HANDOFF](../dev/HANDOFF.md) 的「当前未完成」与
   [已完成归档](../archive/2026-09-17-已完成归档.md) 的「尚未完成」表为准。
   [工程清单](../dev/ENGINEERING-CHECKLIST-2026-09-15.md) 里的 `[ ]` 是**立项时的细项记录**，
   早期批次完成后没有回填（它自己也声明「当前状态与排期只看 HANDOFF」）——
   **不要拿未勾选项当待办**（例如 N02 / N07 已取证完成，框仍是空的）。
6. **自主推进约定（2026-09-19 用户拍板）**：一次会话里**按顺序自动继续下一片**，
   做完一片就登记（HANDOFF 六栏 + 本文件状态列 + 必要测试注册），**不中途停下来问用户**。
   只有遇到「需要用户拍板的产品决定 / 环境阻塞 / 会花钱且无法自判」时才停下汇报。
   每片收尾必须把当前进度与下一片写回 HANDOFF，供下次会话接着跑。

**为什么按「会话切片」组织**：这些工作单看一个主题要跨好几天，但执行者是一次会话。
所以每份文档里的 `S1 / S2 / …` 都是**一次会话内能做完、能独立交出证据、能安全停下**的一片；
片与片之间只通过文档里写明的契约耦合，不靠口头约定。

## 1. 主题总表

| # | 主题（一份实施文档） | 来源（已合并 / 已归档） | 切片 | 依赖 | 状态 |
|---|---|---|---|---|---|
| [01](实施-01-默认pi架构迁移.md) | 默认 pi + 砚原生能力层 | [架构修订-默认pi与砚原生能力层](../archive/2026-09-18-架构修订-默认pi与砚原生能力层.md) | S1–S5 | — | **S1–S4 已完成**（[S1 证据](证据-01-S1-可行性验证.md) / [S2-S3 证据](证据-01-S2-S3-宿主服务与能力入口.md) / S4 = **迁移对照已登记**，7 行判定见 [§4](实施-01-默认pi架构迁移.md)）：闭环成立、`--tools` 是硬门禁、`setActiveTools` 运行时可用、宿主端点 + `yan` CLI 通了、能力入口说明已注入；矩阵 4 行无悬念（3 已等价 + 1「不创建」已符合）。**S4b 已完成（2026-09-19）**：`browser.js` 的 **16 个模型工具 + 1 个斜杠命令全部移除**（零注册），改为 `yan browser …` **19 个命令**（`browser.evaluate` 有意不做）—— **P0 硬阻塞已解除**，矩阵 browser 行改判**已等价**，`test:live -- browserclimodel`（cost 1）取到端到端最小闭环，L04 边界回归绿；证据 [证据-01-S4b](证据-01-S4b-browser-CLI迁移.md)。**剩**：S5 发布切换（等 02–06；已无阻塞） |
| [02](实施-02-任务工具内置化-已完成.md) | 任务工具收归砚内置 | [实施方案-A](../archive/2026-09-18-实施方案-A-任务工具内置化.md) | S0–S5 | 01-S1 | **✅ S1–S5 已完成**（[S1 证据](证据-02-S1-兼容性与契约.md) / [S2 证据](证据-02-S2-任务计划纯逻辑.md) / [S3 证据](证据-02-S3-宿主任务服务.md) / [S4 证据](证据-02-S4-UI与命令接线.md) / [S5 证据](证据-02-S5-真实运行与验收.md)）：旧历史可读、旧扩展共存有行为记录；契约 + 校验 + 六操作 reducer + 幂等 + 历史解析 83 条单测；**宿主任务服务**（`YAN_DIR/task-plans/<sessionId>.jsonl`，只追加 + 串行 + CAS/幂等 + 落盘失败不报成功）与 `yan tasks apply` 通了；**UI 接线**：工具卡标「任务计划 · 砚内置」（可展开原文）、`/panel` 从补全隐藏且手打不清草稿/附件、插件页把内置能力与已装包分开；**真实多步任务**（模型自己写请求文件、登记、执行、勾选）下工具调用 / 界面 / 磁盘三处一致，解包产物里启动器与 CLI 都可用 |
| [03](实施-03-项目知识与旧记忆清理-已完成.md) | 旧记忆残留清理 + 新项目知识 | [实施方案-B](../archive/2026-09-18-实施方案-B-旧记忆清理与项目记忆.md) | S0–S6 | 01-S2 | **S0–S5 已完成**（2026-09-19：S0 边界措辞复核（无需改动）+ S1 旧记忆残留清理 —— 4 处代码注释/文案 + 3 处文档改成当前事实，并建立**保护集**防关键词误删；S2 **存储层** `src/shared/project-memory.ts` + `src/main/project-memory-store.ts`（不可变 revision + 原子 manifest + CAS + 排他锁 + 墓碑，单测 **+153**，证据 [证据-03-S2](证据-03-S2-项目知识存储.md)）；S3 **检索与注入** —— `project-memory-search.ts`（字符 bigram + ASCII 词 + 标签加权、只取 active、top 8 / 2k 预算、无相关项零注入）+ `main/project-knowledge.ts`（宿主检索→每会话一份注入文件，**关闭也写空块**）+ 薄层扩展 `project-knowledge.js`（`before_provider_request` 放在最后一条用户消息之前），单测 **+75**，live **`knowledgeinject`**（cost 1，开/关/无关查询三回合）；S4 **`yan knowledge search/read/propose`** —— 身份只取宿主绑定的 projectId（带别的 id 直接拒）、`propose` 不传 hostCheck（新条目只能落 `candidate`）、证据 `file` 只接受项目内相对路径，live **`knowledgecli`**（cost 1，模型自己检索 + 提议，退出后磁盘多一条 candidate）；S5 **设置页 UI** —— 设置面板新增「项目知识」页（开关 + 已确认 / 待确认 / 需复核三种筛选 + 来源跳转 + 编辑 / 替代 / 确认 / 删除 / 导出 Markdown），四个新 IPC 一律按当前会话推导身份，视图层纯函数 `src/shared/project-knowledge-view.ts`（派生「需复核」），单测 **+30**、live **`knowledgetab`**（cost 0）、视觉 **4 张**；S6 **跨会话 / 项目 / 工作树隔离 + 包与便携数据** —— 真实运行抓到一个**真缺陷**：未登记的 git 工作树与主仓库同前缀（旧 `legacyProjectId` 只取前 27 字节）→ 工作树直接读到主仓库的知识；`src/main/index.ts` 新增 `knowledgeProjectId()`（未登记时走碰撞退路，两处身份推导统一），live **`knowledgeisolation`**（cost 0）+ **通用 `restart` 能力**（两次启动、同一份 `YAN_DATA_DIR`）+ `test:packaged` 新增 9 条（打包态知识读取 / 安装目录与开发目录不被写 / 旧用户数据逐字节不变），单测 **+3**、反向验证 6 条红。**03 全部完成（S0–S6）**，文件名已加 `-已完成` 后缀） |
| [04](实施-04-能力自主选择-MCP与Skill.md) | 模型自主搜索 / 接入 / 使用能力 | [实施方案-C](../archive/2026-09-18-实施方案-C-MCP与Skill自主选择.md) | S1–S7 | 01-S2 | **S1–S5、S6a、S6b-1 已完成**。**S6b-2 进行中（2026-09-21）**：npm `pi-package` 已接 Electron runtime adapter；离线 Pi smoke 已支持并实测相对 glob / globstar / `!` 排除，staging payload 文件集合须与 hash manifest 精确一致；本轮已补 `mcp-package` 的精确 bin 解析、官方 SDK `tools/list` smoke、项目范围 stdio 登记 / 复核 / 幂等重放、受保护环境变量拒绝和超时清理；并补上固定本地项目相对路径的 `skill-files` staging / hash / active 清单 / 项目隔离 / 安全边界调度 / 下一次 runner 启动参数接线，以及独立 Skill 目录的版本 / commit、逐文件 URL / SHA-256 元数据适配与受限读取器；`typecheck` / `build` / 单测 **4158/4158**，`test:skill-files` / `test:skill-source` 通过；真实 `skilldirnet` 通过 SkillMD 目录的 `items → 同源详情 commit → raw 正文 SHA-256 → skill-files 候选` 发现链。之前的实际模型批次使用本机 `local/qwen3-local`（llama.cpp `Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp`，`127.0.0.1:8081`）并已完成真实响应与工具调用核验；本机服务随后按用户要求停止，当前不以它作为运行前提。**S7 实现与真实运行已完成主要接线**：能力设置页、三档模式策略、MCP 项目隔离、显式核验、取消 / 重连均已由 `capsettings` / `mcpcli` / `capcli` 覆盖；无身份时 fail-closed；重新构建后便携版与全新 NSIS 安装版的 `test:packaged --exe` 完整运行探针均已通过，安装器侧栏素材 `build/installerSidebar.bmp` 已随新产物接入。**仍未闭环**：获授权外部候选 acquire → 安装 → runner 激活 → 原目标续接实证；未随 tarball 提供的依赖仍 fail-closed；纯自定义工具且 RPC 不报告 command / Skill 路径的包暂不能确认 active。 |
> 04 行的早期状态描述保留作历史上下文；截至本轮，S7 的视觉截图与解包应用能力页包内验收已经完成；此前便携 wrapper / NSIS 安装态的探针缺口已修复：重新打包后，便携版与全新临时目录安装后的 `砚.exe` 均通过完整 `test:packaged --exe` 运行探针。安装器侧栏使用生图模型生成并转换的 `build/installerSidebar.bmp`（164×314），已接入 NSIS 配置并随新产物构建。当前仍未闭环的是 S6b-2 外部候选整链、独立 `skill-files` 来源，以及未随 tarball 提供依赖和纯自定义工具包的既有限制；Android 客户端按用户决定放在最后。以本段和 [HANDOFF 当前状态](../dev/HANDOFF.md) 为准。
| [05](实施-05-工作模式与长任务续接-已完成.md) | 标准 / 澄清 / 自主模式与长任务续接 | [实施方案-D](../archive/2026-09-18-实施方案-D-工作模式与长任务续接.md)、[方案-三种工作模式](../archive/2026-09-18-三种工作模式与长任务续接.md) | S1–S6 | 01-S1、02、03、04 | **✅ 已完成（S1–S6）** —— **S1（D0）+ S2（D1）+ S3a / S3b（D2）已完成**（2026-09-19）—— **S1**：钩子能力边界与安全点**五组对照实测**（假 provider，不联网不花钱）：`tool_call` 返回 `{block:true}` 的工具**真的不执行**（但拒绝文案固定为 `Tool execution was blocked`、循环不停）、`ctx.abort()` 能让下一个请求**真的不发**（代价：整轮 `Request aborted`，不是暂停）、**钩子里不能压缩**（`ctx.compact()` 会打断当前 run，安全点是宿主侧 RPC `compact`）、`before_provider_request` 返回新 payload **真能改写**发出去的请求体；设施 `scripts/hook-probe.mjs` + `scripts/lib/mock-provider.mjs`，证据 [证据-05-S1](证据-05-S1-钩子与安全点.md)。**S2**：会话级模式（`YAN_DIR/work-modes.json`，**键=会话文件路径**）、旧 `autonomous` 迁移（新字段优先、幂等）、菜单 + `Tab` 快切 + `Esc` 焦点出口、`question` 改读每实例模式快照（自主档不弹窗）；设置页新增「新会话默认模式」与「Tab 快切」。live **`workmode`**（cost 0，**已进 check**：旧配置迁移 / 菜单键盘 / **Tab 用真按键** / A-B 会话不串 + 退出后磁盘核对）；单测 **2879/2879**（新增 `test-work-mode.mjs`（契约 + 会话级存储）/ 改写 `test-question.mjs` / `test-session-runtime.mjs` +3）；视觉 **8 张**（模式菜单深/浅/窄窗 + 自主光带深/浅 + 设置页新增两行）。**真实链路抽到两个真缺陷并修掉**：① pi 对同一份会话文件切走再切回会报**新** `sessionId` —— 拿它作模式键会让模式当场丢回默认值（改用**会话文件路径** + 反向验证）；② `answerUi` / `dismissRequest` 只清顶层 UI 请求，`runners` 推送会把缓存里的旧请求投影回来，已回答的问题会“复活”（两处同时清缓存 + 单测）。**S3a**（D2 前半）：澄清档**硬门禁**（工具表主 + `tool_call` 兑底，执行者是薄层 `pi-extensions/work-mode.js`）+ `yan goal ready|report|status`（内联参数，因澄清档不能写文件）+ 会话级目标状态（幂等先于校验、先落盘、同因两次强制 blocked）；门禁三组对照（cost 0，含「假 provider 收到的请求里也没了 write/edit」）+ 端到端 `goal` 场景（cost 1，就绪→自动切标准），证据 [证据-05-S3a](证据-05-S3a-门禁与就绪转移.md)。**S3b**：跨轮自动续行 —— 宿主写待发续行快照 + 薄层 `pi-extensions/goal-resume.js` 用 **`custom` 角色**消息触发回合（消费证据先落盘、1.8s 二次确认保「用户消息优先」）；`yan:abort` / 切非标准档会撤销未发续行；live `goal` 第 7 节 + 会话文件条目取证。**S3c 已完成（2026-09-19）**：自主档「接着干」—— `goal.report` 成功后宿主 `armContinue`（`kind=continue`、上限 `AUTONOMOUS_CONTINUE_LIMIT = 8`、用户发言 `yan:send` 归零、终态 / 停止清续行），薄层按 `kind` 发 `yan-goal-continue`；新场景 **`goalloop`**（cost 1，固定 deepseek 一闪）+ `afterExit: goalLoopPersisted` 真跑通：**一条用户消息** → rev1 `executing` → 自动叫醒 → rev2 `completed`（单测 **+28** 条，3131 全绿）。**S4 已完成（2026-09-19）**：请求前预算诊断与硬闸门 —— `resources/pi-extensions/context-budget.js`（公式与 `shared/context-policy.ts` 交叉校验）+ `context.js` 的 `before_provider_request`（`normal/soft/physical` 三档；物理风险 `ctx.abort()` **不发送** + 会话留痕 + 诊断；soft 命中跳过清扫收益门槛）；证据 [证据-05-S4](证据-05-S4-请求前预算门.md)（`hook-probe budget / budget-soft` 两组对照 cost 0 + 新场景 `budgetgate` cost 1 + 单测 +51）。**剩 S5–S6**（S5b 交接生成与事务 / S6 联调与包）。**S5a 已完成（2026-09-19）**：交接**计数与资格** —— `shared/handoff.ts` + `main/handoff-service.ts`（`YAN_DIR/handoffs.json`）：只计「成功 + 自动」的完整压缩（`triggeredBy: policy` 或原生 `threshold`/`overflow`）、稳定键挡住 `state` 重放、按片段持久化且重启不归零、到 2 次后看四个资格条件（够数 / 目标在推进 / 自主档 / 不忙）；交接包**契约**（必填校验 + 来源由宿主覆盖 + 提示渲染）同时就位。单测 **+62**（3244 全绿）；真实证据：`contexttakeover`（cost 1）afterExit 里 `handoffs.json` count=1 + 去重键落盘。**S5b-1 已完成（2026-09-19，同天）**：会话链数据层 —— 用户拍板「**后台两份 JSONL、前端显示为同一条会话**」（覆盖 §9 原先的源/目标各自标注）：`shared/session-chain.ts`（段/链/键归一化与 `work-mode-service` 交叉校验/追加幂等/代表段/拼接顺序/脏值清洗）+ `main/session-chain-service.ts`（`YAN_DIR/session-chains.json`、`link` 四种情形、落盘失败抛）；单测 **+55**（3299 全绿）。**S5c 已完成（2026-09-19）**：模型出错后的**自动继续** —— 错误分类（额度 / 认证 / 上下文 / 取消四类**不重试**；其余按 3s/10s/30s 退避再起一轮）+ 连续上限 3 次（用户发言归零、重启不忘记，`YAN_DIR/auto-continue.json`）+ 复用 S3b/S3c 的续行通道（`kind=retry` → `yan-auto-continue`，仍是 `custom` 角色消息）；触发源是新推送通道 `agent-error`（不靠匹配文案）；单测 **+79**（3378 全绿）；新场景 **`autocontinue`（cost 0）**全绿（模型名故意写坏 → 一条用户消息 → 自动再起 2 轮后停手；`auto-continue.json` 计数停在上限、没有混入 S3b/S3c 的标签）；回归 `goal` / `goalloop` / `workmode` / `live` / `sessions` 全绿。**S5b-2（交接包由模型生成）已完成（2026-09-19）**：宿主判资格 → 渲染提示词 → 写 `handoff-request/<runnerId>.json`；薄层新 `handoffs.js` 在 `agent_settled` 时调一次 `ctx.modelRegistry.complete` 并把原文写回结果文件（无论成败）；宿主三道闸门（id 对得上 / 能解析 / 清洗过）后落盘，否则**丢掉并告知**（不写半份包）；`parseHandoffOutput` 改用**括号平衡扫描**（模型多吐一句时旧的「首尾截取」会整份失败）；只读 `yan:getHandoff` 给探针与后续界面用；触发点两处（压缩完成 / **回合结束** —— `goal report` 发生在回合中途，那一刻实例是忙的）；单测 **+69**（3447 全绿）；新场景 **`handoffpack`**（cost 1，`YAN_HANDOFF_THRESHOLD=0`）全绿（扩展日志 `produced ms=4753 chars=1203 error=null` + 包落盘 + 计数仍为 0 + 请求/结果目录已清空），回归 `contexttakeover`（计数照常、未误 arm）。**S5b-3a（事务状态机与日志）已完成（2026-09-19，同天）**：`shared/handoff-transaction.ts`（阶段顺序与硬前提 / 幂等推进 / 目的会话锁定 / `resumed` 只能由**磁盘证据**置位 / `recoveryAction` 把「committed + 无证据 → 重发一次、更早阶段 → 回源」写成可测逻辑）+ `main/handoff-transaction-service.ts`（`YAN_DIR/handoff-transactions.json` 按 `handoffId` 索引、串行队列、原子写、落盘失败抛、未终结事务不裁）；单测 **+59**（3506 全绿）。**本片不接外部动作**（建会话 / 租约 / 发消息 / `link` 是 S5b-3b），所以无真实运行证据，理由已写进 HANDOFF。**S5b-3b（接线与取证）已完成（2026-09-19，同天）**：`shared/handoff-resume.ts`（标记 / 正文 / 证据检测）+ `main/handoff-runner.ts`（**先停源释放同 cwd 租约 → 同 cwd 建目的会话 → 写链 → 发 resume → 等磁盘证据**，失败一律回源；`resumeAttempts` 防盲发两遍）+ `index.ts`（`SessionChainStore` / `HandoffTransactionStore` / 启动 `recoverHandoffs` / `YAN_HANDOFF_COMMIT` 开关，**默认关**待用户拍板）；单测 **+75**（**3581/3581**）；新场景 **`handoffcommit`**（cost 1）全绿 + `afterExit` 磁盘核对（五阶段一个不缺 / 链两段且 `handoffId` 对得上 / 目的会话文件真有标记行 / 源会话与包都在）；真实链路抽到并修掉**三个真问题**（事务查询未归一化会话键 / `yan:getHandoff` 按当前段查包导致交接后归零 / `link` 的「拒绝」返回值被当成成功）；回归 `workmode` / `live` 全绿。**S5b-4（前端仍是「一条会话」）已完成（2026-09-19，同天）**：`main/session-history.ts` 的 `readChainMessages`（按段从旧到新拼接、缺段计入 `missing`、**不改写 JSONL**）+ `agent.ts` 的 `readHistory` 注入 + `yan:peekSession` / 远程历史链感知 + `yan:listSessions` 只列代表段（无标题时用链首段标题）+ `yan:deleteSession` / `restoreSession` 按链删 / 整链撤销 + `SessionChainStore.forget`；单测 **+19**（**3600/3600**）；`handoffcommit` 4b 节（`listSessions()` 里当前会话只一次、旧段不出现、界面 messages 里源段与 resume 同处一条时间线）+ 视觉 **2 张**（`chainjoin` 深浅，已看图，溢出 0px）；回归 `sessions` / `trash` / `historyswitch`。顺手修掉一条真缺陷：切会话时 `runners` 推送把实例的**空缓存**投影上来，把 peek 刚铺好的历史打回 0（闪一下空白）—— 新 `projectSnapshotKeepingPeek` 四道投影共用（A/B 反向验证：`YAN_NO_CHAIN_HISTORY=1` 关掉链感知后照样红，证与本片无关）。已知限制：导出 / 复制仍单段（pi 单文件语义）。**S6（联调 + 包）已完成（2026-09-19）**：自动交接**默认开**（用户拍板；`YAN_HANDOFF_COMMIT=0` 关，解析有单测钉默认值）+ 模式跟着会话走（`inheritWorkMode`）+ 目标不迁移（§8：由模型按交接包重新登记）；`dist:dir` + `test:packaged` 全绿（新增 7 条：asar 静态索引 4 + 解包态交接 3）；单测 **3610/3610**。**05 全部完成（S1–S6）**，剩余限制见文末 |
| [06](实施-06-上下文管理收尾.md) | 上下文管理收尾（N21 系列） | [方案-上下文工具内的自动压缩](../design/方案-上下文工具内的自动压缩-2026-09-15.md)（细节唯一真源）+ HANDOFF/PRIORITY 的 N21 表 | S1–S5 | 01-S1 | **S1–S5 已完成**：S2 的 v7 定稿为 48 次真实调用，状态层相对基线收益不成立（LCR 相对下降 12.5% / 14.3%，低于 25% 门槛），不据此调整 01 白名单；“A 组丢失率先抬至 20–40%”已被数据证伪（A=11.1%，丢失集中于单一任务），不再重跑。S3 压力测试 / 门槛标定 / `symbolsTouched` 决策已完成；S4 两档不可达实测与陈旧场景处置已完成；S5 包验收随 09-S4 完成。详见[实施-06](实施-06-上下文管理收尾.md)与[证据-06-S2](证据-06-S2-N21-9基准-2026-09-19.md) |
| [07](实施-07-Git与环境菜单收尾-已完成.md) | Git 审查 / 环境菜单 / 来源菜单收尾 | [方案-Git审查与环境菜单及插件视觉规划](../archive/2026-09-18-Git审查与环境菜单及插件视觉规划.md)（已归档，剩余转本文） | S1–S5 | — | **主体已交付**：G1/G2/**G3**（GitHub PR）/W1/W2/S1/**P1/P2**/H1 —— 含设置「插件」页（安装 / 卸载 / 更新）与 GitHub REST 的 PR 状态。**S1 已完成（2026-09-19）**：非 Git 目录真实截图（`envnotgit` / `reviewnotgit` 两个新视觉状态，深浅 + 窄窗共 5 张已看图、溢出 0px）+ 三条已知限制复审（与实现一致）。**S3（来源定位消息）已完成（2026-09-19）**：每会话一张 `links.json` 存「来源 ↔ 消息」关联（不写会话 JSONL）；发送时按附件排队、收到 pi 的 user 条目即绑定；菜单里有落盘关联的来源出现「定位消息」→ 滚到 `data-msg-id` 并短暂高亮。场景 `sourcelink`（cost 0，**已进 check**）与 `sourcelinklive`（cost 1，手动），视觉 3 张 `matrix-envlinks-*-2026-09-19s7.png` 已看图。**S2a（工作树来源关系落盘）已完成（2026-09-19）**：每会话一条 `YAN_DATA_DIR/worktree-links.json`（新会话 ↔ 工作树 ↔ 源会话 + 源目录 + 分支 + 时间），开新会话时登记、环境菜单工作树区显示「这个会话是从工作树 X 派生的」；场景 `gitwrite` 扩断言 + 退出后 Node 侧读盘核对，视觉 `matrix-envworktrees-*-2026-09-19s8.png` 已看图。**S2b（四个重绑定本体：项目权限 / 相对文件路径 / 附件授权 / 上下文派生）形态已定（2026-09-19）**：用内置浏览器问过 ChatGPT，采纳 **Fork Session**（新会话 + lineage + 交接包，默认不整段注入、可回看），优先级 = 权限 P0 / 相对路径 P0 / 上下文派生 P0 / 附件 P1，四条反模式写进实施-07 §4；拆成 S2b-1…S2b-5。**S2b-1（形态与文案）已完成**：按钮改「派生新会话」，工作树区分两行如实列出「会带 / 不带」，`gitwrite` 新增 4 条断言 + 视觉已看图。**S2b-2（项目信任重新建立）已完成**：新增 `src/main/project-trust.ts` + IPC `yan:trust:status`/`allow`，工作树行「信任这个目录」写进 trust.json，**不自动继承**（`gitwrite` 新增 7 条断言 + Node 侧读盘核对 + 视觉 `matrix-envworktrees-*-2026-09-19s2b2.png` 已看图）；顺带修掉**设置写入的并发缺陷**（`patchSettings` 加串行队列）。**S2b-3（repo-relative 路径重绑定）已完成**：新增 `src/shared/fork-rebind.ts`（纯逻辑 + 37 条单测）+ IPC `yan:fork:fileRefs`，工作树行显示「源会话 N 个引用 · M 个能对上」，仓库外与 `..` 报 `outside` 不迁移；`gitwrite` 新增 6 条断言（含「源仓库的绝对路径仍是 outside」这条反模式反向验证）+ 视觉 `matrix-envworktrees-*-2026-09-19s2b3.png` 已看图。**S2b-4（语义注入）已完成**：新增 `src/shared/fork-context.ts` + `yan:fork:context`，派生后往输入框放进接手上下文草稿（**不自动发送**），环境派生状态在目标工作树重算、可迁移知识只取源会话交接包（没有就明说）；单测 +34、`gitwrite` +7 条断言（含「没被自动发送」）、视觉 `matrix-forkdraft-*-2026-09-19s2b4.png` 已看图，并同步了新事实的「会带 / 不带」文案。**S2b-5（附件不迁移）已完成**：只数源会话里的图片附件并如实告知「N 个没有带过来」，不做任何搬运；单测 +6、`gitwrite` +5 条断言、视觉 `matrix-forkdraft-*-2026-09-19s2b5.png` 已看图。**S2b 五片至此全部完成**（形态与文案 / 权限重新建立 / 相对路径重绑定 / 语义注入 / 附件）。**S4（来源搜索）已完成（2026-09-19）**：判定接的是**能力目录**（已装 Skill + 已接 MCP 工具，内置 `knowledge.search` 不算）——「有则出现、无则隐藏」，命中时入口只把草稿注入输入框（不自造搜索后端、不代发）；场景 `sourcecap`（cost 0，已进 check）+ 反向验证 + `matrix-sourcesearch-*-2026-09-19s4.png` 深浅两张已看图。**已定不做**：`pi config` 启用 / 禁用、GitLab / Bitbucket PR（S5）。**无剩余可做项**（S2b 五片已回填进本文 §3），文件名已加 `-已完成` 后缀 |
| [08](实施-08-安卓远程管理.md) | 安卓远程管理 | [Android UI 方案](../design/ANDROID-UI-PLAN-2026-09-18.md)（活动区）+ [REMOTE-CONTROL](../dev/REMOTE-CONTROL.md) | S0–S5 | — | **S0 已完成**（2026-09-19：连接状态机与能力边界冻结，`RC-SM/1` —— 126 格迁移表 + 授权轴正交 + 能力矩阵 + 断线语义 + 8 类错误，[文档](../design/远程-连接状态机-2026-09-19.md)）。电脑端协议已落地；**2026-09-20 `remoteroutes` cost 0 全绿**，隔离 Electron 实测 health / 鉴权 / 新建 / 指定会话发送 / runId abort，目标流被取消且桌面视图不切换。Android 客户端未开始 |
| [09](实施-09-交付与验收收尾.md) | 发布门槛 + 取证尾巴 + 两条遗留缺陷 | HANDOFF「当前未完成」+ PRIORITY 的 P0-8 / P2 / P3 | S1–S5 | 全部 | **S1 已完成**（2026-09-19：两条遗留缺陷修掉 —— 窄窗收起 48px 与 `fs` 键盘导航均为**真实变绿 + A/B 反向验证**，证据见 [HANDOFF](../dev/HANDOFF.md) 本轮小节）；**S3（每个项目最后一个会话）已完成（2026-09-19）**：`lastOpenedAt` 分类优先于 `lastActivityAt`、`Rail.switchProject` 决策前刷新列表；场景 `projectopened`（cost 0，已进 `check`）真绿 + 反向验证（换回纯活动时间排序即变红）。⚠️ `lastOpenedAt` 落在已有的 `session-layout.json` 而不是会话文件自身（理由见 [实施-09 §4 S3](实施-09-交付与验收收尾.md)）。**S2 已全部完成（2026-09-19，七批）**：N12 四态（未读 / 等待输入 / 失败 / 退出变体）+ N10「光带运行中」+ L03「模型失败与启动/超时」（顺带修掉一个真缺陷：模型失败原被当成 `done`）+ N04「真实长中英混排推理流」—— 每批都是真实运行证据 + 已看图截图（见 [HANDOFF](../dev/HANDOFF.md) 本轮七节）；**S4/S5 已跑通一次（2026-09-19）**：`vendor:pi:check` → `dist:dir` + `test:packaged` → 便携版 `--exe` → `dist` 三产物 + `SHA256SUMS.txt` 重写 → `npm run test:upgrade`（新造的常设步骤：副本升级读取 + 原目录逐字节未变）→ 包内审计（**拓到并修掉**开发日志进 `app.asar` 的污染）；**S4 的逐项「应用与包」栏核对已完成**（01–08 逐项；06/07/08 本轮新增包内断言，08 含「显式开启可启动」并做了反向验证；07 的 Git 写操作与**审查面板只读链路**均已补到包内运行级（解包 + 便携版各一次，各自反向验证），见实施-09 §3）；本轮又完成了全新 NSIS 安装与安装后 EXE 探针、`npm run test:upgrade` 和 `npm run check` 的前置验证；**剩余发布门槛只受 04-S6b-2 外部候选 / 独立 Skill 来源及其明确边界影响**。P0-8 用户已明确要求放最后 |

> **2026-09-21 状态增量**：S6b-2 新增 staging manifest 精确文件集复核，并补上 `mcp-package` 的精确 bin 解析、官方 SDK `tools/list` smoke、项目范围 stdio 登记 / 复核 / 幂等重放、受保护环境变量拒绝和超时清理；本轮又补上独立 Skill 目录条目适配（必须有版本 / commit、逐文件 URL 与 SHA-256）和受限读取器（来源白名单、UTF-8 / 大小 / 跳转 / hash 复核），`test:skill-source` / `test:skill-files` 已通过；真实 `skilldirnet` 通过 SkillMD 目录的 `items → 同源详情 commit → raw 正文 SHA-256 → skill-files 候选` 发现链，`discnet` 原有 npm / MCP 联网发现也回归通过。S7 已补 MCP 私有服务 runner 项目隔离（全局项保留、本项目私有项只对匹配项目可见；无项目身份 fail-closed）、能力设置页、三档模式策略、显式核验与取消 / 重连；`typecheck` / `build` / 单测 **4158/4158**，`capsettings` / `mcpcli` / `capcli` 真实运行通过；`visual:matrix` 已生成并实际看图核对能力页深浅主题，4 张 S7 截图均溢出 `0px`。`dist:dir` + 最新 `test:packaged` 已在解包、便携版和全新 NSIS 安装后 EXE 中取得完整运行探针；安装器侧栏使用 `build/installerSidebar.bmp` 并随新产物接入。当前仍缺获授权外部候选整链、依赖、纯自定义工具包的限制。08-S0 的隔离 Electron `remoteroutes` 已全绿并纳入 `check`，本轮未复跑。**06-S2 的 A/B 基准已完成，不再以“把 A 组丢失率抬到 20–40%”为待办**：v7 的 A 组为 11.1%，丢失集中于单一任务，继续校准目标已被证据证伪。早期模型批次曾使用本地 llama.cpp，并已完成真实模型与工具调用核对；随后按用户要求停止本机模型服务，DeepSeek API 批次的唯一一次 `contextfoldpref` 超时已用同模型隔离重跑通过。详见 [HANDOFF 本轮记录](../dev/HANDOFF.md)、[S6 技术预检 §6](证据-04-S6-技术预检.md) 与 [06-S2 证据 §6](证据-06-S2-N21-9基准-2026-09-19.md)。
>
> **同日收尾校正**：最近一次完整 `check` 的批量结果为 **80/83**，随后已将 `toolgroup` 的真实高度契约从 `623px` 修正为 `625px` 并单独实测通过；`virtual` / `outlinepos` 的隔离与组合运行也通过。不要把这轮的批量资源敏感性写成产品回归，也不要在没有重新跑完整批量前宣称 83/83；当前可确认的是自动门槛通过、无已复现的隔离场景红，以及三种包形态的运行探针通过。

> **来源列里的归档路径**：本目录建立时把被取代的原方案移进了 `docs/archive/`（没有删除、只做 `git mv`）。
> 原方案里的**业务契约与验收条件已全部吸收进对应实施文档**，冲突处一律以本目录的最新版为准。
> 只有在需要追溯“当时为什么这么想”时才去读归档件。
>
> **决策记录**：本目录的关键取舍来自**两次外部咨询**（各一份记录，不合并）：
> [三方意见对照（第一轮，8 题）](决策记录-三方意见对照-2026-09-18.md) 与
> [二轮外部咨询（5 题）](决策记录-二轮外部咨询-2026-09-18.md)。
> 后者的四条硬口径：**薄层准入按「语义契约 5 条」判定**、**01-S1 必含端到端最小闭环**、
> **钩子缺失时按止损表处理（救 3 项 / 弃 2 项）**、**「最后会话」不新增状态真源**。

### 1.1 并行编排（2026-09-19）

主题表只说「一次会话一片」，**没说片与片能不能同时做**。而本项目是**一个工作区、常年带大量
未提交改动**（2026-09-19 实测 116 项，`git diff` +2494 行）——两个代理同时动一个文件必然互相覆盖。

所以另立一份 [并行代理编排](编排-并行代理分工-2026-09-19.md)：它只回答**哪些片能同时开工、
每个代理占哪几个文件、做完往哪里交证据**，不含任何主题范围与完成度判定（那仍然只看本表与 [HANDOFF](../dev/HANDOFF.md)）。
一句话结论：**W1 五个片可同时开工** —— `yan browser` CLI 迁移（01-S4b，P0 硬阻塞）/ 03-S2 / 06-S2 / 08-S0 / 04-S1；
而 `agent.ts` + `capability-server.ts` + `resources/yan-cli/yan.mjs` 三件套、`scripts/test-live.mjs` 的 `CASES`
与 `HANDOFF` 是共享热点，必须串行（队列顺序见该文 §5）。

## 2. 2026-09-18 新增边界（影响 01–05 全部）

用户新增：**完成版只包含默认 pi，不内置 pi 插件**。这条边界已经合并进 01–05 的正文，
不再作为“附加注意事项”。它对旧方案的**具体修改**如下（旧方案的写法一律作废）：

| 旧方案里的写法 | 现在的写法（最新为准） |
|---|---|
| 随包注册 pi 扩展（`resources/pi-extensions/task-plan.js` / `capabilities.js` / `work-mode.js`） | **不新建**；改为砚主进程服务 + 随包 `yan` CLI 子命令，模型用原生 `bash`/`read` 调用 |
| 预装 `pi-mcp-adapter` / `pi-web-access` 等 pi 插件 | **不预装、不暗中装回、不改名冒充原生** |
| 「能力」= 注册给 pi 的模型工具（`capability_*` / `mcp_*`） | 「能力」= `yan capabilities …` / `yan mcp …` CLI 子命令 |
| 选择性排除用户的旧扩展 | 默认路线**不加载用户的扩展与第三方插件**（只加载砚自有薄层；**pi 自带的 inline 扩展（如 `llama`）属于默认 pi，不在排除之列**）；用户已装的扩展不删除，升级时提供可读清单并说明不再加载 |

**薄适配层的口径（2026-09-18 用户拍板：允许）**：砚**可以**保留一个自有薄适配层，
但它**不是插件生态** —— 只承载「宿主无法通过 CLI / RPC 表达」的生命周期桥接与策略执行，
**不注册模型工具、不注册 pi 命令、不增加用户可见功能、不改 pi 默认工具集**。
能落地到宿主服务 / 随包 `yan` 子命令的，一律不得留在扩展里。
配套两组约束（一次性边界 + 持续约束：允许钩子白名单 / 依赖方向 / 架构检查）见
[01 §1](实施-01-默认pi架构迁移.md)；逐项判定集中在 01-S1 与 [06](实施-06-上下文管理收尾.md)-S1。

## 3. 执行顺序（跨主题）

```text
01-S1（P0 可行性：无扩展的默认 pi 能做什么、不能做什么）   ← 02–06 的共同前提
   ├── 02（任务工具内置化，S1–S5 ✅）─┐
   ├── 03（项目知识）        ─┤ 三者互相独立，可任意顺序
   └── 04（能力自主选择）    ─┘
        └── 05（模式与长任务续接：消费 02/03/04 的接口）
06（上下文管理收尾）  ← 与 01-S1 的结论强耦合（见该文 §3 的冲突说明）
07（Git / 环境菜单）  08（安卓）  ← 与 01–06 无依赖，可并行
09（发布门槛）        ← 必须最后；它同时是上面各项「应用与包」栏的共同缺口
```

## 4. 产品边界（不因为整理文档而改变）

遵循 [AGENTS.md 第五节](../../AGENTS.md)，这里是**精简版**，详细边界以 AGENTS.md 为准：

- **任务面板保持现状**：继续读会话里的任务清单，**不重构面板布局、不改造用户扩展来改变任务引导**。
  02 已**完成**：任务的**所有权与接入来源**已改为砚内置（宿主服务 + `yan tasks apply` + 界面接线）。
- **旧记忆系统不恢复**：记忆存储、`remember`/`recall`/`forget`、记忆扩展与提示词注入都不恢复；
  用户遗留数据不删。03 的「项目知识」是**独立新功能**（**S0–S6 已实施：存储 + 检索 + 注入 + `yan knowledge` CLI + 设置页 + 跨会话 / 工作树隔离与包**），既不等于恢复旧记忆，也不自动导入旧存储。
- **`get_tree` 浏览链路是主动移除的**，不重新实现、不列回待办。
- **推理块默认展开但限高省略**：`--reason-max-h`、裁掉开头、贴底显示最新、顶部渐隐、「展开全部」出口。
  ⚠️ 2026-09-18 深夜用户拍板：**主动展开时给固定范围**（工具组 `min(625px, 80vh)`＝25 条、
  单条详情与推理全文 `min(70vh, 620px)`），AGENTS.md 里「展开全部不引入第二条滚动条」只约束**默认态**。
- **语言约束只有一句话**，唯一真源在 `resources/pi-extensions/language.js`，永远保留模型原文。
- **界面历史就是会话文件**，不能拿 pi 的 `get_messages` 当界面历史。
- **登录只预留**：本地档案不显示虚假的「已登录 / 已同步」；订阅制里只有 ChatGPT(`openai-codex`) 可应用内登录。
- 深浅主题、设置面板、模型接入 UI、Windows 打包、内置浏览器、本机 Chrome 接入**都已实现**，不再列为未开发项。

## 5. 本文的维护规则

1. **一个主题只在本目录有一份实施文档**；旧方案只作历史，不再更新。
2. 切片完成 → 改本文状态列 + 写 HANDOFF 六栏证据；**不把实施计划写成已完成**。
3. 用户后续指示与本文冲突时，以用户指示为准，并回来改本目录（旧的归档件不再回写）。
4. 归档不放流水账：`docs/archive/` 只收「已结束或已被取代」的整份文档，
   文件名带日期前缀，索引见 [archive/README](../archive/README.md)。
5. **整份做完的主题，文件名加 `-已完成` 后缀**（例：`实施-02-任务工具内置化-已完成.md`），
   这样看文件名就知道还剩哪些没完。两条纪律：
   - **只标「没有剩余可做项」的文档**；主体交付但有尾巴的**不标**
     （例如 07 还剩 W2 重绑定 / S1 定位消息 / 非 Git 目录截图，01 还剩 S4–S5）。
   - 加后缀时**必须同步全文引用**（`docs/` 内所有相对链接），
     并用 `npm run audit:refs` 验证文档链接闭合 —— 重命名不会报错，断链才会。
   后缀只是**索引性标注**，完成度仍以 [HANDOFF](../dev/HANDOFF.md) 的六栏证据为准（第 2 条不因后缀而放松）。
