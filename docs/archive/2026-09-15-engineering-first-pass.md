# 首轮工程实施记录 · 2026-09-15

历史快照：从工程清单分离保留。本文的状态、数量和环境阻塞仅代表该轮；当前任务以 [HANDOFF](../dev/HANDOFF.md) 为准，后续证据见[自验证报告](2026-09-15-自验证报告.md)。

## 7. 本轮实施记录（2026-09-15）

> 口径：勾选只代表**本轮真的做了并有证据**；未勾选的条目仍按第 1 节口径视为未完成。
> 每条按第 6 节模板的六栏写；「真实运行 / 视觉验收」里写出的边界就是它**没有**覆盖到的部分。

### 7.1 已完成

#### L01 首轮基线（只完成第一条与第二条）
- **实现**：未改源码；记录基线与打包门槛。
- **自动检查**：`npm run typecheck` ✓（含 CSS 约定与层叠自检）；`npm run build` ✓；`npm run test:unit` **392/392** ✓（本轮新增 33 条运行实例断言）。
- **真实运行**：`npm run dist:dir` 产出 `release/win-unpacked`；`npm run test:packaged` ✓ —— 包内 pi 0.85.1 从 `resources/pi-runtime/dist/bundle/cli.js` 启动、未回退全局 pi、`get_commands` 有返回、扩展 0 报错。
- **应用与包**：验的就是 `release/win-unpacked/砚.exe`。
- **剩余限制**：便携数据升级副本验证、最终产物（安装包 / portable ZIP / SHA256）未做；旧 release 文件未作为新版本证据。

#### N01 分组管理补齐
- **实现**：`src/renderer/src/components/rail/Rail.tsx`（分组菜单、行内重命名、解散）、`src/renderer/src/styles/rail.css`（`.proj-group-*`、`.rail-group-err`）、中英文各 6 个文案键。
- **行为**：空白名 / 重名被拒且**保留输入**；更名只写 `projectGroups[].name`，`groupId` 与 `projects[].groupId` 一个都不动；解散只清 `groupId` 并移除分组记录。
- **自动检查**：新探针 `scripts/probe/grouprename.js`（场景 `grouprename`）。
- **真实运行**：隔离环境注入 2 组 4 项目 → 重命名成功、旧名消失、重名与空白名被拦、解散后 4 个项目记录全部还在（项目行数不变）。
- **视觉验收**：正常窗口；未单独出窄栏截图。
- **剩余限制**：分组排序拖拽未做；解散没有二次确认（清单未要求，靠文案说明"项目保留"）。

#### N03 工具调用默认收起
- **实现**：`src/main/settings.ts`（默认 false + `toolDetailExplicit` 迁移）、`src/shared/ipc.ts`（删除 `toolDetailV2`，新增 `toolDetailExplicit`）、`ToolRow.tsx`（`open = manual ?? false`，失败组不再默认展开）、`Settings.tsx`（切换时写显式标记）、i18n 文案两处。
- **迁移规则**：没有 `toolDetailExplicit` 的配置一律归到 false（含 v2 迁移强制写入的 true）；有标记的配置保留用户选择；规则幂等。
- **自动检查**：`test:live -- toolgroup toolrow` ✓（新预期：默认全收起、失败组只留角标、显式打开后仅运行中那条展开）。
- **真实运行**：注入合成回合，开始 / 增量 / 结束都不自动展开；历史详情仍可点开。
- **剩余限制**：升级用户"手动开过自动展开"无法与 v2 迁移的 true 区分，本轮流一重置为收起（用户重新打开即固化）。

#### N05 点击项目切换到工作目录（部分）
- **实现**：`Rail.tsx` 项目行拆成 `.proj-pick`（切项目）+ `.proj-fold`（折叠会话树）；`switchProject()` = `setCwd` + 该项目最近会话（没有就新会话）；`src/main/index.ts` 的 `yan:setCwd` 改为**只写设置**，不再 stop / 重启 pi。
- **自动检查**：`test:live -- narrow panels resize topbar sessions layout projectlimit railmini` ✓；`branch.js` 里"点项目行折叠"的旧手法已改为点折叠按钮。
- **真实运行**：未做真机"切项目时旧项目继续跑"的端到端（同 N12 的限制）。
- **剩余限制**：草稿恢复、无效路径 / 无权限反馈、文件树与附件随切项目更新的验证未做；`setCwd` 现在不做路径校验（旧实现在重启 pi 时才暴露无效路径）。

#### N06 取消双击项目名重命名
- **实现**：移除 `onDoubleClick`；重命名 Enter 直接保存（不再绕 blur）、Esc 取消、失焦也保存；保存失败保留输入并把错误显示在项目区顶部。
- **自动检查**：grep 确认无探针依赖"双击"或"整行点击折叠"。
- **剩余限制**：无。

#### N08 模型菜单
- **实现**：`Pickers.tsx`（`useLayoutEffect` 量触发器上方可用空间、`maxHeight` 夹到 560、hint 只在空间充裕时渲染、搜索框恒 `autoFocus`、↑↓/Enter 选择 + 高亮滚入视野）、`redesign.css`（`.mt-pop` 宽高自适应）、`composer.css`（`.mt-list flex:1`、`.mt-item.cur`）。
- **自动检查**：新探针 `scripts/probe/modelmenu.js`（两个窗口尺寸）。
- **真实运行 / 视觉验收**：1440×900 → 菜单 360×560、**11 行**完整可见；940×640 → 493 高、11 行；不越界、紧贴触发器、当前模型在视野内、滚到底 / 顶完整可见、24 条模型不被截断。
- **剩余限制**：未在 125% / 150% 缩放与非默认字号下复测。

#### N12 会话后台运行（部分，P0 第一阶段）
- **实现**：
  - 新 `src/main/runners.ts`：`RunnerRegistry`（命中已有实例 / 复用空闲实例 / `RUNNER_LIMIT = 3` / 满额明确拒绝 / `stopOne` / `stopByCwd` / `stopAll` / `statuses()`）。
  - `src/shared/ipc.ts`：`MainPush` 拆成 `MainPushBody & { sessionKey?: string }`；新增 `RunnerStatus`、`runners` 推送、`selectSession` / `runnerStatuses` / `stopRunner`。
  - `src/main/index.ts`：`agent` 单例 → `runners` 注册表 + `ac()`；事件经 `pushFrom(runnerId, …)` 标身份；`selectSession` / `switchSession` / `newSession` 走注册表；切完推该实例的 state / sync / stats；`setCwd` 不停实例；删除会话停对应实例；`restartAgent` 等**全部实例空闲**；`shutdown` 收全部实例。
  - `src/main/agent.ts`：`pendingUi` 集合 + `getPendingUiCount()`（"等待输入"的依据）。
  - `src/renderer/src/state/store.ts`：`activeRunnerId` / `runners`；`applyPush` 身份过滤（非当前实例的事件直接丢弃，切回靠主进程快照）；`switchSession` / `newSession` 走新 API；`syncRunners()`。
  - `Rail.tsx`：每行状态槽改由 `runners` 驱动（运行 / 等待 / 失败）、完成未读改为比较两次 `runners` 快照、项目与分组与 mini 栏的运行汇总、会话菜单「停止运行」。
- **自动检查**：`scripts/test-runners.mjs`（33 断言：命中不发停止、忙碌实例不被复用 / 不被停、满额拒绝、空闲才复用、`stopOne` 只影响一个、`hasBusy`、`stopAll`）；`test:live -- sessionrunners railmini railtitle` ✓。
- **真实运行**：渲染端身份过滤与状态槽用合成推送验证（后台 `msg-add` / `state` 不串进当前视图；后台行显示"运行中"；能停指定实例）。**主进程注册表路径没有真机证据**：隔离测试环境 pi 起不来（`conn=exited`），`runnerselect` 场景输出 `⤺ 跳过`。
- **视觉验收**：状态槽几何包含在 `railtitle`（210px）与 `railmini` 断言里；未做深 / 浅色对照截图。
- **剩余限制**（对应未勾选的 4 条）：
  1. 前端已按会话缓存消息 / 增量 / 队列 / 草稿 / 模型 / 思考级别 / 命令 / 统计，并处理启动期临时 run key 到稳定 sessionId 的迁移；仍缺真实 A/B 切换证明，以及退出后缓存与权威快照的恢复边界证据；
  2. `RunnerRegistry` 已按规范化 cwd 拒绝忙碌实例的并发写入，并让 `stopByCwd` 使用同一作用域规则；仍缺真实 Electron 多实例写入、换项目和异常退出矩阵证据；
  3. 与子代理并发的共同预算没有合并计数（各自独立）；
  4. 运行状态未持久化，"退出后可恢复"不等于任务继续；
  5. 语言 / 凭证变更仍是"等所有实例空闲后整体重启"，没有"稍后应用"的提示。

#### N13 窄侧栏会话标题可读性
- **实现**：`rail.css` —— `.rail-body` 成为容器查询上下文；`@container railbody (max-width: 250px)` 隐藏 `.srow-time`、隐藏分支层级图标、缩进 12 → 9px 每级；会话菜单新增「最后活动」（`rail.lastActive`）。
- **自动检查**：新探针 `scripts/probe/railtitle.js`。
- **真实运行 / 视觉验收（实测数字）**：左栏 210px（`RAIL_MIN`）时 `.srow-name` 可用宽度 **98.4–128.4px**（改动前 55.8–79.8px）；第 4 / 5 层缩进一致（63px 左缘，`--branch-depth` 封顶 3）；标题右缘不越过状态槽；超长标题仍省略但 `title` 带完整名。
- **剩余限制**：未在 125% 缩放与浅色主题下复测；未落截图文件。

#### N14 收起侧栏保留 mini 项目文件夹
- **实现**：`Rail.tsx` mini 栏项目按钮（前 5 个 + 「全部项目」浮层）；`rail.css`（`.rail-compact-proj`、名称浮层、`data-running` 圆点、`.rail-compact-menu`）。名称浮出用 React `data-hover`（合成事件可测）并以 `:hover` / `:focus-visible` 兜底。
- **自动检查**：新探针 `scripts/probe/railmini.js` ✓；`resize.js` / `sidebar-review.js` 的"紧凑栏必须 4 个按钮"断言改为"四个**基础**入口仍在"。
- **视觉验收**：48px 紧凑轨；名称浮层默认 `opacity 0`、悬停 / 聚焦为 1、不越出窗口右缘；浮层列出全部 10 个项目；mini 栏内容 360px < 容器 747px，不被撑破。
- **剩余限制**：切换动作仍走 `setCwd` + 新会话（未接 N05 / N12 的会话级恢复）；内置浏览器原生视图同时打开时的边界未单独测量。

#### N15 回收站提示紧凑显示、30 秒自动消失
- **实现**：`Rail.tsx` 计时 effect 依赖整个 `trashNotice`（删除成功 30s、恢复成功 2.6s、`busy` 期间不计时、cleanup 清旧计时器）；错误文案并入文本区；`rail.css` 顶对齐 + `-webkit-line-clamp: 2` + 按钮不拉伸。
- **自动检查**：`test:live -- trash`（扩展了原探针：真实删除 → 通知 → 3.2s 仍在 → 窄栏几何 → 撤销 → 自动收走 → 关闭按钮）。
- **视觉验收**：210px 栏下通知高 **42.2px**（两行内）、撤销按钮为横条且文字完整、文案区与按钮不重叠。
- **剩余限制**：没有等满 30 秒做到期断言（等的是 3.2 秒，钉住"不是 2.6 秒"这条回归）；恢复失败路径靠代码审查。

#### N17 项目默认显示前五项
- **实现**：`Rail.tsx`（`PROJECT_PREVIEW = 5`、`projectsExpanded`、当前项目在 5 名外自动展开、切项目重置手工状态、「更多项目（N）/ 收起」按钮、切片后按切片数组判断分组标题）+ `rail.css`。
- **自动检查**：新探针 `scripts/probe/projectlimit.js` ✓。
- **真实运行**：隔离环境 9 个项目（含分组）→ 默认 5 个 / 按钮显示隐藏数 / 展开后全部 / 搜索临时全展开 / 清空后恢复展开态 + 焦点回搜索框 + 滚动位置不变。
- **剩余限制**：未做"大量项目（50+）"与重启后状态验证。

#### N20 首次引导第 2 栏按钮错位
- **实现**：根因是 `chat.css` 里旧任务面板遗留的全局 `.todo { display: grid; grid-template-columns: 12px minmax(0, 1fr) }` 命中了引导行的 `todo` 状态类 → 第 2 栏被改成两列 grid，两个按钮被压到 21px 且压在说明文字上。修法：删除该死规则、引导状态类改 `ob-ok` / `ob-todo`、`motion.css` 同步；另外 `Settings.tsx` 新增「关于 → 首次引导 → 重新查看」入口（`onShowOnboarding`），让引导层能在**不重置** `yan.onboarded` 的前提下被真实渲染。
- **自动检查**：新探针 `scripts/probe/onboarding.js` + `test:live` 场景（`wins: ['1440x900', '940x640']`）。
- **视觉验收**：两个窗口尺寸下两个按钮等宽、左边界对齐、`scrollWidth == clientWidth`（文字完整）、与标题 / 说明不重叠、不溢出卡片；「重新检测」与「去配置 → 返回」往返后布局不变。
- **剩余限制**：深 / 浅色主题未各跑一遍；没有真把 `yan.onboarded` 清空做"真·首次启动"自动弹出验证（探针刻意不重置它）。

### 7.2 未开始（本轮未动，仍按未完成计）

N02 · N04 · N07 · N09 · N10 · N11 · N16 · N18 · N19 · L02 · L03 · L04 · L05 · L06，以及 L01 的第二、三、四条。

### 7.3 本轮新增的测试资产

| 文件 | 用途 |
|---|---|
| `scripts/probe/onboarding.js` | N20 引导第 2 栏布局 + 配置页往返 |
| `scripts/probe/modelmenu.js` | N08 可见行数 / 键盘选择 / 不越界 |
| `scripts/probe/grouprename.js` | N01 分组重命名与解散 |
| `scripts/probe/projectlimit.js` | N17 前五项与更多 / 收起 |
| `scripts/probe/railtitle.js` | N13 窄栏标题几何 |
| `scripts/probe/railmini.js` | N14 mini 栏项目入口 |
| `scripts/probe/sessionrunners.js` | N12 渲染端身份过滤与状态槽 |
| `scripts/probe/runnerselect.js` | N12 主进程注册表（pi 未就绪时显式跳过） |
| `scripts/test-runners.mjs` | N12 注册表策略单测（33 断言） |

### 7.4 本轮遗留的环境事项与回归范围

- 验证主进程注册表时用过一次 `YAN_TEST_ISOLATED=0`，它留下的开发态 Electron 实例导致随后 51 个实时场景全部报"应用可能启动失败"。已结束该实例；临时目录里的 `砚.exe`（便携版）未动。
- 因此**本轮没有跑完整回归**。跑过并通过的定向批次：
  `toolgroup toolrow`、`trash`、`onboarding`、`modelmenu`、`detail features light`、
  `narrow railsearch rename grouprename projectlimit sessions layout`、
  `projectlimit railmini grouprename narrow panels resize topbar`、
  `railtitle railmini sessionrunners narrow panels resize topbar sessions layout`。
  全量 `npm run check` 待补。
