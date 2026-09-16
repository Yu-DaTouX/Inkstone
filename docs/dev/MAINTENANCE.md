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
- 免费模型有配额：`inclusionai/ling-3.0-flash-sante:free` 每天 100 次，跑多了会 429，症状是 assistant 消息**内容为空**且 `stopReason=error`（看起来像事件流掉了）。备选：`meituan/LongCat-2.0:free`、`poolside/laguna-s-2.1-free`；需要“模型真的写文件”的场景用 `commandcode/deepseek/deepseek-v4.1-flash`。
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

## `@` 文件引用与 prompt

- pi 的 RPC `prompt` 只接受 `message` / `images` / `streamingBehavior`，**没有文件参数**：`@路径` 不会被展开成内容（展开是 CLI 参数层 `pi @file "..."` 的行为）。砚的补全把路径写进消息、文案说“附件文件，可直接读取”，由模型自己调 `read` —— 实测模型确实会去读（`test:live -- atrefsend` 的 `afterExit` 在会话 JSONL 里看到了文件内容）。改文案时不要写成“内容已加入上下文”。

## 会话与能力状态

- 启动期 sessionId 会从临时值变为稳定 ID。模型、思考档位、命令等能力请求按运行实例与代次判过期，见 `state/capability-request.ts`。
- 启动时加载失败的能力列表，需要在连接就绪后实际补拉。核对调用链，不能只信“稍后重试”的注释。
- 模型未知时保留选择器和空态，避免多层 return null 使用户失去入口。
- 分支 entryId 只取自 `get_fork_messages`；JSONL 快读与 pi 的权威会话切换职责分开。
- 通知需要去重与限流；启动期扩展说明进日志，不反复打断用户。

## 浏览器原生视图

- 网页使用 `WebContentsView`，位于 renderer DOM 之上；加载/错误提示放工具栏，拖拽把手预留空间。
- DOM 的 CSS 坐标乘主窗口 `getZoomFactor()` 后才是 setBounds 所需 DIP。单列 grid 用 `minmax(0, 1fr)`。
- 加载会重置先前缩放；在 ready-to-show 后补设。避免在 did-finish-load 内同步 setZoomFactor，已有渲染进程崩溃记录。
- element ref 在文档替换后失效；普通 DOM 增删不全量清空。已脱离节点返回 STALE_ELEMENT。
- 点击先滚入视野，再重新测量坐标；切换外部 Chrome 目标后重新 observe。
- 内嵌浏览器与本机 Chrome 的 profile 独立。登录、下载与 Cookie 同步需实际目标网站验证，不能用 CDP 冒烟替代。

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
