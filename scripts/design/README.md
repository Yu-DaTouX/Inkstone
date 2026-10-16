# 设计工具与规范（唯一活源）

这里是设计相关的**唯一活源**：可执行脚本、机器可读清单、设计稿与图标编目。
`docs/design/` 下的同名文件是 2026-09-24 迁移前的旧副本 —— 只作历史参考，**不要运行、不要照着更新**。

## 图标

| 文件 | 说明 |
| --- | --- |
| `icons/catalog.json` | 语义名 → 用途。**手写的唯一真源**，61 个语义 |
| `icons/inkline.json` | 「砚线」几何（16 网格 path），与 `catalog.json` 一一对应，规则见设计规范 §3.4 |
| `icons/build-icons.mjs` | 生成链（`npm run icons`）：从上面两份生成下列产物 |
| `icons/sprite.svg` | 生成物：完整 sprite（61 个 symbol） |
| `icons/preview.html` | 生成物：预览页（深浅两套，带尺寸样例） |
| `../../src/renderer/src/icons/sprite.ts` | 生成物：渲染端内联 sprite（`file://` 下必须内联；手机端也读它） |

新增 / 替换图标：在 `catalog.json` 登记语义 → 在 `inkline.json` 画几何 → `npm run icons` → `npm run check:icons`，并按设计规范 §3.4 出 12 / 14px 可读性对照图。
`npm run check:icons` 会拦住：属性走样、引用不存在的图标、一个图标被两个语义借用、生成物与编目不一致。

## 动效

关键帧的唯一真源是 `../src/renderer/src/styles/motion.css`；时长与曲线令牌在 `styles/tokens.css`。
`npm run check:motion` 拦住模块 CSS 里的裸 `@keyframes`、裸时长、裸 `cubic-bezier`，以及悬空的关键帧引用。

## 品牌

品牌设计唯一真源是 `../../resources/brand/inkstone-design.json`：几何 SVG、16/24 像素 mask（frame / prompt / question 分层）、配色、透明度与缓动、各状态四段时长。

| 命令 | 作用 |
| --- | --- |
| `npm run icon` | 从真源生成：`build/prompt-stone.svg`、`build/icon.png`、`build/icon.ico`、`build/tray/`（16/24/32 × on-light/on-dark 静态与去重动画帧 + `manifest.json`）、`src/shared/brand-geometry.ts` |
| `npm run icon -- --check` | 只校验上述产物与真源一致，**不写任何文件**（漂移检查） |
| `node scripts/test-brand-assets.mjs` | 真源结构 / mask 逐格 / 750-1500ms 时间线 / 各 DPI / manifest / 石框逐帧不变 / 符号与框零相交 |
| `node scripts/test-v3-tray-animation.mjs` | 托盘柔和闪动播放器：虚拟时钟、状态与主题切换、减少动态、timer 清理、跳帧、常量缓存、缺素材回退 |

`build/prompt-stone.svg` 与 `src/shared/brand-geometry.ts` 是生成物，不要手改；`scripts/design/01-prompt-stone.svg` 是迁移前的旧素材副本，只作历史参考。

## 其它

| 文件 | 说明 |
| --- | --- |
| `prototype.html` | 可交互设计稿，双击打开即可；图标子集由 `npm run icons` 同步写入，无手工同步点 |
| `check.mjs` | 设计稿静态自检：`node scripts/design/check.mjs` |
| `measure-design.mjs` | 量设计稿的布局溢出：`npm run measure:design` |
| `CSS-令牌清单.md` · `CSS-归属表.md` · `CSS-散落值清单.md` | 生成物：`npm run measure:css`；用 `npm run check:css-docs` 校验是否最新 |
| `01-prompt-stone.svg` | 品牌图形素材（迁移前旧副本，现行真源是 `resources/brand/inkstone-design.json`） |
| `terminal-preview/` | 终端风格重构原型（设计画板源码，只作参考），见 `docs/UI_REDESIGN.md` |

设计规范正文（令牌、组件、禁止项、动效、自检）见 `docs/design/DESIGN.md`（本地维护，不随公开文档分发）。
