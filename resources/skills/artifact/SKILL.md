---
name: artifact
description: 用户要一个能打开查看或操作的成果（表格页、仪表盘、报告页、网页、小工具、计算器、小游戏、可视化讲解、海报、邀请函、名片等单页设计），或要修改之前做的这类成果时使用。用户只说「做个 X 表」「设计个海报」也算；需求再模糊也先读本技能、直接做第一版，不要先提问。
---

# 成果页（Artifact）

成果页是一个单文件 HTML：你写进项目，砚在右侧面板实时显示，挂到回复后用户能切换版本、在「成果」页找回。用户通常只说一句「做个澳洲人均收入表」「帮我设计个海报」，下面的事由你补全。**不要先提问**（包括 question 工具）：主题、内容、风格、格式都没说时，选一个最常见的用途做第一版，文案用一看就知道可替换的占位（如「活动名称」「2026.11.08」），做完再在回复里问要往哪个方向改。用户等一份能看的初稿，比等你提问快得多。

## 什么时候做成成果页

- 要看、要点、要反复用的东西：仪表盘、对比表、报告、网页原型、计算器、表单式小工具、小游戏、交互讲解。
- 单页设计稿：海报、邀请函、名片、证书、封面。
- 不做成成果页：一句话或一张图能答完的（用回答里的 `yan-chart` 等块，见 visual-answer 技能）；修改用户自己的项目代码；Word / Excel / PPT / PDF（见 office 技能）。

## 先读设计资料

动手前读两类资料（用 read 打开，路径相对本技能目录），不要全部读完：

1. **视觉方向，用大厂官方设计资料**（`official/` 下原样收录，见下一节的砚内差异）：
   - 每次都读 `official/frontend-design/SKILL.md`（Anthropic）和 `official/openai-codex-frontend/frontend-tasks.md`（OpenAI，十来行）：先按主题定配色、字体、版式和原则，对照两份里列的「AI 默认长相」检查，再动手。两份说法不一致时（如动效多少），以 Anthropic 那份为准。
   - 报告、仪表盘、幻灯片、工具这类偏商务的成果，用户没指定配色时，从 `official/theme-factory/themes/` 里按「Best Used For」挑一套最合适的配色读进来。
   - 用户要的是艺术作品、艺术海报、纯视觉画面时，改读 `official/canvas-design/SKILL.md`，按它「先定美学宣言再作画」的方法做。
   - 生成艺术、粒子、流场、噪声图案、「用代码画画」，读 `official/algorithmic-art/SKILL.md`。
   - 用户点名了水墨、国潮、像素、赛博等中文语境常见风格时，再补读 `guides/styles.md` 里对应的一行。
2. **结构与砚里的技术写法**：同目录 `guides/` 按成果类型分了指南，挑一份最贴近的读。指南只管结构、画幅和沙箱写法；其中的版式、配色建议和官方技能冲突时，以官方技能为准。

| 用户要的 | 读 |
| --- | --- |
| 海报、邀请函、名片、证书、封面、社交配图 | `guides/poster.md` |
| 数据表、仪表盘、报告、对比、排行 | `guides/dashboard.md` |
| 小游戏 | `guides/game.md` |
| 讲解概念、演示原理、教学可视化 | `guides/explainer.md` |
| 计算器、换算、生成器、格式化等小工具 | `guides/tool.md` |
| 官网、落地页、个人主页、App 页面原型 | `guides/landing.md` |
| 几页演示 / 幻灯片（不要 .pptx 文件时） | `guides/slides.md` |

指南和本文冲突时，以本文的沙箱限制为准。

## 官方设计技能在砚里的差异

`official/` 下是大厂官方原文：Anthropic 的四个技能（Apache-2.0，github.com/anthropics/skills）、OpenAI Codex 的前端段落（Apache-2.0）、Vercel 的界面规范（MIT），来源写在各目录的 `SOURCE.md` 或 `LICENSE`。它们写给别的环境，在砚里按下面改用，其余照原文执行：

- **用用户的语言**：这些资料是英文，但回复、页面文案、占位文字都用用户提问的语言，用户说中文就全用中文。

- **不要先问用户**：原文里「confirm with the client」「Ask for their choice」「Wait for selection」「show it for review」一律改为：自己做决定，在回复里用一句话说明选了什么方向、主题或配色，做完再问要不要换。不要打开 `theme-showcase.pdf`（未收录）。
- **只交一个 HTML**：原文要求输出 `.png`、`.pdf`、`.md`、`.js` 的地方，一律改为一个单文件 HTML 成果页（图形用内联 SVG 或 `<canvas>`）。canvas-design 的美学宣言不另存文件，取一个名字、写一两句放进回复。
- **字体只能用系统字体**：不能下载或引用网络字体，原文点名的字体（含 theme-factory 的 DejaVu、FreeSans）换成气质相近的系统字体。中文：黑体 `"PingFang SC", "Microsoft YaHei", sans-serif`、宋体 `"Songti SC", "SimSun", serif`、楷体 `"Kaiti SC", "KaiTi", serif`；西文还可用 `Georgia`、`"Times New Roman"`、`"Segoe UI"`、`Bahnschrift`（窄体）、`Impact`、`"Courier New"`、`ui-monospace, Consolas`。字体个性不够时，用字重、字距、大小对比和排版本身做出性格。
- **没有 p5.js**：algorithmic-art 原文用 CDN 上的 p5.js，在砚里会被拦截。改用原生 Canvas 2D 自己写：种子随机数（如 mulberry32）、值噪声或 Perlin 噪声、`requestAnimationFrame` 循环。`templates/viewer.html` 只参考它的版面（左侧参数面板、种子切换、重新生成），不要照抄其中的 `<script src>`。
- **Vercel 规范里用不上的条目跳过**：URL 同步状态与深链、离开前提示未保存、hydration、密码管理器、网络请求、`localStorage` 等依赖浏览器环境或服务端的条目，在单文件沙箱里不适用。
- **OpenAI 段落里的「avoid default stacks (… system)」**：砚只能用系统字体，按上一条的字体清单挑有性格的系统字体，用字重、字距和尺寸对比做出个性，不算违反。
- **自检按本文**：原文的「截图自查」「Take a second pass」「FINAL STEP」都用本文第 4 步的 `yan artifact preview` 完成，总共最多两次，不另开浏览器。

## 步骤

1. **开工前一句话说明假设**（数据口径、范围、语言），不要停下来问。用户没说语言就用用户提问的语言做界面。
2. **准备数据**：需要事实数据时，有搜索能力就先查官方或一手来源（`yan search`），记下来源与时间；查不到就用你确知的数并在页面上标「约」与数据时间。不编造精确到个位的数字。
3. **一次写完第一版**：用 write 工具把完整文件写到项目里的 `artifacts/<英文短名>.html`（用户指定路径时用用户的）。写的时候右侧会自动打开实时预览，所以第一版就要完整可看，不要先写骨架再一点点补。
4. **自检**：有交互的成果（工具、游戏、讲解、落地页、仪表盘），先用 read 打开 `official/vercel-web-interface-guidelines/AGENTS.md`（Vercel 官方界面规范），对照 Keyboard、Targets & Input、Animation、Layout、Content & Accessibility、Dark Mode & Theming、Design 几节，把不满足的 MUST 一并改掉；纯海报和静态画面跳过这一步。`yan artifact preview --path <文件>`，看返回的控制台错误、横向溢出，再用 read 打开 `dark-desktop` 和 `light-narrow` 两张截图。只修硬伤：报错、横向溢出、内容被裁掉或互相遮挡、文字看不清。有硬伤就改**同一个文件**，再预览一次确认，然后就结束；配色、间距这类审美微调留给用户提。**`yan artifact preview` 一共最多运行两次。** 不要另开浏览器、起本地服务器或自己截图裁图，这个命令已经按砚的真实沙箱渲染。
5. **挂到回复**：`yan artifact attach --path <文件> --description "<一句话说明>"`。
6. **回复要短**：做了什么（三四条）、数据来源与局限、可以怎么继续改。不要贴 HTML 源码。

## 修改已有成果

用户说「改成…」「再加…」时，编辑原文件（edit 工具），再预览、再 attach。同一路径再次挂载就是新版本（v2、v3…），用户能切换对比。不要另起文件名，内容没变不要重复挂载。

## 页面必须遵守（砚的沙箱限制）

- **单文件**：样式写在 `<style>`，脚本写在 `<script>`，图片用 `data:` URI 或内联 SVG。外部 CSS/JS/字体/图片、CDN 库、`fetch` 网络请求都会被拦截。
- **没有存储和弹窗**：`localStorage`、`sessionStorage`、cookie 会抛错，状态放在内存变量里；`alert/confirm/prompt`、表单提交、新窗口都不可用，用页面内的元素代替。
- **图表手写**：用内联 SVG 或 `<canvas>` 自己画，不引用图表库。数值标签不要互相遮挡，坐标轴从合理的刻度起。
- **深浅主题**：用 CSS 变量配色，并用 `@media (prefers-color-scheme: dark)` 给出深色配色，两种主题都要看得清。
- **首屏**：对话里的缩略图按 1280×800 截取页面顶部，最重要的内容放在这个范围内。
- **窄屏可读**：宽度从 360px 起不出现横向滚动；卡片和图表在窄屏改为单列，表格可横向滚动或减少列。
- **固定画幅**（海报、名片、幻灯片）：画面按宽度整体等比缩放，写法见 `guides/poster.md`。宽度不要用 `vh`/`dvh` 计算：对话里的缩略图和窄屏视口都很矮，按高度算会把整张图压扁。
- **字体**：只能用系统字体，按主题挑，见上面「官方设计技能在砚里的差异」里的字体清单；正文兜底 `system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`。表格里的数字用 `font-variant-numeric: tabular-nums`。
- **大小**：控制在 1MB 以内，最多 5MB。
- **注明来源**：页面底部写数据来源、数据时间和「近似值」说明。

## 好的成果页

- 首屏先给结论：标题 + 一句摘要 + 3–4 个关键数字卡片，再放图表和明细。
- 交互要有用：排序、筛选、切换指标、悬停显示数值；不要为了炫加动画。
- 文案用用户的语言，单位和货币写清楚。
