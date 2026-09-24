<p align="center">
  <img src="docs/assets/inkstone/hero-paper-ink.png" alt="Inkstone · 砚 — Paper, ink, and inkstone brand artwork" width="1280">
</p>

<h1 align="center">Give ideas form.</h1>
<p align="center">A desktop AI workspace for thinking, making, and moving work forward.</p>

<p align="center">
  <a href="https://github.com/Yu-DaTouX/yan--agent/releases">Download</a> ·
  <a href="#get-started">Get started</a> ·
  <a href="docs/GETTING_STARTED_EN.md">User guide</a> ·
  <a href="https://github.com/Yu-DaTouX/yan--agent/issues">Issues</a> ·
  <a href="README.md">中文</a>
</p>
<p align="center"><sub>Windows · Multiple model providers · Light &amp; dark themes · MIT licensed</sub></p>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/inkstone/workspace-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/inkstone/workspace-light.png">
  <img src="docs/assets/inkstone/workspace-light.png" alt="Inkstone workspace: sessions on the left, conversation in the center, and review, browser, file and terminal tools on the right." width="1280">
</picture>

<p align="center"><sub>Development build · Demo configuration: GPT-6 Astra Max · Conversation and tool results are illustrative · English UI is also available</sub></p>

## From an idea to something you can use

**Inkstone (砚)** brings conversations, projects, files, and tools into one desktop workspace. Start with a question, add your material, and work with AI to develop an idea, edit code, run commands, and review the results.

An inkstone holds the ink before it becomes writing. Inkstone carries that idea into a digital workspace: content stays central, input stays close, and execution details open when you need them.

## Keep your work together

| What you want to do | What Inkstone offers |
| --- | --- |
| **Develop an idea** | Streaming conversations, image input, `@` file references, `/` commands, and expandable reasoning and tool details. |
| **Work across projects** | Project groups, session search, branches, and queues. Running tasks can continue in the background when you switch sessions. |
| **Inspect the work** | File previews, change review, an interactive terminal, an embedded browser, and access to local Chrome. |
| **Follow progress** | Goals, plans, task lists, subagent status, and context and runtime information. |
| **Choose your model** | Connect model services and change models or thinking levels within the same interface. |
| **Make the workspace yours** | Light and dark themes, Chinese and English UI, adjustable panels and zoom, and an organized tool area. |

Model capabilities, usage limits, and charges depend on your provider.

## Quiet, clear, considered

- **Content first.** Reading, output, and the next input take priority. Execution details stay behind concise summaries until you open them.
- **Type with a purpose.** Sans serif text for the interface and reading; monospace for code, commands, and paths.
- **Restrained hierarchy.** Space, warm neutrals, and subtle boundaries organize the workspace, with a single accent guiding interaction.

The open frame in the brand symbol represents a workspace; `>_` represents input and action.

## Get started

### Download for Windows

Visit [Releases](https://github.com/Yu-DaTouX/yan--agent/releases) and choose an installer, single-file portable application, or ZIP distribution. For the ZIP version, extract it and run `砚.exe`. Distributed packages include the pi runtime.

**Releases may lag behind the development branch.** This page describes the development build. Check the release notes for the features available in a particular download.

### Connect a model and start working

1. Configure a provider in **Settings → Model access**. Choose a provider and sign in directly from the app, or configure API credentials. No terminal login is required.
2. Select a project or start a conversation. Describe the task, add files with `@`, or explore commands with `/`.
3. Use the workspace panels to inspect files, review changes, or continue in the browser and terminal.

See the [user guide](docs/GETTING_STARTED_EN.md) for shortcuts, installation, and backups.

## Data and platforms

Windows is currently supported. macOS and Linux distributions and code signing are not yet available. Sessions and settings are stored on your machine; cross-device sync is not provided.

Requests to remote models are sent to your selected provider. Data locations differ between the single-file portable app and installed versions. Follow the [backup guide](docs/GETTING_STARTED_EN.md#data-and-backups) before migrating.

## Open source and feedback

Report problems or suggest improvements through [Issues](https://github.com/Yu-DaTouX/yan--agent/issues). Include your app version, reproduction steps, and relevant screenshots with credentials and private content removed.

<details>
<summary>Developers: run from source and contribute</summary>

Inkstone uses Electron, React, and TypeScript, with [pi](https://github.com/badlogic/pi-mono) providing the model loop and tool execution.

Install Git, Node.js (24 recommended), and npm, then run in PowerShell:

```powershell
git clone https://github.com/Yu-DaTouX/yan--agent.git
cd yan--agent
npm install -g @earendil-works/pi-coding-agent
npm run launch
```

The launcher checks dependencies, prepares the bundled runtime when needed, and builds the app. Existing checkouts can also use `启动-砚.cmd`. For development, use `开发-砚.cmd` or `npm run launch:dev`.

Read the [workspace guidelines](AGENTS.md) before contributing. See the [engineering documentation](docs/README.md) for implementation and validation details, currently primarily in Chinese.

</details>

## License

[MIT](LICENSE) · © 2026 Yu-DaTouX. Third-party notices for fonts, icons, syntax highlighting, and the bundled pi runtime are retained in distributions.
