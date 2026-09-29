# 样式规则归属表（自动生成）

> 由 `node scripts/css-inventory.mjs --md` 生成。改 CSS 后重新生成再对比。
>
> 加载顺序与级联层见 `styles/index.css`：后面的层整体压过前面的层；**同层内同特异性时后加载者胜**。

## 1. 各文件规模

| 顺序 | 文件 | 层 | 行数 | 唯一选择器 | 规则数 | @media | !important |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | `tokens.css` | tokens | 455 | 27 | 32 | 2 | 6 |
| 2 | `ui.css` | ui | 754 | 135 | 136 | 0 | 0 |
| 3 | `app.css` | modules | 511 | 72 | 73 | 1 | 0 |
| 4 | `motion.css` | modules | 1415 | 172 | 175 | 4 | 0 |
| 5 | `settings.css` | modules | 1116 | 169 | 175 | 1 | 0 |
| 6 | `electron.css` | modules | 35 | 11 | 12 | 0 | 0 |
| 7 | `highlight.css` | modules | 173 | 81 | 81 | 0 | 0 |
| 8 | `layout.css` | modules | 239 | 19 | 20 | 4 | 2 |
| 9 | `shell.css` | modules | 625 | 102 | 106 | 2 | 7 |
| 10 | `dialog.css` | modules | 151 | 19 | 20 | 0 | 0 |
| 11 | `rail.css` | modules | 1064 | 197 | 206 | 0 | 0 |
| 12 | `chat.css` | modules | 2628 | 356 | 412 | 4 | 0 |
| 13 | `composer.css` | modules | 2028 | 300 | 302 | 1 | 0 |
| 14 | `tools.css` | modules | 4113 | 631 | 692 | 5 | 5 |
| 15 | `browser.css` | modules | 420 | 48 | 52 | 0 | 0 |
| 16 | `terminal.css` | modules | 82 | 10 | 10 | 0 | 0 |
| 17 | `review.css` | modules | 1511 | 233 | 234 | 1 | 0 |
| 18 | `workbench.css` | modules | 1812 | 237 | 248 | 2 | 0 |
| 19 | `icon-state.css` | modules | 30 | 1 | 1 | 1 | 0 |
| | **合计** | | **19162** | **2758** | | | |

## 2. 覆盖热力：每个文件「最终胜出」的选择器数

即：这些规则是这个文件说了算的（它是最后一个定义者）。

| 文件 | 最终胜出 |
| --- | ---: |
| `tokens.css` | 23 |
| `ui.css` | 134 |
| `app.css` | 53 |
| `motion.css` | 150 |
| `settings.css` | 169 |
| `electron.css` | 4 |
| `highlight.css` | 80 |
| `layout.css` | 18 |
| `shell.css` | 102 |
| `dialog.css` | 19 |
| `rail.css` | 197 |
| `chat.css` | 350 |
| `composer.css` | 299 |
| `tools.css` | 631 |
| `browser.css` | 48 |
| `terminal.css` | 10 |
| `review.css` | 233 |
| `workbench.css` | 237 |
| `icon-state.css` | 1 |

## 3. 被多个文件定义的选择器（覆盖链）

共 **56** 个选择器在 ≥2 个文件里出现。渲染顺序 = 从左到右，**最右那个胜出**。

| 选择器 | 定义它的文件（按加载顺序） |
| --- | --- |
| `:root` | tokens → motion → layout |
| `.titlebar` | app → electron → shell |
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
| `.settings-body > *` | motion → settings |
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
| `.boot` | motion → shell |
| `.boot-frame` | motion → shell |
| `.boot-prompt` | motion → shell |
| `.boot-cursor` | motion → shell |
| `.boot.out` | motion → shell |
| `.rail` | electron → rail |
| `.prose` | electron → chat |
| `.md pre code` | highlight → chat |
| `.app.rail-off .rail` | layout → rail |
| `.term-bar` | chat → terminal |
| `.term-bar .spacer` | chat → terminal |
| `.sa-head` | chat → composer |
| `.sa-row` | chat → composer |
| `.sa-activity` | chat → composer |
| `.sa-empty` | chat → composer |
| `.review` | composer → review |
