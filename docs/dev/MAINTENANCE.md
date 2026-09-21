# 实现维护与排障

按问题查阅；当前任务和完成度见 [HANDOFF](HANDOFF.md)。本文只保留可复用的实现约束。

## 运行与测试

- live 场景使用 `out/`，不自动构建；先 build。Electron 启动前清除 `ELECTRON_RUN_AS_NODE`。隔离变量与模型配置统一见 [TESTING](TESTING.md)。
- 单实例锁随 userData 目录隔离。测试没有窗口或输出时，先检查环境变量、构建结果和实例目录。
- 测试按 fixture 路径定位会话，不依赖自动标题；用条件轮询等待连接、DOM 和几何稳定。
- 切会话会让 Composer 重新挂载：先取的 textarea 会脱离文档，对它派发 `input` 没任何效果（表现为“发送键还是灰的”）。要在发送键真的可用之前**重取 DOM**，而不是只等 `sessionFile` 对上。
- 主进程只在实例增删/切换时推 `runners` 快照，`running` 这种随模型状态变的位会滞后：前端可能“`session.isAgentRunning=true` 而 runners 里 `running=false`”。要在探针里先 `syncRunners()` 拉一次再断言。
- `session.isStreaming` 只在“有一条 assistant 消息在流”时为真，**工具执行期间是 false** —— 所以那时输入框按钮显示“发送”（点它是排队/插话）。要停一个正在跑工具的任务，用左栏会话菜单里的「停止运行」。
- 场景比预期久时先看探针自身耗时（`test:live` 的 kill 兜底是 `delay + budget`，默认 budget 90s，长场景用 `budget` 单独给），不要拿“没抓到 PROBE 输出”当启动失败：那个提示同时也意味着**窗口被手动关掉**或探针被 kill —— 两者都没有 PROBE 标记。
- 改文档时不要在 bash 里用 `node -e "..."` 处理含**反引号**的文本：shell 会先把反引号里的内容当命令执行（实测把文档里的 `test:live -- …` 当命令跑了一遍，终端里突然冒出一堆 Electron IPC 错误）。写成临时 `.mjs` 文件再 `node` 执行，或直接用编辑器工具。
- 免费模型有配额：供应商触顶或暂时不可用时会 429，症状是 assistant 消息**内容为空**且 `stopReason=error`（看起来像事件流掉了）。子代理那条路径上更隐蔽：run 会报 `status=done` / `error=null`，只是转录里那条 assistant 文本为空（`-- subagent` 会打印这段诊断）。当前测试优先使用 `commandcode/longcat-2.0:free`，不可用或触顶时改用 `commandcode/laguna-s-2.1-free`；需要“模型真的写文件”的场景再单独选能稳定执行工具的模型。
- 要真写文件的场景（`subagentpair`）要排队跑好几个模型任务，实测约 1 分钟（曾有 4-5 分钟的记录，那是 `delay` 被当成探针预算白等造成的）；它只手动跑，不进 `npm run check`。
- Windows 上 Electron 是 GUI 子系统，主进程 `console.log` **不进 stdout**，test-live 抓不到。子代理事件流有 `YAN_DEBUG_SUBAGENT=1` 开关，会把每个事件追加到系统临时目录的 `yan-subagent-events.log`。
- sandbox 的凭证副本必须随退出、SIGINT/SIGTERM 清理；异常终止后检查残留，不打印凭证内容。

## 截图与视觉矩阵（`npm run visual:matrix`）

- 截图脚本必须**自己指定临时 userData**（`app.setPath('userData', …)`）。用默认目录时，上一次运行留下的 GPUCache/锁会让下一次的 GPU 与 network service 起来就崩，脚本表现为“停在第一张图前不动”。
- 窗口必须 `show: true` 且 `backgroundThrottling: false`：隐藏窗口或后台节流时合成器不出帧，`capturePage()` 会一直等（加超时只会变成“提交超时”而不是诊断出原因）。
- **拉取型 IPC 不要给 stub**（`getSettings` / `getState` / `getStats` / `listModels` …）：返回值会被 bootstrap 写回 store，盖掉刚注入的 fixture 数据 —— `settings` 变 null 时 React 会卸载整棵树，后面几张图表现为“缺 `.settings`”。报 IPC 错反而是安全的。
- React 组件是受控的：`setState` 到 DOM 反映要等重渲染。在同一次 `executeJavaScript` 里 setState 后立即读 `btn.disabled` 拿到的是旧值，必须分两次调用（中间等一下）。
- 模型选择器在 `session.isStreaming` 时为 disabled；要拍菜单得先把它放空。
- 一个进程跑满 7 组会崩（`Network service crashed` / `GPU process exited unexpectedly`）：按组分批（每组一个 Electron 进程）后稳定且失败可重跑。
- 收尾清理**绝不要按进程名杀 `electron.exe`** —— 宿主应用自己也是 Electron，会把自己一起杀掉。只按命令行条件过滤（如 `CommandLine -like '*visual-matrix*'`）或记录 PID 后精杀。

- **`capturePage()` 可能截到上一帧。** 实测：某个状态的 DOM 已经变了、
  `elementFromPoint` 也命中新元素、`getComputedStyle` 显示可见，**但 PNG 里没有** ——
  窗口不在前台时合成器停在上一帧。等两帧 `requestAnimationFrame` 只保证脚本侧排过队，
  **不保证真的出帧**。做法：`capturePage()` 之前调一次 `webContents.invalidate()`
  （只影响画面、不改布局，对所有状态都安全）。判断"是不是截到旧帧"的办法：
  用 `elementFromPoint(中心点)` 看那一刻谁在最上层 —— 它能区分"没渲染"与"没画出来"。
- **状态之间会串。** 每个状态脚本都要复位上一个状态留下的东西：右栏分区展开态、
  文件预览、输入区附件、左栏通知条都是**组件本地 state**（不在 store 里），
  `store.setState` 清不掉。做法：在脚本里显式 `closePreview()` / `clearAttachments()` /
  点一次分区头收起文件树。
- **截图要拍的东西如果依赖"有一条可操作的数据"，就在脚本里补一条合成数据**
  （例如删除通知需要一条非当前会话，而当前会话禁止删除、fixture 只有一条会话）。
  补完记得把原列表放回去，否则左栏会空掉 —— 那不是这张图要证明的事。

## 子进程与日志管道（EPIPE / 僵尸 Electron）

- 症状：反复刷 `EPIPE: broken pipe, write`（stdout 与 stderr 各会来一次）；进程表里留着 `electron.exe`，**窗口标题是「Error」**；上游 `spawnSync` / npm 链几小时不结束（2026-09-16 实测一次挂了 4 小时）。
- 机制链（每步都实测确认）：父进程先退出 / 终端关闭 → 管道**读端没了** → 子进程 `console.log` 拿到 EPIPE → 没人监听流上的 `'error'` → 变成 `uncaughtException` → **Electron 默认处理是弹模态框**（标题「Error」）→ 弹框挡住事件循环，`app.exit()` 与脚本自己的看门狗都跑不到 → 父进程 `spawnSync` 等一辈子；子进程还活着，渲染端继续打 IPC，日志继续 EPIPE，于是“重复报错”。对照实验：`electron out/scratch/pipe-test.mjs | head -3`（造一个每 300ms 打一行的脚本）能稳定复现。
- 定位：`Get-CimInstance Win32_Process | Where-Object CommandLine -like '*visual-matrix*'` 找到整条链，再看 `Get-Process electron | Where MainWindowTitle` 确认是不是卡在 Error 框上；**按 PID** `taskkill /PID <pid> /T /F` 收整棵树（绝对不要按进程名杀，宿主应用自己也是 Electron）。
- 修复位置（四处一起才闭环）：`scripts/lib/stdio-guard.mjs`（脚本侧 EPIPE 容忍 + 把 `uncaughtException` 变成“打印 + 退出码 1”）、`scripts/visual-matrix-run.mjs`（超时收树、信号转发，不再用会阻塞事件循环的 `spawnSync`）、`scripts/test-live.mjs`（Ctrl+C / 被 kill 时先收 Electron 子进程）、`src/main/stdio-guard.ts`（桌面应用只吞 EPIPE + 上报非 EP## 视觉矩阵的"安静状态"与截图取证

## 测试造数据的两个坑

- **文件时间戳的分辨率**：连续两次写入同一文件，Windows 上可能落在**同一个 mtime 刻度**里。
  依赖"改过内容就该被发现"的断言（`workspace-changes` 的等长改写）会因此偶发假失败 ——
  判定逻辑是对的，含糊的是测试数据。造这种数据时用 `utimesSync` 把 mtime 显式拨开。
- **`runId` 不是实例身份**：`RunnerRegistry` 的 `r1/r2` 是注册表内的序号，
  `stopAll()` 之后重新 `start()` **从 r1 重新数**。要判断"实例是否被重建"用 `createdAt`
  （本探针第一版拿 `runId` 比，得出"没有重建"的错误结论）。

IPE，**不退出**）。
- 两条硬约束：① **不要在流 `'error'` 监听里 `throw`** —— 那等于把不可捕获的流错误升级成 `uncaughtException`，也就是上面那个模态框（旧代码就是这么写的）；② 脚本侧接管 `uncaughtException` 后要**非 0 退出**，否则上层只看得到“卡住”。
- 预期噪声：Electron 对未注册 handler 的日志**不走 `console.error`**（patch 全局 console 命中 0 次），而是每个错误**一个三行 chunk 直接写 `process.stderr.write`**（开头是 `Error occurred in handler for '…': Error: No handler registered`）。截图脚本故意不注册那批拉取型 IPC，所以用 `muteMissingHandlerNoise()` 按 chunk 开头静音并在结尾打一行汇总（不是吞掉不管）。

## `@` 文件引用与 prompt

- pi 的 RPC `prompt` 只接受 `message` / `images` / `streamingBehavior`，**没有文件参数**：`@路径` 不会被展开成内容（展开是 CLI 参数层 `pi @file "..."` 的行为）。砚的补全把路径写进消息、文案说“附件文件，可直接读取”，由模型自己调 `read` —— 实测模型确实会去读（`test:live -- atrefsend` 的 `afterExit` 在会话 JSONL 里看到了文件内容）。改文案时不要写成“内容已加入上下文”。

## 会话与能力状态

- 启动期 sessionId 会从临时值变为稳定 ID。模型、思考档位、命令等能力请求按运行实例与代次判过期，见 `state/capability-request.ts`。
- 启动时加载失败的能力列表，需要在连接就绪后实际补拉。核对调用链，不能只信“稍后重试”的注释。
- 模型未知时保留选择器和空态，避免多层 return null 使用户失去入口。
- 分支 entryId 只取自 `get_fork_messages`；JSONL 快读与 pi 的权威会话切换职责分开。
- 通知需要去重与限流；启动期扩展说明进日志，不反复打断用户。

## 上下文策略（工作集）与压缩

- **判定的触发点要单独想清楚**：把「按工作集压缩」挂在“每次刷新用量”上时，
  **切到一个很大的旧会话也会刷新用量**（实测 276k tokens > 262k 窗口）→ 切过去就压缩、
  实例变忙、「新对话」被拒（D27）。现在只有回合结束（`agent_settled`）允许触发。
  这类 bug 的通用问法：**这个判定会被哪些与用户意图无关的路径执行？**
- 探针要能证明自己**不空洞**：`contextswitchguard` 先用 `YAN_CONTEXT_POLICY` 把触发线压到
  极低，再断言“用量在线之上且没有触发” —— 否则“没触发”可能只是因为没到线。
- **pi 的压缩事件形状不看开始记录**：实测成功的压缩只有 `compaction_end`
  （或“正在压缩”已被 `isCompacting=false` 的自愈清掉）。靠 `compaction_start` 盖章会丢，
  要用“上一条记录的 `endedAt`”当基准认出本次调用产生的那条。
- pi 对**外部**发起的 `compact()` 一律报 `reason: 'manual'`：谁发起的只有砚自己知道，
  界面上要按发起方显示（否则用户以为自己点了按钮）。
- **策略要有活性**：不能用“等用量回落”当唯一的上膛条件 —— 上一次压缩如果**失败**
  （pi 回 `Already compacted`、被扩展取消），用量永远不会回落，策略就永久失效了
  （D30）。给一个重试窗口（5 分钟），既不会每轮重试也不会卡死。

- **公式类硬规则要写成"不变式 + 扫输入空间"**：兜底线 `min(窗口 × 90%, 窗口 − 预留)`
  的正确性不是几个参考值能证明的（转折点附近的窗口最容易写错）。做法：把必须成立的性质
  写成断言（不吃预留 / 恒高于压缩线 / 不超过比例），在单测里**逐点扫** 1k–2048k 的窗口，
  违规只累计不逐条打印（700 行 ✓ 会把真正失败的那条淹掉），最后 4 条断言报违规数。
  这类"对所有输入成立"的性质不要指望 live 探针 —— 它只能抽几个点。
- **手写的 fixture 会悄悄过期**：`probe/context.js` 里有一份手写的 `ContextBudget`
  （给界面用）。改了公式以后 fixture 仍"看起来合法"，于是探针照过、真实值已经不一样了。
  改公式时把 fixture 一起改，并在它的字段旁写清"与生产公式一致，别留旧值"。
- **审核别人的提点时，把"采纳 / 修订 / 不采纳"三种结论都写下来**：只写采纳会导致
  照着不成立的建议实施（本次就有一条"更保守"的写法会让兜底线等于压缩线，
  等于让唯一的绕过上膛路径变成小窗口模型的常规路径）。不采纳的理由要落在文档里，
  否则下一轮会被再提一次。
- **核实上游（pi）能力时别停在字段名**（2026-09-17）：`ctx.model` / `ctx.modelRegistry`
  看着只是"模型信息"，但 `ModelRegistry.complete(model, context, options)` 就是一次
  **无工具**的模型调用（返回 Promise），`agent_settled` 也会对扩展分发
  （`_extensionRunner.emit({type:'agent_settled'})`）。先前只看到字段名就判定"扩展跑不了推理"，
  把整个状态生成器绕到"起第二个 pi 进程"上（方案 §13.3 初版结论错，§16.1 已更正）。
  查 minified bundle 的正确姿势：对每个可疑字段再补一次它的**方法**
  （`grep -o "complete(model,context,options){[^}]*}"`、`grep -o "ModelRegistry=class[^}]*"`），
  并用"这个词在 bundle 里出现几次、在哪几个类里"确认归属 —— 字段会骗人，方法不会。

### 阶段 4 的压缩安全规则：先纯函数，再进链路（2026-09-17，N21-10）

"什么不能压坏"是一组**容易写错、错了也难归因**的规则（模型突然忘了要求、它把刚改的地方改回去），
所以做法是：先把规则做成**纯函数 + 不变式**（`resources/pi-extensions/context-safety.js`），
用构造的输入断言，再让阶段 4 的扩展去调。两个值得记的判断：

- **保护要分两档，强度不同**：
  · **硬留**（必须留在原始窗口里）：系统提示/契约、**正在使用的 diff**；
  · **可带走**（可以离开窗口，但必须进状态）：**用户约束**、未解决的错误。
  如果"用户约束"也算硬留，切割就永远退不到它之后 —— 实际永远压不动；
  而"带走"这件事要能被核对（`carryOver()` 交出去、`violations()` 检查忘了没有），
  否则"没降级"只是口头承诺。
- **不变式检查器必须有反向断言**：只测"合法的方案通过"证明不了它有用 ——
  要构造**人为做坏**的输入（切成半条、回收系统提示、保留/丢弃不互补）并断言它报错，
  再摘掉保护逻辑确认那几条断言会变红（本次：摘掉 → 36/42，还原 → 42/42）。
- 契约落在切片区时的取舍：**退到它之前（这次不压）**，而不是悄悄丢掉它 ——
  少压一次的代价远小于发一份少了任务契约的上下文。

## 右栏窄栏排版（PANEL_MIN = 220px）

- **`.rp-kv` 用的是 `align-items: baseline`**：纯文本行没问题，但一行里混了按钮（24px）时，
  基线对齐会让两者看起来不在一条线上。混排的行要单独改成 `center`。
- 窄行里的 `gap` 是**按元素个数算的**：`.rp-kv` 默认 gap 8px，一行里塞了
  `label + .spacer + 开关 + 按钮` 就是 3 个 gap（24px）—— 而那十几 px 正好是按钮文字
  够不够用的临界值。用 `margin-left: auto` 替掉 `.spacer` 更省。
- 按钮文字在窄栏里一定要 `white-space: nowrap`（折行会让行高从 24 变 43px，
  看起来像布局坏了）。要保文字完整就先牺牲装饰图标：`@container` 的容器挂在
  **这一行自己**上（不要挂 `.rp-sec`：那是多分区共用，`container-type` 会带进
  layout containment，可能改变分区内绝对定位菜单的包含块）。
- 几何反例要用**绝对阈值**：「按钮文字 ≤ 22px 高」能抓住折行，而「与同行的标签比高度」
  抓不住 —— 窄栏下标签自己也会被挤成两行，两边一起变高，比值就恒等了。

## 探针的几何断言


- 判「子元素不得越出父容器」时要先看父容器**在该轴是否可滚**：`.rail-body` 是
  `overflow: hidden auto`，列表超过一屏时下半部分的子元素本来就在滚动区之外，
  拿 `bottom > parent.bottom` 判越界会稳定假阳性（D28，`live` 场景偶发失败）。
  `hidden`（裁切）仍要比，那是真问题。
- 几何断言的输入会随**真实数据**变化（左栏项目数来自 fixture 里“最近的真实会话”归属），
  所以结论要写成不依赖条目的性质，或先把数据摆成确定的样子。

## 指针拖拽怎么验（N01，2026-09-17）

自制拖拽（没用 HTML5 `draggable`）的**好处**就是这条：探针能合成 PointerEvent 走
与用户手拖**完全相同**的那一段代码。写法与四个坑记在这里，下次不要再重新摸：

- 事件派发目标不同：`pointerdown` 派发到**行元素**（要过 React 的事件委托才会进 `onPointerDown`），
  而 `pointermove` / `pointerup` 派发到 **`window`** —— 实现里的监听就挂在 window 上。
  坐标从 `getBoundingClientRect()` 取，不要写死像素。
- **“越过阀值”那一移动不能省**：实现里按下只记候选，没超过 4px 一律当点击
 （否则行本身也是按钮，单击就废了）。少了那一步只能探到“什么也没发生”。
- 被拖的行必须 `pointer-events: none`，否则 `document.elementFromPoint` 永远命中它自己，
  落点永远算不出来。这条加上 `opacity: .45` 就是「被拖的是哪一个」的全部视觉语言。
- 松手后浏览器紧跟的 `click` 必须被吞。判据用**「上一次拖拽会话是否还活着」**，
  不要用时间戳：拖完立刻点同一行会被误吞。
- 截图要停在**拖拽进行中**：拖完的列表与普通列表在视觉上没区别，
  而插入线必须能在真图里被人眼检查（探针只能证明类名在，证明不了看得见）。
  截图脚本里的落点必须**同组**（跨组不接受落点），否则拿到的是一张没有插入线的图。
- 这类交互建议**配一条反向验证**：把限制条件去掉跑一次，看对应断言变红（本轮做了「去掉同组限制」与「不消费 click」两条）。
  只有“变红”才能证明断言真的在看这件事。

## 浏览器原生视图

- 网页使用 `WebContentsView`，位于 renderer DOM 之上；加载/错误提示放工具栏，拖拽把手预留空间。
- DOM 的 CSS 坐标乘主窗口 `getZoomFactor()` 后才是 setBounds 所需 DIP。单列 grid 用 `minmax(0, 1fr)`。
- 加载会重置先前缩放；在 ready-to-show 后补设。避免在 did-finish-load 内同步 setZoomFactor，已有渲染进程崩溃记录。
- element ref 在文档替换后失效；普通 DOM 增删不全量清空。已脱离节点返回 STALE_ELEMENT。
- 点击先滚入视野，再重新测量坐标；切换外部 Chrome 目标后重新 observe。
- 内嵌浏览器与本机 Chrome 的 profile 独立。登录、下载与 Cookie 同步需实际目标网站验证，不能用 CDP 冒烟替代。

## 浏览器网络边界与下载（L04）

- **不要用渲染端的 `fetch` 去探本机服务**：应用自己的 CSP 会拦下来（实测 `Failed to fetch`，
  一度把“服务明明活着”误判成“拿不到服务”）。要证明本地服务可达，就走**网页视图**去读它
  （`openBrowser` + `observe().text`）—— 那也正是真实链路。
- 判定「谁在发这个请求」要用**已提交文档**（`tab.committedUrl`），不能用 `state.url`：
  `open()` 会在导航发起时就把目标地址写进 `state.url`，拿它判等于**拿目标跟自己比**，
  于是「远程页面借道访问本机」的顶层导航会被放过（D24，已修）。
- 构造这些边界的真实形状不需要自建公网服务：`https://httpbin.org/redirect-to?url=…` 就是一个
  **真实 302**（页面发起的顶层导航），`sslip.io` 的通配 DNS 能把 `127-0-0-1.sslip.io` 解析到
  127.0.0.1（DNS 重绑定的形状）。负对照同样重要：解析到**公网**的同形状域名（`1-1-1-1.sslip.io`）
  必须不被拦 —— 否则「全拦」也能让正例通过。
- 网络边界是安全相关行为：判定逻辑放 `main/browser/network-boundary.ts`（纯函数、有单测）。
  真窗口只能验证“路径走通了”，判错的分支（子框架 / XHR / link-local）只有单测能覆盖。
- 浏览器里的下载写到 `app.getPath('downloads')`（**用户真实下载目录**）：测试必须用
  `YAN_DOWNLOADS_DIR` 隔离。
- 权限/拦截明细以前摆在单行横向滚动区里，窄右栏下全部落在可视区之外（状态里有、界面看不到，
  D26）。**探针要断言几何**（每行的 `getBoundingClientRect` 都在面板可视区内），
  只断言“元素存在”是抓不到这类问题的。


## 提示类改动：位置比措辞更重要（2026-09-17）

同一句话，模型服从与否可能只差**放在提示的哪个位置**：

| 做法 | 句子落在哪 | 实测（`deepseek-v4.1-flash`，界面英文 + 中文提问） |
|---|---|---|
| `--append-system-prompt` | 提示前部（约 1900 / 11364 字符处） | 服从（回英文） |
| 扩展 `before_agent_start` 追加到系统提示末尾 | **最后 60 字符**（AGENTS.md + 技能清单之后） | 5 次里 5 次**不服从**（回中文） |
| 扩展把句子放在系统提示**开头** | 第 0 字符附近 | 2 次里 1 次服从（不稳定） |
| 扩展 `before_provider_request`：在最后一条 user 消息**前**插一条独立 `developer` 消息 | 贴近用户消息 | **2/2 服从** |

结论与用法：

- 需要模型**稳定**遵守的简短要求（语言、格式、口吻），优先用「贴近用户消息的独立消息」，
  而不是往那个上万字符的系统提示尾巴上挂一句话；
- 同一句话可以两处都放（payload 主通道 + 系统提示兜底），但**措辞只有一处真源**；
- 这类要求是**软约束**：注入成功 ≠ 每次服从。所以
  · 机制用单测钉住（`scripts/test-language-extension.mjs`）；
  · 每轮注入与否用 `YAN_LANG_EXT_LOG` 写文件取证（比问模型可靠）；
  · live 断言写成「多次尝试里出现过符合期望的一次」+ 打印每次的比值，别断言单次。

**反向验证是必须的**：把 payload 注入摘掉、只留系统提示末尾那份，`language` 探针的第 2 节
必须连红 3 次 —— 实测确实如此（CJK 0.57 / 0.82 / 0.80）。没有这一步，「修好了」只是猜测。

## 启停期固定的东西别指望它能跟随运行时设置（2026-09-17）

`--append-system-prompt`、`--model`、`--extension` 都是**进程启动参数**。pi 只在启动时读一次，
而同一个 cwd 下的「新会话」会复用已有进程 —— 于是「用户改了设置」与「模型真的按新设置跑」
之间隔着一整个进程生命周期。

历史上为了绕过它做过两件事，代价都很大：

- 切语言 → `restartAgent` 重建实例 → **界面短暂空白**（主实例被建在一条新会话上，
  先推了一次空 sync；D37）+ 后台会话被一起掐掉；
- 切模型 → 走 RPC（这条没问题，因为 pi 有 `set_model`）。

**判断方法**：要改的东西 pi 有没有对应的 RPC？有（`set_model` / `set_thinking` /
`set_auto_compaction` / `set_session_name`）就直接改；没有（系统提示、扩展集合）就用
**每轮都会跑的扩展钩子**（`before_agent_start` / `before_provider_request`）读设置注入 ——
那是唯一能「改完下一轮就生效」且不打断任何会话的路。

## 界面历史 = 会话文件，不是 pi 的当前上下文（2026-09-17）

`get_messages` 给的是**模型当前上下文**：会话被压缩过之后，它只剩压缩后那一段
（实测文件 858 条 → 86 条，首条用户消息都不在了）。界面上的「会话历史」应当是用户能在
文件里看到的完整历史，所以：

- `hydrate()` 以 `readSessionMessages(sessionFile)` 为来源（60ms 级），`get_messages` 只兜底；
- 这样切换会话的「peek（读文件）」与随后的权威 `sync` **来源一致**，不会先铺全量再被压短；
- `elapsedMs` 是「本轮从开始生成到结束的墙钟耗时（含工具往返）」，与 `speed`（首 token→结束、
  不含排队与工具往返）不是一回事 —— 界面上报「本次用时」要用它。

## 运行时缓存投影必须按会话认人（2026-09-17）

N12 的按会话缓存（`sessionRuntimes`）会被投影回顶层字段。它有三条容易踩的路：

- `findRuntimeSnapshot` 的 `run:${runId}` 兜底：实例会被**复用到别的会话**，实例 id 不变而会话换了，
  拿旧会话的缓存投影上去就把眼前的内容换成了别人的（常见是空的）；
- `runners` 全局推送不带实例身份，切会话过程中它会投影「实例当前还停在的那条会话」；
- 切换成功后立刻投影缓存也有同样风险（peek 刚铺好的内容被盖）。

统一规则：**投影之前先比会话身份**（`peekedSessionId ?? session.sessionId` vs
`snapshot.runtime.sessionId`），不一致就只更新列表/状态，不碰 `messages`。

## 「不是本轮回归」要用旧实现重跑同一场景（2026-09-17）

本轮排查里两次用到，值得固化成习惯：把改动临时改回旧写法（构建、跑同一个探针），
如果**同样失败**，就不是这次改出来的：

- `compactionstatus`：改回 `get_messages` 版 hydrate 后同样红 → 前提过期（pi 0.85.1 不再按
  `reserveTokens` 在回合结束自动压），不是本轮回归。**已处置（2026-09-19）：按实施-06 §2
  选项 ② 降级为说明**（场景与探针保留、不再列入待跑清单）；
- 免费模型当天返回空文本时，`tokens` / `subagent` / `contexttakeover` 会整片红 ——
  先换 `YAN_TEST_MODEL=commandcode/longcat-2.0:free`，不可用或触顶时再换 `YAN_TEST_MODEL=commandcode/laguna-s-2.1-free` 复跑就能分辨。

顺带记两条这次学到的：

- **探针内部等待上限必须小于 case 的 `budget`**（默认只有 90s）。`e2e` 的探针等 150s，
  被杀死在打印之前，报出来的是「没抓到 PROBE 输出 —— 应用可能启动失败」—— 那是**误导**，
  先怀疑预算，再怀疑启动。
- **正在运行的砚会占着 `out/` 之外的东西吗**：不会，但它是用户自己的实例，别去 kill
  （用 `--user-data-dir` 分辨：真实目录是 `%APPDATA%/yan-desktop`，测试是临时沙箱）。
  改代码后用户要**重启应用**才看得到修复。

## 模型登录

- ChatGPT 登录实现在 `src/main/oauth.ts`：授权参数、PKCE、state、回调端口和 auth.json 格式必须对齐所分发的 pi 版本，不随意简化。
- 凭证写入要合并 provider 键；pi 重新读取凭证需按运行生命周期处理，不能打断忙碌会话。
- 其余 provider 不照搬 ChatGPT 协议；registerCommand 与 registerShortcut 分开看，后者在当前已记录的 pi RPC 中缺枚举/执行接口。

## 样式、扫描与打包

- 令牌先改 [DESIGN](../design/DESIGN.md)，再同步 tokens.css；旧名 stage1/stage2/redesign 不代表可删除。
- CSS 与死代码扫描先用已知正例自检；无外部 import 的 export 可能仍被文件内部使用，IPC 类型导出属于契约面。
- 不在 CASES 的 probe 可能由打包、审阅或手工 YAN_PROBE 入口驱动；删除前查调用者。
- 生成脚本后检查正则、反斜杠和 Windows 路径是否原样落盘，避免转义损坏造成扫描假阳性。
- pi runtime 保留其 bundle、依赖、WASM、worker 和动态资源；用 upgrade:pi 更新，不手工重打单文件。
- electron-builder 的 extraResources 要包含 runtime 的 node_modules；`out/test/**` 排除在发布包外。产物要查实际 asar，详见 [RELEASING](RELEASING.md)。

## 用本机 Codex 做第三方只读核对（2026-09-17）

需要"再一个模型独立评审"时，不必只靠浏览器：本机 Codex 桌面端自带完整 CLI，可以直接命令行跑。

```text
CX="$LOCALAPPDATA/OpenAI/Codex/bin/<hash>/codex.exe"   # hash 目录随版本变化，用 Get-Process 找路径
"$CX" exec --ephemeral -s read-only -C <repo> -o <out.md> - < prompt.md
```

- **必须显式 `-s read-only`**：用户的 `~/.codex/config.toml` 默认是
  `approval_policy = "never"` + `sandbox_mode = "workspace-write"`，不覆盖就会真的改文件。
- `--ephemeral` 不落会话文件；`-o` 取"最后一条消息"比解析 stdout 稳（stdout 是完整过程日志，
  含它读过的每个文件）。
- prompt 长时用 `-` 从 stdin 读，避免命令行转义。
- 凭证与桌面端同一份（`~/.codex/auth.json`）→ **消耗订阅额度**：实测一次
  "读 4 个文档 + 若干实现文件"的评审用了 **147,856 tokens**（gpt-5.6-luna / reasoning max）。
  让它自己读文件比把长文塞进 prompt 省事、但更贵；stdout 末尾会打 `tokens used` 供核对。
- 结论要连同"模型/只读沙箱/token 数"一起记进文档，否则下次无法比较两次评审的成本。

## 探针 fixture 必须钉住 UI 实际取值的那一层（2026-09-17）

`test:live -- context` 的 `显示「128k / 262k」` 曾经是红的，而它与任何代码回归都无关：
探针只改了 `stats.contextUsage.contextWindow`，但右栏的分母**优先取模型能力**
（`RightPanel` 的 `win = session.model.contextWindow ?? …`）—— 真实测试模型的窗口是 1M，
于是它覆盖了 fixture 里的 262144，断言变成「看环境的脸色」。

这类失败的特征是**换一个模型/环境就变红变绿，而代码一行没动**。排查顺序：

1. 先把渲染处的取值链读出来（`rg -n "const win =" src/renderer/src`），不要在探针里猜；
2. 看探针的 `setState` 覆盖了链上的哪几层 —— **链上每一层都要钉**（这里要同时钉
   `session.model` 与 `stats`，因为前者优先级更高）；
3. 只有当「真实值」与「fixture 值」可能不同时才需要钉（模型窗口、默认设置、平台能力都是重灾区）。

顺带一条：改扩展注入块的头行会连带打破一串 `includes('<TASK_STATE>')` 字串断言（精确标记匹配）。
用**前缀**（`includes('<TASK_STATE derived="true"')`）比完整标记稳，断言本身也就把契约写清楚了。

## 判断「这是什么条目」别用白名单枚举（2026-09-17）

背景：我们想判断「状态快照是不是只落后用户刚说的那一句」。第一版写成
`tail.length === 1 && tail[0].message.role === 'user'`，真实链路里**一直判不出来** ——
加上角色指纹诊断才看清 pi 在水位之后写的是 `["session_info", "user"]`：
**`session_info` 是 pi 自己的会话元信息条目**，不在任何我们预期的类型里。

两层的教训：

1. **判据要反向表达**。不要问「是不是我认识的包装类型」（那必然会漏下一个新类型），
   而要问「**有没有执行事实**」：`tail.every(e => e.type !== 'message' || e.message.role === 'user')`
   —— 非 message 的一律不算执行事实，pi 将来加多少种包装条目都不会影响这个判断。
2. **给判断结果配一个可读的「指纹」诊断**。`gap: 2` 这种数字排查不出来问题，
   而 `tail: ["session_info","user"]` 一眼就能定位。凡是「按某个集合/水位算出来的判定」，
   都把**参与判定的原始要素**一起记进诊断（成本是几十字节，省下的是一整轮 blind 排查）。

同类先例：`task-state-injected` 的 `freshness` 之所以要连着记 `gap / turnsGap / pendingOnly / tail`，
就是因为只看一个档位名无法分辨「真陈旧」与「定义不对」。

## 探针必须先证明「回合真的跑起来了」

`context-takeover` 的失败输出原来只有一行 `主进程记录: null` —— 这句话同时对应三种完全不同的原因：
模型侧失败（免费模型空响应 / 挂住 / **429 额度用尽**）、用量没到线、功能真的没触发。
三者不区分开，排查会走错方向（实测：为此白跑了两轮模型额度才发现是 429）。

现在这类探针先断言「回合真的跑起来了」并打印判定原料：

```
✓ 回合真的跑起来了（否则下面"没触发压缩"证明不了任何事）
  消息数=10｜isAgentRunning=false｜pi 用量=31019/1000000（percent=3.1）｜policyState={…}
```

**规则**：凡是「等某个副作用出现」的探针，都要先证明**产生副作用的前提条件**成立，
并把前提条件的数值打出来。前提不成立时直接 `return`，别让后续断言产生误导性结论。

## 「一句输出都没有」≠「应用启动失败」

`test:live` 抓不到 `---PROBE-START---` 时原来一律提示「应用可能启动失败」。但探针的输出是
**最后一次性打印**的，所以进程若在打印前被 kill，`buf` 就是空的 —— 这和应用没起来长得一模一样。
`contexttakeover` 就因此白查了三轮（真实原因是它 `budget` 只有 180s，而探针要先跑完一个大回合、
再等压缩落定）。

现在提示会分开报：`buf` 非空 → 「应用可能启动失败」；`buf` 为空 → 直接提示去看
`delay + budget` 够不够。**探针变慢之后，必须同步加预算。**

## pi 报的用量口径不透明且非线性（pi 0.85.1 实测）

| 发出的消息 | pi 报的 `contextUsage.tokens` | 若按「字符数 ÷ 4」 |
|---|---|---|
| 15 字符（`只回复「好」，不要用任何工具。`） | **4** | 4 |
| ~7.8k 字符（填充 ×250） | **1940** | 1938 |
| ~46k 字符（填充 ×1500） | **31019** | 11625 |

前两行巧合般符合「÷4」，第三行完全不符合；而且它**不含** system prompt 与工具定义
（15 字符的消息不可能是真的 4 token —— 光 system 就远超这个数）。**所以：**

- **别依赖这个绝对值**，只依赖两个相对关系：① `compactionInfo().threshold`（pi 原生线）
  远在工作集之上；② 用量确实越过了工作集线（内容够大）。
- 想用「把工作集压到极低」来验证接管，就必须让**内容本身**够大，
  否则失败信息会像「接管坏了」，实际只是「用量没到」。
- pi 也会拒压「太小」的会话（`Nothing to compact (session too small)`）；但**不要**用
  「先发个小回合建立历史」去绕 —— 在极低工作集阈值下，那个预热回合结束本身就会触发一次压缩，
  反而干扰后面的回合（实测：推理模型下连「回合跑起来了」都观测不到）。

## 探针别拿旧 DOM 引用（切换后必须重新查询）

`features` 的多档思考断言在 deepseek（5 档）下红了，诊断长这样：

```
[诊断] 点 off 后等了 5s 仍是 "high"；直接调主进程返回 {"ok":true}；再读 store="off"
```

「点击没反应、而直接调 API 立刻生效」= 你在点一个 **detached 节点**。
原因：那段代码在**切过模型之后**还用着切之前查到的按钮列表 —— 菜单早已重渲染，
旧节点不在文档里，`click()` 不会触发 React 的 onClick。
（单档模型没有可点的第二个档位，所以这条断言从来没真正执行过。）

**规则**：任何「先查询 → 中间做了会改 DOM 的事 → 再点击」的探针，都要在**点击前**重新查询。
判断依据也是一个通用套路：**把"点击"与"直接调用同一个 API"对照**，两者结论不一致就是引用/命中问题，
不是产品缺陷。

## 「没有写出状态文件」这类否定断言必须按会话隔离

所有 live 场景**共用同一个沙箱**（`sandboxRoot` 在场景循环之前就创建了），所以
`ctx-ext.log` 与 `data/context-state/` 里混着兄弟场景留下的东西。不隔离时：

- `contextproduce` 读到别人的状态文件 → `revision: undefined`、`evidence` 全空；
- `contextgate` 的「没有提交状态」「没有写出状态文件」必然误判（看到的是兄弟场景的提交）。

修法：各 context 探针都会打印 `<key>.sessionId=…`，退出后检查用它过滤诊断行与状态文件
（`ownSessionIdFrom`，见 `scripts/test-live.mjs`）。实测：隔离前并跑必红、单跑全绿；
隔离后「两个一起跑」全绿（`contextgate` 正确排除了兄弟场景的 3 个文件）。

**规则**：否定断言（"没有…"）在共享状态下必须显式限定作用域，否则它测的是邻居。

## 批量跑 live 时的偶发红：先单跑复核

`sessions` / `virtual` 在 33 个场景连跑时红过（`virtual` 渲染耗时 **24.6s**、DOM 里 0 个消息节点），
而单跑立即全绿 —— 这是重负载下渲染类断言的超时，不是回归。判定顺序：

1. 先看失败的是不是**否定断言 / 环境敏感断言**（→ 先怀疑污染或负载）；
2. **单跑一次**同一场景（几分钟，成本低）；
3. 两次结论不一致 → 记为偶发并写进 HANDOFF 的「已知偶发」，别当成回归去改产品代码。

## ChatGPT 长会话页的 ref 会持续失效：改用 URL 参数预填（2026-09-18）

**现象**：在 ChatGPT 的**长会话页**里，`browser_observe` 每次返回的 generation 都在 +1，
而紧接着用上一轮拿到的 ref 调 `browser_type` / `browser_click`，一律报「元素引用已失效」。
原因不是 ref 过期太快，而是**页面自己在持续重渲染** —— 只要 generation 还在前进，
任何依赖 ref 的工具都用不了；而 `observe` 本身又会让 generation 前进，于是形成死锁。
同一个页面上 `browser_scroll` 也会失效（滚 100000px 后偏移量一点不动）。

**可用替代**：把要问的话写进 URL 的查询参数，让页面自己预填：

```
https://chatgpt.com/?q=<问题文本>
```

实测会被规范成 `?prompt=…` 并把内容填进输入框（`observe` 里能看到），
然后用 **`browser_press('Enter')`** 发送 —— **按键不需要 ref**，这条路绕开了整个 ref 机制。

**两个硬约束**：

1. **URL 长度**。中文经 `encodeURIComponent` 每个字膨胀成 9 个字符（UTF-8 3 字节 → `%XX`×9），
   同一段话用英文写，URL 只有约 1/3。实践上问题要压到 ~1000 字符以内才好可靠粘贴。
2. **`?q=` 只能开新会话**（会话页不支持），所以问题必须**自带背景** —— 不能指望它记得上一轮，
   连「你上次说的五条 P0」都要在问题里点名复述。

**取舍**：这条路的代价是失去上下文，收益是能自动化。如果非要续问旧会话，
就只剩「请用户手动粘贴」这一条路（`browser_request_user_control`）。

## 诊断过滤器为空时会静默误报（2026-09-18）

`diagnostic(hook, payload)` 的签名是「第一参数进 `hook` 字段，其余字段由 payload 提供」——
它**不写 `stage`**。某个阶段的记录能不能被 `stage === "x"` 过滤出来，**完全取决于**
该阶段的调用方有没有在 payload 里显式写 `stage`（producer 系写了，compact 系当时没写）。

后果：`ownRecords.filter((r) => r?.stage === "compact")` 恒为空数组 —— 而**空数组
与「这件事真的没发生」在输出上一模一样**。当时据此得出的结论是
「pi 的 `session_before_compact` 一次都没被调到」，还顺手加了一条 `entered` 取证去
「确认」它 —— 但那条取证同样被同一个空过滤器挡掉，于是**误报被自己加固了一遍**。

补上 `stage` 后重测真会压缩的场景，真相是 `{entered:1, fallback:1}`，钩子被正常调用，
fallback 的原因是 `inject-off`（该场景没开 `episode-fold`，`state.inject` 为 false）——**正确的降级**。

**可操作的规则**：

1. 新增一个阶段的诊断时，**照抄既有阶段 payload 的完整字段**（含 `stage`），不要只学一半；
2. 检查函数在断言「某件事**没有**发生」之前，**先打印该阶段的记录条数**（分布/总数），
   确认过滤器是**通的**再断言。条数为 0 时必须能区分「没发生」与「没读到」；
3. 一个「否定结论」如果只由一条新加的取证支撑，**先怀疑取证本身** ——
   这条误报正是因为新加了一条同样被空过滤器挡掉的取证，反而显得更可信。

## 同一个响应里「已用」与「剩余」并存时，方向必须用真实数据钉住（2026-09-21）

Command Code 的 `/alpha/billing/credits` 把两种口径混在同一个对象里：

- `windowLimits.fiveHour|weekly.used` —— **已用**；
- `credits.monthlyCredits` —— **本月剩余**（名字里没有 remaining，最容易想当然）。

把它当「已用」的后果不是报错，而是**面板一直显示「本月已用 99.9%」**（用户报的
「显示已用完，其实没有用」）。这类「静默反向」缺陷有三个可复用的处置：

1. **用算术交叉验证字段语义**：拿到的真实响应里 `weekly.cap = 35`（套餐额度 70）、
   `monthlyCredits = 69.996221407`，而它恰好等于 `70 − fiveHour.used(0.003778593)` ——
   同一个消耗值同时出现在两个窗口里，说明月度那一个是**余额**。只靠字段名、或
   「上次看跟官网显示一致」都不足以定案：那次「50% 与官网一致」是巧合（用了一半时，
   两种解释都给 50%）。
2. **解析抽成纯函数 + 真实快照单测**：这类缺陷只有真账号能复现，但放一份 fixture
   （`scripts/test-quota.mjs` 里的线上快照）就能在没有凭证、不发请求的情况下把方向钉住。
3. **界面上不把推算说得像官方**：月度上限是反推出来的，就标 `estimated` 并在文案里写明
   「推算」，别让它看起来像接口给的精确值。

## 样式「档位」映射别把中间档写成空字符串（2026-09-21）

同一次改动里还埋着一个更安静的缺陷：色阶三档写的是
`tone === 'err' ? 'err' : tone === 'warn' ? 'warn' : ''` —— 于是 `ok` 档没有任何类名，
`.rp-v.ok { color: var(--ok) }` 从来没生效，低用量显示的是默认前景色（灰）。
**「没有类名」在截图上看着像一种设计选择**，只有把计算色与设计令牌对比才会露出来
（视觉矩阵 `quotatone` 状态里的 `getComputedStyle` 断言，第一次跑就红了）。

规则：**档位映射要一一对应地写全**（`ok` 就写 `ok`），并且给「颜色正确」留一条
不靠肉眼的断言（类名 + 计算色），否则配色回归只能靠人盯着截图看。
