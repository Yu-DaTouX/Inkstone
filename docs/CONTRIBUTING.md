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
| `npm run test:live -- <场景>` | Electron 场景检查，不自动构建 |
| `npm run audit:refs` | 引用一致性审计 |
| `npm run check:css-docs` | CSS 生成清单一致性 |
| `npm run icons` | 从维护用原型生成图标模块 |

按改动范围选择检查。live 场景配置见 `scripts/test-live.mjs`；涉及远程模型的场景可能产生费用，运行前确认 provider、模型和授权。测试使用独立数据目录，禁止复用真实用户凭证、会话或发布目录中的用户数据。

视觉改动同时关注深浅主题、窄窗口、缩放、键盘操作与实际截图。生成截图保留在本地，不批量提交到仓库；主页配图单独维护。

子代理反馈专项：构建后运行 `node scripts/test-subagent-feedback-live.mjs`，在独立数据目录的真实 Electron 深浅主题与窄窗检查紧凑卡片、详情展开、后台通知隐藏、无进展提醒恢复与错误原文展示；数据为合成夹具，不调用模型或复制凭证。`node scripts/test-subagent-light-live.mjs` 使用真实 pi 子进程和本机模型夹具验证指定模型、文件写入、独立危险审批与结束清理，不能作为真实服务验收。

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

## 提交与反馈

UX 反馈专项：构建后设置 `YAN_LIGHT_PROBE=scripts/probe/ux-feedback.js`、`YAN_LIGHT_FIXTURE_SESSIONS=1` 和 `YAN_LIGHT_INVALID_HISTORY=1`，运行 `node scripts/test-light-client-live.mjs`。实际 Electron 浅/深/窄窗检查两档权限真实设置、运行期停止入口、审批来源、搜索换词、CC 只读组合、设置键盘与附件清理失败说明；只用临时历史/附件，停止与来源跳转使用观察桩，不调用模型或安装插件。清理拒绝通过真实 IPC，结束后核对临时附件未变；完成后清除本次环境变量。

安全与性能边界回归已纳入 `test:unit`，也可在构建后单独运行 `node scripts/test-security-performance-fixes.mjs`：用临时文件、真实本机 HTTP 和构建出的 Office worker 检查 ZIP 实际大小/累计预算、办公响应限长、流式搜索、冷历史检索、会话缓存回收及 SSE 慢连接/连接数上限。浏览器新窗口另运行 `node scripts/test-browser-popup-live.mjs`，启动独立隐藏 Electron 窗口，验证远程页面弹窗/重定向不能访问本机，正常公网新标签及明确打开的本地预览仍可用；不使用个人会话、凭证或模型。

### 可重复性能测量

流式投影比较可运行 `node scripts/measure-turn-stream.mjs` 和 `node scripts/measure-turn-stream.mjs --after`：同一组合成2002条消息、200次更新，分别比较完整分组和按消息引用复用历史的投影；这是单个计算阶段的耗时，不是应用帧率或整体性能。

构建后可将 `YAN_LIGHT_PROBE` 设为 `scripts/probe/stream-smooth.js` 的绝对路径，再运行 `node scripts/test-light-client-live.mjs`。它在独立Electron目录中验证长历史、连续代码/中文/emoji输出、输入响应、无文字时工具可见、最终全文/代码高亮/表格与旧数据保留；不会调用模型。需要订阅额度的 `node scripts/test-luna-progress-live.mjs --real-luna` 使用已有Codex OAuth的隔离副本，仅运行精确 `openai-codex/gpt-6-luna` low小任务，记录首字/工具时间；无其他模型回退，执行前须得到额度调用授权。模型是否先说进展是行为采样，不是延迟保证。

Windows 上运行 `node scripts/measure-light-client.mjs` 记录三次空会话启动、空闲 CPU 与进程树工作集；`YAN_MEASURE_SCENARIO=long` 改用独立窗口的 2,000 条合成消息，记录首帧、120 次滚动采样和虚拟化 DOM 数量。`YAN_LIGHT_EXE` 指定独立目录包，`YAN_MEASURE_OUT` 指定新的证据文件；前后比较应使用同类运行方式。Chromium 探针关闭了帧率/后台限制，帧耗时不是实际显示器 FPS，工作集之和也不是独占物理内存。

`node scripts/measure-subagents.mjs` 测真实 pi 的单/双子任务，使用本机模型屏障，每种三次；已授权时加 `--real-haiku` 测 CC Haiku 5.5 low 单/双子任务，每种一次，需设置 `YAN_CC_TEST_BRIDGE`。CC 数据包括 SDK/CLI 进程，不能混同普通 pi。记录任务完成及采样子进程退出，检查重新归属后的 PID；同步进程采样会增加测得的总时长，短任务采样峰值可能漏掉瞬时尖峰。

### 升级 pi 与兼容验证

砚默认启用 Codemode，可在设置的能力与插件页关闭。`codemode-policy.js` 只选择原生工具并执行桌面偏好，不改 pi 引擎或用户 settings.json；默认会话只保留必要护栏；旧工作模式与活动档案不再装配。升级时运行 `node scripts/test-codemode-policy.mjs` 及 `node scripts/test-pi-native-tools.mjs --controller --desktop-codemode --project-package-policy`，核对默认启用、同一会话切换、计划模式恢复，以及原生 pi 对受信项目包的发现与禁用设置；应用设置的保存与开关交互可用 `npm run test:live -- codemodesetting` 验证。

磁贴工作区用 `npm run test:live -- resize fs fsedge todos terminalsurface` 检查资源身份、调整尺寸、文件系统边界和真实 PTY。`workspace-tiles.js` 属于隔离视觉矩阵：设置 `YAN_MATRIX_ONLY=workspace` 后运行 `npm run visual:matrix -- 0 1 2`，检查移动、拆分、隐藏、拖动取消和组件身份；会话及 Agent 数据为夹具，终端使用真实本机 PTY，浏览器使用真实 WebContentsView。旧固定右栏排序、分区高度、浮出及统一窗口标签探针已移除；新探针通过当前工具菜单打开资源。旧布局读取兼容仍保留，不能把它当作新的磁贴入口。

砚通过独立 RPC 子进程运行官方 pi；运行时由 `scripts/vendor-pi.mjs` 搬运官方 bundle、资产和最小依赖闭包。宿主策略及界面桥接放在 `resources/pi-extensions/`，不修改生成的 pi 引擎。上下文、压缩、恢复与技能发现由 pi 管理；身份、语言和高危确认等砚薄层仍需随升级核对。

先运行 `npm run upgrade:pi -- --check` 比较内置与本机源版本。准备目标版本的官方 npm 包后，可用 `YAN_PI_SRC` 指定其包目录，再执行 `npm run upgrade:pi`；升级不会自动安装或更新全局 pi。`--force` 只重新提取同版本，降级必须显式使用 `--allow-downgrade`，直接调用 vendor 脚本也遵守该限制。新运行时以独立 generation 保存，通过 `current.json` 切换；旧目录保留给活跃进程，已有窗口不会自动重启。升级结束会重新生成 `resources/pi-extensions/generated/pi-model-catalog.json`（从随包 pi 的模型目录摘出能否思考、协议、上下文与输出上限，自定义服务接入时按模型 ID 补齐能力），这份文件要随升级一起提交；单独重新生成用 `node scripts/gen-pi-model-catalog.mjs`，`--check` 只比对。

Codemode 需要 `quickjs-wasi/quickjs.wasm` 和官方脚本 worker。版本与 RPC 握手通过后，仍需执行 `node scripts/test-pi-compatibility.mjs`、`npm run test:agent-native-context` 和 `node scripts/test-pi-native-tools.mjs --controller`。原生工具检查仅连接本机模型/MCP 夹具；可加 `--only`、`--no-mcp`、`--native-search`、`--guard`、`--profile-blocked` 或 `--image`（codemode `image()` 输出在实时事件、历史与宿主投影中的图片块）验证对应边界，`--compact` 验证原生压缩。构建、真实服务和发行包需要各自证据。

升级还要核对 `parentToolCallId` 实时事件与 `toolResult.nestedCalls` 历史摘要、执行时 `tool_call` 护栏和各类子 pi 的加载策略。原生 MCP 使用 pi 的 `mcp.json`，旧宿主服务使用砚的 `mcp-servers.json`；两者不自动迁移凭证。原生 MCP 的 OAuth 登录由 pi 完成（`/mcp login <server>` 自动打开浏览器，授权链接以通知给出，浏览器到不了本机时由提问面板粘贴回调地址），凭证在 pi 的 `mcp-auth.json`，砚不读写。相关提交正文应写明目标版本、宿主适配、验证范围和剩余限制，不能只引用本地资料。

Issue 应包含版本、复现步骤及必要截图；移除密钥、私人对话和个人路径。提交说明应写清修改原因、检查范围和剩余限制。构建成功、模拟数据和真实运行是不同的证据，不互相替代。

新增公开文档应有稳定用途，并从 [文档索引](README.md) 可达。内部计划、验收流水与一次性报告保存在本地忽略目录。发布步骤见 [Windows 打包与数据](dev/RELEASING.md)。

### 可选真实 Claude 订阅检查

`node scripts/test-cc-guard.mjs` 检查整次 CC 原生工具委派的批准/拒绝、自定义工具名、原生模式与完整审批内容，不调用模型。`node scripts/test-rpc-disconnect-live.mjs` 使用真实 pi 与本机模型流，在生成中终止隔离进程，通过正式运行实例重载恢复同一会话；不重放原请求，只有显式新消息才继续执行。

已授权真实订阅调用时，`node scripts/test-cross-provider-live.mjs --real-haiku` 使用本机父 Provider 委派到真实 CC Haiku 子模型；不调用第二个收费 Provider。`node scripts/test-cc-subscription-live.mjs --real-haiku --recovery` 额外验证持久 CC 会话重载后的真实后续回复。进程断开恢复不等于所有网络错误或自动重试已经验收。

真实调用必须由用户明确授权，不纳入默认 unit。设置 `YAN_CC_TEST_BRIDGE` 为已安装 `pi-claude-bridge` 的包目录，然后运行 `node scripts/test-cc-subscription-live.mjs --real-haiku`、`node scripts/test-cc-subagent-live.mjs --real-haiku` 或 `node scripts/test-cc-delegation-live.mjs --real-haiku`。当前脚本仅使用 `claude-haiku-5-5` 和 `low`，不配置其他模型回退；第一项可加 `--preflight-only` 仅核对模型状态、不推理。Windows 默认取 `~/.local/bin/claude.exe`，其他安装位置可用 `YAN_CC_TEST_EXECUTABLE` 指定。测试使用临时 pi 配置，通过已有 Claude 登录运行；日志及运行回执留在自己的临时目录。订阅 Provider 的 cost=0 不能当作零额度消耗。
