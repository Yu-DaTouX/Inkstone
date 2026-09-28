# 样式规则归属表（自动生成）

> 由 `node scripts/css-inventory.mjs --md` 生成。改 CSS 后重新生成再对比。
>
> 加载顺序与级联层见 `styles/index.css`：后面的层整体压过前面的层；**同层内同特异性时后加载者胜**。

## 1. 各文件规模

| 顺序 | 文件 | 层 | 行数 | 唯一选择器 | 规则数 | @media | !important |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | `tokens.css` | tokens | 422 | 25 | 30 | 2 | 6 |
| 2 | `ui.css` | ui | 352 | 58 | 59 | 0 | 0 |
| 3 | `app.css` | modules | 528 | 74 | 74 | 1 | 0 |
| 4 | `motion.css` | modules | 1550 | 175 | 180 | 6 | 2 |
| 5 | `settings.css` | modules | 1152 | 169 | 172 | 1 | 0 |
| 6 | `electron.css` | modules | 35 | 11 | 12 | 0 | 0 |
| 7 | `highlight.css` | modules | 173 | 81 | 81 | 0 | 0 |
| 8 | `layout.css` | modules | 248 | 21 | 22 | 4 | 2 |
| 9 | `shell.css` | modules | 466 | 62 | 64 | 1 | 7 |
| 10 | `dialog.css` | modules | 193 | 24 | 25 | 0 | 0 |
| 11 | `rail.css` | modules | 1802 | 233 | 255 | 0 | 0 |
| 12 | `chat.css` | modules | 2563 | 326 | 350 | 6 | 0 |
| 13 | `composer.css` | modules | 2163 | 283 | 295 | 2 | 0 |
| 14 | `tools.css` | modules | 4128 | 607 | 661 | 5 | 5 |
| 15 | `browser.css` | modules | 502 | 57 | 68 | 0 | 0 |
| 16 | `terminal.css` | modules | 82 | 10 | 10 | 0 | 0 |
| 17 | `review.css` | modules | 1546 | 224 | 225 | 1 | 0 |
| 18 | `workbench.css` | modules | 1883 | 244 | 255 | 2 | 0 |
| 19 | `icon-state.css` | modules | 30 | 1 | 1 | 1 | 0 |
| | **合计** | | **19818** | **2629** | | | |

## 2. 覆盖热力：每个文件「最终胜出」的选择器数

即：这些规则是这个文件说了算的（它是最后一个定义者）。

| 文件 | 最终胜出 |
| --- | ---: |
| `tokens.css` | 21 |
| `ui.css` | 57 |
| `app.css` | 52 |
| `motion.css` | 158 |
| `settings.css` | 169 |
| `electron.css` | 4 |
| `highlight.css` | 80 |
| `layout.css` | 20 |
| `shell.css` | 62 |
| `dialog.css` | 24 |
| `rail.css` | 233 |
| `chat.css` | 324 |
| `composer.css` | 282 |
| `tools.css` | 607 |
| `browser.css` | 57 |
| `terminal.css` | 10 |
| `review.css` | 224 |
| `workbench.css` | 244 |
| `icon-state.css` | 1 |

## 3. 被多个文件定义的选择器（覆盖链）

共 **49** 个选择器在 ≥2 个文件里出现。渲染顺序 = 从左到右，**最右那个胜出**。

| 选择器 | 定义它的文件（按加载顺序） |
| --- | --- |
| `:root` | tokens → motion → layout |
| `.titlebar` | app → electron → shell |
| `.rail` | app → electron → rail |
| `.bubble` | app → electron → chat |
| `.composer textarea` | app → electron → composer |
| `.composer-bar` | app → electron → composer |
| `.status` | app → electron → tools |
| `html[data-theme='light']` | tokens → motion |
| `body` | tokens → electron |
| `.ico` | tokens → icon-state |
| `.btn:active:not(:disabled)` | ui → motion |
| `.tb-name` | app → shell |
| `.tb-right` | app → shell |
| `.workspace` | app → layout |
| `.search` | app → rail |
| `.item` | app → rail |
| `.center` | app → layout |
| `.center > .stream` | app → layout |
| `.stream` | app → chat |
| `.stream-inner` | app → chat |
| `.msg` | app → chat |
| `.msg-label` | app → chat |
| `.think summary` | app → chat |
| `.send` | app → composer |
| `.send:disabled` | app → composer |
| `.sect` | app → tools |
| `.card` | app → tools |
| `.modal-scrim` | motion → dialog |
| `.settings-scrim` | motion → settings |
| `.modal` | motion → dialog |
| `.settings` | motion → settings |
| `.mt-pop` | motion → composer |
| `.row-menu-surface` | motion → rail |
| `.notices` | motion → shell |
| `.notice` | motion → shell |
| `.notice:hover` | motion → shell |
| `.logdrawer` | motion → shell |
| `.connbar` | motion → shell |
| `.outline-preview` | motion → chat |
| `.op-title` | motion → chat |
| `.op-empty` | motion → chat |
| `.rp-now-spin` | motion → tools |
| `.rp-todo.active` | motion → tools |
| `.prose` | electron → chat |
| `.md pre code` | highlight → chat |
| `.app.rail-off .rail` | layout → rail |
| `.term-bar` | chat → terminal |
| `.term-bar .spacer` | chat → terminal |
| `.review` | composer → review |
