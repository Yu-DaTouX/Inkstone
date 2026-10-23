---
name: artifact
description: 用户要一个能打开查看或操作的成果（表格页、仪表盘、报告页、网页、小工具、计算器、小游戏、可视化讲解、海报、邀请函、名片等单页设计），要动画短片、片头、3D 视频（用 HTML 合成，可导出 MP4，不需要另装软件），或要修改之前做的这类成果时使用。用户只说「做个 X 表」「设计个海报」「做个短视频」也算；需求再模糊也先读本技能、直接做第一版，不要先提问。
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
   - 每次都读 `official/frontend-design/SKILL.md`（Anthropic）和 `official/openai-codex-frontend/frontend-tasks.md`（OpenAI，十来行），学它们的方法和品质要求，对照两份里列的「AI 默认长相」检查。两份说法不一致时（如动效多少），以 Anthropic 那份为准。
   - 每次也读 `official/open-design-craft/anti-ai-slop.md`（open-design 整理的「AI 套路」清单，规则具体到色值和字距），再按下面指南表「加读 craft」一列读对应的一两份同目录文件。craft 只管字距、层级、对比度、状态、动效时长这类通用手艺，配色和字体仍按风格牌。
   - **风格怎么定，按用户说了多少**（用户说的永远优先，牌只补用户没说的部分）：
     - 用户给了具体要求（品牌色、指定颜色、深色 / 浅色、字体、logo、参考图或参考网站、已有项目的设计规范）：照用户的来；其余没说的维度再抽牌补齐，用户要深色就加 `--theme dark`。牌和用户要求冲突的地方，以用户为准。
     - 用户点名了风格名（「瑞士风」「包豪斯」「国潮」「赛博朋克」「像素风」等）：先运行 `yan artifact style --list`，有同名或相近的牌就用 `yan artifact style --id <id 或中文名>` 取那一张；没有对应的牌时看 `guides/styles.md`；那里也没有，就按用户的描述和对这个风格的公认特征自己定配色、字体、母题，仍然只用系统字体。
     - 用户点名某个具体设计系统或品牌（「按 Linear / Stripe 的样子」「用编辑部风设计系统」），或随包风格牌和 `guides/styles.md` 都对不上时：`yan artifact style --remote list --query <英文关键词>` 找 id，关键词只匹配英文的名称、分类和描述，搜不到就换风格词（editorial、minimal、brutalism、japanese 等）或不带 `--query` 看全表。再 `yan artifact style --remote <id>` 拉到本机，读返回的 `design`（DESIGN.md）照做，`tokens` 指向的 tokens.css 的 `:root` 变量抄进成果，其中 `--font-*` 等网络字体同样换成系统字体；只适用于拉丁字母的规则（大小写等）在中文里忽略。只在这时才拉，不要为了抽牌去联网。
     - 项目里有 `DESIGN.md`（当前目录或用 `--cwd` 指定）时，`yan artifact style` 会直接返回它的路径：优先照项目的设计规范做，不抽牌也不拉远端；它没写的部分才补风格牌，确实要换成随包牌时加 `--ignore-project`。
     - 用户只给了气质词（「高级一点」「可爱」「科技感」「简约」「复古」）：抽牌后选最贴的一张；三张都不贴就用 `--list` 挑。
     - 用户什么都没说：运行 `yan artifact style --kind <类型>`（poster / dashboard / game / explainer / tool / landing / slides / video），从抽到的 3 张里选最贴合主题和受众的一张。
     - 修改已有成果：沿用它现有的风格，不抽牌；用户说「换个风格」才再抽，或按用户说的方向换。
     - 选定的牌：配色、字体、字号、形状、版式、母题都照牌来，`avoid` 里的不做；官方资料里的具体配色、字体建议和牌冲突时以牌为准。不要因为「更稳妥」换回自己习惯的那套。
   - 用户要商务主题或「给几套主题选」时，可从 `official/theme-factory/themes/` 挑，只取配色，字体字段忽略。
   - 用户要的是艺术作品、艺术海报、纯视觉画面时，改读 `official/canvas-design/SKILL.md`，按它「先定美学宣言再作画」的方法做。
   - 生成艺术、粒子、流场、噪声图案、「用代码画画」，读 `official/algorithmic-art/SKILL.md`。
   - `guides/styles.md` 只在用户点名的风格没有对应风格牌时用。
2. **结构与砚里的技术写法**：同目录 `guides/` 按成果类型分了指南，挑一份最贴近的读。指南只管结构、画幅和沙箱写法；其中的版式、配色建议和官方技能冲突时，以风格牌和官方技能为准。

| 用户要的 | 读 | 加读 craft（`official/open-design-craft/`） |
| --- | --- | --- |
| 海报、邀请函、名片、证书、封面、社交配图 | `guides/poster.md` | `typography.md`、`color.md` |
| 数据表、仪表盘、报告、对比、排行 | `guides/dashboard.md` | `typography-hierarchy.md`、`state-coverage.md` |
| 小游戏 | `guides/game.md` | `animation-discipline.md` |
| 讲解概念、演示原理、教学可视化 | `guides/explainer.md` | `typography-hierarchy.md`、`animation-discipline.md` |
| 计算器、换算、生成器、格式化等小工具 | `guides/tool.md` | `form-validation.md`、`state-coverage.md` |
| 官网、落地页、个人主页、App 页面原型 | `guides/landing.md` | `typography-hierarchy.md`、`laws-of-ux.md` |
| 几页演示 / 幻灯片（不要 .pptx 文件时） | `guides/slides.md` | `typography-hierarchy.md`、`color.md` |
| 逐镜头推进的短片、片头、动态海报、讲解视频 | `guides/video.md` | `animation-discipline.md`、`typography.md` |

风格牌是杂志编辑、学术报告这类长文阅读风格时，把 `typography-hierarchy.md` 换成 `typography-hierarchy-editorial.md`；页面里有表单或强交互时加读 `accessibility-baseline.md`。

视频类型也写成单文件 HTML，但按 hyperframes 的合成格式约定写：根元素带 `data-composition-id` / `data-width` / `data-height` / `data-duration`，片段带 `data-start` / `data-duration` / `data-track-index`。画布会识别根元素上的 `data-composition-id`，动画统一挂在 `window.__timelines[<composition-id>]` 的控制器上（接口见 `guides/video.md`），预览后可以按时间点检查画面。要 3D 画面时用 `<script data-yan-lib="three"></script>` 引入砚随包的 three.js，写法见 `guides/video.md` 的「三维画面」。

指南和本文冲突时，以本文的沙箱限制为准。

## 官方设计技能在砚里的差异

`official/` 下是大厂官方原文：Anthropic 的四个技能（Apache-2.0，github.com/anthropics/skills）、OpenAI Codex 的前端段落（Apache-2.0）、Vercel 的界面规范（MIT）、open-design 的 craft 规则（Apache-2.0，部分改编自 MIT 的 refero_skill），来源写在各目录的 `SOURCE.md` 或 `LICENSE`。它们写给别的环境，在砚里按下面改用，其余照原文执行：

- **用用户的语言**：这些资料是英文，但回复、页面文案、占位文字都用用户提问的语言，用户说中文就全用中文。

- **不要先问用户**：原文里「confirm with the client」「Ask for their choice」「Wait for selection」「show it for review」一律改为：自己做决定，在回复里用一句话说明选了什么方向、主题或配色，做完再问要不要换。不要打开 `theme-showcase.pdf`（未收录）。
- **只交一个 HTML**：原文要求输出 `.png`、`.pdf`、`.md`、`.js` 的地方，一律改为一个单文件 HTML 成果页（图形用内联 SVG 或 `<canvas>`）。canvas-design 的美学宣言不另存文件，取一个名字、写一两句放进回复。
- **字体只能用系统字体**：不能下载或引用网络字体，原文点名的字体（含 theme-factory 的 DejaVu、FreeSans）换成气质相近的系统字体。中文：黑体 `"PingFang SC", "Microsoft YaHei", sans-serif`、宋体 `"Songti SC", "SimSun", serif`、楷体 `"Kaiti SC", "KaiTi", serif`；西文还可用 `Georgia`、`"Times New Roman"`、`"Segoe UI"`、`Bahnschrift`（窄体）、`Impact`、`"Courier New"`、`ui-monospace, Consolas`。Bahnschrift、等宽字体只在风格牌指定时用。
- **没有 p5.js**：algorithmic-art 原文用 CDN 上的 p5.js，在砚里会被拦截。改用原生 Canvas 2D 自己写：种子随机数（如 mulberry32）、值噪声或 Perlin 噪声、`requestAnimationFrame` 循环。`templates/viewer.html` 只参考它的版面（左侧参数面板、种子切换、重新生成），不要照抄其中的 `<script src>`。
- **open-design craft 的砚内对应**：文中的「active `DESIGN.md`」指你选定的风格牌（或项目 `DESIGN.md`、远端设计系统）；`--accent` 等令牌按风格牌写进 `:root`。显示字体要用衬线的说法不适用，字体按风格牌。`.ph-img`、`data-od-id`、`data-screen-label`、seed 模板、daemon 注入都是 open-design 自己的机制，跳过。文中说「the linter / lint-artifact 会查」的规则，在砚里由 `yan artifact preview` 结果的 `lint` 字段报告。全大写字距这类只对拉丁字母有意义的规则，中文里忽略。
- **Vercel 规范里用不上的条目跳过**：URL 同步状态与深链、离开前提示未保存、hydration、密码管理器、网络请求、`localStorage` 等依赖浏览器环境或服务端的条目，在单文件沙箱里不适用。
- **OpenAI 段落里的「avoid default stacks (… system)」**：砚只能用系统字体，字体按风格牌来，不算违反。
- **自检按本文**：原文的「截图自查」「Take a second pass」「FINAL STEP」都用本文第 4 步的 `yan artifact preview` 完成，总共最多三次，不另开浏览器。

## 步骤

1. **开工前一句话说明假设**（数据口径、范围、语言），不要停下来问。用户没说语言就用用户提问的语言做界面。
   同时**定风格**：按上面「风格怎么定」的顺序，先看用户说了什么，没点名风格就运行 `yan artifact style --kind <类型>` 选一张牌；这一步不能跳过，不要自己凭印象起风格名。
2. **准备数据**：需要事实数据时，有搜索能力就先查官方或一手来源（`yan search`），记下来源与时间；查不到就用你确知的数并在页面上标「约」与数据时间。不编造精确到个位的数字。
3. **一次写完第一版**：思考里只定方向和结构（几行要点），**不要在思考里先把 HTML 打一遍草稿**，直接在 write 工具里写，用户才能在右侧看着页面一点点长出来。用 write 工具把完整文件写到项目里的 `artifacts/<英文短名>.html`（用户指定路径时用用户的）。写的时候右侧会自动打开实时预览，所以第一版就要完整可看，不要先写骨架再一点点补。
4. **自检**：有交互的成果（工具、游戏、讲解、落地页、仪表盘），先用 read 打开 `official/vercel-web-interface-guidelines/AGENTS.md`（Vercel 官方界面规范），对照 Keyboard、Targets & Input、Animation、Layout、Content & Accessibility、Dark Mode & Theming、Design 几节，把不满足的 MUST 一并改掉；纯海报和静态画面跳过这一步。`yan artifact preview --path <文件>`，看返回的控制台错误、横向溢出和 `lint`（按 open-design 反 AI 套路规则查源码：`[必须改]` 的和报错同等对待，`[建议改]` 能顺手改就改），再用 read 打开 `light-desktop` 和 `light-narrow` 两张截图（写了深色版时把桌面那张换成 `dark-desktop`）。每张截图是整页按屏拼成的拼版（从左到右、从上到下依次是第 1、2… 屏），首屏以下的表格、图表、页脚也要看；结果里写着「中段省略，最后一格是页尾」时，说明页面超过 4 屏：前 3 格是开头三屏，最后一格是页尾，中间部分要靠代码确认。只修硬伤：报错、横向溢出、`lint` 里的 `[必须改]`、内容被裁掉或互相遮挡、文字看不清。有硬伤就改**同一个文件**，把这一轮发现的问题一次改完，再预览确认；确认后还有硬伤可以再改一轮，然后就结束；配色、间距这类审美微调留给用户提。**`yan artifact preview` 一共最多运行三次。** 不要另开浏览器、起本地服务器或自己截图裁图，这个命令已经按砚的真实沙箱渲染。
5. **挂到回复**：`yan artifact attach --path <文件> --description "<一句话说明>"`。子 Agent 不能 attach，在结果里写明文件路径，由主会话挂载。
6. **回复要短**：做了什么（三四条，含用了哪张风格牌）、数据来源与局限、可以怎么继续改。不要贴 HTML 源码。

## 修改已有成果

用户说「改成…」「再加…」时，编辑原文件（edit 工具），再预览、再 attach。同一路径再次挂载就是新版本（v2、v3…），用户能切换对比。不要另起文件名，内容没变不要重复挂载。

## 页面必须遵守（砚的沙箱限制）

- **单文件**：样式写在 `<style>`，脚本写在 `<script>`，图片用 `data:` URI 或内联 SVG。挂到回复时只复制 HTML 本身，同目录的 CSS/JS/图片会丢；CDN 库、网络字体、`fetch` 网络请求都会被拦截。
- **没有存储和弹窗**：`localStorage`、`sessionStorage`、cookie 会抛错，状态放在内存变量里；`alert/confirm/prompt`、表单提交、新窗口都不可用，用页面内的元素代替。
- **图表手写**：用内联 SVG 或 `<canvas>` 自己画，不引用图表库。数值标签不要互相遮挡，坐标轴从合理的刻度起。
- **一套配色**：按风格牌的 `theme` 只做一种配色，颜色、字体写成 `:root` 里的 CSS 变量；不写 `prefers-color-scheme` 深色版，用户要求跟随系统深浅时才写。
- **首屏**：对话里的缩略图按 1280×800 截取页面顶部，最重要的内容放在这个范围内。
- **窄屏可读**：宽度从 360px 起不出现横向滚动；卡片和图表在窄屏改为单列，表格可横向滚动或减少列。
- **固定画幅**（海报、名片、幻灯片）：画面按宽度整体等比缩放，写法见 `guides/poster.md`。宽度不要用 `vh`/`dvh` 计算：对话里的缩略图和窄屏视口都很矮，按高度算会把整张图压扁。
- **字体**：只能用系统字体，按风格牌的 `fonts`，清单见上面「官方设计技能在砚里的差异」；正文兜底 `system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`。表格里的数字用 `font-variant-numeric: tabular-nums`。
- **大小**：控制在 1MB 以内，最多 5MB。
- **注明来源**：页面底部写数据来源、数据时间和「近似值」说明。

## 好的成果页

- 首屏先给结论，形式三选一：一句结论 + 一张主图；一个主角数字；不超过 4 个数字（卡片、表头行、图内标注都行）。不要每次都是「标题 + 摘要 + 4 张数字卡」。
- 砚里模型最常见的默认长相，风格牌没要求就不要用：偏色纸白底或带色近黑底、Bahnschrift 窄体大数字、1px 细线分隔加零圆角、`A · B` 中点串、全大写加宽字距的小标签、背景淡网格或光晕、账本 / 年鉴 / 印章 / 档案式的命名和装饰。
- 装饰上也别落入套路：卡片左侧细竖条、卡片顶部色条、标题旁小色块、每张卡片一种颜色的彩虹卡、装饰性角块和短横线、每页都有同样的页头条。
- 交互要有用：排序、筛选、切换指标、悬停显示数值；不要为了炫加动画。
- 文案用用户的语言，单位和货币写清楚。
