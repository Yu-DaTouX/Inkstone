# 设计令牌散落值清单（自动生成）

> 由 `node scripts/css-drift.mjs --md` 生成。改令牌或补 token 后重新生成再对比。
>
> V-0 的输入之一：`可映射` = 有**同值**的令牌，可考虑替换；`无对应` = 需要设计决策。
> 语法高亮色板 `highlight.css` 不计（它不是 UI 语义令牌）。

## 1. 各文件散落值

| 文件 | 颜色 | 其中可映射 | px | 其中可映射 | 时长 | 其中可映射 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `tokens.css` | 0 | 0 | 13 | 12 | 0 | 0 |
| `ui.css` | 0 | 0 | 89 | 57 | 0 | 0 |
| `app.css` | 4 | 2 | 15 | 8 | 0 | 0 |
| `motion.css` | 2 | 0 | 198 | 191 | 0 | 0 |
| `settings.css` | 6 | 2 | 79 | 43 | 0 | 0 |
| `electron.css` | 0 | 0 | 0 | 0 | 0 | 0 |
| `highlight.css` | 0 | 0 | 0 | 0 | 0 | 0 |
| `layout.css` | 2 | 2 | 2 | 1 | 0 | 0 |
| `shell.css` | 3 | 1 | 43 | 21 | 0 | 0 |
| `dialog.css` | 1 | 0 | 13 | 7 | 0 | 0 |
| `rail.css` | 1 | 1 | 72 | 52 | 0 | 0 |
| `chat.css` | 34 | 10 | 135 | 90 | 0 | 0 |
| `composer.css` | 2 | 0 | 115 | 80 | 0 | 0 |
| `approval.css` | 0 | 0 | 0 | 0 | 0 | 0 |
| `tools.css` | 3 | 2 | 284 | 207 | 0 | 0 |
| `browser.css` | 1 | 1 | 26 | 18 | 0 | 0 |
| `terminal.css` | 0 | 0 | 0 | 0 | 0 | 0 |
| `review.css` | 0 | 0 | 81 | 51 | 0 | 0 |
| `workbench.css` | 0 | 0 | 155 | 120 | 0 | 0 |
| `workspace.css` | 0 | 0 | 9 | 5 | 0 | 0 |
| `icon-state.css` | 0 | 0 | 0 | 0 | 0 | 0 |
| **合计** | **59** | **21** | **1329** | **963** | **0** | **0** |

## 2. 无对应令牌的值（语义缺口）

| 值 | 类别 | 出现次数 | 文件 |
| --- | --- | ---: | --- |
| `18px` | length | 32 | browser.css, chat.css, composer.css, rail.css, settings.css, tools.css, ui.css, workbench.css |
| `20px` | length | 26 | chat.css, composer.css, rail.css, settings.css, shell.css, tools.css, ui.css |
| `10px` | length | 24 | chat.css, composer.css, motion.css, rail.css, settings.css, shell.css, tools.css, ui.css, workbench.css |
| `22px` | length | 21 | chat.css, composer.css, review.css, shell.css, tools.css, ui.css, workbench.css |
| `26px` | length | 20 | app.css, browser.css, chat.css, composer.css, rail.css, settings.css, shell.css, tools.css, ui.css, workbench.css |
| `220px` | length | 16 | chat.css, motion.css, review.css, settings.css, shell.css, tools.css, ui.css, workbench.css, workspace.css |
| `36px` | length | 14 | chat.css, composer.css, layout.css, review.css, tools.css, ui.css |
| `320px` | length | 13 | chat.css, composer.css, settings.css, shell.css, tools.css, ui.css, workbench.css |
| `420px` | length | 10 | chat.css, composer.css, review.css, tools.css, ui.css, workbench.css |
| `5px` | length | 9 | chat.css, composer.css, shell.css, tools.css, ui.css |
| `120px` | length | 9 | composer.css, motion.css, settings.css, tools.css, workbench.css |
| `180px` | length | 9 | browser.css, composer.css, dialog.css, settings.css, shell.css, tools.css, workbench.css |
| `11.5px` | length | 9 | review.css, settings.css |
| `240px` | length | 8 | browser.css, composer.css, ui.css, workbench.css, workspace.css |
| `34px` | length | 8 | app.css, chat.css, composer.css, rail.css, tools.css, workbench.css |
| `160px` | length | 8 | browser.css, chat.css, review.css, settings.css, tools.css, workbench.css |
| `rgb(0, 0, 0, 1.000)` | color | 7 | chat.css, composer.css, dialog.css, settings.css |
| `260px` | length | 7 | composer.css, dialog.css, settings.css, tools.css |
| `30px` | length | 6 | chat.css, composer.css, motion.css, review.css, tools.css, ui.css |
| `64px` | length | 6 | composer.css, settings.css, tools.css, workbench.css |
| `280px` | length | 6 | chat.css, tools.css, workbench.css |
| `96px` | length | 5 | composer.css, dialog.css, review.css, tools.css, ui.css |
| `200px` | length | 5 | app.css, settings.css, tools.css |
| `10.5px` | length | 5 | review.css, settings.css |
| `360px` | length | 5 | chat.css, composer.css, review.css, tools.css |
| `99px` | length | 4 | app.css, shell.css, tokens.css |
| `56px` | length | 4 | shell.css, ui.css |
| `rgb(0, 0, 0)` | color | 4 | app.css, motion.css |
| `1.5px` | length | 4 | chat.css, rail.css, settings.css |
| `140px` | length | 4 | browser.css, chat.css, shell.css, workspace.css |
| `560px` | length | 4 | composer.css, dialog.css |
| `620px` | length | 4 | chat.css, tools.css |
| `300px` | length | 3 | motion.css, shell.css, workbench.css |
| `72px` | length | 3 | settings.css |
| `52px` | length | 3 | composer.css, shell.css, workbench.css |
| `rgb(214, 214, 214)` | color | 3 | chat.css |
| `rgb(126, 231, 135)` | color | 3 | chat.css |
| `150px` | length | 3 | tools.css |
| `42px` | length | 3 | browser.css, tools.css |
| `720px` | length | 2 | app.css, settings.css |
| `rgb(20, 20, 18, 0.000)` | color | 2 | settings.css |
| `380px` | length | 2 | shell.css, workbench.css |
| `88px` | length | 2 | shell.css, workbench.css |
| `430px` | length | 2 | composer.css, rail.css |
| `rgb(127, 127, 127)` | color | 2 | chat.css |
| `rgb(111, 111, 111)` | color | 2 | chat.css |
| `480px` | length | 2 | chat.css, workbench.css |
| `78px` | length | 2 | composer.css, tools.css |
| `9.5px` | length | 2 | tools.css |
| `17px` | length | 2 | review.css |
| `190px` | length | 2 | review.css, workbench.css |
| `168px` | length | 1 | ui.css |
| `400px` | length | 1 | motion.css |
| `184px` | length | 1 | settings.css |
| `960px` | length | 1 | settings.css |
| `700px` | length | 1 | settings.css |
| `600px` | length | 1 | settings.css |
| `46px` | length | 1 | shell.css |
| `rgb(196, 43, 28)` | color | 1 | shell.css |
| `rgb(177, 38, 26)` | color | 1 | shell.css |
| … | | | 其余 34 条省略 |

## 3. 定义了但没被引用的令牌

- `--dur-1150`
- `--dur-1500`
- `--dur-1900`
- `--dur-320`

## 4. 同一令牌有多个值（主题差异或重复定义）

| 令牌 | 值 | 定义于 |
| --- | --- | --- |
| `--d-row-gap` | 3px / 1px / 7px | tokens.css |
| `--d-section-gap` | 3px / 1px / 9px | tokens.css |
| `--d-message-gap` | 32px / 16px / 48px | tokens.css |
| `--w-stream` | 800px / 980px | tokens.css |
| `--bg-0` | #151515 / #fcfcfa | tokens.css |
| `--bg-1` | #1b1b1a / #f3f3f0 | tokens.css |
| `--bg-2` | #222221 / #ffffff | tokens.css |
| `--bg-3` | #2b2b29 / #eaeae6 | tokens.css |
| `--bg-4` | #393936 / #deded9 | tokens.css |
| `--border-soft` | rgba(255, 255, 255, 0.06) / rgba(0, 0, 0, 0.07) | tokens.css |
| `--border` | rgba(255, 255, 255, 0.1) / rgba(0, 0, 0, 0.13) | tokens.css |
| `--border-str` | rgba(255, 255, 255, 0.16) / rgba(0, 0, 0, 0.2) | tokens.css |
| `--edge` | rgba(255, 255, 255, 0.07) / rgba(0, 0, 0, 0.04) | tokens.css |
| `--split-dim` | rgba(21, 21, 21, 0.38) / rgba(252, 252, 250, 0.5) | tokens.css |
| `--fg` | #ecece8 / #252522 | tokens.css |
| `--fg-dim` | #b4b4ac / #55554f | tokens.css |
| `--fg-mute` | #92928a / #6a6a63 | tokens.css |
| `--accent` | #93a4f4 / #4b5dbf | tokens.css |
| `--accent-soft` | rgba(147, 164, 244, 0.16) / rgba(75, 93, 191, 0.1) | tokens.css |
| `--accent-line` | rgba(147, 164, 244, 0.52) / rgba(75, 93, 191, 0.42) | tokens.css |
| `--ok` | #34d399 / #047857 | tokens.css |
| `--ok-soft` | rgba(52, 211, 153, 0.16) / rgba(4, 120, 87, 0.1) | tokens.css |
| `--warn` | #fbbf24 / #9a4508 | tokens.css |
| `--warn-soft` | rgba(251, 191, 36, 0.16) / rgba(154, 69, 8, 0.1) | tokens.css |
| `--err` | #ff6467 / #c42020 | tokens.css |
| `--err-soft` | rgba(255, 100, 103, 0.16) / rgba(196, 32, 32, 0.1) | tokens.css |
| `--magenta` | #c084fc / #9333ea | tokens.css |
| `--code-bg` | #0d1117 / #f6f8fa | tokens.css |
| `--code-fg` | #c9d1d9 / #24292f | tokens.css |
| `--code-inline-bg` | rgba(255, 255, 255, 0.07) / rgba(0, 0, 0, 0.055) | tokens.css |
| `--code-inline-fg` | #cdd6dc / #45525a | tokens.css |
| `--on-accent` | #10131f / #ffffff | tokens.css |
| `--shadow-pop` | 0 12px 32px -8px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(0, 0, 0, 0.2) / 0 12px 32px -10px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.04) | tokens.css |
| `--w-right` | var(--w-panel-user, 264px) / var(--w-panel-user, 220px) / 0px / var(--w-panel-user, 336px) / min(var(--w-panel-user, 190px), max(170px, calc((100vw - 360px) / 2))) / min(var(--w-panel-user, 170px), max(170px, calc((100vw - 360px) / 2))) / min(calc(var(--w-panel-user, 340px) + 400px), max(400px, calc(100vw - var(--w-rail) - 420px))) / calc(100vw - var(--w-rail)) / min(420px, 48vw) | tokens.css, layout.css, workbench.css |
| `--think-off` | #8a8a84 / #6a6a64 | motion.css |
| `--think-minimal` | #a4a49e / #5c5c56 | motion.css |
| `--think-low` | #6990b8 / #335d82 | motion.css |
| `--think-medium` | #81a2be / #40719a | motion.css |
| `--think-high` | #b294bb / #7a5f8c | motion.css |
| `--think-xhigh` | #d183e8 / #8b4bb0 | motion.css |
| `--think-max` | #ff5fff / #a300a3 | motion.css |
| `--h` | currentcolor / var(--accent) / var(--fg-dim) | motion.css |
| `--t` | color-mix(in srgb, currentcolor 55%, transparent) / var(--accent-line) / var(--fg-mute) | motion.css |
| `--w-rail` | var(--w-rail-collapsed) / var(--w-rail-user, 248px) / min(var(--w-rail-user, 210px), max(180px, calc(100vw - 360px - var(--w-right)))) / min(var(--w-rail-user, 180px), max(180px, calc(100vw - 360px - var(--w-right)))) | layout.css |
| `--sg-tone` | var(--fg-mute) / var(--accent) / var(--ok) / var(--warn) / var(--err) | chat.css |

## 5. 概况

- 令牌总数：142（被引用 138）
- 令牌引用点：5167（含组件内联 style）
