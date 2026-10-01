# 设计令牌散落值清单（自动生成）

> 由 `node scripts/css-drift.mjs --md` 生成。改令牌或补 token 后重新生成再对比。
>
> V-0 的输入之一：`可映射` = 有**同值**的令牌，可考虑替换；`无对应` = 需要设计决策。
> 语法高亮色板 `highlight.css` 不计（它不是 UI 语义令牌）。

## 1. 各文件散落值

| 文件 | 颜色 | 其中可映射 | px | 其中可映射 | 时长 | 其中可映射 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `tokens.css` | 0 | 0 | 13 | 12 | 0 | 0 |
| `ui.css` | 0 | 0 | 92 | 59 | 0 | 0 |
| `app.css` | 1 | 0 | 15 | 8 | 0 | 0 |
| `motion.css` | 2 | 0 | 199 | 192 | 0 | 0 |
| `settings.css` | 6 | 2 | 79 | 43 | 0 | 0 |
| `electron.css` | 0 | 0 | 0 | 0 | 0 | 0 |
| `highlight.css` | 0 | 0 | 0 | 0 | 0 | 0 |
| `layout.css` | 2 | 2 | 2 | 1 | 0 | 0 |
| `shell.css` | 3 | 1 | 41 | 20 | 0 | 0 |
| `dialog.css` | 1 | 0 | 6 | 3 | 0 | 0 |
| `rail.css` | 0 | 0 | 68 | 49 | 0 | 0 |
| `chat.css` | 34 | 11 | 129 | 87 | 0 | 0 |
| `composer.css` | 2 | 0 | 113 | 76 | 0 | 0 |
| `tools.css` | 6 | 3 | 287 | 209 | 0 | 0 |
| `browser.css` | 1 | 1 | 28 | 18 | 0 | 0 |
| `terminal.css` | 0 | 0 | 0 | 0 | 0 | 0 |
| `review.css` | 1 | 0 | 78 | 49 | 0 | 0 |
| `workbench.css` | 0 | 0 | 154 | 118 | 0 | 0 |
| `workspace.css` | 0 | 0 | 8 | 4 | 0 | 0 |
| `icon-state.css` | 0 | 0 | 0 | 0 | 0 | 0 |
| **合计** | **59** | **20** | **1312** | **948** | **0** | **0** |

## 2. 无对应令牌的值（语义缺口）

| 值 | 类别 | 出现次数 | 文件 |
| --- | --- | ---: | --- |
| `18px` | length | 32 | browser.css, chat.css, composer.css, rail.css, settings.css, tools.css, ui.css, workbench.css |
| `10px` | length | 31 | browser.css, chat.css, composer.css, motion.css, rail.css, settings.css, shell.css, tools.css, ui.css, workbench.css |
| `20px` | length | 27 | chat.css, composer.css, rail.css, settings.css, shell.css, tools.css, ui.css |
| `22px` | length | 20 | chat.css, composer.css, review.css, shell.css, tools.css, ui.css, workbench.css |
| `26px` | length | 19 | app.css, browser.css, composer.css, rail.css, settings.css, shell.css, tools.css, ui.css, workbench.css |
| `220px` | length | 15 | chat.css, motion.css, review.css, settings.css, tools.css, ui.css, workbench.css, workspace.css |
| `320px` | length | 14 | chat.css, composer.css, review.css, settings.css, shell.css, tools.css, ui.css, workbench.css |
| `36px` | length | 14 | chat.css, composer.css, layout.css, review.css, tools.css, ui.css |
| `420px` | length | 10 | chat.css, composer.css, review.css, tools.css, ui.css, workbench.css |
| `11.5px` | length | 10 | review.css, settings.css |
| `120px` | length | 9 | composer.css, motion.css, settings.css, tools.css, workbench.css |
| `180px` | length | 9 | browser.css, composer.css, dialog.css, settings.css, shell.css, tools.css, workbench.css |
| `240px` | length | 8 | browser.css, composer.css, ui.css, workbench.css, workspace.css |
| `34px` | length | 8 | app.css, chat.css, composer.css, rail.css, tools.css, workbench.css |
| `160px` | length | 8 | browser.css, chat.css, review.css, settings.css, tools.css, workbench.css |
| `rgb(0, 0, 0, 1.000)` | color | 7 | chat.css, composer.css, dialog.css, settings.css |
| `5px` | length | 6 | shell.css, tools.css, ui.css |
| `260px` | length | 6 | composer.css, settings.css, tools.css |
| `280px` | length | 6 | chat.css, tools.css, workbench.css |
| `96px` | length | 5 | composer.css, dialog.css, review.css, tools.css, ui.css |
| `1.5px` | length | 5 | chat.css, rail.css, settings.css, ui.css |
| `200px` | length | 5 | app.css, settings.css, tools.css |
| `64px` | length | 5 | composer.css, settings.css, tools.css, workbench.css |
| `10.5px` | length | 5 | review.css, settings.css |
| `99px` | length | 4 | app.css, shell.css, tokens.css |
| `56px` | length | 4 | shell.css, ui.css |
| `30px` | length | 4 | chat.css, composer.css, motion.css, tools.css |
| `140px` | length | 4 | browser.css, chat.css, shell.css, workspace.css |
| `620px` | length | 4 | chat.css, tools.css |
| `360px` | length | 4 | chat.css, composer.css, tools.css |
| `300px` | length | 3 | motion.css, shell.css, workbench.css |
| `72px` | length | 3 | settings.css |
| `52px` | length | 3 | composer.css, shell.css, workbench.css |
| `560px` | length | 3 | composer.css, dialog.css |
| `rgb(214, 214, 214)` | color | 3 | chat.css |
| `rgb(126, 231, 135)` | color | 3 | chat.css |
| `150px` | length | 3 | tools.css |
| `42px` | length | 3 | browser.css, tools.css |
| `720px` | length | 2 | app.css, settings.css |
| `rgb(0, 0, 0)` | color | 2 | motion.css |
| `rgb(20, 20, 18, 0.000)` | color | 2 | settings.css |
| `380px` | length | 2 | shell.css, workbench.css |
| `88px` | length | 2 | shell.css, workbench.css |
| `430px` | length | 2 | composer.css, rail.css |
| `rgb(127, 127, 127)` | color | 2 | chat.css |
| `rgb(16, 19, 24)` | color | 2 | chat.css |
| `rgb(111, 111, 111)` | color | 2 | chat.css |
| `480px` | length | 2 | chat.css, workbench.css |
| `78px` | length | 2 | composer.css, tools.css |
| `9.5px` | length | 2 | tools.css |
| `rgb(112, 196, 154)` | color | 2 | tools.css |
| `17px` | length | 2 | review.css |
| `190px` | length | 2 | review.css, workbench.css |
| `168px` | length | 1 | ui.css |
| `1.2px` | length | 1 | ui.css |
| `rgb(11, 11, 13)` | color | 1 | app.css |
| `400px` | length | 1 | motion.css |
| `184px` | length | 1 | settings.css |
| `960px` | length | 1 | settings.css |
| `700px` | length | 1 | settings.css |
| … | | | 其余 34 条省略 |

## 3. 定义了但没被引用的令牌

- `--dur-1150`
- `--dur-1500`
- `--dur-1900`

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
| `--fg` | #ecece8 / #252522 | tokens.css |
| `--fg-dim` | #b4b4ac / #66665f | tokens.css |
| `--fg-mute` | #92928a / #73736b | tokens.css |
| `--accent` | #93a4f4 / #5264c8 | tokens.css |
| `--accent-soft` | rgba(147, 164, 244, 0.16) / rgba(82, 100, 200, 0.1) | tokens.css |
| `--accent-line` | rgba(147, 164, 244, 0.52) / rgba(82, 100, 200, 0.42) | tokens.css |
| `--ok` | #34d399 / #059669 | tokens.css |
| `--ok-soft` | rgba(52, 211, 153, 0.16) / rgba(5, 150, 105, 0.1) | tokens.css |
| `--warn` | #fbbf24 / #b45309 | tokens.css |
| `--warn-soft` | rgba(251, 191, 36, 0.16) / rgba(180, 83, 9, 0.1) | tokens.css |
| `--err` | #ff6467 / #dc2626 | tokens.css |
| `--err-soft` | rgba(255, 100, 103, 0.16) / rgba(220, 38, 38, 0.1) | tokens.css |
| `--magenta` | #c084fc / #9333ea | tokens.css |
| `--code-bg` | #0d1117 / #f6f8fa | tokens.css |
| `--code-fg` | #c9d1d9 / #24292f | tokens.css |
| `--code-inline-bg` | rgba(255, 255, 255, 0.07) / rgba(0, 0, 0, 0.055) | tokens.css |
| `--code-inline-fg` | #cdd6dc / #45525a | tokens.css |
| `--on-accent` | #10131f / #ffffff | tokens.css |
| `--shadow-pop` | 0 12px 32px -8px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(0, 0, 0, 0.2) / 0 12px 32px -10px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.04) | tokens.css |
| `--w-right` | var(--w-panel-user, 264px) / var(--w-panel-user, 220px) / 0px / var(--w-panel-user, 336px) / min(var(--w-panel-user, 190px), max(170px, calc((100vw - 360px) / 2))) / min(var(--w-panel-user, 170px), max(170px, calc((100vw - 360px) / 2))) / min(calc(var(--w-panel-user, 340px) + 400px), max(400px, calc(100vw - var(--w-rail) - 420px))) / calc(100vw - var(--w-rail)) / min(420px, 48vw) | tokens.css, layout.css, workbench.css |
| `--think-off` | #4a4a4a / #9a9a9a | motion.css |
| `--think-minimal` | #6e6e6e / #8a8a8a | motion.css |
| `--think-low` | #5f87af / #3f6c92 | motion.css |
| `--think-medium` | #81a2be / #4a7ba0 | motion.css |
| `--think-high` | #b294bb / #7a5f8c | motion.css |
| `--think-xhigh` | #d183e8 / #8b4bb0 | motion.css |
| `--think-max` | #ff5fff / #a300a3 | motion.css |
| `--h` | currentcolor / var(--accent) / var(--fg-dim) | motion.css |
| `--t` | color-mix(in srgb, currentcolor 55%, transparent) / var(--accent-line) / var(--fg-mute) | motion.css |
| `--w-rail` | var(--w-rail-collapsed) / var(--w-rail-user, 248px) / min(var(--w-rail-user, 210px), max(180px, calc(100vw - 360px - var(--w-right)))) / min(var(--w-rail-user, 180px), max(180px, calc(100vw - 360px - var(--w-right)))) | layout.css |
| `--sg-tone` | var(--fg-mute) / var(--accent) / var(--ok) / var(--warn) / var(--err) | chat.css |

## 5. 概况

- 令牌总数：142（被引用 139）
- 令牌引用点：4892（含组件内联 style）
