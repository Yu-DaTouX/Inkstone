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

## Everyday shortcuts

| Action | Shortcut or location |
| --- | --- |
| Send / new line | `Enter` / `Shift+Enter` by default; configurable in settings |
| File reference / command | `@` / `/` |
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

Backups can contain API credentials, private conversations, and browser state. Keep them private and do not upload them to public repositories or issues. Automatic cross-device sync is not provided.

## Get help

Open an [issue](https://github.com/Yu-DaTouX/Inkstone/issues) with your app version, Windows version, reproduction steps, and relevant errors. Remove credentials and private content from screenshots and logs.
