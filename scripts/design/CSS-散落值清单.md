# 设计令牌散落值清单（自动生成）

> 由 `node scripts/css-drift.mjs --md` 生成。改令牌或补 token 后重新生成再对比。
>
> V-0 的输入之一：`可映射` = 有**同值**的令牌，可考虑替换；`无对应` = 需要设计决策。
> 语法高亮色板 `highlight.css` 不计（它不是 UI 语义令牌）。

## 1. 各文件散落值

| 文件 | 颜色 | 其中可映射 | px | 其中可映射 | 时长 | 其中可映射 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `tokens.css` | 0 | 0 | 10 | 9 | 1 | 0 |
| `app.css` | 1 | 0 | 22 | 11 | 0 | 0 |
| `stage1.css` | 1 | 0 | 11 | 5 | 0 | 0 |
| `redesign.css` | 10 | 4 | 113 | 67 | 8 | 0 |
| `motion.css` | 7 | 3 | 94 | 70 | 17 | 0 |
| `settings.css` | 2 | 1 | 78 | 54 | 0 | 0 |
| `electron.css` | 0 | 0 | 0 | 0 | 0 | 0 |
| `highlight.css` | 0 | 0 | 0 | 0 | 0 | 0 |
| `layout.css` | 4 | 4 | 2 | 1 | 0 | 0 |
| `shell.css` | 3 | 1 | 20 | 11 | 5 | 1 |
| `dialog.css` | 0 | 0 | 2 | 2 | 0 | 0 |
| `rail.css` | 1 | 0 | 186 | 130 | 0 | 0 |
| `chat.css` | 30 | 10 | 178 | 119 | 19 | 0 |
| `composer.css` | 5 | 1 | 158 | 109 | 1 | 0 |
| `tools.css` | 10 | 3 | 434 | 305 | 6 | 4 |
| `browser.css` | 1 | 1 | 42 | 28 | 0 | 0 |
| `terminal.css` | 0 | 0 | 0 | 0 | 0 | 0 |
| `review.css` | 4 | 0 | 249 | 172 | 0 | 0 |
| `icon-state.css` | 0 | 0 | 0 | 0 | 0 | 0 |
| **合计** | **79** | **28** | **1599** | **1093** | **57** | **5** |

## 2. 无对应令牌的值（语义缺口）

| 值 | 类别 | 出现次数 | 文件 |
| --- | --- | ---: | --- |
| `5px` | length | 115 | app.css, chat.css, composer.css, motion.css, rail.css, redesign.css, review.css, settings.css, shell.css, stage1.css, tools.css |
| `10px` | length | 51 | browser.css, chat.css, composer.css, motion.css, rail.css, redesign.css, review.css, stage1.css, tools.css |
| `20px` | length | 32 | app.css, chat.css, composer.css, rail.css, review.css, shell.css, tools.css |
| `26px` | length | 31 | app.css, browser.css, composer.css, rail.css, redesign.css, review.css, settings.css, shell.css, tools.css |
| `18px` | length | 27 | browser.css, chat.css, rail.css, redesign.css, review.css, settings.css, tools.css |
| `22px` | length | 23 | browser.css, chat.css, composer.css, rail.css, review.css, shell.css, tools.css |
| `28px` | length | 19 | browser.css, chat.css, composer.css, rail.css, redesign.css, tools.css |
| `36px` | length | 15 | composer.css, layout.css, rail.css, redesign.css, review.css, tools.css |
| `rgb(0, 0, 0, 1.000)` | color | 14 | chat.css, composer.css, motion.css, rail.css, redesign.css, settings.css, stage1.css, tools.css |
| `11.5px` | length | 13 | review.css, settings.css |
| `34px` | length | 10 | app.css, chat.css, composer.css, rail.css, settings.css, tools.css |
| `320px` | length | 10 | chat.css, redesign.css, review.css, settings.css, tools.css |
| `420px` | length | 10 | chat.css, composer.css, redesign.css, review.css, tools.css |
| `30px` | length | 9 | rail.css, redesign.css, review.css, tools.css |
| `120px` | length | 8 | composer.css, motion.css, redesign.css, review.css, tools.css |
| `220px` | length | 8 | chat.css, review.css, settings.css, tools.css |
| `96px` | length | 6 | composer.css, review.css, settings.css, stage1.css, tools.css |
| `ms:140` | time | 6 | chat.css, redesign.css |
| `ms:180` | time | 6 | chat.css, motion.css |
| `42px` | length | 6 | browser.css, review.css, tools.css |
| `200px` | length | 5 | app.css, settings.css, tools.css |
| `180px` | length | 5 | composer.css, redesign.css, shell.css, stage1.css, tools.css |
| `240px` | length | 5 | browser.css, composer.css, motion.css, tools.css |
| `620px` | length | 5 | chat.css, motion.css, tools.css |
| `64px` | length | 5 | composer.css, motion.css, settings.css, tools.css |
| `260px` | length | 5 | composer.css, review.css, settings.css, tools.css |
| `10.5px` | length | 5 | review.css, settings.css |
| `160px` | length | 5 | browser.css, chat.css, composer.css, review.css, tools.css |
| `99px` | length | 4 | app.css, shell.css, tokens.css |
| `17px` | length | 4 | redesign.css, review.css |
| `ms:200` | time | 4 | composer.css, motion.css, redesign.css |
| `360px` | length | 4 | chat.css, redesign.css, tools.css |
| `ms:220` | time | 4 | chat.css |
| `280px` | length | 4 | chat.css, review.css, tools.css |
| `ms:130` | time | 4 | chat.css |
| `150px` | length | 4 | review.css, tools.css |
| `560px` | length | 3 | composer.css, redesign.css, stage1.css |
| `46px` | length | 3 | redesign.css, shell.css |
| `ms:900` | time | 3 | motion.css, tools.css |
| `1.5px` | length | 3 | chat.css, rail.css |
| `9.5px` | length | 3 | rail.css, tools.css |
| `rgb(214, 214, 214)` | color | 3 | chat.css |
| `rgb(126, 231, 135)` | color | 3 | chat.css |
| `rgb(229, 72, 77)` | color | 3 | review.css |
| `ms:1100` | time | 2 | redesign.css, tokens.css |
| `rgb(127, 127, 127)` | color | 2 | chat.css, redesign.css |
| `168px` | length | 2 | redesign.css, settings.css |
| `ms:1600` | time | 2 | motion.css |
| `rgb(255, 255, 255, 1.000)` | color | 2 | motion.css |
| `60px` | length | 2 | motion.css |
| `ms:80` | time | 2 | shell.css |
| `ms:760` | time | 2 | shell.css |
| `430px` | length | 2 | composer.css, rail.css |
| `680px` | length | 2 | chat.css |
| `rgb(16, 19, 24)` | color | 2 | chat.css |
| `rgb(111, 111, 111)` | color | 2 | chat.css |
| `140px` | length | 2 | browser.css, chat.css |
| `52px` | length | 2 | composer.css |
| `rgb(112, 196, 154)` | color | 2 | tools.css |
| `rgb(224, 123, 123)` | color | 2 | tools.css |
| … | | | 其余 61 条省略 |

## 3. 定义了但没被引用的令牌

（无）

## 4. 同一令牌有多个值（主题差异或重复定义）

| 令牌 | 值 | 定义于 |
| --- | --- | --- |
| `--d-row-gap` | 3px / 1px / 7px | tokens.css |
| `--d-section-gap` | 3px / 1px / 9px | tokens.css |
| `--d-message-gap` | 32px / 16px / 48px | tokens.css |
| `--w-stream` | 800px / 980px | tokens.css, redesign.css |
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
| `--w-right` | var(--w-panel-user, 220px) / var(--w-panel-user, 264px) / 0px / var(--w-panel-user, 336px) / min(var(--w-panel-user, 264px), 190px) / min(var(--w-panel-user, 264px), 170px) / var(--w-review-user, clamp(420px, 46vw, 900px)) | redesign.css, layout.css, review.css |
| `--w-rail` | var(--w-rail-collapsed) / var(--w-rail-user, 248px) / min(var(--w-rail-user, 260px), 210px) / min(var(--w-rail-user, 260px), 180px) | redesign.css, layout.css |
| `--think-off` | #4a4a4a / #9a9a9a | motion.css |
| `--think-minimal` | #6e6e6e / #8a8a8a | motion.css |
| `--think-low` | #5f87af / #3f6c92 | motion.css |
| `--think-medium` | #81a2be / #4a7ba0 | motion.css |
| `--think-high` | #b294bb / #7a5f8c | motion.css |
| `--think-xhigh` | #d183e8 / #8b4bb0 | motion.css |
| `--think-max` | #ff5fff / #a300a3 | motion.css |
| `--ring-color` | var(--fg-mute) / var(--ok) / var(--warn) / var(--err) | tools.css |

## 5. 概况

- 令牌总数：84（被引用 84）
- 令牌引用点：3305（含组件内联 style）
