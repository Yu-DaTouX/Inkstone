# 语言与应用壳选择：以 Inkstone 当前代码为基准

[代码地图](CODE_MAP.md) · [架构简介](ARCHITECTURE.md) · [代码导览](PROJECT.md)

**结论（2026-09-28）：以个人开发者长期维护得动为首要约束，保留现有 TypeScript/React/pi 作为近期主线，首发只承担 Windows 桌面与 Android 手机参与的完整流程。** Rust、Go、Kotlin、Dart/Flutter 与 C#/.NET 按具体职责评估，不要求一个语言或界面覆盖所有设备。从扩展性看，最先需要解决的是任务、会话、事件和数据契约的归属。把 `index.ts` / `agent.ts` 的业务逐行翻译成另一种语言，仍会留下相同的耦合，并新增跨语言边界。此文是源码静态评估与技术选型建议，未创建候选原型，也没有做性能、包体或跨平台实测。

## 先按产品边界选语言

| 候选 | 当前适合承担的职责 | 对本项目的代价与判断 |
| --- | --- | --- |
| **TypeScript / Node.js**（现状） | Electron 宿主、pi RPC、共享契约、React 桌面 UI | 现有代码和生态可直接沿用，最快交付 Agent 能力；需拆分大控制器和状态机，不能靠继续堆代码解决维护问题 |
| **TypeScript + React Native** | 独立 Android 客户端；以后可扩到 iOS | 可复用语言、部分纯业务类型与 React 开发经验；桌面 DOM/CSS 和 Electron IPC 不能直接搬到手机，仍需原生权限、录音、文件与网络适配。[React Native TypeScript](https://reactnative.dev/docs/typescript) |
| **Rust** | 边界明确的本机服务、稳定数据处理或 Tauri 原生层 | 适合严格资源与并发边界；当前 pi/浏览器/终端仍需跨进程适配，全面改写成本高 |
| **Go** | 独立远程 Agent 网关、连接服务或跨平台后台进程 | 网络服务和单独可执行程序是合理候选；现有 React/Electron UI 与 pi 执行并不会因换 Go 自动复用或变简单。[Go 平台文档](https://go.dev/doc/install/source) |
| **Kotlin** | 首版 Android 客户端；日后可评估 Kotlin Multiplatform 共享移动端逻辑 | Android 原生集成有直接价值；重写现有桌面宿主会重复实现 Web UI、浏览器和终端。KMP 可选择性共享逻辑，不能假定与现有 TypeScript 业务零成本互通。[Kotlin Multiplatform 平台状态](https://kotlinlang.org/docs/multiplatform/supported-platforms.html) |
| **Dart / Flutter** | 独立 Android 客户端，未来需要统一移动/桌面界面时作为候选 | 多端 UI 能力明确，但意味着重做现有 React 界面和桌面原生集成；适合比较手机体验，不适合作为修复当前 Agent 内核的起点。[Flutter 平台支持](https://docs.flutter.dev/platform-integration) |
| **C# / .NET** | Windows 原生宿主或独立服务；MAUI 可评估手机端 | Windows 集成有吸引力，但改写现有宿主/React 仍需迁移。MAUI 官方覆盖 Windows、Android、iOS、macOS；Linux 桌面不是其正式目标。[.NET MAUI 支持平台](https://learn.microsoft.com/dotnet/maui/supported-platforms) |

Swift 可在以后做 iOS 原生客户端时单独考虑；Python 适合隔离的模型、文档或数据工具。它们都没有成为当前 Windows 宿主整体重写的充分理由。**语言、桌面壳和手机客户端框架是三项选择**：例如桌面仍用 TypeScript/Electron、手机用 Kotlin、将来独立服务用 Go 或 Rust，可以通过同一版本化任务协议协作，无需强求一个语言覆盖所有端。

就**第一版 Android 手机参与**而言，优先比较 Kotlin 原生与 TypeScript/React Native：前者更直接处理 Android 平台能力，后者与当前 React/TypeScript 团队及纯逻辑共享更接近。Flutter/Dart 可作为第三候选，前提是其独立 UI 工作量能换来明确的跨端收益。手机客户端主要查看电脑任务、回复问题和提交语音文字，不要求在手机重建 pi 执行核心。

## 个人开发者的多平台维护边界

这里的“支持某平台”有不同深度。首版 **Windows 桌面**承载 pi、文件、浏览器、终端和任务执行；**Android App**只需查看、回复和语音输入，任务仍由电脑执行。**Linux 主机**作为 SSH 等协议可连接的外部 Agent 是需求中的远期方向，2026-09-28 起暂不实施；它也不等于要维护 Linux 桌面发行包。iOS、macOS 与 Linux 桌面保留接口空间，等实际需求和设备条件明确后再交付。这个范围沿用需求稿中的已确认边界，而非要求一次维护五套完整客户端。

| 方案 | 复用点 | 个人开发者新增维护面 | 当前建议 |
| --- | --- | --- | --- |
| Electron Windows + React Native Android | TypeScript、React 经验、可共享的纯数据契约 | 第二套移动 UI、Android 权限/录音/文件、移动发布 | **首选评估**；手机能力较窄时，避免同时重做桌面 |
| Electron Windows + Kotlin Android | 任务协议与数据模型语义 | 第二套语言、构建链和 UI，但 Android 原生能力直接 | 当录音、后台连接或系统集成使 React Native 适配明显复杂时选 |
| Tauri 桌面 + Android 共用 Web 前端 | 部分 React 页面与业务展示 | 桌面壳迁移、pi sidecar、浏览器/终端替代，再叠加 Android 平台适配 | 有共享 UI 潜力；当前迁移成本先于收益，不作为首版捷径 |
| Flutter/Dart 重做桌面与手机 | 新建的统一 UI 体系 | 现有 React UI 与桌面原生能力需重做，新增语言和发布链 | 只有真实原型证明总维护成本更低才考虑 |

“一份 UI 跑所有端”不等于“只维护一端”：窗口、文件、权限、录音、输入方式、应用生命周期和发行包仍要分别处理。反过来，两套界面也不应复制任务状态机：桌面与手机通过**一个版本化任务协议**共享稳定 ID、命令、事件、断线恢复和授权语义；界面只实现本端需要的操作。优先保持协议与宿主服务可复用，而不是追求代码行数的表面复用。

新增平台时控制范围：先列出它需要的最小用户流程、必须独立实现的原生能力和可复用契约，再决定是否维护该端；对尚未交付的平台只保留数据格式与协议演进空间，不提前搭建完整壳、打包链或平台分支。Android 首版的技术比较应以一条真实流程为准：电脑执行任务 → 手机接收状态/问题 → 回复或录音转文字 → 电脑继续 → 手机查看成果。

## Rust 及桌面壳的具体可行性

| 范围 | 当前可行性 | 对未来扩展与维护的判断 |
| --- | --- | --- |
| 保留 Electron/React/pi，在独立 Rust 进程中承担少量稳定的宿主业务 | 可行，需先定义版本化协议和进程生命周期 | 当任务状态、同步或大量 I/O 有明确边界与实测收益时值得试；若只是增加一层转发，维护面反而扩大 |
| 将桌面壳改为 Tauri，保留 React，并把 pi 作为外部 Node sidecar | 技术路径存在，迁移成本高 | 需重做 preload/IPC、原生浏览器视图、终端、窗口行为和打包；不能由 Tauri 支持 Android 推断现有桌面功能可直接跨端 |
| 用 Rust 自研模型循环并替换 pi、Electron 和主要 TypeScript 业务 | 理论可做，当前依据不足 | 要重建 provider、工具、扩展、会话格式、取消/恢复、用户数据兼容与生态集成；会延缓已确认的 Agent 和 Android 功能 |

Tauri 官方支持把外部可执行程序作为 sidecar 打包，但每个目标架构需准备对应二进制；这只证明**可启动外部运行时**，不证明当前 pi 包、扩展和用户数据在新壳里即插即用。Tauri 2 支持桌面和移动端，移动端仍需要 Android SDK/NDK 与平台适配。[Tauri sidecar](https://v2.tauri.app/develop/sidecar/) · [Tauri 平台前置条件](https://v2.tauri.app/start/prerequisites/) · [Tauri 概览](https://v2.tauri.app/start/)

## 当前代码中会影响迁移的真实边界

1. **pi 执行核心。** `src/main/protocol.ts` 以 Electron 自带 Node 启动独立 pi RPC 子进程；`src/main/agent.ts` 将它的事件转为砚的运行与界面状态。换 Rust 宿主仍需提供兼容 Node 运行时、参数、环境、扩展加载和 JSONL RPC 的完整链路。保留 pi 可避免同时重写模型执行核心。
2. **桌面原生能力。** `src/main/browser.ts` 持有 `WebContentsView`，并处理视图覆盖、位置、缩放和 Chrome 连接；`src/main/terminal.ts` 使用 `node-pty`。替换 Electron 时需分别证明浏览器嵌入与控制、PTY、焦点、权限、下载和窗口协作的等价行为。[Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)
3. **会话与任务的身份。** `src/main/runners.ts`、`src/main/index.ts`、`src/renderer/src/state/session-runtime.ts` 已用 `sessionId/runId/generation` 区分持久会话、运行实例和代次。扩到手机或多 Agent，应先把这套身份与事件归属变成客户端无关的契约；语言不是这一问题的替代答案。
4. **业务与入口仍有耦合。** `src/main/index.ts` 承担大量 IPC 注册和任务调度，`src/main/agent.ts` 同时处理 RPC、事件、工具、界面状态和会话动作。先把业务从 Electron 入口抽出，才便于比较 Rust 服务、Tauri 壳或 Android 客户端各自接入的成本。
5. **持久数据不能只复制文件。** `src/main/paths.ts` 区分 pi、砚、Electron 及便携版目录；项目知识、上下文投影和会话 JSONL 有不同事实源。迁移需保持旧数据可读、旧会话可继续，并明确备份和失败回退。

## 面向未来的建议路线

1. **先整理语言无关的业务契约。** 明确任务、会话、运行实例、事件序号、状态恢复、权限和数据归属；让桌面 IPC 与现有可选远程入口调用同一业务服务。`src/main/remote-server.ts` 已有有限的会话命令与事件筛选，可作边界参考，但不是完整手机或跨用户授权接口。
2. **保留 React、Electron 与 pi，先拆高耦合职责。** 任务调度从 `index.ts` 移出；`AgentController` 保留 pi 适配并逐步移出独立业务；渲染端沿已有 `session-runtime.ts` 收紧身份投影。这一步本身会提高扩展性，也给 Rust 迁移提供稳定接口。
3. **只在有明确瓶颈时验证 Rust 模块。** 候选是可独立运行、输入输出明确的任务/同步服务或需要跨平台原生实现的能力。原型须证明生命周期、数据兼容、错误恢复、Windows 与 Android 集成，并与 TypeScript 方案比较实际维护工作量；不以“Rust 更快”作为未经测量的前提。
4. **若评估 Tauri，先验证最难替代的桌面流程。** 在隔离原型里串起 pi sidecar、一条真实会话、终端和内置浏览器，再看 Android 的查看/回复/语音流程。Tauri 可以复用 Web 前端方向，但系统 WebView 与 Electron 的 Chromium/`WebContentsView` 行为不同，尤其要核对浏览器控制与布局。[Tauri 架构](https://v2.tauri.app/concept/architecture/) · [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)

**决策条件：** 只有当某个新语言模块或应用壳在真实流程中降低了总维护成本、满足现有桌面能力并保住旧数据，才把它提升为迁移方案。Windows + Android 的产品目标也可以通过桌面运行服务与独立手机客户端实现，未要求两端共用同一个语言或原生壳。
