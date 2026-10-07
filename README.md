<p align="center">
  <img src="docs/assets/inkstone/hero-paper-ink.png" alt="Inkstone · 砚 — 纸墨与砚台品牌横幅" width="1280">
</p>

<h1 align="center">让想法成形。</h1>
<p align="center">砚（Inkstone）是装在电脑上的 AI 助手：你说要做什么，它帮你查资料、写东西、改代码，过程和结果都摆在眼前。</p>

<p align="center">
  <a href="https://github.com/Yu-DaTouX/Inkstone/releases/latest"><b>下载</b></a> ·
  <a href="docs/GETTING_STARTED.md">使用指南</a> ·
  <a href="https://github.com/Yu-DaTouX/Inkstone/releases">更新日志</a> ·
  <a href="https://github.com/Yu-DaTouX/Inkstone/issues">反馈</a> ·
  <a href="README_EN.md">English</a>
</p>
<p align="center">
  <a href="https://github.com/Yu-DaTouX/Inkstone/releases/latest"><img src="https://img.shields.io/github/v/release/Yu-DaTouX/Inkstone?label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC" alt="最新版本"></a>
  <img src="https://img.shields.io/badge/Windows-x64-0078D4" alt="Windows x64">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
</p>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/inkstone/workspace-tiles-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/inkstone/workspace-tiles-light.png">
  <img src="docs/assets/inkstone/workspace-tiles-light.png" alt="砚的界面：左边是会话列表，中间是对话，右边并排打开文件和另一个 AI 的工作结果。" width="1280">
</picture>

<p align="center"><sub>界面示意 · 图中内容均为演示数据</sub></p>

## 它能帮你做什么

- **聊着把活干了**：像聊天一样交代任务，可以贴图片、用 `@` 指定文件。AI 每一步做了什么都能点开看。
- **一个窗口就够**：对话、文件、网页、终端并排摆在一起，想怎么摆就怎么摆，不用来回切窗口。
- **改坏了能退回**：每次发消息前，自动给项目存一份快照；不满意，一键退回到那一刻。
- **危险操作先问你**：大范围删除、丢弃改动这类操作，会先停下来等你点头。
- **模型随你选**：在软件里登录，或填入 API Key 就能用，随时切换。
- **以前聊过的都找得到**：按 `Ctrl+K`，搜标题或聊天内容。
- **还能当老师**：说想学什么，它一步步讲、出题、等你作答，答错了先给提示。

## 开始使用

1. 到 [发布页](https://github.com/Yu-DaTouX/Inkstone/releases/latest) 下载安装包，双击安装（之后会在软件里自动更新）。也有免安装的便携版。
2. 打开砚，在 **设置 → 模型** 里登录，或填入 API Key。
3. 新建对话，说出你要做的事。

安装包还没有数字签名，Windows 可能会弹出“未知发布者”提示，请只从本页下载。更多用法见 [使用指南](docs/GETTING_STARTED.md)。

## 需要知道的

- 目前只有 Windows 版。
- 聊天记录和设置都存在你自己的电脑上。你发给 AI 的内容会发到你选的模型服务，费用由该服务收取。
- 换电脑或换版本前，先看 [备份说明](docs/GETTING_STARTED.md#数据与备份)。
- 安卓手机可以连上电脑看进度、回消息，目前还在测试，见 [手机接入说明](docs/MOBILE_ACCESS.md)。

遇到问题欢迎提 [Issue](https://github.com/Yu-DaTouX/Inkstone/issues)，写上版本号和操作步骤，截图时记得遮住密钥。

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

参与贡献前请阅读 [贡献指南](docs/CONTRIBUTING.md) 和 [AI 协作约定](AGENTS.md)。按功能定位代码见[代码地图](docs/CODE_MAP.md)，架构、构建与发布入口见[文档索引](docs/README.md)。

</details>

## 许可证

[MIT](LICENSE) · © 2026 Yu-DaTouX。第三方组件的许可见 [第三方许可](docs/THIRD-PARTY.md)。
