# 设计令牌清单（自动生成）

> 由 `node scripts/css-tokens.mjs --md` 生成。改令牌后重新生成。
>
> **只有每个变量的“最终值”生效** —— 它可能不在 `tokens.css` 里。
> 定义链从左到右，最右者胜（同特异性、后加载）。

## `:root`　43 个变量

| 变量 | 最终值 | 定义链 |
| --- | --- | --- |
| `--dur` | `120ms` | **tokens**: 120ms |
| `--ease` | `cubic-bezier(0.2, 0, 0.2, 1)` | **tokens**: cubic-bezier(0.2, 0, 0.2, 1) |
| `--font-mono` | `'Maple Mono CN', ui-monospace, Consolas, monospace` | **tokens**: 'Maple Mono CN', ui-monospace, Consolas, monospace |
| `--font-ui` | `var(--font-mono)` | **tokens**: var(--font-mono) |
| `--fs-base` | `12.5px` | **tokens**: 12.5px |
| `--fs-code` | `12px` | **tokens**: 12px |
| `--fs-lg` | `14px` | **tokens**: 14px |
| `--fs-sm` | `11px` | **tokens**: 11px |
| `--fs-xs` | `10px` | **tokens**: 10px |
| `--h-titlebar` | `36px` | **tokens**: 36px |
| `--lh-base` | `1.65` | **tokens**: 1.65 |
| `--lh-tight` | `1.45` | **tokens**: 1.45 |
| `--mo-base` | `170ms` | **motion**: 170ms |
| `--mo-ease` | `cubic-bezier(0.22, 1, 0.36, 1)` | **motion**: cubic-bezier(0.22, 1, 0.36, 1) |
| `--mo-ease-out` | `cubic-bezier(0.4, 0, 1, 1)` | **motion**: cubic-bezier(0.4, 0, 1, 1) |
| `--mo-fast` | `110ms` | **motion**: 110ms |
| `--mo-shift` | `6px` | **motion**: 6px |
| `--mo-slow` | `240ms` | **motion**: 240ms |
| `--r-full` | `999px` | **tokens**: 999px |
| `--r-lg` | `6px` | **tokens**: 6px |
| `--r-md` | `4px` | **tokens**: 4px |
| `--r-sm` | `3px` | **tokens**: 3px |
| `--r-xl` | `8px` | **tokens**: 8px |
| `--r-xs` | `2px` | **tokens**: 2px |
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
| `--tree-indent` | `13px` | **tokens**: 13px |
| `--w-rail` | `var(--w-rail-user, 260px)` | **layout**: var(--w-rail-user, 260px) |
| `--w-rail-collapsed` | `48px` | **layout**: 48px |
| `--w-right` | `var(--w-panel-user, 264px)` | **redesign**: var(--w-panel-user, 264px) |
| `--w-status` | `328px` | **tokens**: 328px |
| `--w-stream` | `800px` | **tokens**: 800px |

## `html[data-theme='dark']`　29 个变量

| 变量 | 最终值 | 定义链 |
| --- | --- | --- |
| `--accent` | `#4c7ef3` | **tokens**: #4c7ef3 |
| `--accent-line` | `rgba(76, 126, 243, 0.5)` | **tokens**: rgba(76, 126, 243, 0.5) |
| `--accent-soft` | `rgba(76, 126, 243, 0.16)` | **tokens**: rgba(76, 126, 243, 0.16) |
| `--bg-0` | `#0a0a0a` | **tokens**: #0a0a0a |
| `--bg-1` | `#171717` | **tokens**: #171717 |
| `--bg-2` | `#262626` | **tokens**: #262626 |
| `--bg-3` | `#303030` | **tokens**: #303030 |
| `--bg-4` | `#3d3d3d` | **tokens**: #3d3d3d |
| `--border` | `rgba(255, 255, 255, 0.1)` | **tokens**: rgba(255, 255, 255, 0.1) |
| `--border-soft` | `rgba(255, 255, 255, 0.06)` | **tokens**: rgba(255, 255, 255, 0.06) |
| `--border-str` | `rgba(255, 255, 255, 0.16)` | **tokens**: rgba(255, 255, 255, 0.16) |
| `--code-bg` | `#0d1117` | **tokens**: #0d1117 |
| `--code-fg` | `#c9d1d9` | **tokens**: #c9d1d9 |
| `--code-inline-bg` | `rgba(255, 255, 255, 0.06)` | **tokens**: rgba(255, 255, 255, 0.06) |
| `--code-inline-fg` | `#7ee7f7` | **tokens**: #7ee7f7 |
| `--cyan` | `#22d3ee` | **tokens**: #22d3ee |
| `--edge` | `rgba(255, 255, 255, 0.07)` | **tokens**: rgba(255, 255, 255, 0.07) |
| `--err` | `#ff6467` | **tokens**: #ff6467 |
| `--err-soft` | `rgba(255, 100, 103, 0.16)` | **tokens**: rgba(255, 100, 103, 0.16) |
| `--fact` | `#22d3ee` | **tokens**: #22d3ee |
| `--fact-soft` | `rgba(34, 211, 238, 0.14)` | **tokens**: rgba(34, 211, 238, 0.14) |
| `--fg` | `#fafafa` | **tokens**: #fafafa |
| `--fg-dim` | `#d4d4d4` | **tokens**: #d4d4d4 |
| `--fg-mute` | `#a1a1a1` | **tokens**: #a1a1a1 |
| `--magenta` | `#c084fc` | **tokens**: #c084fc |
| `--ok` | `#34d399` | **tokens**: #34d399 |
| `--ok-soft` | `rgba(52, 211, 153, 0.16)` | **tokens**: rgba(52, 211, 153, 0.16) |
| `--warn` | `#fbbf24` | **tokens**: #fbbf24 |
| `--warn-soft` | `rgba(251, 191, 36, 0.16)` | **tokens**: rgba(251, 191, 36, 0.16) |

## `html[data-theme='light']`　36 个变量

| 变量 | 最终值 | 定义链 |
| --- | --- | --- |
| `--accent` | `#2563eb` | **tokens**: #2563eb |
| `--accent-line` | `rgba(37, 99, 235, 0.4)` | **tokens**: rgba(37, 99, 235, 0.4) |
| `--accent-soft` | `rgba(37, 99, 235, 0.1)` | **tokens**: rgba(37, 99, 235, 0.1) |
| `--bg-0` | `#ffffff` | **tokens**: #ffffff |
| `--bg-1` | `#fafafa` | **tokens**: #fafafa |
| `--bg-2` | `#f5f5f5` | **tokens**: #f5f5f5 |
| `--bg-3` | `#ededed` | **tokens**: #ededed |
| `--bg-4` | `#e0e0e0` | **tokens**: #e0e0e0 |
| `--border` | `rgba(0, 0, 0, 0.13)` | **tokens**: rgba(0, 0, 0, 0.13) |
| `--border-soft` | `rgba(0, 0, 0, 0.07)` | **tokens**: rgba(0, 0, 0, 0.07) |
| `--border-str` | `rgba(0, 0, 0, 0.2)` | **tokens**: rgba(0, 0, 0, 0.2) |
| `--code-bg` | `#f6f8fa` | **tokens**: #f6f8fa |
| `--code-fg` | `#24292f` | **tokens**: #24292f |
| `--code-inline-bg` | `rgba(9, 105, 218, 0.08)` | **tokens**: rgba(9, 105, 218, 0.08) |
| `--code-inline-fg` | `#0a5fa8` | **tokens**: #0a5fa8 |
| `--cyan` | `#0891b2` | **tokens**: #0891b2 |
| `--edge` | `rgba(0, 0, 0, 0.04)` | **tokens**: rgba(0, 0, 0, 0.04) |
| `--err` | `#dc2626` | **tokens**: #dc2626 |
| `--err-soft` | `rgba(220, 38, 38, 0.1)` | **tokens**: rgba(220, 38, 38, 0.1) |
| `--fact` | `#0891b2` | **tokens**: #0891b2 |
| `--fact-soft` | `rgba(8, 145, 178, 0.1)` | **tokens**: rgba(8, 145, 178, 0.1) |
| `--fg` | `#0a0a0a` | **tokens**: #0a0a0a |
| `--fg-dim` | `#333333` | **tokens**: #333333 |
| `--fg-mute` | `#5f5f5f` | **tokens**: #5f5f5f |
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

## 小结

- 变量总数（含各主题）：**109**
- 同一选择器内被重复定义（真冗余）：**0**
- ⚠️ 标记的那些：改值要改**最后一个**，否则看不到效果；
  它们是「令牌归并」的候选（把最终值收敛到 tokens.css 并删掉中间覆盖）。
