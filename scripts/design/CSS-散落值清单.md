# 设计令牌散落值清单（自动生成）

> 由 `node scripts/css-drift.mjs --md` 生成。改令牌或补 token 后重新生成再对比。
>
> V-0 的输入之一：`可映射` = 有**同值**的令牌，可考虑替换；`无对应` = 需要设计决策。
> 语法高亮色板 `highlight.css` 不计（它不是 UI 语义令牌）。

## 1. 各文件散落值

| 文件 | 颜色 | 其中可映射 | px | 其中可映射 | 时长 | 其中可映射 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `tokens.css` | 0 | 0 | 13 | 8 | 0 | 0 |
| `ui.css` | 4 | 0 | 101 | 69 | 0 | 0 |
| `app.css` | 4 | 0 | 15 | 8 | 0 | 0 |
| `motion.css` | 2 | 0 | 198 | 189 | 0 | 0 |
| `settings.css` | 6 | 1 | 83 | 48 | 0 | 0 |
| `electron.css` | 0 | 0 | 0 | 0 | 0 | 0 |
| `highlight.css` | 0 | 0 | 0 | 0 | 0 | 0 |
| `layout.css` | 2 | 0 | 2 | 0 | 0 | 0 |
| `shell.css` | 3 | 1 | 43 | 24 | 0 | 0 |
| `dialog.css` | 1 | 0 | 13 | 7 | 0 | 0 |
| `rail.css` | 1 | 0 | 72 | 59 | 0 | 0 |
| `chat.css` | 34 | 10 | 138 | 87 | 0 | 0 |
| `composer.css` | 2 | 0 | 115 | 82 | 0 | 0 |
| `approval.css` | 0 | 0 | 0 | 0 | 0 | 0 |
| `tools.css` | 3 | 0 | 284 | 212 | 0 | 0 |
| `browser.css` | 1 | 1 | 26 | 18 | 0 | 0 |
| `terminal.css` | 0 | 0 | 0 | 0 | 0 | 0 |
| `review.css` | 0 | 0 | 81 | 55 | 0 | 0 |
| `workbench.css` | 0 | 0 | 155 | 117 | 0 | 0 |
| `workspace.css` | 0 | 0 | 9 | 6 | 0 | 0 |
| `icon-state.css` | 0 | 0 | 0 | 0 | 0 | 0 |
| `scheme.css` | 0 | 0 | 2 | 2 | 0 | 0 |
| **合计** | **63** | **13** | **1350** | **991** | **0** | **0** |

## 2. 无对应令牌的值（语义缺口）

| 值 | 类别 | 出现次数 | 文件 |
| --- | --- | ---: | --- |
| `14px` | length | 42 | app.css, browser.css, chat.css, composer.css, layout.css, motion.css, rail.css, review.css, settings.css, tokens.css, tools.css, ui.css, workbench.css |
| `18px` | length | 32 | browser.css, chat.css, composer.css, rail.css, settings.css, tools.css, ui.css, workbench.css |
| `10px` | length | 24 | chat.css, composer.css, motion.css, rail.css, settings.css, shell.css, tools.css, ui.css, workbench.css |
| `26px` | length | 20 | app.css, browser.css, chat.css, composer.css, rail.css, settings.css, shell.css, tools.css, ui.css, workbench.css |
| `220px` | length | 16 | chat.css, motion.css, review.css, settings.css, shell.css, tools.css, ui.css, workbench.css, workspace.css |
| `36px` | length | 14 | chat.css, composer.css, layout.css, review.css, tools.css, ui.css |
| `320px` | length | 13 | chat.css, composer.css, settings.css, shell.css, tools.css, ui.css, workbench.css |
| `420px` | length | 12 | chat.css, composer.css, review.css, tools.css, ui.css, workbench.css |
| `rgb(0, 0, 0, 0.000)` | color | 10 | app.css, layout.css, rail.css, settings.css, tools.css, ui.css |
| `180px` | length | 10 | browser.css, composer.css, dialog.css, settings.css, shell.css, tools.css, workbench.css |
| `5px` | length | 9 | chat.css, composer.css, shell.css, tools.css, ui.css |
| `120px` | length | 9 | composer.css, motion.css, settings.css, tools.css, workbench.css |
| `11.5px` | length | 9 | review.css, settings.css |
| `160px` | length | 8 | browser.css, chat.css, review.css, settings.css, tools.css, workbench.css |
| `34px` | length | 7 | app.css, chat.css, composer.css, rail.css, tools.css, workbench.css |
| `rgb(0, 0, 0, 1.000)` | color | 7 | chat.css, composer.css, dialog.css, settings.css |
| `260px` | length | 7 | composer.css, dialog.css, settings.css, tools.css |
| `rgb(0, 0, 0)` | color | 6 | app.css, motion.css, ui.css |
| `1.5px` | length | 6 | chat.css, rail.css, settings.css, ui.css |
| `30px` | length | 6 | chat.css, composer.css, motion.css, review.css, tools.css, ui.css |
| `64px` | length | 6 | composer.css, settings.css, tools.css, workbench.css |
| `280px` | length | 6 | chat.css, tools.css, workbench.css |
| `96px` | length | 5 | composer.css, dialog.css, review.css, tools.css, ui.css |
| `200px` | length | 5 | app.css, settings.css, tools.css |
| `10.5px` | length | 5 | review.css, settings.css |
| `140px` | length | 5 | browser.css, chat.css, shell.css, workspace.css |
| `99px` | length | 4 | app.css, shell.css, tokens.css |
| `72px` | length | 4 | settings.css, ui.css |
| `56px` | length | 4 | shell.css, ui.css |
| `52px` | length | 4 | composer.css, shell.css, workbench.css |
| `360px` | length | 4 | chat.css, review.css, tools.css |
| `300px` | length | 3 | motion.css, shell.css, workbench.css |
| `560px` | length | 3 | composer.css, dialog.css |
| `620px` | length | 3 | chat.css, tools.css |
| `rgb(214, 214, 214)` | color | 3 | chat.css |
| `rgb(126, 231, 135)` | color | 3 | chat.css |
| `150px` | length | 3 | tools.css |
| `42px` | length | 3 | browser.css, tools.css |
| `rgb(20, 20, 18, 0.000)` | color | 2 | settings.css |
| `600px` | length | 2 | chat.css, settings.css |
| `380px` | length | 2 | shell.css, workbench.css |
| `88px` | length | 2 | shell.css, workbench.css |
| `640px` | length | 2 | chat.css, dialog.css |
| `430px` | length | 2 | composer.css, rail.css |
| `rgb(127, 127, 127)` | color | 2 | chat.css |
| `rgb(111, 111, 111)` | color | 2 | chat.css |
| `480px` | length | 2 | chat.css, workbench.css |
| `680px` | length | 2 | chat.css, composer.css |
| `78px` | length | 2 | composer.css, tools.css |
| `9.5px` | length | 2 | tools.css |
| `190px` | length | 2 | review.css, workbench.css |
| `100px` | length | 1 | ui.css |
| `0.4px` | length | 1 | ui.css |
| `168px` | length | 1 | ui.css |
| `400px` | length | 1 | motion.css |
| `184px` | length | 1 | settings.css |
| `960px` | length | 1 | settings.css |
| `700px` | length | 1 | settings.css |
| `46px` | length | 1 | shell.css |
| `rgb(196, 43, 28)` | color | 1 | shell.css |
| … | | | 其余 34 条省略 |

## 3. 定义了但没被引用的令牌

- `--dur-1150`
- `--dur-1500`
- `--dur-1900`
- `--dur-320`
- `--font-sans`
- `--vb-1`
- `--vb-2`
- `--vb-3`
- `--vb-4`

## 4. 同一令牌有多个值（主题差异或重复定义）

| 令牌 | 值 | 定义于 |
| --- | --- | --- |
| `--d-row-gap` | 3px / 1px / 7px | tokens.css |
| `--d-section-gap` | 3px / 1px / 9px | tokens.css |
| `--d-message-gap` | 32px / 16px / 48px | tokens.css |
| `--bg-0` | #17191d / #f6f7f9 | tokens.css |
| `--bg-1` | #1f2228 / #eef0f3 | tokens.css |
| `--bg-2` | #282c34 / #ffffff | tokens.css |
| `--bg-3` | #2d3340 / #e3e7ee | tokens.css |
| `--bg-4` | #3a414e / #d5dae2 | tokens.css |
| `--border-soft` | rgba(255, 255, 255, 0.07) / rgba(20, 30, 50, 0.07) | tokens.css |
| `--border` | rgba(255, 255, 255, 0.11) / rgba(20, 30, 50, 0.13) | tokens.css |
| `--border-str` | rgba(255, 255, 255, 0.18) / rgba(20, 30, 50, 0.2) | tokens.css |
| `--edge` | rgba(255, 255, 255, 0.07) / rgba(20, 30, 50, 0.04) | tokens.css |
| `--split-dim` | rgba(23, 25, 29, 0.38) / rgba(246, 247, 249, 0.5) | tokens.css |
| `--fg` | #e5e7eb / #242830 | tokens.css |
| `--fg-dim` | #b3bac5 / #505966 | tokens.css |
| `--fg-mute` | #929caa / #5e6876 | tokens.css |
| `--accent` | #93a8ff / #4059ad | tokens.css |
| `--accent-soft` | rgba(147, 168, 255, 0.16) / rgba(64, 89, 173, 0.1) | tokens.css |
| `--accent-line` | rgba(147, 168, 255, 0.5) / rgba(64, 89, 173, 0.42) | tokens.css |
| `--ok` | #82c7a0 / #216a4b | tokens.css |
| `--ok-soft` | rgba(130, 199, 160, 0.14) / rgba(33, 106, 75, 0.1) | tokens.css |
| `--warn` | #e8b17b / #8a430d | tokens.css |
| `--warn-soft` | rgba(232, 177, 123, 0.14) / rgba(138, 67, 13, 0.1) | tokens.css |
| `--err` | #f5a2a2 / #a53030 | tokens.css |
| `--err-soft` | rgba(245, 162, 162, 0.13) / rgba(165, 48, 48, 0.09) | tokens.css |
| `--magenta` | #c4a5f5 / #7e3fc4 | tokens.css |
| `--code-bg` | #1c1f24 / #ebedf1 | tokens.css |
| `--code-fg` | #c9d1d9 / #24292f | tokens.css |
| `--code-inline-bg` | rgba(255, 255, 255, 0.07) / rgba(20, 30, 50, 0.06) | tokens.css |
| `--code-inline-fg` | #cfd5de / #3c4654 | tokens.css |
| `--on-accent` | #17191d / #ffffff | tokens.css |
| `--shadow-pop` | 0 14px 36px -14px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(0, 0, 0, 0.2) / 0 14px 36px -14px rgba(20, 30, 50, 0.28), 0 0 0 1px rgba(20, 30, 50, 0.05) | tokens.css |
| `--w-right` | var(--w-panel-user, 264px) / var(--w-panel-user, 220px) / 0px / var(--w-panel-user, 336px) / min(var(--w-panel-user, 190px), max(170px, calc((100vw - 360px) / 2))) / min(var(--w-panel-user, 170px), max(170px, calc((100vw - 360px) / 2))) / min(calc(var(--w-panel-user, 340px) + 400px), max(400px, calc(100vw - var(--w-rail) - 420px))) / calc(100vw - var(--w-rail)) / min(420px, 48vw) | tokens.css, layout.css, workbench.css |
| `--think-off` | #868991 / #64676e | motion.css |
| `--think-minimal` | #93a3b5 / #566676 | motion.css |
| `--think-low` | #5fbfc9 / #137a85 | motion.css |
| `--think-medium` | #7aa7f5 / #2f62c9 | motion.css |
| `--think-high` | #9d92f6 / #5a4cc7 | motion.css |
| `--think-xhigh` | #d38be0 / #9a3fae | motion.css |
| `--think-max` | #f26b6b / #bf2e2e | motion.css |
| `--h` | currentcolor / var(--accent) / var(--fg-dim) | motion.css |
| `--t` | color-mix(in srgb, currentcolor 55%, transparent) / var(--accent-line) / var(--fg-mute) | motion.css |
| `--w-rail` | var(--w-rail-collapsed) / var(--w-rail-user, 248px) / min(var(--w-rail-user, 210px), max(180px, calc(100vw - 360px - var(--w-right)))) / min(var(--w-rail-user, 180px), max(180px, calc(100vw - 360px - var(--w-right)))) | layout.css |
| `--artifact-html-h` | clamp(200px, 40vh, 380px) / clamp(320px, 75vh, 860px) | chat.css |
| `--sg-tone` | var(--fg-mute) / var(--accent) / var(--ok) / var(--warn) / var(--err) | chat.css |

## 5. 概况

- 令牌总数：154（被引用 145）
- 令牌引用点：5905（含组件内联 style）
