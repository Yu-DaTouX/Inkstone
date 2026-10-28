# 第三方许可

砚本身以 [MIT](LICENSE) 发布。本文件登记**随分发保留**的第三方组件及其许可，只做索引，不替代各组件原始许可文本。

## 图标

- 桌面端界面图标使用 [Lucide](https://lucide.dev)（ISC，npm 包 `lucide-react`）。
- Android 应用的图标是本仓库自绘的「砚线」，随砚以 MIT 发布，不含第三方几何。几何写在 [`scripts/design/icons/inkline.json`](scripts/design/icons/inkline.json)，语义写在 [`catalog.json`](scripts/design/icons/catalog.json)，由 `npm run icons` 生成 `src/renderer/src/icons/sprite.ts`，由 `mobile/src/icons.tsx` 引用。
- 更早的版本使用过 `lucide-static`（ISC）与 [reicon](https://reicon.dev)。分发这些旧版本时，其许可声明仍随对应版本保留。
- 文件类型图标在 [`src/renderer/src/assets/file-icons/`](src/renderer/src/assets/file-icons/)。语言、工具与品牌类的标志取自 [Simple Icons](https://simpleicons.org) 16.35.0（项目整体 CC0-1.0，未作为依赖安装），只缩放到 16 网格并按深浅主题调整品牌色；文档类（文本、PDF、Word、幻灯片、表格、字体、图片、音视频、压缩包、数据库、锁文件等）以及 Vue、VS Code、PostCSS、Java、C#、PowerShell、Sass 为本仓库自绘，随砚以 MIT 发布。以下标志在 Simple Icons 中另有单独许可，对应 SVG 文件继续适用该许可：
  - CC0-1.0：TypeScript、React、Python、Go、HTML5、CSS、Swift、Svelte、Astro、GraphQL、WebAssembly、Terraform、Docker、npm、Bun、Vite、ESLint、Prettier、Biome、Oxc、Babel、stylelint、Tailwind CSS、SVGO、Model Context Protocol、Claude、C、C++、Kotlin、Lua、Dart、TOML、YAML、pnpm、Node.js、Gradle、CMake、.ENV、GitHub Actions、NGINX、Prisma、Jest、Vitest、Elixir、Erlang、Haskell、Scala、Perl、Julia、Jupyter、Electron、Next.js、Turborepo、Vercel、Netlify、Cypress、esbuild、Nx、Markdown
  - MIT：JavaScript（logo.js）、Bootstrap、Deno、Storybook
  - CC-BY-3.0：Git（Jason Long）
  - CC-BY-4.0：Yarn、Solidity、Angular
  - CC-BY-SA-2.5：Ruby
  - CC-BY-SA-4.0：Rust、Zig、PHP、R
  - webpack：按 [OpenJS 商标政策](https://js.foundation/about/governance/trademark-policy) 使用
- 上述标志的商标归各自所有者，砚仅用它们标识文件类型，不表示任何关联或认可。

## 子代理模型 Bot

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| [Lobe Icons](https://github.com/lobehub/lobe-icons)（npm 包 `@lobehub/icons-static-png@1.97.0`） | MIT | 模型 logo 源图在 [`assets/lobe-icons/`](assets/lobe-icons/)（附原许可 `LICENSE`），由 `scripts/gen-bot-forms.mjs` 预先算出外沿、色场与小图，写入 `src/renderer/src/patterns/model-bot/bot-forms.json`；通知用的 `resources/bot-icons/` 由 `scripts/gen-bot-icons.mjs` 按同一套形体渲染；各 logo 的商标归其厂商所有 |
| [agent-hud-open](https://github.com/jazzenchen/agent-hud-open) | Apache-2.0 | Bot 形体与动作算法及各品牌参数移植自其 `Sources/AgentHUDDesktop/Bots/`（`BotForm`、`BotRenderer`、`BotFins`、`BotState` 等），许可原文见 [`src/renderer/src/patterns/model-bot/LICENSE-agent-hud-open`](src/renderer/src/patterns/model-bot/LICENSE-agent-hud-open)；未使用其 Clawd 像素精灵 |

## 随包技能

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| [Anthropic Agent Skills](https://github.com/anthropics/skills)（提交 `dbd4588`）：`frontend-design`、`theme-factory`、`canvas-design`、`algorithmic-art` | Apache-2.0 | 原样收录在 `resources/skills/artifact/official/`，各目录附原许可 `LICENSE.txt`；未收录 `theme-showcase.pdf` 与 `canvas-fonts/`。在砚里的用法差异写在 `resources/skills/artifact/SKILL.md`，官方文件本身未修改 |
| [OpenAI Codex](https://github.com/openai/codex)（提交 `c2d5ea52`）系统提示中的「Frontend tasks」段落 | Apache-2.0 | 原文摘录在 `resources/skills/artifact/official/openai-codex-frontend/`，附原许可 |
| [open-design](https://github.com/nexu-io/open-design)（提交 `e03d5c23`）：`craft/` 设计规则与 `apps/daemon/src/lint-artifact.ts` 检查规则 | Apache-2.0；部分 craft 内容由 open-design 改编自 [refero_skill](https://github.com/referodesign/refero_skill)（MIT，© 2026 Refero） | 10 份 craft 原文收录在 `resources/skills/artifact/official/open-design-craft/`，附 `LICENSE`、`LICENSE-refero_skill` 与 `SOURCE.md`，文件本身未修改；`src/main/artifact-lint.ts` 按其检查规则改写（删去 open-design 专属规则、改成中文提示、网络资源检查扩到脚本/样式/字体），由 `yan artifact preview` 返回 |
| [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines)（提交 `434b7f91`） | MIT | 原文 `AGENTS.md` 在 `resources/skills/artifact/official/vercel-web-interface-guidelines/`，附原许可 |
| [three.js](https://threejs.org)（npm 包 `three@0.186.1`，含 `TextGeometry`、`FontLoader`、`RoomEnvironment` 附加模块）与 three.js 仓库 `r186` 的 `helvetiker_bold.typeface.json`（MgOpen 字体） | three.js：MIT；字体：MgOpen 许可（允许随软件分发，需保留版权与许可声明） | 由 `scripts/vendor-three.mjs` 打包为 `resources/skills/artifact/vendor/three.min.js`，许可原文在同目录 `LICENSE-three.txt`、`LICENSE-mgopen-fonts.txt`；成果页写 `<script data-yan-lib="three"></script>` 时由砚内联 |

## 其它运行时组件

| 组件 | 许可 |
| --- | --- |
| React / React DOM / Zustand / CodeMirror 6 / mermaid / xterm.js 等 npm 依赖 | 各自包内声明（多为 MIT） |
| React Aria Components（`react-aria-components`） | Apache-2.0 |
| [PDF.js](https://mozilla.github.io/pdf.js/)（npm 包 `pdfjs-dist`，文件预览里的 PDF 渲染） | Apache-2.0 |
| [ProseMirror](https://prosemirror.net)（`prosemirror-model` / `-state` / `-view` / `-commands` / `-keymap` / `-history`，输入框编辑器） | MIT |
| highlight.js（经 `lowlight`、`rehype-highlight` 使用） | BSD-3-Clause |
| KaTeX（含其字体，经 `remark-math`、`rehype-katex` 按需加载） | MIT |
| qrcode.react | ISC |
| tar | BlueOak-1.0.0 |
| Maple Mono CN（`@mogeko/maple-mono-cn`） | 见包内声明 |
| node-pty | 见包内声明 |
| 内置 pi 运行时（`resources/pi-runtime/`） | 见上游项目声明 |
| electron-updater | MIT（见包内声明） |
| [ego-lite](https://github.com/citrolabs/ego-lite)（`package/ego-browser/src` 的 `driver/keyboard`、`driver/page-keyboard`、`driver/scroll-motion`，提交 `aecc583`） | MIT，内置浏览器驱动 [`src/main/browser/driver/`](src/main/browser/driver/) 移植自这些文件，许可原文见 [`LICENSE-ego-lite`](src/main/browser/driver/LICENSE-ego-lite)；ego lite 浏览器本体不随砚分发 |

[Browser Cookie Bridge](https://github.com/apoorvdarshan/browser-cookie-bridge) 的 `extension-template/background.js`（来源 Cookie 采集与字段映射）及 `src/broker.js`（Bearer 认证、本地 HTTP 桥接）以 MIT 许可适配到 `resources/browser-cookie-bridge/` 和 `src/main/browser/cookie-bridge.ts`。Copyright (c) 2026 Apoorv Darshan。许可原文见 [`resources/browser-cookie-bridge/LICENSE`](resources/browser-cookie-bridge/LICENSE)。砚移除了定时同步、历史记录和目标扩展通道，仅保留用户触发的一次性本机导入。

## 按需下载的组件

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| [Git for Windows](https://gitforwindows.org/)（PortableGit） | GPL-2.0 及其所含组件各自的许可 | **不随安装包分发**。用户在设置或引导里确认后才从官方发布页（或 npmmirror 镜像）下载，校验 SHA-256 后解压到数据目录，仅在没有系统 Git 时使用；源码与许可见官方发布页与包内 `LICENSE.txt` |
| [open-design](https://github.com/nexu-io/open-design)（设计系统目录 `design-systems/<id>/`） | Apache-2.0 | **不随安装包分发**。用户点名某个设计系统或随包风格牌不够时，`yan artifact style --remote <id>` 才从该仓库固定提交 `61ab0f2a` 按需下载该系统的 `DESIGN.md` 与 `tokens.css` 到砚数据目录 `design-systems/<提交前 12 位>/<id>/`，同目录写入 `NOTICE.txt` 记录来源仓库、提交与许可；内容只作设计参考读取，不执行 |

## Android 应用

随 APK 分发：

| 组件 | 许可 |
| --- | --- |
| React Native / Hermes | MIT |
| AndroidX（`window` / `activity` / `camera:*`） | Apache-2.0 |
| ML Kit 条码扫描（`com.google.mlkit:barcode-scanning`） | Google ML Kit 条款（见包内声明） |

完整许可文本随各自分发包一起保留；升级依赖时请同步核对本表。
