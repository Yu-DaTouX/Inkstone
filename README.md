# 砚 · Yan

基于 Electron、React 和 TypeScript 的独立 agent 桌面端。砚负责会话、项目、输入、模型接入和界面；pi 通过 RPC 子进程提供模型循环与工具执行。

![砚的界面预览](docs/design/preview/ui-live.png)

*界面示意，沿用项目已有截图；当前验收范围见[开发交接](docs/dev/HANDOFF.md)。*

## 开始使用

- **已有 Windows 成品**：安装版运行安装程序；ZIP 版解压后运行 `砚.exe`。成品包含 pi，无需另装。
- **已有源码工作区**：双击根目录 `启动-砚.cmd`；开发模式用 `开发-砚.cmd`。
- **首次从源码启动**：准备 Node.js（建议 24）和本地 pi，然后在项目根目录运行：

```powershell
npm install -g @earendil-works/pi-coding-agent
npm run launch
```

启动器会检查依赖、提取缺失的内置 pi 并按需构建。开发模式运行 `npm run launch:dev`。pi 检测失败时运行 `npm run probe-pi`。

## 主要功能

- **对话与输入**：流式回复、推理展示、工具详情、图片、`/` 命令、`@` 文件引用和 `!` shell。
- **项目与会话**：分组、分支、搜索、回收站、队列与后台运行状态。
- **模型接入**：模型和思考档位切换；ChatGPT（`openai-codex`）支持从应用发起登录，其余订阅接入按界面提示走终端。
- **工作面板**：上下文、任务、文件、子代理审阅、日志，以及内置浏览器和本机 Chrome 接入。
- **界面**：深浅主题、中英切换、可调栏宽与缩放。

这些能力的实现与验收进度分别见[实现总览](docs/PROJECT.md)和[当前待办](docs/dev/HANDOFF.md)。

## 常用操作

| 操作 | 入口 |
|---|---|
| 发送 / 换行 | 输入框 `Enter` / `Shift+Enter` |
| 文件与命令补全 | 输入 `@` / `/`，选择候选后再发送 |
| 模型接入 | 设置 → 模型接入 |
| 调整工具分区 | 工具库按钮收放和排序；工具栏内部可拖动排序 |
| 调整界面缩放 | `Ctrl+=` / `Ctrl+-` / `Ctrl+0`（自动） |

推理默认展开、限高显示最新内容，提供“展开全部 / 收起”；始终保留模型原文。更详细的功能入口见[实现总览](docs/PROJECT.md)。

## 平台与数据

Windows 是当前交付平台；macOS、Linux 和代码签名仍需对应环境或证书。Yan 自有账号与跨设备同步尚未实现，本地档案不代表已登录。

默认会话沿用 pi 的 JSONL 格式与用户目录，可与 pi TUI 共用。单文件便携版把数据放在 EXE 旁的 `砚数据/`；ZIP 版与安装版默认使用本机用户目录。备份和发布注意事项见[打包与数据](docs/dev/RELEASING.md)。

## 参与开发

先读 [AGENTS.md](AGENTS.md) 和[开发交接](docs/dev/HANDOFF.md)，再按需查看：

| 需要什么 | 文档 |
|---|---|
| 全部文档与方案入口 | [文档索引](docs/README.md) |
| 某功能怎么实现 | [实现总览](docs/PROJECT.md) |
| 目录和文件定位 | [工作区导览](docs/WORKSPACE.md) · [代码地图](docs/dev/CODE-MAP.md) |
| 检查与验收 | [测试约定](docs/dev/TESTING.md) |
| 颜色、字体、尺寸 | [设计规范](docs/design/DESIGN.md) |

## 许可证

[MIT](LICENSE)。第三方许可声明见 LICENSE；字体、图标、代码高亮和内置 pi 的许可随分发保留。
