# 界面重构计划 · 终端风格（v0.5）

[文档索引](README.md) · [设计规范](DESIGN_SYSTEM.md) · [品牌规范](BRAND.md) · [代码地图](CODE_MAP.md)

状态：**P0 已定案**（2026-09-28），下一步 P1。视觉方向、状态栏、图标、动效与手机端规则已写入[设计规范 v0.5](DESIGN_SYSTEM.md)；本文只记录范围、界面清单、分阶段路线、进度与仍待决定的事项。

原型源码：[`scripts/design/terminal-preview/`](../scripts/design/terminal-preview/README.md)（工作台演示、组件与令牌、动效规范、图标规范四块画板）。图标几何：[`scripts/design/icons/inkline.draft.json`](../scripts/design/icons/inkline.draft.json)。

## 1. 目标与边界

- **风格延续**：保留 v0.4 的墨色工作空间、内容优先、单一靛蓝强调、色阶表达层级；在此之上加入现代终端的气质。
- **结构先行**：先把样式收拢到令牌、控件层和级联层，再改视觉。结构到位后，视觉调整基本只动 `tokens.css` 与 `ui.css`。
- **全部界面**：重构覆盖第 3 节清单里的每一个桌面界面与 Android 手机端页面，不只是工作台主画面。清单是验收范围：每一项在 P5 / P6 结束时都要有深浅主题截图。
- **不改的**：品牌标志 `build/prompt-stone.svg` 的路径、线宽与比例；深浅双主题；键盘可达与窄屏可读；现有检查脚本的约束；手机端的连接、分页与提醒行为。
- **平台**：Windows 桌面端与 Android 手机端。iOS、macOS 与 Linux 桌面不预建空壳。

## 2. 定案摘要（详见设计规范）

| 待决项 | 决定 | 规范位置 |
| --- | --- | --- |
| 骨架字体 | 骨架等宽（Maple Mono CN），对话正文与页标题无衬线 | §2.2 |
| 底部状态栏 | 新增；输入区下方用量条并入状态栏后移除；不重复模型档位与上下文 | §4 |
| `Ctrl K` 命令面板 | 不新增；现有 `/` 命令菜单按命令面板样式改版 | §3.6 |
| 图标 | 采纳「砚线」；桌面 1.25px、手机 1.5dp，附可读性规则 | §3.4、§7 |
| 强调色 | 保持靛蓝 | §2.1 |
| 环绕流光 | 只在运行超过 3 秒后出现 | §6 |
| 位移上限 | 6px → 4px | §6 |

## 3. 界面清单

按用户看到的界面列出，括号内是主要源码。行数为 2026-09-28 测量。

### 3.1 桌面端（`src/renderer/src/`）

| 区域 | 界面 | 主要源码 |
| --- | --- | --- |
| 外壳 | 标题栏、品牌标志、原生层桥接 | `shell/TitleBar`、`shell/BrandMark`、`shell/UiBridge` |
| 外壳 | 状态栏（新增） | 待建，取代 `chat/UsageBar` |
| 左栏 | 新对话与搜索、置顶 / 最近、项目与会话树、待我处理、用户区、右键菜单 | `rail/Rail`（1983 行）、`rail/RailUser`、`common/ContextMenu` |
| 对话 | 会话头、空状态、回合、用户消息、助手正文、推理、工具行与详情、子代理说明、交接与延续说明、提问面板、学习操作、对话大纲 | `chat/SessionHeader`、`EmptyStream`、`TurnView`、`MessageParts`、`Reasoning`、`ToolRow`、`ToolDetails`、`SubagentNote`、`HandoffNote`、`Continuity`、`QuestionPanel`、`LearningActions`、`ConversationOutline` |
| 输入区 | 输入框与边框、运行条、`/` 命令菜单、`@` 文件菜单、模型与思考档位、语音输入 | `chat/Composer`（1882 行）、`ComposerBorder`、`slash-query`、`at-query`、`Pickers`、`VoiceInputButton` |
| 右栏检查器 | 任务、上下文、额度、文件树与预览、队列、目标、工具分区、浮出磁贴、拖动预览、开始页、工作对象条 | `toolbar/RightPanel`（2839 行）、`GoalSection`、`GoalPopover`、`FileTree`、`FilePreview`、`FloatingTiles`、`DragPreview`、`StartPage`、`WorkObjectBar`、`ToolSection` |
| 工作台 | 工作台首页、空间概览与空间工作台、任务收件箱、资料库、成果查看、会话地图与预览、跟随面板 | `workbench/*` |
| 审查 | 审查面板、改动文件树、差异查看、提交条、环境与来源菜单、Office 内容 | `review/*` |
| 内嵌表面 | 浏览器、终端 | `browser/BrowserSurface`、`terminal/TerminalSurface`、`chat/Terminal` |
| 设置 | 模型接入、外观、工作区、上下文、知识、能力、声音提示、状态、能力包、语音、手机接入、砚互联、关于；自定义模型表单、授权同意、活动模型 | `settings/*` |
| 引导与对话框 | 首次引导、砚互联批准对话框、通用对话框 | `settings/Onboarding`、`shell/PeerApprovalDialog`、`styles/dialog.css` |
| 兜底 | 错误边界 | `ErrorBoundary` |
| 主进程页面 | 模型登录回调页 | `src/main/oauth.ts` |
| 安装与品牌 | 安装器侧栏与页眉位图、应用图标 | `scripts/build-installer-sidebar.mjs`、`build/` |

### 3.2 Android 手机端（`mobile/src/`）

| 界面 | 主要源码 |
| --- | --- |
| 配对（扫码 / 手动输入） | `screens/PairScreen` |
| 工作台首页：待回答、活动会话、项目、最近会话、搜索 | `screens/HomeScreen` |
| 会话：消息、工具折叠、运行条、输入栏、模型选择、语音输入 | `screens/SessionScreen`（423 行）、`components/MessageBody`、`ModelPicker`、`SpeechInputButton` |
| 提问卡片 | `components/QuestionCard` |
| 成果查看 | `screens/ArtifactScreen` |
| 设置与待回答提醒 | `screens/SettingsScreen` |
| 宽屏 / 折叠屏双栏 | `App`、`foldLayout` |
| 系统通知（常驻与提醒） | `android/…/QuestionAlertService.kt` |
| 共用：令牌、控件、动效、图标、品牌 | `theme`、`ui`、`motion`、`icons`、`brandMark` |
| 启动图标 | `android/app/src/main/res/mipmap-*` |

## 4. 现状（2026-09-28 测量）

| 指标 | 数值 | 说明 |
| --- | --- | --- |
| 样式文件 | 21 个，约 2 万行 | `tools.css` ≈ 4000 行，`chat.css` ≈ 2200 行 |
| 按历史命名的层 | `stage1.css`、`redesign.css` | 早加载、被后续文件覆盖；归属靠 import 顺序 |
| 散落像素值 | 2042 个，1464 个有同值令牌 | 无令牌的高频值：`5px` ×113、`10px` ×100、`18/20/22/26px` |
| 统一控件使用 | `components/ui` 被 3 个 tsx 引用 | 另有 158 处直接写 `className="btn…"` |
| 模块私有控件 | 约 25 种 `*-btn / *-chip / *-tab` | 如 `.set-chip`、`.rp-stage-chip` |
| 超大组件 | `RightPanel` 2839 行、`Rail` 1983 行、`Composer` 1882 行 | |
| 图标 | `catalog.json` 61 个语义，全部 Lucide | 12px 是最常用尺寸；手机端解析同一份 sprite |
| 手机令牌 | `mobile/src/theme.ts` 手抄桌面色值 | 目前靠人工同步，没有检查 |

数据来源：`npm run measure:css` 生成的 `scripts/design/CSS-*.md`，以及对源码的静态统计。

## 5. 结构重构

| 步骤 | 做法 | 完成标准 |
| --- | --- | --- |
| 级联层 | `@layer tokens, base, ui, layout, modules, overrides;`，覆盖关系由层决定 | 不再依赖 import 顺序；`stage1.css`、`redesign.css` 按内容拆回归属文件后删除；`npm run lint:layers` 证明最终生效声明不变 |
| 令牌补缺 | `5px`→4/6、`10px`→8/12 按规则归并；新增 `--ctl-h-xs: 20px`、浮层与菜单宽度令牌；已有同值令牌的裸值批量替换 | `measure:css` 散落值只降不升 |
| 手机令牌同源 | 检查脚本比对 `tokens.css` 与 `mobile/src/theme.ts` 的同名色值 | 不一致即失败，接入 `npm run check` |
| 控件层 | `components/ui` 补 `Menu`/`Popover`、`Tabs`、`Field`/`Input`/`Select`、`SettingRow`、`InspectorSection`、`ListRow`；每个先写进规范 §3 | 模块私有 `*-btn/*-chip/*-tab` 清零；`className="btn…"` 改用组件 |
| 组件拆分 | `RightPanel` 按检查器分区拆文件；`Rail`、`Composer` 拆出行与工具条 | 单文件体量明显下降，行为不变 |
| 防回退 | 散落值数、模块私有控件类数、`!important` 数记基线，接入 `npm run check` | 只允许下降 |

## 6. 分阶段路线

| 阶段 | 内容 | 检查 | 进度 |
| --- | --- | --- | --- |
| P0 规范 | 待决项定案，写入 `DESIGN_SYSTEM.md` v0.5；界面清单 | 文档评审 | 完成 |
| P1 结构 | 级联层、拆历史层、令牌补缺、手机令牌同源检查 | `typecheck`、`lint:css`、`lint:layers`、`check:css-docs`、视觉矩阵截图无差异 | 下一步 |
| P2 控件 | 扩充 `components/ui`，先迁设置页，再迁工作台、审查与右栏 | 同上 + 设置相关 `test:live` | |
| P3 动效 | `grow`、`spin`、`caret`、`orbit`、滑块、交叉淡变入 `motion.css` 与组件；位移上限 4px；手机 `motion.tsx` 同步 | `check:motion` + 实机录屏 | |
| P4 图标 | 砚线接入生成链；补齐未画语义；桌面与手机同时切换 | `icons`、`check:icons`、`check:shell-icons`；12/14px 可读性对照图 | |
| P5 桌面视觉 | 按第 3.1 节逐区：外壳与状态栏 → 左栏 → 对话与输入区（含 `/` 菜单）→ 右栏 → 工作台 → 审查 → 设置、引导与对话框 → 浏览器、终端与兜底页 → 登录回调页与安装器 | 全量 `npm run check`；深浅主题 × 1440×900 / 940×620 / 900×520 截图 | |
| P6 手机视觉 | 按第 3.2 节逐页：配对 → 首页 → 会话 → 成果 → 设置 → 通知；宽屏与折叠屏双栏 | `mobile` 下 `npm run typecheck`；深浅主题 × 手机竖屏 / 折叠屏展开实机截图 | |

每阶段单独提交；视觉结论以实际截图为准，构建、静态检查、运行与截图证据分别说明。云端容器没有 Windows 字体与 Android 设备，那里产出的截图只作同环境前后对比，Windows 与实机截图由维护者复核。

## 7. 仍待决定

1. **检查器分区编号**（`01…05`）与**上下文方格条**（25 格，系统 / 对话 / 工具三色）：在 P5 右栏改版时用截图比较后决定。
2. **手机端字体**：在 APK 内嵌 Maple Mono CN 子集（统一观感，增加安装包体积），还是继续用系统等宽字体。在 P6 前决定。
3. **未画图标**：`learn`、`dashboard`、`dock`、`home`、`tile`、`compare`、`pull-request`、`library`、`group`、`audio`、`message-dots` 的砚线几何，在 P4 补齐并按可读性规则验收。

## 8. 原型的已知限制

- 画布无法加载随包的 Maple Mono CN，等宽回退为 JetBrains Mono + Noto Sans SC，汉字未严格落在 1:2 栅格上。
- `@property` 角度动画与 `grid-template-rows` 过渡在 Electron 的 Chromium 中可用，但尚未在应用内实测。
- 原型数据（会话、文件、数字）为演示用途，不代表真实运行结果。原型状态栏中的模型档位与上下文百分比已按定案去掉。
