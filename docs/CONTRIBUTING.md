# 参与 Inkstone 开发

开始改产品前先读[产品方向与精简边界](PRODUCT_DIRECTION.md)。当前文档调整不等于代码迁移授权；现有开发与发行链仍主要针对 Windows，目标平台的适配应分别验收。

[文档索引](README.md) · [项目主页](../README.md)

## 环境与启动

准备 Windows、Git、Node.js（建议 24）和 npm。具体依赖与命令以 [package.json](../package.json) 为准。

```powershell
git clone https://github.com/Yu-DaTouX/Inkstone.git
cd Inkstone
npm install -g @earendil-works/pi-coding-agent
npm run launch
```

启动器检查依赖与内置运行时，并按需构建。开发模式用 `npm run launch:dev`；已有工作区可使用根目录的两个启动脚本。

## 修改前

阅读 [架构简介](ARCHITECTURE.md)、[代码导览](PROJECT.md) 与 [AGENTS.md](../AGENTS.md)。检查工作区已有改动，只提交当前任务相关内容。提案与历史记录不代表执行授权。多个 AI agent 并行或接力时，按[多 Agent 协作流程](AGENT_WORKFLOW.md)登记状态与交接。

## 常用检查

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | TypeScript、CSS 布局与样式层约定 |
| `npm run build` | 构建当前源码 |
| `npm run test:unit` | 单元检查，依赖当前构建 |
| `npm run test:agent-native-context` | 原生上下文边界、技能发现、运行时选择及打包路径 |
| `node scripts/test-project-directory.mjs` | 更改项目文件夹专项：隔离设置/会话、目录占用及链接、并发与落盘失败、旧会话授权；不调用模型。UI 可单跑 `YAN_TEST_SYNTHETIC_ONLY=1 npm run test:live -- projectdirectory`（PowerShell 用 `$env:YAN_TEST_SYNTHETIC_ONLY='1'`，启动前清除 `ELECTRON_RUN_AS_NODE`） |
| `node scripts/test-context-trim.mjs` | 裁剪与自动压缩专项：用量校准、长单轮工具组保护、批次收益/前缀不变/容量兜底及会话边界；无需构建，不调用模型 |
| `npm run test:live -- <场景>` | Electron 场景检查，不自动构建 |
| `npm run audit:refs` | 引用一致性审计 |
| `npm run check:css-docs` | CSS 生成清单一致性 |
| `npm run icons` | 从维护用原型生成图标模块 |

生图边界专项 `node scripts/test-image-generation-boundaries.mjs` 现场编译当前宿主源码到独立目录，不覆盖应用 `out/`；以隔离凭证/数据和全桩 fetch 检查参考图目录联接逃逸、合法根别名、跨 store/生成/attach 并发保存与恢复、兼容通道默认模型及覆盖、停止/实例关闭/探测与确认中的取消、各适配器取消信号、ComfyUI 仅删除所属排队项和迟到成果抑制。它同时运行既有 artifact/适配器用例，已纳入 unit；不启动 ComfyUI、调用真实模型或网络，不代替真实服务/整窗/发行验收。

宿主可靠性夹具可逐个运行 `node scripts/<脚本>.mjs`，也已登记在 `test:unit`：`test-title-lifecycle`、`test-open-path-boundary`、`test-files-root-boundary`、`test-inbox-ipc-bounds`、`test-attachment-prune-race`、`test-session-restore-rollback`、`test-subagent-stop-intent`、`test-package-timeout-fallback`、`test-package-sources-fixture`、`test-write-file-durable`、`test-service-receipt-hub-null`、`test-preview-markdown-bound`、`test-browser-tab-buttons`、`test-mobile-model-url`、`test-session-read-equivalence`、`test-session-reader-stream`、`test-ui-survey-regressions`、`test-live-synthetic-isolation`。这些为源码断言、现场方法或隔离文件夹具，不调用真实模型，不代表 Electron 整窗、真实账号/系统权限或跨平台验收；单个夹具通过不表示完整 unit 已跑。

会话读取（`src/main/session-reader.ts`、`normalize.ts` 的 `createHistoryBuilder`）的分块读取、等价语义与并发单飞见[代码地图](CODE_MAP.md)：`test-session-read-equivalence` 用固定夹具覆盖坏行、超长行、末尾截断、entryIds、工具配对与图片本地化；`test-session-reader-stream` 覆盖 5 并发共享一次遍历、快照不可变、增长/替换/截短重读与句柄回收。两者只读临时目录，不碰用户会话。

大纲导航专项 `node scripts/test-outline-navigation.mjs` 执行现场源码回调，覆盖旧恢复帧抢回、流式/虚拟滚动、快照和分屏归属，含旧策略负对照；`node scripts/test-browser-frame-origin.mjs` 执行真实请求来源选择与网络边界，含远程父页/未知来源拒绝和 link-local 例外。两者已登记 unit，但不替代真实窗口验收。`npm run test:live -- browserframeboundary` 是正式应用的本地 iframe/network 单场景，复用 browser-boundary 原断言，不访问外部站点或启动 Chrome；操作经 `yan browser observe/select/click`，不能混用桌面 observe 引用与 CLI 运行归属。`node scripts/test-browser-frame-network.mjs` 是独立 Electron/CDP 本地夹具，含无操作点击负对照，不包含应用宿主门禁或真实 CLI；因此未并入纯 unit，单独运行。

按改动范围选择检查。live 场景配置见 `scripts/test-live.mjs`；涉及远程模型的场景可能产生费用，运行前确认 provider、模型和授权；`cost: 0` 不保证没有外部请求，仍须核对探针和 fixture。测试使用独立数据目录，禁止复用真实用户凭证、会话或发布目录中的用户数据。

无个人数据的单场景检查可在 PowerShell 设置 `$env:YAN_TEST_SYNTHETIC_ONLY='1'` 后运行 `npm run test:live -- <场景>`，结束后 `Remove-Item Env:YAN_TEST_SYNTHETIC_ONLY`。此模式仅允许隔离的 `cost: 0` 场景，使用空凭证与合成会话，剥离外层模型密钥/身份，不复制个人会话或模型目录；它不是网络沙箱，仍须先审查探针。纯 Node 回归为 `node scripts/test-live-synthetic-isolation.mjs`。`modelmenu` 验证当前滚动列表、供应商选择和键盘选模（选模动作打桩）；`detail` 验证详细程度设置；`context` 验证原生窗口用量投影；`permissions` 验证两档权限菜单、键盘浏览与正式 IPC 持久化；这些都不发送模型请求。

任务收件箱、会话地图、空间/活动档案、持续关注、知识设置、旧工作模式和目标 UI 的 live/矩阵登记，以及依赖旧宿主工作集/预算的模型压力场景已退役，不能作为现行入口验收；纯 IPC 与历史数据兼容检查另行保留。矩阵保留旧数字组序，只有退役状态的组会拒绝空验收。`node scripts/test-visual-matrix.mjs` 无需构建或模型，检查退役登记、重复键、有效探针路径、菜单忙态与复位；`node scripts/test-review-browser.mjs` 编译本机夹具，检查下载目录先于保存路径、建目录失败和旧顺序负对照，不执行外部下载。

视觉改动同时关注深浅主题、窄窗口、缩放、键盘操作与实际截图。生成截图保留在本地，不批量提交到仓库；主页配图单独维护。

运行实例事务回归可单独运行 `node scripts/test-runners.mjs`，使用假 Agent 验证跨目录替换先准备、成功才提交，失败保留旧实例并回收替代进程；不调用模型。

空闲回收专项 `node scripts/test-runner-reclaim.mjs` 现场编译、使用假 Agent 与注入时钟检查10分钟/60秒/一轮一个、活动/分屏/子代理/忙碌/未保存/队列/隐藏/同cwd/重载保护、退出清定时器、选择与重载并发及恢复代次，已纳入 unit。`node scripts/test-runner-reclaim-live.mjs` 用独立数据目录和真实随包 pi（Node 宿主、非 Electron 整窗）验证3个进程回收到1个、原会话/消息载回、不重放模型请求，Windows 下复用进程树工具记录工作集与退出PID；时间阈值通过注入时钟推进，不代表10分钟实等、长期放置或真实服务验收。它不启动外部模型任务、不读取个人凭证、不覆盖应用 `out/`；证据默认保存在本地独立目录，`YAN_RECLAIM_EVIDENCE` 可指定新的输出位置。

子代理限制可直接运行 `node scripts/test-subagent-limits.mjs`，现场编译当前源码到临时目录，用独立数据目录、假 RPC 和临时 Git 验证10个并发名额及启动交接、10分钟停滞期限及进展续期、75秒收尾不被迟到事件延长、可选总期限和模型自主调用次数；不依赖应用构建、不启动 Electron或调用模型。

子代理反馈专项：构建后运行 `node scripts/test-subagent-feedback-live.mjs`，在独立数据目录的真实 Electron 深浅主题与窄窗检查紧凑卡片的「范围、模型、思考、原生上下文、耗时」顺序与缺失值、详情展开、后台通知隐藏、停滞超时收尾原因与错误原文展示，并在独立桌面冷启动及复用同一数据目录的重启后核对真实 IPC 恢复调用结果、原父会话归属、过程窗口无任务原文按钮；数据为合成夹具，不调用模型或复制凭证。`test:unit` 中的 `scripts/test-subagents.mjs` 使用临时目录和假 RPC 验证新快照写入/读回、旧摘要从指定子会话补回调用、异常退出不复活、显式清除不反弹，以及落盘等待期间停止不再启动进程。快照及兼容转录保留最近 200 条消息；原生 JSONL 不改写，历史读取跳过损坏或超过 64 MiB 的单文件。

`node scripts/test-subagent-light-live.mjs` 使用真实 pi 子进程和本机模型夹具验证指定模型、文件写入、独立危险审批与结束清理，不能作为真实服务验收。

可靠性专项无需应用构建：`node scripts/test-queue-rpc-live.mjs` 使用当前 `AgentController`、真实随包 pi 与回环地址模型夹具，检查撤回/插队/中止交错、同文本队列身份、正常消费和回收后显式发送。`node scripts/test-personal-state-electron.mjs` 在隔离 Electron 组件夹具中加载正式 preload、IPC 注册器、互动状态 hook 与真实 sandbox iframe，检查写失败不发布、跨会话和进程重启恢复、非可信窗口拒绝与父窗口消息来源。两者现场编译到临时目录，不覆盖应用 `out/`，不复制凭证、不调用外部模型；后者日志中的写盘/坏文件/非可信 IPC 错误为预期故障注入。组件通过不代表整窗书签、小部件 UI、真实服务或发行包验收。

运行服务专项见 [运行服务](AGENT_SERVICE.md)：`node scripts/test-agent-service.mjs --pi` 使用真实 Node 和官方 pi 连接本机模型夹具；`node scripts/test-agent-service-cli.mjs` 检查公开 JSONL 入口、跨进程数据根互斥和重启请求去重。独立文件任务桌面页面与对应 UI 探针已退役。不会调用真实服务或复用个人凭证。

消息内 HTML 专项：`node scripts/test-html-artifact-preview.mjs` 检查受控目录、完整限长读取、令牌与资源释放（已纳入 unit）；先构建，再运行 `node scripts/test-html-artifact-live.mjs` 验证真实 Electron / preload / IPC / 成果卡片、脚本交互、隔离与源码切换，自动覆盖深浅主题和窄窗，不复制凭证、不调用模型。`YAN_HTML_PREVIEW_FILE` 可指定额外的单文件 HTML 作为截图样本，`YAN_HTML_SHOT_DIR` 可指定新的截图目录；目录已存在时拒绝覆盖。

模型菜单的多模型列表专项使用合成数据，不连接真实模型服务。在 PowerShell 中运行：

```powershell
$env:YAN_MATRIX_ONLY = "modelmenufull"
$env:YAN_SHOT_DIR = Join-Path $env:TEMP "inkstone-model-menu-shots"
npm run visual:matrix
```

此专项自动选择深色、浅色和窄窗三组，不需要记数组下标；单组可运行 `npm run visual:matrix -- modelmenufull-dark`（另有 `modelmenufull-light`、`modelmenufull-narrow`），命名组也可在未设置 `YAN_MATRIX_ONLY` 时直接使用。旧数字组号仍保留，显式指定的组优先；所选组没有任何目标场景时会报错并返回非零退出码，不算验收通过。纯 Node 回归检查为 `node scripts/test-visual-matrix.mjs`，也已纳入 `test:unit`。专项结束后清除本次设置的环境变量，避免过滤后续验证：

```powershell
Remove-Item Env:YAN_MATRIX_ONLY, Env:YAN_SHOT_DIR
```

其他矩阵场景必须显式指定一个目标组，`YAN_MATRIX_ONLY` 不保证为所有历史场景自动选组。例如 PowerShell：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:YAN_MATRIX_ONLY = "widgetfixture"
npm run visual:matrix -- 0  # 仅深色；另次使用组1检查浅色
Remove-Item Env:YAN_MATRIX_ONLY
```

`widgetfixture` 使用正式隔离预览协议、仅替换数据根，无网络模型请求；`composerfocus` 检查真实输入框聚焦，`toolgroup` 检查现行过程入口/长组展开，均可逐次使用组0/1。`terminal` 深浅为组13/14。截图须实际打开检查，旧截图保留；这些合成数据检查不代替运行服务、持久交互状态或发行包验收。

## 提交与反馈

设置页分区专项：构建后设置 `YAN_LIGHT_PROBE=scripts/probe/settings-sections.js`，运行 `node scripts/test-light-client-live.mjs`，检查主题切换、未访问分区不挂载、同页草稿保留、旧深链接、键盘焦点、外置依赖入口和深浅/窄窗溢出。使用独立数据目录，不安装插件或调用模型；`YAN_LIGHT_EVIDENCE` 可指定新的证据目录。完成后清除本次环境变量。

UX 反馈专项：构建后设置 `YAN_LIGHT_PROBE=scripts/probe/ux-feedback.js`、`YAN_LIGHT_FIXTURE_SESSIONS=1` 和 `YAN_LIGHT_INVALID_HISTORY=1`，运行 `node scripts/test-light-client-live.mjs`。实际 Electron 浅/深/窄窗检查两档权限真实设置、运行期停止入口、审批来源、搜索换词、CC 只读组合、设置键盘与附件清理失败说明；只用临时历史/附件，停止与来源跳转使用观察桩，不调用模型或安装插件。清理拒绝通过真实 IPC，结束后核对临时附件未变；完成后清除本次环境变量。

安全与性能边界回归已纳入 `test:unit`，也可在构建后单独运行 `node scripts/test-security-performance-fixes.mjs`：用临时文件、真实本机 HTTP 和构建出的 Office worker 检查 ZIP 实际大小/累计预算、办公响应限长、流式搜索、冷历史检索、会话缓存回收及 SSE 慢连接/连接数上限。浏览器新窗口另运行 `node scripts/test-browser-popup-live.mjs`，启动独立隐藏 Electron 窗口，验证远程页面弹窗/重定向不能访问本机，正常公网新标签及明确打开的本地预览仍可用；不使用个人会话、凭证或模型。

### 可重复性能测量

流式投影比较可运行 `node scripts/measure-turn-stream.mjs` 和 `node scripts/measure-turn-stream.mjs --after`：同一组合成2002条消息、200次更新，分别比较完整分组和按消息引用复用历史的投影；这是单个计算阶段的耗时，不是应用帧率或整体性能。

导航轨专项运行 `node scripts/test-outline-performance.mjs`：现场编译纯投影函数，在2002条合成消息、200次更新下交替比较旧全量分组/查找和历史引用缓存，逐字段核对结果，重复三轮；`YAN_OUTLINE_PERF_OUT` 可指定新的 JSON 证据文件。基础导航语义检查已纳入 unit。

子代理流式专项运行 `node scripts/test-subagent-stream-performance.mjs`：独立数据目录与假 RPC 验证33ms快照合并、主动读取即时性、工具/结束/停止即时推送和清除后不反弹，以及增量推送（只发自上次推送起的转录，拼回后与权威转录一致）的字节量对比，并重复三轮100条历史与500次更新的序列化测量。`YAN_SUBAGENT_STREAM_OUT` 可指定新的 JSON 文件；`YAN_SUBAGENT_STREAM_MODULE` 可指定优化前编译的模块，配合 `--baseline` 运行同负载对照。字节数是 JSON 序列化体积，不是实际 IPC 字节；同步事件处理耗时不含异步推送回调，不能当作总 CPU 收益。并行运行隔离与收口检查也已纳入 unit。

### 写 live 探针时的三个坑（2026-10-11 踩到）

- **过程入口默认折叠**：`TurnProcess` 只在展开时渲染工具行与推理块，而默认是否展开只看「并列布局 + 正在流式」。注入夹具（`applyPush({ch:'sync'})` 或 `setState({messages})`）后如果不先点开 `[data-testid="turn-process-toggle"]`，看到的是「一个工具行都没有」「终端没渲染」「推理块没渲染」这类**假象**。两个细节：注入当下 DOM 里还挂着上一条回合的入口，要先等新回合上屏再点；换新消息 id 会让过程重挂，每条用例都要重新铺开。`scripts/probe/toolrow.js` 的 `openProcess()` 是可抄的写法。
- **设置页入口**：`openSettings('packages')` 是兼容深链接，直接选中「插件市场 → pi 插件」（包括附件清理）；也可用 `openSettings('market')` + 点 `market-pi-tab`。目录搜索默认收起，先展开 `market-catalog`。模型、自定义服务、能力等改为页内分区，先点对应 `settings-section-*`，不能只等旧表单出现。各探针的 `q()` 有的收选择器、有的收 testid 名，改之前先看定义。
- **探针顶层要包 `try/catch`**：异常不兜住只会得到「没抓到 PROBE 输出」，连已跑过的断言一并丢掉，排查成本高得多。

构建后可将 `YAN_LIGHT_PROBE` 设为 `scripts/probe/stream-smooth.js` 的绝对路径，再运行 `node scripts/test-light-client-live.mjs`。它在独立Electron目录中验证长历史、连续代码/中文/emoji输出、输入响应、无文字时活动行与过程入口可见、展开后工具可见、最终全文/代码高亮/表格与旧数据保留；不会调用模型。`YAN_LIGHT_WIDE_SIZE` 可改宽/深两次的窗口尺寸（默认 1440x1000），需验证并列过程栏时用 `1920x1000` 这类不会回退到正文内的宽度。工具详情专项 `scripts/probe/tool-detail-layouts.js` 检查两种过程布局的落位、单条详情只有一个滚动区、宽幅阅读的焦点归还、真实增删数与逐行 diff、以及七步长组的折叠口径；夹具是合成调用，不代表真实模型会话。需要订阅额度的 `node scripts/test-luna-progress-live.mjs --real-luna` 使用已有Codex OAuth的隔离副本，仅运行精确 `openai-codex/gpt-6-luna` low小任务，记录首字/工具时间；无其他模型回退，执行前须得到额度调用授权。模型是否先说进展是行为采样，不是延迟保证。

Windows 上运行 `node scripts/measure-light-client.mjs` 记录三次空会话启动、空闲 CPU 与进程树工作集；`YAN_MEASURE_SCENARIO=long` 改用独立窗口的 2,000 条合成消息，记录首帧、120 次滚动采样和虚拟化 DOM 数量。`YAN_LIGHT_EXE` 指定独立目录包，`YAN_MEASURE_OUT` 指定新的证据文件；前后比较应使用同类运行方式。Chromium 探针关闭了帧率/后台限制，帧耗时不是实际显示器 FPS，工作集之和也不是独占物理内存。

`node scripts/measure-subagents.mjs` 测真实 pi 的单/双子任务，使用本机模型屏障，每种三次；已授权时加 `--real-haiku` 测 CC Haiku 5.5 low 单/双子任务，每种一次，需设置 `YAN_CC_TEST_BRIDGE`。CC 数据包括 SDK/CLI 进程，不能混同普通 pi。记录任务完成及采样子进程退出，检查重新归属后的 PID；同步进程采样会增加测得的总时长，短任务采样峰值可能漏掉瞬时尖峰。

`node scripts/measure-memory.mjs` 是内存审计通道：起隔离实例（独立 userData / 会话 / 数据 / pi 目录，不上屏）并开调试端口，用 CDP 读渲染端真实指标（V8 堆、DOM 节点与事件监听器数）并按 `--scales` 逐档注入合成消息，同时采样进程树工作集。`--verify` 验证渲染端文件预览标签的数量上限；`--steps`、`--idle` 是调试用分步/心跳模式。它不启动用户窗口、不碰真实数据目录；工作集按进程累加，不等于独占物理内存。

### 升级 pi 与兼容验证

砚默认启用 Codemode，可在设置的能力与插件页关闭。`codemode-policy.js` 只选择原生工具并执行桌面偏好，不改 pi 引擎或用户 settings.json；默认会话只保留必要护栏；旧工作模式与活动档案不再装配。升级时运行 `node scripts/test-codemode-policy.mjs` 及 `node scripts/test-pi-native-tools.mjs --controller --desktop-codemode --project-package-policy`，核对默认启用、同一会话切换、计划模式恢复，以及原生 pi 对受信项目包的发现与禁用设置；应用设置的保存与开关交互可用 `npm run test:live -- codemodesetting` 验证。

磁贴工作区用 `npm run test:live -- resize fs fsedge todos terminalsurface` 检查资源身份、调整尺寸、文件系统边界和真实 PTY。`workspace-tiles.js` 属于隔离视觉矩阵：设置 `YAN_MATRIX_ONLY=workspace` 后运行 `npm run visual:matrix -- 0 1 2`，检查移动、拆分、隐藏、拖动取消和组件身份；会话及 Agent 数据为夹具，终端使用真实本机 PTY，浏览器使用真实 WebContentsView。旧固定右栏排序、分区高度、浮出及统一窗口标签探针已移除；新探针通过当前工具菜单打开资源。旧布局读取兼容仍保留，不能把它当作新的磁贴入口。

砚通过独立 RPC 子进程运行官方 pi；运行时由 `scripts/vendor-pi.mjs` 搬运官方 bundle、资产和最小依赖闭包。宿主策略及界面桥接放在 `resources/pi-extensions/`，不修改生成的 pi 引擎。上下文、压缩、恢复与技能发现由 pi 管理；身份、语言和高危确认等砚薄层仍需随升级核对。

先运行 `npm run upgrade:pi -- --check` 比较内置与本机源版本。准备目标版本的官方 npm 包后，可用 `YAN_PI_SRC` 指定其包目录，再执行 `npm run upgrade:pi`；升级不会自动安装或更新全局 pi。`--force` 只重新提取同版本，降级必须显式使用 `--allow-downgrade`，直接调用 vendor 脚本也遵守该限制。新运行时以独立 generation 保存，通过 `current.json` 切换；旧目录保留给活跃进程，已有窗口不会自动重启。升级结束会重新生成 `resources/pi-extensions/generated/pi-model-catalog.json`（从随包 pi 的模型目录摘出能否思考、协议、上下文与输出上限，自定义服务接入时按模型 ID 补齐能力），这份文件要随升级一起提交；单独重新生成用 `node scripts/gen-pi-model-catalog.mjs`，`--check` 只比对。能力表生成失败时升级命令非零退出，并明确报告运行时已更新但升级未全部完成；先补生成再继续后续检查，不能将部分成功视为整体成功。`node scripts/test-pi-compatibility.mjs --upgrade-catalog-only` 用临时副本和假子进程验证退出码，不执行真实升级。

Codemode 需要 `quickjs-wasi/quickjs.wasm` 和官方脚本 worker。版本与 RPC 握手通过后，仍需执行 `node scripts/test-pi-compatibility.mjs`、`npm run test:agent-native-context` 和 `node scripts/test-pi-native-tools.mjs --controller`。原生工具检查仅连接本机模型/MCP 夹具；可加 `--only`、`--no-mcp`、`--native-search`、`--guard`、`--profile-blocked` 或 `--image`（codemode `image()` 输出在实时事件、历史与宿主投影中的图片块）验证对应边界，`--compact` 验证原生压缩。构建、真实服务和发行包需要各自证据。

升级还要核对 `parentToolCallId` 实时事件与 `toolResult.nestedCalls` 历史摘要、执行时 `tool_call` 护栏和各类子 pi 的加载策略。原生 MCP 使用 pi 的 `mcp.json`，旧宿主服务使用砚的 `mcp-servers.json`；两者不自动迁移凭证。原生 MCP 的 OAuth 登录由 pi 完成（`/mcp login <server>` 自动打开浏览器，授权链接以通知给出，浏览器到不了本机时由提问面板粘贴回调地址），凭证在 pi 的 `mcp-auth.json`，砚不读写。相关提交正文应写明目标版本、宿主适配、验证范围和剩余限制，不能只引用本地资料。

Issue 应包含版本、复现步骤及必要截图；移除密钥、私人对话和个人路径。提交说明应写清修改原因、检查范围和剩余限制。构建成功、模拟数据和真实运行是不同的证据，不互相替代。

新增公开文档应有稳定用途，并从 [文档索引](README.md) 可达。内部计划、验收流水与一次性报告保存在本地忽略目录。发布步骤见 [Windows 打包与数据](dev/RELEASING.md)。

### 可选真实 Claude 订阅检查

`node scripts/test-cc-guard.mjs` 检查整次 CC 原生工具委派的批准/拒绝、自定义工具名、原生模式与完整审批内容，不调用模型。`node scripts/test-rpc-disconnect-live.mjs` 使用真实 pi 与本机模型流，在生成中终止隔离进程，通过正式运行实例重载恢复同一会话；不重放原请求，只有显式新消息才继续执行。

已授权真实订阅调用时，`node scripts/test-cross-provider-live.mjs --real-haiku` 使用本机父 Provider 委派到真实 CC Haiku 子模型；不调用第二个收费 Provider。`node scripts/test-cc-subscription-live.mjs --real-haiku --recovery` 额外验证持久 CC 会话重载后的真实后续回复。进程断开恢复不等于所有网络错误或自动重试已经验收。

真实调用必须由用户明确授权，不纳入默认 unit。设置 `YAN_CC_TEST_BRIDGE` 为已安装 `pi-claude-bridge` 的包目录，然后运行 `node scripts/test-cc-subscription-live.mjs --real-haiku`、`node scripts/test-cc-subagent-live.mjs --real-haiku` 或 `node scripts/test-cc-delegation-live.mjs --real-haiku`。当前脚本仅使用 `claude-haiku-5-5` 和 `low`，不配置其他模型回退；第一项可加 `--preflight-only` 仅核对模型状态、不推理。Windows 默认取 `~/.local/bin/claude.exe`，其他安装位置可用 `YAN_CC_TEST_EXECUTABLE` 指定。测试使用临时 pi 配置，通过已有 Claude 登录运行；日志及运行回执留在自己的临时目录。订阅 Provider 的 cost=0 不能当作零额度消耗。
