# 样式规则归属表（自动生成）

> 由 `node scripts/css-inventory.mjs --md` 生成。改 CSS 后重新生成再对比。
>
> 加载顺序与级联层见 `styles/index.css`：后面的层整体压过前面的层；**同层内同特异性时后加载者胜**。

## 1. 各文件规模

| 顺序 | 文件 | 层 | 行数 | 唯一选择器 | 规则数 | @media | !important |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | `tokens.css` | tokens | 456 | 27 | 32 | 2 | 6 |
| 2 | `ui.css` | ui | 921 | 281 | 284 | 5 | 0 |
| 3 | `app.css` | modules | 517 | 72 | 73 | 1 | 0 |
| 4 | `motion.css` | modules | 1419 | 172 | 175 | 4 | 0 |
| 5 | `settings.css` | modules | 1116 | 169 | 175 | 1 | 0 |
| 6 | `electron.css` | modules | 38 | 14 | 15 | 0 | 0 |
| 7 | `highlight.css` | modules | 173 | 81 | 81 | 0 | 0 |
| 8 | `layout.css` | modules | 239 | 19 | 20 | 4 | 2 |
| 9 | `shell.css` | modules | 682 | 139 | 143 | 2 | 7 |
| 10 | `dialog.css` | modules | 151 | 19 | 20 | 0 | 0 |
| 11 | `rail.css` | modules | 1064 | 197 | 206 | 0 | 0 |
| 12 | `chat.css` | modules | 2704 | 379 | 437 | 5 | 0 |
| 13 | `composer.css` | modules | 2037 | 301 | 304 | 1 | 0 |
| 14 | `tools.css` | modules | 3960 | 616 | 677 | 2 | 5 |
| 15 | `browser.css` | modules | 420 | 48 | 52 | 0 | 0 |
| 16 | `terminal.css` | modules | 82 | 10 | 10 | 0 | 0 |
| 17 | `review.css` | modules | 631 | 84 | 84 | 0 | 0 |
| 18 | `workbench.css` | modules | 1953 | 375 | 391 | 3 | 0 |
| 19 | `workspace.css` | modules | 69 | 64 | 64 | 0 | 0 |
| 20 | `icon-state.css` | modules | 30 | 1 | 1 | 1 | 0 |
| | **合计** | | **18662** | **2991** | | | |

## 2. 覆盖热力：每个文件「最终胜出」的选择器数

即：这些规则是这个文件说了算的（它是最后一个定义者）。

| 文件 | 最终胜出 |
| --- | ---: |
| `tokens.css` | 23 |
| `ui.css` | 260 |
| `app.css` | 53 |
| `motion.css` | 150 |
| `settings.css` | 169 |
| `electron.css` | 7 |
| `highlight.css` | 80 |
| `layout.css` | 18 |
| `shell.css` | 139 |
| `dialog.css` | 19 |
| `rail.css` | 197 |
| `chat.css` | 377 |
| `composer.css` | 301 |
| `tools.css` | 616 |
| `browser.css` | 48 |
| `terminal.css` | 10 |
| `review.css` | 84 |
| `workbench.css` | 375 |
| `workspace.css` | 64 |
| `icon-state.css` | 1 |

## 3. 被多个文件定义的选择器（覆盖链）

共 **71** 个选择器在 ≥2 个文件里出现。渲染顺序 = 从左到右，**最右那个胜出**。

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
| `.ui-usage-num` | ui → shell |
| `.quota-block-sub` | ui → shell |
| `.quota-pop-foot` | ui → shell |
| `.ctx-window-note` | ui → shell |
| `.agent-chat-user` | ui → workbench |
| `.agent-chat-packet` | ui → workbench |
| `.agent-chat-report` | ui → workbench |
| `.agent-chat-meta` | ui → workbench |
| `.agent-chat-who` | ui → workbench |
| `.agent-chat-bubble-text` | ui → workbench |
| `.agent-chat-tool > summary` | ui → workbench |
| `.agent-chat-kind` | ui → workbench |
| `.agent-chat-cmd` | ui → workbench |
| `.agent-chat-out` | ui → workbench |
| `.agent-chat-diff` | ui → workbench |
| `.agent-chat-approval` | ui → workbench |
| `.agent-chat-approval-detail` | ui → workbench |
| `.agent-chat-working` | ui → workbench |
| `.agent-chat-end` | ui → workbench |
| `.agent-tree` | ui → workbench |
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
