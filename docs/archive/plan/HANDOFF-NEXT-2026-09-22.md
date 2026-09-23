> 历史交接，已由 2026-09-23 审核融合入口取代；以下状态与任务顺序不作为当前指令。

# 下一会话交接：完成 pi-desktop 当前待办

> 交接日期：2026-09-22
>
> 这是一份给下一会话 agent 的可执行交接。它不替代当前状态入口 [`docs/dev/HANDOFF.md`](../../dev/HANDOFF.md)，也不替代路线图 [`docs/plan/README.md`](../../plan/README.md)：状态以 HANDOFF 和源码为准，任务顺序以 plan/active 正文为准。

## 一句话结论

当前不是“从头盘点项目”，而是按 **P0 → P1** 继续收口：04-S6b-2 的一个真实 Skill 文件候选整链已在本轮用户明确授权下通过；01-S5 的 `question`（`yan question ask`）与 `context_recall`（`yan context recall`）都已是宿主唯一入口，空壳 `browser.js` 与只服务于它的 loopback bridge 也已删除（2026-09-23 S5d）；当前 P0 主要剩其它资源类型的包级候选证据与 09 最终发布门槛；P1 是 06 的残余证据边界、11 Harness / 工作窗口 / 1M 队列、10 最终视觉矩阵和 08 Android 客户端。

可以直接推进本地源码、测试、文档和已有能力的证据收口。若当前会话没有明确的候选来源和网络获取 / 安装 / 运行授权，遇到“连接真实外部候选并安装”时必须停在授权边界；已有授权的候选仍须经过来源固定、恶意 Skill 审查和相应包级证据。开始 Android UI / 配对 / TLS / APK 仍需单独授权，不能用 fixture、目录发现或桌面端证据代替真实交付。

## 0. 下一会话开始时必须做的事

1. 先读根目录 [`AGENTS.md`](../../../AGENTS.md)、[`docs/plan/README.md`](../../plan/README.md)、[`docs/dev/HANDOFF.md`](../../dev/HANDOFF.md) 和本文件。
2. 执行 `git status --short`、`git log -1 --oneline`，确认当前工作树，不要假定脏改动是缓存。
3. 当前工作树已在 `9be856d chore: checkpoint current Yan progress` 完成本地检查点，`git status --short` 应为空。保留用户数据和后续新改动，不要把当前检查点误当成可随意清理的缓存。
4. 先读目标活动正文，再读对应源码和现有测试；不要只按历史 HANDOFF 中的“下一步”动手。
5. 开任何真实 Electron 场景前，先 `npm run build`；测试数据必须使用独立的 `YAN_USER_DATA`、`YAN_SESSIONS_DIR`、`YAN_DATA_DIR`、`YAN_PI_DIR`。调模型前先确认模型、额度和 `docs/dev/TESTING.md` 的 cost 约定。
6. 每完成一个切片，立即把六栏证据写回活动正文和 `docs/dev/HANDOFF.md`，不要积累到最后再凭记忆补。

最近一次检查点已包含以下文档与源码进度；后续若继续修改，应以当前源码和活动正文为准：

- `docs/plan/README.md`、`docs/plan/active/README.md`；
- `docs/design/active/README.md`；
- `docs/dev/HANDOFF.md`；
- `docs/plan/active/实施-01-默认pi架构迁移.md`、`实施-04-能力自主选择-MCP与Skill.md`、`实施-06-上下文管理收尾.md`、`实施-09-交付与验收收尾.md`、`实施-10-AI产物展示与GPT-Image.md`、`实施-11-Harness工作窗口与1M模型策略融合.md`；
- `docs/plan/active/编排-并行代理分工-2026-09-19.md`（已明确标成历史波次文件，不是独立待办）。

本检查点同时包含能力 / Skill 安全、上下文召回、CLI / probe / 测试和视觉证据的现有进度；不要因为这些文件已经提交就把对应主题误判为六栏全部完成。

不要用 `git reset`、`git checkout`、`git clean`、`rm` 或“清理工作区”的方式处理它们。根目录真实 `nul` 已在检查点按项目约定处理，不能重新创建、删除或覆盖。

## 1. 当前路线和完成定义

| 优先级 | 主题 | 当前真实状态 | 下一出口 |
|---|---|---|---|
| P0-1 | 04 能力自主选择 | S1–S5、S6a、S6b-1、S7 主链、独立 Skill 目录只读发现、本地 Pi / staging / mcp-package / 固定 Skill 安全边界已有证据；本轮已完成一个获授权外部 Skill 文件候选整链，并加入用户指定候选也必须执行的恶意 Skill 审查 | 其它资源类型 / 包级候选证据，以及最终发布门槛复核 |
| P0-2 | 01 默认 pi 架构迁移 | `question` 与 `context_recall` 都已收口为宿主 CLI 唯一入口；空壳 `browser.js` 与只服务于它的 loopback bridge 已删除（2026-09-23 S5d），薄层不再有空壳扩展 | 默认 pi + 允许的砚薄适配层可启动、扩展边界唯一、旧入口不再用户可见；剩发布切换重跑 |
| P0-3 | 09 交付与验收 | 解包、便携、全新 NSIS 安装态已有历史运行证据，但等待 01 / 04 最终边界后重跑 | 当前源码的最终 check、真实运行、视觉、包和剩余限制齐全 |
| P1 | 06 上下文管理 | N21-9 已完成；不要重做 N21-9 | 长会话证据限制、最终归属和 01-S5 边界记录准确 |
| P1 | 11 Harness / 1M | H-1/H-2/C-1/H-7/C-4/C-5 已交付；H-6/H-6b、C-2、H-3/H-4 部分；C-6、C-3、H-8/H-9/H-10/H-11 仍有开放项 | 按正文 §3 的依赖队列逐片闭环 |
| P1 | 10 AI 产物 / GPT Image | 主链已有；最终视觉矩阵仍需收口 | 真实截图看图并记录；参考图上传、PDF 阅读仍如实保留为限制 |
| P1 | 08 Android 远程管理 | 桌面端 HTTP + SSE / 定向消息 / abort 已有；移动端未开始 | 先取得 Android 范围授权，再做配对、密钥、TLS / 中继、UI、APK |

每一项只有同时具备“实现、自动检查、真实运行、视觉验收、应用与包、剩余限制”六栏，才能从待办移出。代码存在、mock 通过、探针打印 `ok`、构建成功、文件已打包，都不能单独算完成。

## 2. P0 执行顺序

### P0-1：实施-04 S6b-2 —— 真实外部候选整链

权威正文：[`实施-04-能力自主选择-MCP与Skill.md`](../../plan/active/实施-04-能力自主选择-MCP与Skill.md)。

#### 授权门槛

- 只有用户在当前会话明确给出候选来源 / 包 / URL，并明确允许网络获取、安装和运行，才可以执行真实 acquire / install / activation。
- 不能把 `skilldirnet` 的外部目录只读发现当成候选已授权，也不能把本地 fixture、临时 npm 包、离线 Pi smoke 或 `mcp-package` 的内部回归当成外部整链。
- 没有授权时保持 `pending-boundary` / fail-closed，继续推进不依赖它的 01、06、10、11 文档和本地工程项；不要伪造“完成”。

#### 获授权后按这个顺序执行

1. 固定候选的来源、版本 / commit、包内文件清单、依赖和目标项目身份；保存授权证据和 `operationId`。即使候选由用户指定，也必须先做 Skill 正文恶意内容审查：high fail-closed，medium 作为提醒留在回执。
2. 走现有受管 staging，不直接写真实用户目录；重新计算并核对精确 manifest / SHA-256，拒绝未登记文件、缺失文件、符号链接、特殊文件、路径穿越和超出边界的依赖。
3. 按候选类型走已实现的 runner：`skill-files` 要验证来源 / hash / 项目隔离 / 空闲 runner / `--skill`；`pi-package` 要验证受管 `pi install -l` 和 package runner；`mcp-package` 要验证精确 `bin`、官方 SDK `tools/list`、项目范围 stdio 登记和受管配置；不属于已支持类型就 fail-closed。
4. 做真实激活：只重载目标 `runnerId`，验证 trust、`generation`、`cwd`、`projectId`、`goalRevision`、`sourceHead` 和 `continueId` 仍匹配；忙碌的无关 runner 不得被重启。
5. 从原目标继续一次，记录原目标文件、同一 runner、唯一 `continueId`、`resumed` 回执和失败 / 取消 / 重试行为；确认 `continueId` 不会被重复消费。
6. 在同一授权范围下补包级证据：解包、便携、安装态至少覆盖候选落位、配置边界、启动、激活和原目标续接；依赖不随包提供时必须保留 fail-closed 证据。

#### 04 的完成回填

在 `实施-04`、`docs/dev/HANDOFF.md` 和必要的 `docs/archive/evidence/` 中分别记录：候选身份与授权、实现、自动检查、真实 Electron / runner 行为、视觉（如有 UI 变化）、包内运行、剩余限制。特别写清“临时 Pi 不是 OS 沙箱，候选仍以当前用户权限执行”。

### P0-2：实施-01 S5 —— 默认 pi 唯一入口收口

权威正文：[`实施-01-默认pi架构迁移.md`](../../plan/active/实施-01-默认pi架构迁移.md)。

执行要求：

- 先核对当前源码和 02–06 的最终归属，不按旧扩展文件的存在推导“功能未迁移”。
- 完成版只保留默认 pi 和必要的砚薄适配层；薄层只允许承载宿主无法由 CLI / RPC 表达的生命周期桥接与策略，不注册模型工具、pi 命令或旧生态入口。
- 不恢复旧记忆存储、`remember` / `recall` / `forget`、任务工具扩展、`get_tree`、`browser.js` 模型工具或第二个同义用户入口。浏览器能力以 `yan browser` / 宿主正式入口为准。
- 清理的是用户可见旧兼容入口和空壳扩展，不是随意删除历史数据；`release/砚数据/` 只读，`resources/pi-runtime/` 不手改，`resources/pi-extensions/` 只按迁移边界修改。
- 每次改动后先 `npm run build`，再跑受影响的 `test:live`；不要因为文件删除或静态 grep 通过就宣称迁移完成。

重点验证：默认启动、扩展加载边界、`yan` 正式入口、旧入口不存在、项目知识 / 任务 / 浏览器 / context 归属没有回归；`question`（S5b）与 `context_recall`（S5c）均已有宿主 CLI 六栏证据，空壳 `browser.js` 与 loopback bridge 已在 2026-09-23 S5d 删除；把它和“明确不迁移”的项写入六栏。

### P0-3：实施-09 —— 最终发布门槛

权威正文：[`实施-09-交付与验收收尾.md`](../../plan/active/实施-09-交付与验收收尾.md)。必须在 04-S6b-2 和 01-S5 的源码边界稳定后重跑，不得把 2026-09-19 的历史数字当作最终当前证据。

建议顺序：

1. 阅读 [`docs/dev/TESTING.md`](../../dev/TESTING.md)，确认模型、额度、cost 1 场景和隔离目录。
2. 跑 `npm run typecheck`、`npm run build`、`npm run test:unit`、`npm run vendor:pi:check -- --if-present`、`npm run audit:refs`；全量门槛按授权条件执行 `YAN_TEST_MODEL=<已验证的provider/model> npm run check`。
3. 按 09 的当前清单分别验证 `npm run dist:dir` + `npm run test:packaged`、便携版、全新 NSIS 安装态和 `npm run test:upgrade`；必要时重写 `release/SHA256SUMS.txt`，并记录实际文件大小 / 哈希，不能沿用旧产物数字。
4. 包内验证要覆盖内置 pi、正式 `yan` CLI、项目知识 / 设置读回、远程服务默认关闭与显式开启、Git / 文件数据边界、能力设置页和新增的 04 / 01 断言。
5. 视觉矩阵只在真实 Electron 窗口或明确的 capturePage 证据上判定；不要用 CSS 静态测量代替最终视觉。

如果模型服务、额度或外部依赖不可用，记录阻塞原因和已经完成的无模型证据；不要私自切换服务、修改真实用户模型配置或把 cost 1 场景伪装成 cost 0。

## 3. P1 执行队列

### 3.1 实施-06：只做剩余边界，不重做 N21-9

权威正文：[`实施-06-上下文管理收尾.md`](../../plan/active/实施-06-上下文管理收尾.md)。N21-9（浏览器 CLI 迁移与相关基线）已经完成，不要重跑并重新列为待办。

只处理：

- 真实长会话证据限制是否需要重新取证；
- `context_recall` 的最终归属和 01-S5 唯一 carrier 是否与当前源码一致；`question` 的 host CLI 入口已由 `questioncli` / `ask` / `askbackground` 取证；
- 与 04 / 11 的策略、薄层和模型级试行档边界；
- 六栏状态、当前 HANDOFF 和活动 README 的互相一致。

如果没有新的源码变化或用户要求，不要为了“看起来有动作”重复 N21-9、浏览器迁移或已完成的 live 场景。

### 3.2 实施-11：Harness / Workbench / 1M

权威正文：[`实施-11-Harness工作窗口与1M模型策略融合.md`](../../plan/active/实施-11-Harness工作窗口与1M模型策略融合.md)。这是唯一详细队列；历史并行分工文件不能替代它。

按依赖串行推进：

| 波次 | 任务 | 依赖 / 注意 |
|---|---|---|
| A | H-6 / H-6b：稳定逻辑回合 ID、等待分段 `waitSpans`、usage 聚合、真正 SIGKILL 中途快照边界 | 先读已有崩溃→中断证据；不要破坏 H-1 页脚和历史 JSONL 口径 |
| B | C-2b：轻量整理、episode-fold、full compaction 三类动作分别统计 | 依赖 C-2；统计不能把三类动作再次合并成一个“压缩次数” |
| C | C-6：三类整理门槛、收益条件、失败 / 取消后的重试窗口、防抖与标定 | 依赖 C-4、C-2；必须用实际计量验证，不用静态阈值自证 |
| D | C-5 残余：右栏显示精确档位名和来源 | 不能把 600K / 700K 写成全局性能承诺 |
| E | H-3：完整 `WorkbenchState`，会话隔离、多文档 tab、active / 导航 revision、滚动和资源身份 | 先于 H-4 / H-9 / H-10 / H-8；右栏同波次只开一项 |
| F | H-4：文件树联动、目录 / 文件打开 tab、大文件窗口化、变化提示、稳定资源身份 | 依赖 H-3；保留已经完成的 Markdown 阅读 / 源码切换 / 缺失重试 |
| G | H-9：浏览器窗口融合 | 依赖 H-3；原生 `WebContentsView` 坐标必须考虑 zoom factor |
| H | H-10：子代理展示与累计统计 | 依赖 H-3；不把已有 subagent 场景误报成完整 Harness 工作台 |
| I | H-8：图标接入统一 | 依赖工作窗口形态；先读设计输入和令牌，截图另存，不覆盖旧视觉证据 |
| J | H-11：交互终端 | 独立波次；改 `package.json` / 原生依赖前先核对共享改动并补包验收 |
| K | C-3：大窗口策略验证矩阵 / 真实 1M | 依赖 C-6；只在有明确 provider/model、真实窗口能力和额度授权时执行 |

共享热点按正文 §3.7 处理：`agent.ts` / `capability-server.ts` / `yan-cli` 走能力面串行队列；`store.ts` / `RightPanel.tsx` 的渲染端右栏同波次只开一项；`context*.js` 与 06 残余互斥；`package.json` 先检查脏改动。每个 H / C 切片独立完成六栏后再进入下一项。

明确限制：600K / 700K 只是精确 `provider/model` 的可回退试行档；没有真实 1M 端点和授权额度，就只能完成策略 / UI / 单测，不能声称 1M 质量或性能。

### 3.3 实施-10：最终视觉矩阵

权威正文：[`实施-10-AI产物展示与GPT-Image.md`](../../plan/active/实施-10-AI产物展示与GPT-Image.md)。

- 只对当前源码重新生成并实际查看深 / 浅主题矩阵和相关产物展示场景；截图使用新文件名，不覆盖 `docs/design/preview/` 的用户视觉证据。
- 分别写静态、真实运行和视觉结论；不能把 mock 生图、静态 DOM 或已有旧截图写成当前全绿。
- 参考图上传、PDF 阅读等没有实现的能力要保持“剩余限制”，不要为了清单完整而虚构入口。

### 3.4 实施-08：Android 远程管理

桌面端协议 S0 已完成：HTTP + SSE、鉴权、定向发送、指定 runId abort 等均有桌面证据。Android UI、二维码 / 配对、设备密钥、TLS / 中继、APK、移动端视觉和正式包验收都没有完成。

下一会话除非用户明确授权 Android 范围和交付目标，否则只维护准确的状态记录，不开始移动端实现，也不把桌面 API 写成 Android 已交付。

## 4. 不得做的事情

- 不要 reset、checkout、clean、递归删除或覆盖工作区既有改动；不要用“整理”名义清掉用户代码、截图、诊断产物或运行窗口。
- 不要编辑 `release/砚数据/`，不要手改 `resources/pi-runtime/`；所有测试使用副本和隔离环境。
- 不要恢复旧记忆、旧任务扩展、`get_tree`、`browser.js` 模型工具、第二个同义入口或插件生态兼容壳。
- 不要把 archive/中的历史命令、旧计数、旧“下一步”当成授权；先对照当前源码和活动正文。
- 不要把目录存在、包存在、mock、fixture、探针 `ok`、typecheck / build 通过当成真实功能完成。
- 不要在未授权时联网寻找、下载、安装或运行真实外部候选；不要私自登入账号、切换 provider、启动或替换本机模型服务。
- 不要重复已经完成的 02、03、05、07、N21-9、浏览器迁移和已有包基线；只有源码边界变化才做针对性回归。
- 不要为了“完成所有待办”擅自把 P3 外部条件（签名、跨平台构建、上游 registerShortcut、Yan 账号同步、Command Code 配额）变成伪实现。

## 5. 每个切片的回填模板

在活动正文和 `docs/dev/HANDOFF.md` 使用下面的最小格式；没有证据的栏写“未做 / 原因”，不要留空：

~~~markdown
### <切片> · <日期>

- 实现：改了哪些文件、入口和边界；
- 自动检查：typecheck / build / unit / live 的具体命令、场景、结果；
- 真实运行：真实 Electron / CLI / runner / provider 行为，是否使用模型、是否产生费用；
- 视觉验收：真实窗口或截图路径、深浅主题、溢出 / 交互结果；
- 应用与包：解包 / 便携 / 安装态是否验证，未验证的原因；
- 剩余限制：未完成、授权阻塞、模型 / 平台 / 外部依赖限制；
- 回填：同步更新的活动正文、HANDOFF、证据文件和路线图状态。
~~~

## 6. 完成收口协议

1. 先在源码和测试中确认行为，再写六栏；不要先改状态再找证据。
2. 主题全部闭环后，更新 `docs/plan/README.md` 的 P0 / P1、活动索引和已完成索引；只有六栏齐全才能把正文移入 `docs/archive/plan/`。
3. 文档调整后运行 `git diff --check` 和 `npm run audit:refs`；代码调整按影响范围补 `typecheck`、`build`、单测、live、视觉、包证据。
4. 把“本轮未跑”的项目和原因保留在 HANDOFF，不要用历史证据覆盖当前缺口。
5. 后续提交仍需以用户明确授权为准；本轮已由用户授权并完成 `9be856d` 检查点。新的提交应先复核文件范围，不使用 `git add -A` 掩盖不相关改动。
6. 最终回复要给出：已完成切片、仍阻塞的授权 / 外部条件、实际测试和包证据、未完成限制、工作树 / commit 状态。

## 7. 可以安全并行的范围

若需要并行 agent，只把互不重叠的文件域拆开：H-6 与 H-7、C 系列内部按依赖、H-3 之后的 H-4 / H-9 / H-10 / H-8、以及独立的 H-11。任何两个 agent 同时改 `agent.ts`、`store.ts`、`RightPanel.tsx`、`context*.js`、`package.json` 或 `docs/dev/HANDOFF.md` 前，先合并 / 检查工作树；主 agent 负责最终六栏和路线图收口。

交接完成的判据不是“待办表被清空”，而是每个可交付项都有可复核证据；真实权限、模型、平台或用户授权尚不存在的部分，要明确标注为阻塞或产品边界。
