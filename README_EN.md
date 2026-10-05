<p align="center">
  <img src="docs/assets/inkstone/hero-paper-ink.png" alt="Inkstone · 砚 — Paper, ink, and inkstone brand artwork" width="1280">
</p>

<h1 align="center">Give ideas form.</h1>
<p align="center">A desktop AI workspace for thinking, making, and moving work forward.</p>

<p align="center">
  <a href="https://github.com/Yu-DaTouX/Inkstone/releases">Download</a> ·
  <a href="#get-started">Get started</a> ·
  <a href="docs/GETTING_STARTED_EN.md">User guide</a> ·
  <a href="https://github.com/Yu-DaTouX/Inkstone/issues">Issues</a> ·
  <a href="README.md">中文</a>
</p>
<p align="center">
  <a href="https://github.com/Yu-DaTouX/Inkstone/releases/latest"><img src="https://img.shields.io/github/v/release/Yu-DaTouX/Inkstone?label=release" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/Windows-x64-0078D4" alt="Windows x64">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
</p>
<p align="center"><sub>Windows · Multiple model providers · Tiled workspace · Light &amp; dark themes · MIT licensed</sub></p>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/inkstone/workspace-tiles-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/inkstone/workspace-tiles-light.png">
  <img src="docs/assets/inkstone/workspace-tiles-light.png" alt="Inkstone workspace: sessions grouped by project on the left, the main conversation in the center, and a file preview and a sub-agent run tiled on the right." width="1280">
</picture>

<p align="center"><sub>v0.6 interface (Chinese UI) · Sessions, main conversation, and file and sub-agent tiles · All conversations, files and results are synthetic demo data · English UI is also available</sub></p>

## From an idea to something you can use

**Inkstone (砚)** brings conversations, projects, files, and tools into one desktop workspace. Start with a question, add your material, and work with AI to develop an idea, edit code, run commands, and review the results.

An inkstone holds the ink before it becomes writing. Inkstone carries that idea into a digital workspace: content stays central, input stays close, and execution details open when you need them.

## Keep your work together

| What you want to do | What Inkstone offers |
| --- | --- |
| **Develop an idea** | Streaming conversations, image input, `@` file references, `/` commands, and expandable reasoning and tool details. |
| **Work across projects** | Project groups, session search, branches, and queues. Running tasks can continue in the background when you switch sessions. |
| **Inspect the work** | File previews, an interactive terminal, an embedded browser, and access to local Chrome. Web search uses Bing, 360, DuckDuckGo and similar pages, or optional keys for Tavily, Brave, Firecrawl and Context7 under Settings > Enhanced search for steadier search, page reading and developer-docs lookup (all behind the single `yan search` entry). |
| **Arrange your workspace** | The main conversation, files, browser, terminals, tasks, logs and agents are tiles you can drag, group or split, resize, maximize and hide. Layouts are remembered per session. |
| **Find and rewind anything** | `Ctrl+K` session switcher searches titles and conversation text; project files are checkpointed before each turn and “Rewind code” on a user message restores them (undoable); the Agent asks before writing outside the project. |
| **Follow progress** | Goals, plans, task lists, and agent context, usage and runtime information. |
| **Work with multiple agents** | A unified Agent workspace for child pi sessions and external CLI runs. Sub-agent progress and results render the same way as the main conversation. Agent Hub is still in development. |
| **Let agents script their tools** | pi Codemode is on by default, so the agent can call tools in batches from a script and summarize the results. Nested calls appear as a tree, and dangerous operations still ask first. You can turn it off in Settings. |
| **Choose your model** | Connect model services and change models or thinking levels within the same interface. |
| **Make the workspace yours** | Light and dark themes, Chinese and English UI, adjustable panels and zoom. |
| **Build up a topic** | Topic spaces group conversations by theme rather than by project folder. Imported material becomes citable sources and can be handed off to the tutor. |
| **Learn with a tutor** | Say what you want to learn; the tutor explains step by step, asks questions and waits for your answer, and gives hints before answers. How it teaches lives in a bundled skill. |
| **See how conversations branch** | The session map lays conversations out per workspace lane. Expanding a session shows one card per exchange, and you can branch from a specific exchange. |

**Settings → Workspace → Layout** switches between **coding** and **daily**: the first is centered on projects and files, the second organizes conversations, material, and learning by topic.

The agent manages its own context. Inkstone displays runtime events, usage and tool results, while compaction controls call native pi directly. You choose which materials to send; the agent loads its own rules, skills and memory.

Model capabilities, usage limits, and charges depend on your provider.

## Quiet, clear, considered

- **Content first.** Reading, output, and the next input take priority. Execution details stay behind concise summaries until you open them.
- **Type with a purpose.** Sans serif text for the interface and reading; monospace for code, commands, and paths.
- **Restrained hierarchy.** Space, warm neutrals, and subtle boundaries organize the workspace, with a single accent guiding interaction.

The open frame in the brand symbol represents a workspace; `>_` represents input and action.

## Get started

### Download for Windows

Visit the [latest release](https://github.com/Yu-DaTouX/Inkstone/releases/latest) and choose an installer, single-file portable application, or ZIP distribution. For the ZIP version, extract it and run `砚.exe`. Distributed packages include the pi runtime. The installed version can update itself from within the app.

This page and its screenshots follow the `main` branch. Check the release notes for the features in a particular download.

### Connect a model and start working

1. Configure a provider in **Settings → Model access**. Choose a provider and sign in directly from the app, or configure API credentials. No terminal login is required.
2. Select a project or start a conversation. Describe the task, add files with `@`, or explore commands with `/`.
3. Use the workspace panels to inspect files or continue in the browser and terminal.

See the [user guide](docs/GETTING_STARTED_EN.md) for shortcuts, installation, and backups.

An Android phone can pair over Tailscale by QR code to browse desktop sessions, answer questions, send messages and dictate; tasks still run on the computer. The entry is **Settings → Devices → Phone** on the desktop. The phone app is still in testing and has no public Android package yet; setup steps are in the [mobile access guide](docs/MOBILE_ACCESS.md) (Chinese).

Two computers running Inkstone can connect to each other and, with per-connection approval, view and copy sessions and results. See the [peer access guide](docs/PEER_ACCESS.md) (Chinese).

## Data and platforms

Windows is currently supported. macOS and Linux distributions and code signing are not yet available. Sessions and settings are stored on your machine; cross-device sync is not provided.

Requests to remote models are sent to your selected provider. Data locations differ between the single-file portable app and installed versions. Follow the [backup guide](docs/GETTING_STARTED_EN.md#data-and-backups) before migrating.

## Open source and feedback

Report problems or suggest improvements through [Issues](https://github.com/Yu-DaTouX/Inkstone/issues). Include your app version, reproduction steps, and relevant screenshots with credentials and private content removed.

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

The launcher checks dependencies, prepares the bundled runtime when needed, and builds the app. Existing checkouts can also use `启动-砚.cmd`. For development, use `开发-砚.cmd` or `npm run launch:dev`.

Read the [contribution guide](docs/CONTRIBUTING.md) and [AI collaboration rules](AGENTS.md). Architecture, build, and release guidance are in the [documentation index](docs/README.md).

</details>

## License

[MIT](LICENSE) · © 2026 Yu-DaTouX. Third-party notices for fonts, icons, syntax highlighting, and the bundled pi runtime are retained in distributions.
