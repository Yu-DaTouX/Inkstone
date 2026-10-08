# 参与 Inkstone 开发

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

### 升级 pi 与兼容验证

砚默认启用 Codemode，可在设置的能力与插件页关闭。`codemode-policy.js` 只选择原生工具并执行桌面偏好，不改 pi 引擎或用户 settings.json；先加载此薄层，再由工作模式与档案收紧工具。升级时运行 `node scripts/test-codemode-policy.mjs` 及 `node scripts/test-pi-native-tools.mjs --controller --desktop-codemode --project-package-policy`，核对默认启用、同一会话切换、计划模式恢复，以及原生 pi 对受信项目包的发现与禁用设置；应用设置的保存与开关交互可用 `npm run test:live -- codemodesetting` 验证。

磁贴工作区用 `npm run test:live -- resize fs fsedge todos terminalsurface` 检查资源身份、调整尺寸、文件系统边界和真实 PTY。`workspace-tiles.js` 属于隔离视觉矩阵：设置 `YAN_MATRIX_ONLY=workspace` 后运行 `npm run visual:matrix -- 0 1 2`，检查移动、拆分、隐藏、拖动取消和组件身份；会话及 Agent 数据为夹具，终端使用真实本机 PTY，浏览器使用真实 WebContentsView。旧固定右栏排序、分区高度、浮出及统一窗口标签探针已移除；新探针通过当前工具菜单打开资源。旧布局读取兼容仍保留，不能把它当作新的磁贴入口。

砚通过独立 RPC 子进程运行官方 pi；运行时由 `scripts/vendor-pi.mjs` 搬运官方 bundle、资产和最小依赖闭包。宿主策略及界面桥接放在 `resources/pi-extensions/`，不修改生成的 pi 引擎。上下文、压缩、恢复与技能发现由 pi 管理；身份、语言、活动工具限制和高危确认等砚薄层仍需随升级核对。

先运行 `npm run upgrade:pi -- --check` 比较内置与本机源版本。准备目标版本的官方 npm 包后，可用 `YAN_PI_SRC` 指定其包目录，再执行 `npm run upgrade:pi`；升级不会自动安装或更新全局 pi。`--force` 只重新提取同版本，降级必须显式使用 `--allow-downgrade`，直接调用 vendor 脚本也遵守该限制。新运行时以独立 generation 保存，通过 `current.json` 切换；旧目录保留给活跃进程，已有窗口不会自动重启。升级结束会重新生成 `resources/pi-extensions/generated/pi-model-catalog.json`（从随包 pi 的模型目录摘出能否思考、协议、上下文与输出上限，自定义服务接入时按模型 ID 补齐能力），这份文件要随升级一起提交；单独重新生成用 `node scripts/gen-pi-model-catalog.mjs`，`--check` 只比对。

Codemode 需要 `quickjs-wasi/quickjs.wasm` 和官方脚本 worker。版本与 RPC 握手通过后，仍需执行 `node scripts/test-pi-compatibility.mjs`、`npm run test:agent-native-context` 和 `node scripts/test-pi-native-tools.mjs --controller`。原生工具检查仅连接本机模型/MCP 夹具；可加 `--only`、`--no-mcp`、`--native-search`、`--guard`、`--profile-blocked` 或 `--image`（codemode `image()` 输出在实时事件、历史与宿主投影中的图片块）验证对应边界，`--compact` 验证原生压缩。构建、真实服务和发行包需要各自证据。

升级还要核对 `parentToolCallId` 实时事件与 `toolResult.nestedCalls` 历史摘要、执行时 `tool_call` 护栏和各类子 pi 的加载策略。原生 MCP 使用 pi 的 `mcp.json`，旧宿主服务使用砚的 `mcp-servers.json`；两者不自动迁移凭证。原生 MCP 的 OAuth 登录由 pi 完成（`/mcp login <server>` 自动打开浏览器，授权链接以通知给出，浏览器到不了本机时由提问面板粘贴回调地址），凭证在 pi 的 `mcp-auth.json`，砚不读写。相关提交正文应写明目标版本、宿主适配、验证范围和剩余限制，不能只引用本地资料。

Issue 应包含版本、复现步骤及必要截图；移除密钥、私人对话和个人路径。提交说明应写清修改原因、检查范围和剩余限制。构建成功、模拟数据和真实运行是不同的证据，不互相替代。

新增公开文档应有稳定用途，并从 [文档索引](README.md) 可达。内部计划、验收流水与一次性报告保存在本地忽略目录。发布步骤见 [Windows 打包与数据](dev/RELEASING.md)。
