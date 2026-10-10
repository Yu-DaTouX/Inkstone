<p align="center">
  <img src="docs/assets/inkstone/hero-paper-ink.png" alt="Inkstone · 砚 — Paper, ink, and inkstone brand artwork" width="1280">
</p>

<h1 align="center">Give ideas form.</h1>
<p align="center">Inkstone is a lightweight graphical agent client built on pi: pick a model, describe the task, and see the tool steps and results directly.</p>

<p align="center">
  <a href="https://github.com/Yu-DaTouX/Inkstone/releases/latest"><b>Download</b></a> ·
  <a href="docs/GETTING_STARTED_EN.md">User guide</a> ·
  <a href="https://github.com/Yu-DaTouX/Inkstone/releases">Changelog</a> ·
  <a href="https://github.com/Yu-DaTouX/Inkstone/issues">Issues</a> ·
  <a href="README.md">中文</a>
</p>
<p align="center">
  <a href="https://github.com/Yu-DaTouX/Inkstone/releases/latest"><img src="https://img.shields.io/github/v/release/Yu-DaTouX/Inkstone?label=release" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/Windows-x64-0078D4" alt="Windows x64">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
</p>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/inkstone/workspace-tiles-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/inkstone/workspace-tiles-light.png">
  <img src="docs/assets/inkstone/workspace-tiles-light.png" alt="Inkstone: the session list on the left, the conversation in the center, and a file and another AI's results side by side on the right." width="1280">
</picture>

<p align="center"><sub>UI preview · All content in the screenshot is demo data</sub></p>

## What it does for you

- **Get work done by chatting**: describe the task like you would in a chat, paste images, or point at files with `@`. Every step the AI takes can be opened and checked.
- **One window is enough**: conversation, files, web pages and terminal sit side by side, arranged however you like.
- **Undo mistakes**: before each message, your project is snapshotted automatically. Not happy? Roll back to that moment in one click.
- **Asks before risky moves**: broad deletes, discarding changes and the like wait for your OK first.
- **Your choice of model**: sign in or paste an API key inside the app, and switch any time.
- **Plugins when you need them**: download Inkstone adapters or browse and manage pi ecosystem packages in the [plugin market](docs/PLUGIN_MARKET.md) (Chinese).
- **Find old conversations**: press `Ctrl+K` and search titles or what was said.


## Product direction

Inkstone is converging on a lightweight pi GUI: readable conversations, two permission modes (dangerous-operation approval and native behavior), and delegation to a specified model. Desktop targets are Windows, macOS and Linux; Android and iOS connect to the computer. Dedicated writing, learning, spaces and library modules are outside the core product.

The current development build implements Claude Code subscription access through a pi plugin, model-specific subagents, and two permission modes. CC read-only subtasks remain unsupported. Legacy plan/autonomous modes, spaces, library, and dedicated writing/learning flows have left the default UI. Windows is the current delivery and validation target; other platforms are not delivered. Your downloaded release may predate these changes. See the [product direction](docs/PRODUCT_DIRECTION.md) (Chinese).

## Get started

1. Download the installer from the [releases page](https://github.com/Yu-DaTouX/Inkstone/releases/latest) and run it (it updates itself from then on). A portable version is also available.
2. Open Inkstone and sign in, or add an API key, under **Settings → Model access**.
3. Start a conversation and say what you want done.

The installer isn't code-signed yet, so Windows may warn about an unknown publisher; only download from this page. See the [user guide](docs/GETTING_STARTED_EN.md) for more.

## Good to know

- Windows only for now.
- Conversations and settings stay on your computer. What you send to the AI goes to the model service you pick, which also bills you.
- Before switching computers or versions, read the [backup guide](docs/GETTING_STARTED_EN.md#data-and-backups).
- An Android phone can connect to your PC to follow progress and reply. It's still in testing; see the [mobile access guide](docs/MOBILE_ACCESS.md) (Chinese).
- Hermes can inspect sessions, select models and submit tasks through the standalone [Inkstone control plugin](integrations/hermes-inkstone/README.md) (Chinese).

Found a problem? Open an [issue](https://github.com/Yu-DaTouX/Inkstone/issues) with your version and steps to reproduce, and hide any keys in screenshots.

<details>
<summary>Developers: run from source and contribute</summary>

Inkstone uses Electron, React, and TypeScript, with [pi](https://github.com/badlogic/pi-mono) providing the model loop and tool execution.

Install Git, Node.js (24 recommended), and npm, then run in PowerShell:

```powershell
git clone https://github.com/Yu-DaTouX/Inkstone.git
cd Inkstone
npm install -g @earendil-works/pi-coding-agent
npm run launch
```

The launcher checks dependencies, prepares the bundled runtime when needed, and builds the app when needed. Existing checkouts can double-click `启动-砚.cmd`. For development, use `开发-砚.cmd` or `npm run launch:dev`.

Read the [contribution guide](docs/CONTRIBUTING.md) and [AI collaboration rules](AGENTS.md). Find code by feature in the [code map](docs/CODE_MAP.md) (Chinese). Architecture, build, and release guidance are in the [documentation index](docs/README.md).

Existing ordinary file tasks and the standalone local Node entry are documented in [agent service](docs/AGENT_SERVICE.md) (Chinese). They are listed for streamlining review and are not a required workflow for the new product.

</details>

## License

[MIT](LICENSE) · © 2026 Yu-DaTouX. Third-party licenses are listed in [THIRD-PARTY](docs/THIRD-PARTY.md).
