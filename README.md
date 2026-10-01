<p align="center">
  <img src="docs/assets/inkstone/hero-paper-ink.png" alt="Inkstone · 砚 — 纸墨与砚台品牌横幅" width="1280">
</p>

<h1 align="center">让想法成形。</h1>
<p align="center">Give ideas form.</p>
<p align="center">砚 · 一个专注于内容与行动的桌面 AI 工作空间。</p>

<p align="center">
  <a href="https://github.com/Yu-DaTouX/Inkstone/releases">下载</a> ·
  <a href="#开始使用">快速开始</a> ·
  <a href="docs/GETTING_STARTED.md">使用指南</a> ·
  <a href="docs/MOBILE_ACCESS.md">手机接入说明</a> ·
  <a href="docs/AGENT_HUB.md">多 Agent 工作台（开发中）</a> ·
  <a href="https://github.com/Yu-DaTouX/Inkstone/issues">反馈</a> ·
  <a href="README_EN.md">English</a>
</p>
<p align="center">
  <a href="https://github.com/Yu-DaTouX/Inkstone/releases/latest"><img src="https://img.shields.io/github/v/release/Yu-DaTouX/Inkstone?label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC" alt="最新版本"></a>
  <img src="https://img.shields.io/badge/Windows-x64-0078D4" alt="Windows x64">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
</p>
<p align="center"><sub>Windows · 多模型接入 · 磁贴工作区 · 深浅主题 · MIT 开源</sub></p>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/inkstone/workspace-tiles-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/inkstone/workspace-tiles-light.png">
  <img src="docs/assets/inkstone/workspace-tiles-light.png" alt="Inkstone 工作空间：左侧按项目组织会话，中间是主会话，右侧并排打开文件预览与子 Agent 运行结果。" width="1280">
</picture>

<p align="center"><sub>v0.6 界面 · 左侧会话、中间主会话、右侧文件与子 Agent 磁贴 · 会话、文件与运行结果均为合成演示数据</sub></p>

## 从一个想法，到一份作品

**Inkstone（砚）** 将对话、项目、文件和工具放在同一个桌面工作空间里。你可以从一个问题开始，带上已有资料，与 AI 一起梳理思路、修改代码、运行命令，并查看工作的过程与产出。

砚是承接笔墨的地方。Inkstone 延续这个意象：让内容成为中心，让输入始终触手可及，让执行细节在需要时展开。

## 在同一处，把工作接着做

| 你想做什么 | Inkstone 提供什么 |
| --- | --- |
| **把思路说清楚** | 流式对话、图片输入、`@` 文件引用、`/` 命令；推理和工具过程可展开查看。 |
| **围绕项目推进** | 项目分组、会话搜索、分支与队列；切换会话时，已经运行的任务可以继续在后台执行。 |
| **查看过程与产出** | 文件预览、交互终端、内置浏览器和本机 Chrome 接入；联网搜索可用 Bing、360、DuckDuckGo 等网页搜索，也可配置 Brave 搜索 API。 |
| **自由摆放工作区** | 主会话、文件、浏览器、终端、任务、日志和 Agent 都是磁贴：可拖动、分组或拆分、调尺寸、放大与收起，布局按会话记住。 |
| **让任务有进展可循** | 目标与计划、任务清单，以及 Agent 原生上下文、用量和运行信息。 |
| **让多个 Agent 协作** | 统一 Agent 工作区汇总子 pi 与外部 CLI 运行，子 Agent 的过程与结果用和主会话相同的方式呈现；多 Agent 工作台仍在开发中。 |
| **让 Agent 组合调用工具** | 默认启用 pi Codemode，Agent 可以用脚本批量调用工具并整理结果；嵌套调用按树状展示，高危操作仍需确认。可在设置中关闭。 |
| **选择合适的模型** | 接入模型服务、切换模型与思考档位，在同一套界面中工作。 |
| **按自己的习惯使用** | 深浅主题、中英界面、可调栏宽与缩放。 |
| **围绕主题积累** | 主题空间按主题（而不是项目目录）归类会话；导入的资料可作来源引用，也能交给导师带你学。 |
| **跟着导师学** | 在对话里说想学什么，导师一步步讲解、出题并等你作答，答错先给提示；讲法与出题做法写在随包技能里。 |
| **看清会话的分支** | 会话地图按工作区分泳道；展开一个会话能看到一轮一轮的问答，也能从某一轮分叉出新的会话。 |

在 **设置 → 工作区 → 界面形态** 中可以切换**编码**与**日常**：前者以项目和文件为中心，后者把会话、资料与学习按主题组织。

上下文由 Agent 原生管理。砚把运行过程、用量和工具结果呈现为界面，压缩操作直接调用 pi；资料由你主动发送，或由 Agent 按自己的规则读取。技术边界见[架构简介](docs/ARCHITECTURE.md)。

模型能力、额度和费用取决于所接入的服务。

## 安静、清楚、精致

Inkstone 的界面围绕“墨色工作空间”设计：

- **内容优先。** 把阅读、产出和下一步输入放在主要位置；执行过程先显示摘要，细节按需展开。
- **文字各司其职。** 界面与正文采用无衬线字体；代码、命令和路径采用等宽字体。
- **克制地表达层级。** 用留白、暖中性色和少量边界组织界面，以单一强调色引导操作。

品牌图标中的开口石框代表工作空间，`>_` 代表输入与行动。

## 开始使用

### 下载 Windows 版本

前往 [最新发行版](https://github.com/Yu-DaTouX/Inkstone/releases/latest)，按发布说明选择安装版、单文件便携版或 ZIP 版。ZIP 版解压后运行 `砚.exe`；发行包包含 pi 运行时，无需单独安装 pi。安装版支持应用内自动更新。

本页介绍与截图跟随 `main` 分支；某个发行包包含哪些功能，以对应的发布说明为准。

### 接入模型，开始第一项工作

1. 在 **设置 → 模型** 中配置服务。选择服务后，可直接在软件内完成登录或配置 API 凭证，无需使用终端登录。
2. 选择项目或新建对话，在输入框写下任务；用 `@` 引用文件，用 `/` 查看可用命令。
3. 在工作面板中查看文件，或打开浏览器与终端继续操作。

常用操作、数据备份与安装说明见[使用指南](docs/GETTING_STARTED.md)。

Android 手机可以经 Tailscale 扫码配对，查看电脑上的会话、回答提问、发消息和语音输入，任务仍在电脑上执行。入口在桌面端 **设置 → 设备连接 → 手机**；手机应用目前仍在测试，尚无公开 Android 安装包，说明见[手机接入说明](docs/MOBILE_ACCESS.md)。

两台运行 Inkstone 的电脑可以互相连接，按「本次连接」授权查看、复制会话与成果，见[砚互联说明](docs/PEER_ACCESS.md)。

## 数据与平台

目前提供 Windows 版本，尚未提供 macOS、Linux 发行包或代码签名。会话与设置保存在本机；跨设备同步暂不提供。

连接远程模型时，请求会发送到所选服务。单文件便携版与安装版的数据位置有所不同，迁移前请按[使用指南](docs/GETTING_STARTED.md#数据与备份)备份。

## 开源与反馈

欢迎通过 [Issues](https://github.com/Yu-DaTouX/Inkstone/issues) 反馈问题或提出建议。请附上应用版本、复现步骤与必要截图，并隐去密钥和私人内容。

<details>
<summary>开发者：从源码运行与参与贡献</summary>

Inkstone 使用 Electron、React 和 TypeScript，并由 [pi](https://github.com/badlogic/pi-mono) 提供模型循环与工具执行。

准备 Git、Node.js（建议 24）和 npm，在 PowerShell 中执行：

```powershell
git clone https://github.com/Yu-DaTouX/Inkstone.git
cd Inkstone
npm install -g @earendil-works/pi-coding-agent
npm run launch
```

启动器会检查依赖、准备缺失的内置运行时并按需构建。已有工作区可双击 `启动-砚.cmd`；开发模式使用 `开发-砚.cmd` 或 `npm run launch:dev`。

参与贡献前请阅读 [贡献指南](docs/CONTRIBUTING.md) 和 [AI 协作约定](AGENTS.md)。按功能定位代码见[代码地图](docs/CODE_MAP.md)，语言与应用壳选择见[技术路线评估](docs/TECH_STACK_OPTIONS.md)；架构、构建与发布入口见[文档索引](docs/README.md)。

</details>

## 许可证

[MIT](LICENSE) · © 2026 Yu-DaTouX。第三方字体、图标、代码高亮和内置 pi 的许可随分发保留，清单见[第三方许可](docs/THIRD-PARTY.md)。
