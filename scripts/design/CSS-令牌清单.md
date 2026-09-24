# 设计令牌清单（自动生成）

> 由 `node scripts/css-tokens.mjs --md` 生成。改令牌后重新生成。
>
> **只有每个变量的“最终值”生效** —— 它可能不在 `tokens.css` 里。
> 定义链从左到右，最右者胜（同特异性、后加载）。

## `:root`　53 个变量（其中 1 个被重复定义）

| 变量 | 最终值 | 定义链 |
| --- | --- | --- |
| `--ctl-disabled-opacity` | `0.5` | **tokens**: 0.5 |
| `--d-message-gap` | `32px` | **tokens**: 32px |
| `--d-row-gap` | `3px` | **tokens**: 3px |
| `--d-section-gap` | `3px` | **tokens**: 3px |
| `--dur` | `120ms` | **tokens**: 120ms |
| `--ease` | `cubic-bezier(0.2, 0, 0.2, 1)` | **tokens**: cubic-bezier(0.2, 0, 0.2, 1) |
| `--focus-ring-color` | `var(--accent)` | **tokens**: var(--accent) |
| `--focus-ring-offset` | `1px` | **tokens**: 1px |
| `--focus-ring-w` | `1px` | **tokens**: 1px |
| `--focus-ring-w-strong` | `2px` | **tokens**: 2px |
| `--font-body` | `var(--font-ui)` | **tokens**: var(--font-ui) |
| `--font-code` | `var(--font-mono)` | **tokens**: var(--font-mono) |
| `--font-mono` | `'Maple Mono CN', ui-monospace, Consolas, monospace` | **tokens**: 'Maple Mono CN', ui-monospace, Consolas, monospace |
| `--font-ui` | `'Segoe UI', 'Microsoft YaHei UI', system-ui, sans-serif` | **tokens**: 'Segoe UI', 'Microsoft YaHei UI', system-ui, sans-serif |
| `--fs-base` | `13px` | **tokens**: 13px |
| `--fs-body` | `14px` | **tokens**: 14px |
| `--fs-code` | `12.5px` | **tokens**: 12.5px |
| `--fs-lg` | `15px` | **tokens**: 15px |
| `--fs-sm` | `12px` | **tokens**: 12px |
| `--fs-xs` | `11px` | **tokens**: 11px |
| `--h-titlebar` | `40px` | **tokens**: 40px |
| `--lh-base` | `1.55` | **tokens**: 1.55 |
| `--lh-body` | `1.7` | **tokens**: 1.7 |
| `--lh-tight` | `1.45` | **tokens**: 1.45 |
| `--mo-base` | `170ms` | **motion**: 170ms |
| `--mo-ease` | `cubic-bezier(0.22, 1, 0.36, 1)` | **motion**: cubic-bezier(0.22, 1, 0.36, 1) |
| `--mo-ease-out` | `cubic-bezier(0.4, 0, 1, 1)` | **motion**: cubic-bezier(0.4, 0, 1, 1) |
| `--mo-fast` | `110ms` | **motion**: 110ms |
| `--mo-shift` | `6px` | **motion**: 6px |
| `--mo-slow` | `240ms` | **motion**: 240ms |
| `--r-full` | `999px` | **tokens**: 999px |
| `--r-lg` | `12px` | **tokens**: 12px |
| `--r-md` | `8px` | **tokens**: 8px |
| `--r-sm` | `6px` | **tokens**: 6px |
| `--r-xl` | `12px` | **tokens**: 12px |
| `--r-xs` | `4px` | **tokens**: 4px |
| `--sp-1` | `4px` | **tokens**: 4px |
| `--sp-2` | `8px` | **tokens**: 8px |
| `--sp-3` | `12px` | **tokens**: 12px |
| `--sp-4` | `16px` | **tokens**: 16px |
| `--sp-5` | `24px` | **tokens**: 24px |
| `--sp-6` | `32px` | **tokens**: 32px |
| `--think-high` | `#b294bb` | **motion**: #b294bb |
| `--think-low` | `#5f87af` | **motion**: #5f87af |
| `--think-max` | `#ff5fff` | **motion**: #ff5fff |
| `--think-medium` | `#81a2be` | **motion**: #81a2be |
| `--think-minimal` | `#6e6e6e` | **motion**: #6e6e6e |
| `--think-off` | `#4a4a4a` | **motion**: #4a4a4a |
| `--think-xhigh` | `#d183e8` | **motion**: #d183e8 |
| `--w-rail` | `var(--w-rail-user, 248px)` | **layout**: var(--w-rail-user, 248px) |
| `--w-rail-collapsed` | `0px` | **layout**: 0px |
| `--w-right` ⚠️ | `var(--w-panel-user, 336px)` | redesign: var(--w-panel-user, 264px) → **layout**: var(--w-panel-user, 336px) |
| `--w-stream` | `800px` | **tokens**: 800px |

## `html[data-theme='dark']`　27 个变量

| 变量 | 最终值 | 定义链 |
| --- | --- | --- |
| `--accent` | `#93a4f4` | **tokens**: #93a4f4 |
| `--accent-line` | `rgba(147, 164, 244, 0.52)` | **tokens**: rgba(147, 164, 244, 0.52) |
| `--accent-soft` | `rgba(147, 164, 244, 0.16)` | **tokens**: rgba(147, 164, 244, 0.16) |
| `--bg-0` | `#151515` | **tokens**: #151515 |
| `--bg-1` | `#1b1b1a` | **tokens**: #1b1b1a |
| `--bg-2` | `#222221` | **tokens**: #222221 |
| `--bg-3` | `#2b2b29` | **tokens**: #2b2b29 |
| `--bg-4` | `#393936` | **tokens**: #393936 |
| `--border` | `rgba(255, 255, 255, 0.1)` | **tokens**: rgba(255, 255, 255, 0.1) |
| `--border-soft` | `rgba(255, 255, 255, 0.06)` | **tokens**: rgba(255, 255, 255, 0.06) |
| `--border-str` | `rgba(255, 255, 255, 0.16)` | **tokens**: rgba(255, 255, 255, 0.16) |
| `--code-bg` | `#0d1117` | **tokens**: #0d1117 |
| `--code-fg` | `#c9d1d9` | **tokens**: #c9d1d9 |
| `--code-inline-bg` | `rgba(255, 255, 255, 0.07)` | **tokens**: rgba(255, 255, 255, 0.07) |
| `--code-inline-fg` | `#cdd6dc` | **tokens**: #cdd6dc |
| `--cyan` | `var(--accent)` | **tokens**: var(--accent) |
| `--edge` | `rgba(255, 255, 255, 0.07)` | **tokens**: rgba(255, 255, 255, 0.07) |
| `--err` | `#ff6467` | **tokens**: #ff6467 |
| `--err-soft` | `rgba(255, 100, 103, 0.16)` | **tokens**: rgba(255, 100, 103, 0.16) |
| `--fg` | `#ecece8` | **tokens**: #ecece8 |
| `--fg-dim` | `#b4b4ac` | **tokens**: #b4b4ac |
| `--fg-mute` | `#92928a` | **tokens**: #92928a |
| `--magenta` | `#c084fc` | **tokens**: #c084fc |
| `--ok` | `#34d399` | **tokens**: #34d399 |
| `--ok-soft` | `rgba(52, 211, 153, 0.16)` | **tokens**: rgba(52, 211, 153, 0.16) |
| `--warn` | `#fbbf24` | **tokens**: #fbbf24 |
| `--warn-soft` | `rgba(251, 191, 36, 0.16)` | **tokens**: rgba(251, 191, 36, 0.16) |

## `html[data-theme='light']`　34 个变量

| 变量 | 最终值 | 定义链 |
| --- | --- | --- |
| `--accent` | `#5264c8` | **tokens**: #5264c8 |
| `--accent-line` | `rgba(82, 100, 200, 0.42)` | **tokens**: rgba(82, 100, 200, 0.42) |
| `--accent-soft` | `rgba(82, 100, 200, 0.1)` | **tokens**: rgba(82, 100, 200, 0.1) |
| `--bg-0` | `#fcfcfa` | **tokens**: #fcfcfa |
| `--bg-1` | `#f3f3f0` | **tokens**: #f3f3f0 |
| `--bg-2` | `#ffffff` | **tokens**: #ffffff |
| `--bg-3` | `#eaeae6` | **tokens**: #eaeae6 |
| `--bg-4` | `#deded9` | **tokens**: #deded9 |
| `--border` | `rgba(0, 0, 0, 0.13)` | **tokens**: rgba(0, 0, 0, 0.13) |
| `--border-soft` | `rgba(0, 0, 0, 0.07)` | **tokens**: rgba(0, 0, 0, 0.07) |
| `--border-str` | `rgba(0, 0, 0, 0.2)` | **tokens**: rgba(0, 0, 0, 0.2) |
| `--code-bg` | `#f6f8fa` | **tokens**: #f6f8fa |
| `--code-fg` | `#24292f` | **tokens**: #24292f |
| `--code-inline-bg` | `rgba(0, 0, 0, 0.055)` | **tokens**: rgba(0, 0, 0, 0.055) |
| `--code-inline-fg` | `#45525a` | **tokens**: #45525a |
| `--cyan` | `var(--accent)` | **tokens**: var(--accent) |
| `--edge` | `rgba(0, 0, 0, 0.04)` | **tokens**: rgba(0, 0, 0, 0.04) |
| `--err` | `#dc2626` | **tokens**: #dc2626 |
| `--err-soft` | `rgba(220, 38, 38, 0.1)` | **tokens**: rgba(220, 38, 38, 0.1) |
| `--fg` | `#252522` | **tokens**: #252522 |
| `--fg-dim` | `#66665f` | **tokens**: #66665f |
| `--fg-mute` | `#73736b` | **tokens**: #73736b |
| `--magenta` | `#9333ea` | **tokens**: #9333ea |
| `--ok` | `#059669` | **tokens**: #059669 |
| `--ok-soft` | `rgba(5, 150, 105, 0.1)` | **tokens**: rgba(5, 150, 105, 0.1) |
| `--think-high` | `#7a5f8c` | **motion**: #7a5f8c |
| `--think-low` | `#3f6c92` | **motion**: #3f6c92 |
| `--think-max` | `#a300a3` | **motion**: #a300a3 |
| `--think-medium` | `#4a7ba0` | **motion**: #4a7ba0 |
| `--think-minimal` | `#8a8a8a` | **motion**: #8a8a8a |
| `--think-off` | `#9a9a9a` | **motion**: #9a9a9a |
| `--think-xhigh` | `#8b4bb0` | **motion**: #8b4bb0 |
| `--warn` | `#b45309` | **tokens**: #b45309 |
| `--warn-soft` | `rgba(180, 83, 9, 0.1)` | **tokens**: rgba(180, 83, 9, 0.1) |

## `@media (min-width: 1600px) :root`　1 个变量

| 变量 | 最终值 | 定义链 |
| --- | --- | --- |
| `--w-stream` | `980px` | **redesign**: 980px |

## `html[data-density='comfortable']`　3 个变量

| 变量 | 最终值 | 定义链 |
| --- | --- | --- |
| `--d-message-gap` | `48px` | **tokens**: 48px |
| `--d-row-gap` | `7px` | **tokens**: 7px |
| `--d-section-gap` | `9px` | **tokens**: 9px |

## `html[data-density='compact']`　3 个变量

| 变量 | 最终值 | 定义链 |
| --- | --- | --- |
| `--d-message-gap` | `16px` | **tokens**: 16px |
| `--d-row-gap` | `1px` | **tokens**: 1px |
| `--d-section-gap` | `1px` | **tokens**: 1px |

## 小结

- 变量总数（含各主题）：**121**
- 同一选择器内被重复定义（真冗余）：**1**
- ⚠️ 标记的那些：改值要改**最后一个**，否则看不到效果；
  它们是「令牌归并」的候选（把最终值收敛到 tokens.css 并删掉中间覆盖）。
