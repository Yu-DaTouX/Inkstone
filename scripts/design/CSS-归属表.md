# 样式规则归属表（自动生成）

> 由 `node scripts/css-inventory.mjs --md` 生成。改 CSS 后重新生成再对比。
>
> 加载顺序与级联层见 `styles/index.css`：后面的层整体压过前面的层；**同层内同特异性时后加载者胜**。

## 1. 各文件规模

| 顺序 | 文件 | 层 | 行数 | 唯一选择器 | 规则数 | @media | !important |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | `tokens.css` | tokens | 464 | 27 | 32 | 1 | 6 |
| 2 | `ui.css` | ui | 1089 | 341 | 354 | 5 | 0 |
| 3 | `app.css` | modules | 517 | 72 | 73 | 1 | 0 |
| 4 | `motion.css` | modules | 1618 | 223 | 226 | 5 | 1 |
| 5 | `settings.css` | modules | 1331 | 204 | 210 | 1 | 0 |
| 6 | `electron.css` | modules | 38 | 14 | 15 | 0 | 0 |
| 7 | `highlight.css` | modules | 173 | 81 | 81 | 0 | 0 |
| 8 | `layout.css` | modules | 239 | 19 | 20 | 4 | 2 |
| 9 | `shell.css` | modules | 690 | 141 | 145 | 2 | 7 |
| 10 | `dialog.css` | modules | 309 | 44 | 45 | 0 | 0 |
| 11 | `rail.css` | modules | 1129 | 207 | 216 | 0 | 0 |
| 12 | `chat.css` | modules | 3581 | 554 | 616 | 6 | 0 |
| 13 | `composer.css` | modules | 2163 | 339 | 345 | 2 | 0 |
| 14 | `approval.css` | modules | 145 | 17 | 17 | 0 | 0 |
| 15 | `tools.css` | modules | 3945 | 614 | 675 | 2 | 5 |
| 16 | `browser.css` | modules | 423 | 49 | 53 | 0 | 0 |
| 17 | `terminal.css` | modules | 82 | 10 | 10 | 0 | 0 |
| 18 | `review.css` | modules | 741 | 97 | 98 | 0 | 0 |
| 19 | `workbench.css` | modules | 1986 | 399 | 416 | 3 | 0 |
| 20 | `workspace.css` | modules | 110 | 88 | 91 | 0 | 0 |
| 21 | `icon-state.css` | modules | 30 | 1 | 1 | 1 | 0 |
| 22 | `scheme.css` | modules | 961 | 184 | 194 | 0 | 0 |
| | **合计** | | **21764** | **3533** | | | |

## 2. 覆盖热力：每个文件「最终胜出」的选择器数

即：这些规则是这个文件说了算的（它是最后一个定义者）。

| 文件 | 最终胜出 |
| --- | ---: |
| `tokens.css` | 23 |
| `ui.css` | 319 |
| `app.css` | 53 |
| `motion.css` | 165 |
| `settings.css` | 204 |
| `electron.css` | 7 |
| `highlight.css` | 80 |
| `layout.css` | 17 |
| `shell.css` | 138 |
| `dialog.css` | 44 |
| `rail.css` | 196 |
| `chat.css` | 493 |
| `composer.css` | 337 |
| `approval.css` | 16 |
| `tools.css` | 614 |
| `browser.css` | 49 |
| `terminal.css` | 10 |
| `review.css` | 97 |
| `workbench.css` | 398 |
| `workspace.css` | 88 |
| `icon-state.css` | 1 |
| `scheme.css` | 184 |

## 3. 被多个文件定义的选择器（覆盖链）

共 **179** 个选择器在 ≥2 个文件里出现。渲染顺序 = 从左到右，**最右那个胜出**。

| 选择器 | 定义它的文件（按加载顺序） |
| --- | --- |
| `:root` | tokens → motion → layout |
| `.mt-pop` | ui → motion → composer |
| `.titlebar` | app → electron → shell |
| `.stream` | app → chat → scheme |
| `.bubble` | app → electron → chat |
| `.composer textarea` | app → electron → composer |
| `.composer-bar` | app → electron → composer |
| `.status` | app → electron → tools |
| `.outline-preview` | motion → chat → scheme |
| `.vb-card` | motion → chat → scheme |
| `.vb-tile` | motion → chat → scheme |
| `.vb-stepper-panel` | motion → chat → scheme |
| `.vb-ask` | motion → chat → scheme |
| `html[data-theme='light']` | tokens → motion |
| `body` | tokens → electron |
| `.ico` | tokens → icon-state |
| `.btn:active:not(:disabled)` | ui → motion |
| `.model-row` | ui → composer |
| `.ui-usage-num` | ui → shell |
| `.quota-block-sub` | ui → shell |
| `.quota-pop-foot` | ui → shell |
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
| `.market-item` | motion → settings |
| `.env-menu` | motion → review |
| `.row-menu-surface` | motion → rail |
| `.notices` | motion → shell |
| `.notice` | motion → shell |
| `.notice:hover` | motion → shell |
| `.logdrawer` | motion → shell |
| `.connbar` | motion → shell |
| `.outline-preview .op-head` | motion → scheme |
| `.op-title` | motion → chat |
| `.op-answer` | motion → scheme |
| `.op-empty` | motion → chat |
| `.msg.assistant` | motion → scheme |
| `.cborder` | motion → scheme |
| `.cborder.busy` | motion → scheme |
| `.rp-now-spin` | motion → tools |
| `.boot` | motion → shell |
| `.boot-frame` | motion → shell |
| `.boot-prompt` | motion → shell |
| `.boot-cursor` | motion → shell |
| `.boot.out` | motion → shell |
| `.srow-wrap` | motion → rail |
| `.session-children` | motion → rail |
| `.rail-more-sessions` | motion → rail |
| `.srow-rename-input` | motion → rail |
| `.proj-rename-input` | motion → rail |
| `.proj-head.drop-before::before` | motion → rail |
| `.proj-head.drop-after::after` | motion → rail |
| `.proj-group-heading.drop-before::before` | motion → rail |
| `.proj-group-heading.drop-after::after` | motion → rail |
| `.srow-wrap.is-dragging` | motion → rail |
| `.proj-head.is-dragging` | motion → rail |
| `.rail-trash` | motion → rail |
| `.split-drop` | motion → chat |
| `.split-peer-state` | motion → chat |
| `.rp-float-tile` | motion → tools |
| `.rp-float-tile.locate-flash` | motion → tools |
| `.rp-snap-guide` | motion → tools |
| `.rp-float-notice` | motion → tools |
| `.vb-bar` | motion → chat |
| `.vb-value` | motion → chat |
| `.vb-step-wrap` | motion → chat |
| `.vb-result` | motion → chat |
| `.vb-pending` | motion → chat |
| `.qform-field` | motion → composer |
| `.qform-error` | motion → composer |
| `.rail` | electron → rail |
| `.prose` | electron → chat |
| `.md pre code` | highlight → chat |
| `.app.rail-off .rail` | layout → rail |
| `html[data-theme='light'] .outline-preview` | layout → scheme |
| `.statusbar` | shell → scheme |
| `.sb-mode[data-mode='run']` | shell → scheme |
| `.sb-mode[data-mode='wait']` | shell → scheme |
| `.srow-row` | rail → scheme |
| `.srow-row:hover` | rail → scheme |
| `.srow` | rail → scheme |
| `.srow-dot` | rail → scheme |
| `.srow-row.selected .srow-dot` | rail → scheme |
| `.srow-dot.waiting` | rail → scheme |
| `.srow-dot.failed` | rail → scheme |
| `.srow-dot.iso` | rail → scheme |
| `.srow-dot.iso.blocked` | rail → scheme |
| `.srow-dot.unread` | rail → scheme |
| `.srow-time` | rail → scheme |
| … | 另有 59 个 |
