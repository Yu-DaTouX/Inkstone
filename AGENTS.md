# 砚（Yan）· 项目工作须知

Electron + React + TypeScript。pi 以 `--mode rpc` 子进程提供模型循环，界面只订阅协议，不直接 import pi 内部模块。本文件只保留长期规则；状态与证据以 HANDOFF 为准，历史命令不产生当前授权。

## 开工入口

1. 读 [实施计划](docs/plan/README.md)、[当前状态](docs/dev/HANDOFF.md)，再读用户指定的 `docs/plan/active/` 正文。
2. `git status --short` 核对并保留已有修改，不预设工作树干净。目录导航读 [WORKSPACE](docs/WORKSPACE.md)，代码定位读 [PROJECT](docs/PROJECT.md)。
3. 当前任务提示词见 [审核融合入口](docs/plan/active/执行-2026-09-23-审核融合与任务提示词.md)。design/active 是设计输入，archive 是历史，不是执行清单。

## 工作区边界

- 不用 reset/checkout/clean/rm 处理无关修改；不擅自 stage、commit、push、打包或重启用户窗口。
- `release/砚数据/` 只读；测试用独立 YAN_* 目录，升级验证只能用备份副本。
- `resources/pi-runtime/` 是生成物，不手改，升级用 `npm run upgrade:pi`；`resources/pi-extensions/` 是随包薄层源码。
- 保留根目录 `启动-砚.cmd` / `开发-砚.cmd`、受版本控制的 `build/icon.ico` / `build/icon.png`。
- `docs/design/preview/` 截图与 GIF 是证据，不删不覆盖，新图另存新名。旧名 CSS 不等于无用，先查导入和动态类名。

## 架构与产品边界

- 完成版只有默认 pi 和必要的砚薄适配层；薄层只做宿主无法经 CLI/RPC 表达的生命周期桥接与策略，不注册模型工具/pi 命令、不增加用户可见功能、不改默认工具集。可落宿主/yan 的能力不得留薄层，见实施-01。
- 一个能力只有一个正式入口。浏览器、question、context recall 走宿主 `yan` CLI；不恢复 browser.js 模型工具、空壳扩展、旧 fallback。N21-9 已完成，不重跑。
- 任务服务已内置（`yan tasks apply`，日志在 `YAN_DATA_DIR/task-plans/`，不写会话 JSONL）；保持任务面板布局，不新增任务 pi 扩展、不恢复 `/panel` 补全。
- 不恢复旧记忆存储、remember/recall/forget 或提示词注入，不删除遗留数据。项目知识是独立、默认关闭的功能，不自动导入旧记忆。不恢复 get_tree 会话树链路。
- **推理新决定（2026-09-23）**：默认最新一句，点击在当前聊天位置展开全文；限高 `min(70vh, 620px)`，头部可收起，阅读旧内容不被新流抢回。默认无内部滚动条；模型原文保留。实施状态查 V-2a/HANDOFF，不把规范当已实现。工具组主动展开仍约 25 条固定范围，详见 DESIGN §3.5。
- 推理语言仅允许“必须用某语言思考”这一要求；界面语言约束由 `resources/pi-extensions/language.js` 的 `languageSystemPrompt()` 一句话提供，经 before_provider_request 和系统兜底交付；不用 `--append-system-prompt`，不重建实例。保留模型原文，软约束不作为故障证据。
- 历史界面以 JSONL 为准，不用仅含当前上下文的 get_messages 覆盖完整历史。分支 entryId 来自 get_fork_messages，不猜 DOM/归一化 ID。
- 本地档案不显示假登录/同步；订阅登录只有 ChatGPT openai-codex 在应用内，其余走终端。
- 深浅主题、设置、模型接入、Windows 打包、内置浏览器、本机 Chrome 已有实现；不要列作全部未开发。工作台已有 v1 布局/标签状态，完整资源生命周期与多文档验收仍按实施-11 收口。
- 600K/700K 仅为精确 provider/model 可回退试行档，不是全局默认或真实 1M 质量结论。
- Android 当前搁置，只有桌面协议基础；发布全量门槛暂无排期。不能把文档里的旧队列当作恢复两者的授权。

## 实现约定

- 主进程入口 `src/main/index.ts`；pi 协议集中 protocol/agent/normalize。渲染端只经 preload 和 `src/shared/ipc.ts` 调主进程、消费 MainPush。
- 设计先更新 [DESIGN](docs/design/DESIGN.md)，再同步 tokens.css/组件。grid 弹性列用 `minmax(0, 1fr)`。
- WebContentsView 是原生层，CSS z-index 无法压住它；浮层统一协调可见性，bounds 换算乘 `win.webContents.getZoomFactor()`。
- 注释只写当前职责、边界与原因。TypeScript 开启 noUnusedLocals/noUnusedParameters。

## 验证与交付

测试唯一规则见 [TESTING](docs/dev/TESTING.md)；发布规则见 [RELEASING](docs/dev/RELEASING.md)。

| 命令 | 用途 |
|---|---|
| `npm run typecheck` | TS、CSS 约定及 layer |
| `npm run build` | 生成当前 out |
| `npm run test:unit` | 依赖 out，先 build |
| `npm run test:live -- <场景>` | CASES 定义场景，不自动 build |
| `npm run audit:refs` | 文档/脚本/IPC 等引用静态检查 |
| `npm run launch` / `launch:dev` | 根启动入口对应启动流程 |

- Electron 前清掉 `ELECTRON_RUN_AS_NODE=1`。旧 out/release 文件存在不代表本次构建成功。
- 自动 live 默认隐藏、不上任务栏；不要关闭用户窗口。视觉验收须显式采集真实窗口并看图，不能拿隐藏 DOM 测量代替。
- 真实模型场景以 CASES 的 cost:1 为准；跑前核对模型、额度和授权，不因 free 名称假定免费。
- fixture 按路径定位，不依赖模型生成标题；条件轮询代替固定 sleep，几何稳定后测量。
- 六栏分别回填 HANDOFF：**实现 / 自动检查 / 真实运行 / 视觉验收 / 应用与包 / 剩余限制**。依据[工程清单](docs/dev/ENGINEERING-CHECKLIST-2026-09-15.md)决定可否勾选；静态/mock/构建/历史包都不能冒充完整交付。
- 每主题一份活动正文，完成后归档；引导文档不复制测试数字、检查点、历史故障流水账。文档总索引见 [docs/README](docs/README.md)。
