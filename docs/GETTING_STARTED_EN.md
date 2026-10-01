# Get started with Inkstone

[Home](../README_EN.md) · [中文](GETTING_STARTED.md)

## Install and launch

Choose a Windows package from [GitHub Releases](https://github.com/Yu-DaTouX/Inkstone/releases). Read that version's release notes; features and screenshots on the development branch may be newer than the release.

| Package | Launch | Best suited for |
| --- | --- | --- |
| Installer | Run `*-setup.exe` and follow the wizard | Your regular computer |
| ZIP | Extract `*-portable-fast.zip` and run `砚.exe` | Running without installation |
| Single-file portable | Run `*-portable.exe` | Carrying the app with its adjacent data folder |

Packages include the pi runtime, so you do not need to install Node.js or pi. Configure a model provider separately; its limits and charges apply. Packages are currently unsigned. Download from this repository's release page and check the supplied `SHA256SUMS.txt`.

## Connect a model

1. Open **Settings → Model access**.
2. Configure the required credentials or subscription login. Choose a provider and sign in directly from the app, or configure API credentials. No terminal login is required.
3. Choose an available model and thinking level below the input area.

A local profile name or avatar is for personalization and does not indicate a signed-in model account. Requests to remote models are sent to your selected provider.

## Start a task

Choose a project or start a conversation. Describe what you want to accomplish and provide relevant material. For example:

> Read this project's README, outline the page structure, and suggest what needs improvement.

Reference files with `@`, explore commands with `/`, or enter a Shell command with `!`. Expand tool details to inspect the work, or open files, change review, the browser, and the terminal from the workspace panels.

## Codemode tool calls

Open **Settings → Capabilities & plugins → Codemode** to turn it on or off. It is enabled by default, and changes apply from the next conversation turn. The Agent can batch tool calls and process results in scripts while retaining direct tool calls. Plan mode and read-only subagents keep their execution restrictions.

Codemode controls tool execution independently of the title bar's coding/daily mode. It uses native pi capabilities and is unavailable with an older pi or an explicitly disabled native Codemode extension.

## Daily mode

The switch at the left of the title bar toggles between **coding mode** and **daily mode**. Daily mode organizes the app around a few long-running topics:

- **Workbench home**: start a conversation and return to recent ones.
- **Topic spaces**: group conversations by topic instead of by project folder. Each space has overview, library, and artifacts views.
- **Library and artifacts**: imported material (text or files) becomes a source you can cite. Artifacts are editable documents with versions and checklists; they export to Markdown and can be handed to the tutor to learn from.
- **Learning**: say what you want to learn in the conversation. The tutor checks what you already know, explains step by step, asks questions and waits for your answer, and gives hints before answers. Courses, exercises, and notes from earlier versions are kept as a readable copy in `learning-export/` in the data folder.
- **Session map**: conversations and their branches are laid out per workspace lane. Expanding a session shows one card per exchange, and you can branch from a specific exchange.

All of it stays on this machine and can be exported or removed at any time. When something needs network access, an installed capability, or sending data outward, Inkstone explains the path first instead of doing it for you.

## Everyday shortcuts

| Action | Shortcut or location |
| --- | --- |
| Send / new line | `Enter` / `Shift+Enter` by default; configurable in settings |
| File reference / command | `@` / `/` |
| Coding / daily mode | Mode switch at the left of the title bar |
| Model and thinking level | Selectors below the input area |
| Zoom | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` (automatic) |
| Language and theme | Appearance settings |

Switching sessions does not actively stop running tasks. Use the stop action in the relevant session when needed.

## Data and backups

Default locations, unless you have configured overrides:

| Version | Sessions and model credentials | App settings |
| --- | --- | --- |
| Single-file portable | `砚数据/pi-agent/` beside the EXE | `砚数据/yan/` beside the EXE |
| Installer / ZIP | `.pi/agent/` in your user directory | `.pi/agent/yan/` in your user directory |

For the single-file portable version, close the app and back up the entire adjacent `砚数据/` folder. For installed and ZIP versions, back up `.pi/agent/` in your user directory. Browser logins and other Electron state are stored separately in the app data directory and are not included in that session backup. Full directory details are in [packaging and data](dev/RELEASING.md).

**Moving to another disk**: Installed and ZIP versions can pick an empty folder in **Settings → About → Data location**. On the next start the app moves the whole data directory there and leaves a directory junction in the old location, so existing sessions and `pi` in your terminal keep working. The original directory is deleted only after the copy is verified; if anything fails the app rolls back. The single-file portable version and test environments cannot be moved.

**App updates**: Settings can check for a new version. With the installed version you confirm the restart after the download finishes; installation is refused while a task is running. The portable version only links to the release page.

Backups can contain API credentials, private conversations, and browser state. Keep them private and do not upload them to public repositories or issues. Automatic cross-device sync is not provided.

## Get help

Open an [issue](https://github.com/Yu-DaTouX/Inkstone/issues) with your app version, Windows version, reproduction steps, and relevant errors. Remove credentials and private content from screenshots and logs.
