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
2. Choose a provider and sign in from the app or configure API credentials. CC subscription access requires Claude Code sign-in on this computer first, followed by the plugin installation entry on this page.
3. Choose an available model and thinking level below the input area.

A local profile name or avatar is for personalization and does not indicate a signed-in model account. Requests to remote models are sent to your selected provider.

## Start a task

Choose a project or start a conversation. Describe what you want to accomplish and provide relevant material. For example:

> Read this project's README, outline the page structure, and suggest what needs improvement.

Reference files with `@`, explore commands with `/`, or enter a Shell command with `!`. Expand tool details to inspect the work, or open files, change review, the browser, and the terminal from the workspace panels.

## HTML artifacts in messages

The desktop app displays managed `.html` / `.htm` artifacts as web pages inside their message cards, including interactive diagrams and single-file reports. Use **Page / Source** to switch views. Download, source preview, file location, and copy-path actions remain available.

This is an isolated offline preview, not a full browser. Inline scripts, styles, and embedded images are supported; network resources, adjacent local files, popups, form submissions, fullscreen, and page-initiated exports are blocked. The page controls its own theme. The limit is 5 MiB, and ordinary HTML code blocks are not executed. If an attempted navigation leaves the preview unavailable, switch to **Source** and back to **Page** to reload it.

## Codemode tool calls

Open **Settings → Capabilities & plugins → Codemode** to turn it on or off. It is enabled by default, and changes apply from the next conversation turn. The Agent can batch tool calls and process results in scripts while retaining direct tool calls. Read-only subagents retain their execution restrictions. Legacy plan mode has left the default workflow.

Codemode uses native pi capabilities, rather than adding a work mode. It is unavailable with an older pi or an explicitly disabled native Codemode extension.

The model menu supports provider filters, search, shared favorites and pagination. Starring a model does not select it. New conversations use the last successfully selected main model; existing conversations keep their own model. Thinking strength and response detail expand at the bottom, retaining the animated slider. An unavailable remembered model is not silently replaced; a failed initialization offers an explicit preference reset and reconnect.

## Conversations and subagents

The development build is conversation-first. Coding/daily and standard/plan/autonomous switches, spaces, library, and dedicated writing/learning pages have left the default UI. Historical data is retained. Writing, explanations, learning, and file work remain possible in normal conversations. Asking a model to plan first is a conversation instruction, not a host-enforced read-only plan mode.

Open **Subagents** from the tools menu, select a model, enter a task, and choose execution. The panel remembers its own last selected model, initially using the current conversation. An explicit follow option resolves to the current conversation model; the form shows the actual model and working folder. Results return to the parent conversation. Current-folder execution changes files directly; read-only limits tools; optional Git worktree isolation requires Git. CC subscription models do not support read-only subtasks; unsupported combinations are explained before submission.

Messages entered during a run wait for your choice to steer or queue. Stop ends the current run. Switching conversations does not stop background work. Files, browser, terminal, and subagent details open on demand and retain their owning conversation in split views.

## Plugins and remote access

**Settings → Plugin market** has Inkstone and pi pages. Inkstone currently offers the Hermes plugin; exporting it does not install or pair it. The pi page supports package search, installation, updates, and removal, without guaranteeing graphical compatibility. See the [plugin market](PLUGIN_MARKET.md).

The Android client remains in testing and connects to a running computer for conversations, messages, questions, and artifacts. Sensitive approvals in the Android app can only be denied; allow them on the computer. The independent Hermes plugin provides explicit user allow/deny commands after separate installation and pairing. Ordinary model answers cannot grant approval. macOS/Linux/iOS are not delivered; automatic cross-device sync is not provided. See [mobile access](MOBILE_ACCESS.md).

## Session switcher (Ctrl+K)

Press `Ctrl+K` anywhere, whether or not the sidebar is open. Type a few words to search session titles, project names and **conversation text** at once (every word must appear); a snippet of the match is shown. Arrow keys select, Enter opens, `Esc` closes. With no input it lists recent sessions, so Enter takes you back to the previous one.

The text index lives only in memory and is built from the local session files (pi JSONL); nothing is uploaded. When a terminal has focus, `Ctrl+K` is left to the shell.

## Checkpoints and Rewind code

Before each new turn, Inkstone saves a snapshot of the project folder in a shadow git repository under the data folder (unrelated to the project's own `.git`), kept for 30 days on this machine only. When “Rewind code” appears under a user message, it first lists which files will be modified, removed or restored, and only acts after you confirm. The current state is saved first, so the dialog offers “Undo this rewind”.

- The conversation is unchanged; use “Branch” on the same row to go back in the conversation too.
- Changes made by shell commands are covered, not only edit/write tools; files ignored by `.gitignore` and `node_modules` are untouched.
- Skipped for the home folder or more than 30,000 files; turn it off under **Settings > Capabilities and plugins > Checkpoints**.
- Moving the data folder (Settings > About) carries the checkpoints along with the session files (the JSONL under `sessions/`).

## Two permission modes

The selector beside the conversation input shows the current mode and applies to all conversations and ordinary subagents:

- **Dangerous-operation approval**: routine actions run directly; recognized dangerous actions ask for approval.
- **Native mode**: Inkstone adds no approval or interception. pi, providers, external tools, and the operating system retain their own behavior.

Approval cards identify their source conversation, subagent, and folder, with a source link when available. Unresolved sources are labeled as unknown. WAIT means a response is needed; other tasks may still be running. These guardrails are not a sandbox or a task-level permission system. AskClaude executes inside CC and receives whole-delegation approval in dangerous mode. Use an Inkstone subagent with a claude-bridge model when approval should inspect individual pi tool operations.

## Computers without Git

Change review, worktrees, subtask isolation, and checkpoints need Git, and the command-line tool needs Git Bash on Windows. If Git is missing, Inkstone prompts after startup and offers a one-click **Install Git**. After you confirm, it downloads PortableGit (about 57 MB) from the official release page (the Chinese interface tries a mainland China mirror first), verifies it, and unpacks it into Inkstone's data directory. It does not open an installer wizard, needs no administrator rights, and does not change the system PATH. If Git is already installed, Inkstone uses it first and does not overwrite it.

Inkstone still works without Git. The command-line tool falls back to the PowerShell that ships with Windows, and the model writes commands in PowerShell syntax, but change review, worktrees, and checkpoints remain unavailable.

## Everyday shortcuts

| Action | Shortcut or location |
| --- | --- |
| Send / new line | `Enter` / `Shift+Enter` by default; configurable in settings |
| File reference / command | `@` / `/` |
| Two permission modes | Selector beside the input; applies to all conversations |
| Model and thinking level | Selectors below the input area |
| Switch session (search titles and conversation text) | `Ctrl+K` |
| Rewind project files to before a message | “Rewind code” under a user message |
| Peek at the sidebar when it is collapsed | Hover the toggle at the top-left of the title bar |
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
