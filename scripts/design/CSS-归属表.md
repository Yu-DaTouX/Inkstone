# 样式规则归属表（自动生成）

> 由 `node scripts/css-inventory.mjs --md` 生成。改 CSS 后重新生成再对比。
>
> 加载顺序与 `App.tsx` 的 import 一致；**同特异性时后加载者胜**。

## 1. 各文件规模

| 顺序 | 文件 | 行数 | 唯一选择器 | 规则数 | @media | !important |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | `tokens.css` | 346 | 24 | 25 | 1 | 2 |
| 2 | `ui.css` | 352 | 58 | 59 | 0 | 0 |
| 3 | `app.css` | 528 | 74 | 74 | 1 | 0 |
| 4 | `stage1.css` | 205 | 25 | 33 | 1 | 0 |
| 5 | `redesign.css` | 1186 | 129 | 142 | 5 | 0 |
| 6 | `motion.css` | 1380 | 160 | 165 | 5 | 9 |
| 7 | `settings.css` | 1037 | 148 | 151 | 1 | 2 |
| 8 | `electron.css` | 35 | 11 | 12 | 0 | 0 |
| 9 | `highlight.css` | 173 | 81 | 81 | 0 | 0 |
| 10 | `layout.css` | 176 | 14 | 14 | 3 | 2 |
| 11 | `shell.css` | 393 | 54 | 56 | 1 | 7 |
| 12 | `dialog.css` | 80 | 11 | 11 | 0 | 0 |
| 13 | `rail.css` | 1568 | 224 | 230 | 0 | 0 |
| 14 | `chat.css` | 2201 | 289 | 294 | 5 | 2 |
| 15 | `composer.css` | 1898 | 263 | 266 | 1 | 0 |
| 16 | `tools.css` | 3967 | 593 | 638 | 3 | 5 |
| 17 | `browser.css` | 417 | 57 | 57 | 0 | 0 |
| 18 | `terminal.css` | 82 | 10 | 10 | 0 | 0 |
| 19 | `review.css` | 1526 | 220 | 221 | 1 | 0 |
| 20 | `workbench.css` | 3282 | 440 | 457 | 3 | 0 |
| 21 | `icon-state.css` | 30 | 1 | 1 | 1 | 0 |
| | **合计** | **20862** | **2778** | | | |

## 2. 覆盖热力：每个文件「最终胜出」的选择器数

即：这些规则是这个文件说了算的（它是最后一个定义者）。

| 文件 | 最终胜出 |
| --- | ---: |
| `tokens.css` | 17 |
| `ui.css` | 57 |
| `app.css` | 52 |
| `stage1.css` | 11 |
| `redesign.css` | 74 |
| `motion.css` | 156 |
| `settings.css` | 148 |
| `electron.css` | 9 |
| `highlight.css` | 81 |
| `layout.css` | 14 |
| `shell.css` | 54 |
| `dialog.css` | 11 |
| `rail.css` | 224 |
| `chat.css` | 287 |
| `composer.css` | 262 |
| `tools.css` | 593 |
| `browser.css` | 57 |
| `terminal.css` | 10 |
| `review.css` | 220 |
| `workbench.css` | 440 |
| `icon-state.css` | 1 |

## 3. 被多个文件定义的选择器（覆盖链）

共 **92** 个选择器在 ≥2 个文件里出现。渲染顺序 = 从左到右，**最右那个胜出**。

| 选择器 | 定义它的文件（按加载顺序） |
| --- | --- |
| `:root` | tokens → redesign → motion → layout |
| `.rail` | app → redesign → electron → rail |
| `.composer textarea` | app → redesign → electron → composer |
| `.titlebar` | app → redesign → electron |
| `.workspace` | app → redesign → layout |
| `.msg-label` | app → stage1 → redesign |
| `.bubble` | app → redesign → electron |
| `.composer-bar` | app → redesign → electron |
| `.send` | app → redesign → composer |
| `.status` | app → redesign → electron |
| `.md code` | stage1 → redesign → chat |
| `.md pre` | stage1 → redesign → chat |
| `.composer` | redesign → motion → composer |
| `html[data-theme='light']` | tokens → motion |
| `body` | tokens → electron |
| `::-webkit-scrollbar` | tokens → redesign |
| `::-webkit-scrollbar-thumb` | tokens → redesign |
| `::-webkit-scrollbar-thumb:hover` | tokens → redesign |
| `.ico` | tokens → icon-state |
| `.btn:active:not(:disabled)` | ui → motion |
| `.tb-name` | app → shell |
| `.tb-right` | app → redesign |
| `.search` | app → redesign |
| `.item` | app → redesign |
| `.center` | app → stage1 |
| `.center > .stream` | app → redesign |
| `.stream` | app → redesign |
| `.stream-inner` | app → redesign |
| `.msg` | app → redesign |
| `.think summary` | app → redesign |
| `.send:disabled` | app → redesign |
| `.sect` | app → redesign |
| `.card` | app → redesign |
| `.connbar` | stage1 → motion |
| `.empty-stream` | stage1 → redesign |
| `.cursor-inline` | stage1 → redesign |
| `.md pre code` | stage1 → highlight |
| `.modal-scrim` | stage1 → motion |
| `.modal` | stage1 → motion |
| `.notices` | stage1 → motion |
| `.notice` | stage1 → motion |
| `.notice:hover` | stage1 → motion |
| `.logdrawer` | stage1 → motion |
| `.stream-row` | stage1 → redesign |
| `.composer textarea::placeholder` | redesign → composer |
| `.browser-tabs` | redesign → browser |
| `.browser-tab` | redesign → browser |
| `.browser-new-tab` | redesign → browser |
| `.browser-toolbar` | redesign → browser |
| `.browser-nav` | redesign → browser |
| `.browser-close` | redesign → browser |
| `.browser-nav.browser-chrome` | redesign → browser |
| `.browser-address` | redesign → browser |
| `.browser-address input` | redesign → browser |
| `.rp-hist-todo .rp-text` | redesign → tools |
| `.app.rail-off .rail` | redesign → rail |
| `.rail-top` | redesign → rail |
| `.rail-action` | redesign → rail |
| `.rail-section` | redesign → rail |
| `.rail-body` | redesign → rail |
| `.proj-head` | redesign → rail |
| `.proj-path` | redesign → rail |
| `.srow-row` | redesign → rail |
| `.srow-text` | redesign → rail |
| `.srow-line` | redesign → rail |
| `.srow-origin` | redesign → rail |
| `.srow-menu-path` | redesign → rail |
| `.turn` | redesign → motion |
| `.srow-name` | redesign → rail |
| `.srow-wrap .srow-time` | redesign → rail |
| `.composer-wrap` | redesign → composer |
| `.composer:focus-within` | redesign → composer |
| `.composer-wrap.dropping .composer` | redesign → composer |
| `.mt-pop` | redesign → motion |
| `.row-menu-surface` | redesign → motion |
| `.row-menu` | redesign → motion |
| `.prose` | redesign → electron |
| `.rp-body` | redesign → tools |
| `.rp-sec` | redesign → tools |
| `.rp-sec-head` | redesign → tools |
| `.rp-sec-body` | redesign → tools |
| `.rp-quota-plan` | redesign → tools |
| `.rp-todo.active` | redesign → motion |
| `.rp-now-spin` | redesign → motion |
| `.outline-preview` | redesign → motion |
| `.op-title` | redesign → motion |
| `.op-empty` | redesign → motion |
| `.settings-scrim` | motion → settings |
| `.settings` | motion → settings |
| `.term-bar` | chat → terminal |
| `.term-bar .spacer` | chat → terminal |
| `.review` | composer → review |
