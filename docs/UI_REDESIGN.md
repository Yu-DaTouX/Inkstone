# 界面重构计划 · 终端风格（v0.5 草案）

[文档索引](README.md) · [设计规范](DESIGN_SYSTEM.md) · [品牌规范](BRAND.md) · [代码地图](CODE_MAP.md)

状态：**草案**（2026-09-28）。本文记录界面重构的目标、原型结论与分阶段路线，尚未实现。按[设计规范](DESIGN_SYSTEM.md) §9「先改规范再改代码」，下文每个决定在采纳时写入 `DESIGN_SYSTEM.md`，本文随之收缩为路线与进度说明。

原型源码：[`scripts/design/terminal-preview/`](../scripts/design/terminal-preview/README.md)（工作台演示、组件与令牌、动效规范、图标规范四块画板）。图标几何：[`scripts/design/icons/inkline.draft.json`](../scripts/design/icons/inkline.draft.json)。

## 1. 目标与边界

- **风格延续**：保留 v0.4 的墨色工作空间、内容优先、单一靛蓝强调、色阶表达层级；在此之上加入现代终端的气质（等宽骨架、提示符语言、命令块、状态栏、方点阵与块光标）。
- **结构先行**：先把样式收拢到令牌、控件层和级联层，再改视觉。结构到位后，视觉调整基本只动 `tokens.css` 与 `ui.css`。
- **不改的**：品牌标志 `build/prompt-stone.svg` 的路径、线宽与比例；深浅双主题；键盘可达与窄屏可读；现有检查脚本的约束。
- **首版只做 Windows 桌面端**，不为其他平台预建空壳。

## 2. 现状（2026-09-28 测量）

| 指标 | 数值 | 说明 |
| --- | --- | --- |
| 样式文件 | 21 个，约 2.1 万行 | `tools.css` ≈ 4000 行，`workbench.css` ≈ 3300 行 |
| 按历史命名的层 | `stage1.css`、`redesign.css` | 早加载、被后续文件覆盖；归属靠 import 顺序 |
| 散落像素值 | 2042 个，1464 个有同值令牌 | 无令牌的高频值：`5px` ×113、`10px` ×100、`18/20/22/26px` |
| 统一控件使用 | `components/ui` 被 3 个 tsx 引用 | 另有 158 处直接写 `className="btn…"` |
| 模块私有控件 | 约 25 种 `*-btn / *-chip / *-tab` | 如 `.set-chip`、`.rp-stage-chip` |
| 超大组件 | `RightPanel` 2839 行、`Rail` 1983 行、`Composer` 1882 行 | |
| 图标 | `catalog.json` 61 个语义，全部 Lucide | 12px 是最常用尺寸；`scripts/design/README.md` 仍写 55 个 |

数据来源：`npm run measure:css` 生成的 `scripts/design/CSS-*.md`，以及对 `src/renderer/src` 的静态统计。

## 3. 视觉方向

### 3.1 字体分工

- `--mono`（Maple Mono CN）：界面骨架、元数据、路径、工具行、代码、终端、状态栏、快捷键。
- `--sans`：对话正文与页标题。长段中文用无衬线更好读。原型提供「正文等宽」开关用于比较，默认关闭。

### 3.2 提示符语言

| 位置 | 形式 |
| --- | --- |
| 用户消息 | `›` 提示符 + 正文的块，`--bg-2` 底；时间与分支淡显于下方 |
| 工具调用 | 命令块：状态（方点阵 / 成功点）· 工具名 · 目标 · 右侧耗时或 `+n −m`；`bash` 目标前加强调色 `$` |
| 写入 / 编辑 | 命令块内联 diff 预览，行号 + `+` 标记，新增行 `--ok-soft` 底 |
| 输入区 | `›` + 2px 块光标；顶边为运行条（方点阵 · 阶段文字 · 计时 · 中止）；运行时边框环绕流光 |
| 选中项 | `--bg-3` 底 + 行首强调色 `›`（命令面板）或状态圆点（左栏）。**不用 inset 边线**：圆角会把它弯成一道蓝弧 |

### 3.3 新增区域（待决策）

- **状态栏**（窗口底部 24px）：左端模式色块 `RUN / IDLE / WAIT`，其后是分支与改动数、pi 连接、手机配对、模型档位、上下文占用、当日花费、本地模式。它会成为 v0.4 版面图之外的新常驻区域，与输入区下方用量条的职责需要重新划分。
- **命令面板**（`Ctrl K`）：`›` 输入行、分组结果、右侧快捷键、底部键位提示；入场 240ms、退场 110ms。
- **检查器分区编号** `01…05` 与**上下文方格条**（25 格，系统 / 对话 / 工具三色）。

## 4. 动效体系

在现有 `motion.css` 令牌上收敛为「一条曲线、三档时长、一个节拍」：

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--mo-fast` | 110ms | 退场、按压、悬停 |
| `--mo-base` | 170ms | 淡入、图标切换 |
| `--mo-slow` | 240ms | 展开、滑块、色阶变化 |
| `--mo-ease` | `cubic-bezier(.22,1,.36,1)` | 所有入场与位移 |
| `--mo-ease-out` | `cubic-bezier(.4,0,1,1)` | 退场 |
| `--mo-loop`（新增） | `cubic-bezier(.45,0,.55,1)` | 只给运行中的循环 |
| 错峰 | 60–70ms | 列表、diff 行 |
| 字符节奏 | 输入 30ms/字 · 流式正文 20ms/字 | |

约束：位移 ≤ 4px、缩放 ≥ 0.965、不弹跳；循环只挂在真实运行的状态上且不是唯一的状态信息；`prefers-reduced-motion` 下 1ms 直达终态。

基础件（原型中已有实现，迁入 `motion.css` 与 `components/ui`）：

- **展开** `grow`：新块 `grid-template-rows: 0fr → 1fr` 同步透明度，旧内容被连续推开，不跳。
- **方点阵** `spin`：10×10px、3×3 方点，亮点沿外圈转、带一格尾迹，0.8s 一圈；取代 `loader-circle` 图标与盲文字符（后者是 2×4 竖长条）。
- **光标** `caret`：2px 宽、1.2em 高；输入时常亮，停下后 1.06s `step-end` 闪烁。
- **环绕流光** `orbit`：`@property --ang` + `conic-gradient` 边框，经 mask 只露 1px 边；2.4s 一圈，随运行状态 240ms 淡入淡出。
- **分段滑块**：选中底块 `translateX` 滑动，而不是跳到新位置。
- **状态交叉淡变**：状态栏色块颜色 240ms 过渡，文字叠放交叉淡变，宽度固定。

**同一时钟原则**：运行中的各面板（输入区运行条、工具行、任务、上下文、改动、终端、状态栏）都从同一条运行事件流推导状态，不各自计时，因此动效始终同拍。

## 5. 图标规范「砚线」

母题是品牌标志「提示砚」：开口石框 + 方头斜接的 `>_`。

1. **16 网格，12 活动区**，四周留 2px，对齐 12 / 14 / 16 三档尺寸。
2. **描边恒定 1.25px**：`vector-effect: non-scaling-stroke`，三档尺寸一样粗。现状 1.5/24 在 12px 下只有 0.75px。
3. **方头 · 斜接**：`stroke-linecap: square; stroke-linejoin: miter`。按 16px 缩放后标志框角半径仅约 0.5px，所以统一直角。
4. **开口角**：文件、目录、终端、外链等容器类图标右上角留缺口。
5. **直线与整圆为主**：0° / 45° / 90°，不画插画式隐喻。
6. **进行中不用图标**：用方点阵；状态点、勾选框由 CSS 绘制。

语义调整：`sparkles` → 星号 `*`；`agent`（bot）→ `>>`；`settings`（齿轮）→ 推子；`alert-circle` / `check-circle` → 方框内 `!` / 勾；`running`、`activity` 由方点阵取代；`terminal` 即标志图形。

首批 48 个几何已写入 [`inkline.draft.json`](../scripts/design/icons/inkline.draft.json)，按 `name="…"` 静态引用统计约覆盖九成用法。尚未重画：`learn`、`dashboard`、`dock`、`home`、`tile`、`compare`、`pull-request`、`library`、`group`、`audio`、`message-dots`。

接入方式：`catalog.json` 的 `lib` 增加 `inkline`，`build-icons.mjs` 从草案文件读取几何并输出同名 symbol；`npm run check:icons` 的约束（语义唯一、属性一致、生成物同步）保持不变。

## 6. 结构重构

| 步骤 | 做法 | 完成标准 |
| --- | --- | --- |
| 级联层 | `@layer tokens, base, ui, layout, modules, overrides;`，覆盖关系由层决定 | 不再依赖 import 顺序；`stage1.css`、`redesign.css` 按内容拆回归属文件后删除；`npm run lint:layers` 证明最终生效声明不变 |
| 令牌补缺 | `5px`→4/6、`10px`→8/12 按规则归并；新增 `--ctl-h-xs: 20px`、浮层与菜单宽度令牌；已有同值令牌的裸值批量替换 | `measure:css` 散落值只降不升 |
| 控件层 | `components/ui` 补 `Menu`/`Popover`、`Tabs`、`Field`/`Input`/`Select`、`SettingRow`、`InspectorSection`、`ListRow`；每个先写进规范 §3 | 模块私有 `*-btn/*-chip/*-tab` 清零；`className="btn…"` 改用组件 |
| 组件拆分 | `RightPanel` 按检查器分区拆文件；`Rail`、`Composer` 拆出行与工具条 | 单文件体量明显下降，行为不变 |
| 防回退 | 散落值数、模块私有控件类数、`!important` 数记基线，接入 `npm run check` | 只允许下降 |

## 7. 分阶段路线

| 阶段 | 内容 | 检查 |
| --- | --- | --- |
| P0 规范 | 第 8 节待决策项定案，写入 `DESIGN_SYSTEM.md` v0.5 | 文档评审 |
| P1 结构 | 级联层、拆历史层、令牌补缺 | `typecheck`、`lint:css`、`lint:layers`、`check:css-docs`、视觉矩阵截图无差异 |
| P2 控件 | 扩充 `components/ui`，先迁设置页 | 同上 + 设置相关 `test:live` |
| P3 动效 | `grow`、`spin`、`caret`、`orbit`、滑块入 `motion.css` 与组件 | `check:motion` + 实机录屏 |
| P4 图标 | 砚线接入生成链，先迁引用最多的前 10 个 | `icons`、`check:icons`、`check:shell-icons` |
| P5 视觉 | 左栏 → 右栏 → 输入区与对话流 → 工具行与工作台；状态栏；命令面板 | 全量 `npm run check`；深浅主题 × 1440×900 / 940×620 / 900×520 截图 |

每阶段单独提交；视觉结论以实际截图为准，构建、静态检查、运行与截图证据分别说明。

## 8. 待决策

1. 界面骨架整体改用等宽字体？（原型默认：是；正文保持无衬线）
2. 是否新增底部状态栏？用量条保留还是并入状态栏？
3. 是否新增 `Ctrl K` 命令面板？
4. 是否采纳「砚线」替换 Lucide？描边取 1 / 1.25 / 1.5 哪档？（原型默认 1.25）
5. 强调色保持靛蓝？（原型另备青绿、紫两档用于比较）
6. 运行时边框流光是否常驻，还是只在长任务（例如超过 3 秒）时出现？

## 9. 原型的已知限制

- 画布无法加载随包的 Maple Mono CN，等宽回退为 JetBrains Mono + Noto Sans SC，汉字未严格落在 1:2 栅格上。
- `@property` 角度动画与 `grid-template-rows` 过渡在 Electron 的 Chromium 中可用，但尚未在应用内实测。
- 原型数据（会话、文件、数字）为演示用途，不代表真实运行结果。
