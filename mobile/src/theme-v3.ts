/**
 * 手机端 v3 令牌映射（WP-60，方案 02 §5 / §14，03 §6.7）。
 *
 * 生成物 `mobile/src/theme.v3.generated.ts` 与桌面 `design/tokens.json` 同源；
 * 本文件只把它翻译成现有 `Palette` 形状（见 theme.ts），不新增色值、不改生成物。
 * 开关 `THEME_V3_ENABLED` 默认 false：`usePalette()` 继续返回旧色板，
 * 手机端当前外观不变；置为 true 后才切到 v3 墨色主按钮与新中性色。
 *
 * 旧 `Palette` 只有一个 `accent`，而 v3 把「墨蓝（焦点 / 选中 / 链接）」与
 * 「墨色主按钮（发送、允许）」分成两组令牌，所以这里在旧形状上补 `ink / inkHover / onInk`
 * 三项，由 `ui.tsx` 的主按钮取用；旧色板没有这三项，取值时回退 `accent / onAccent`。
 */
import { v3Dark, v3Light } from './theme.v3.generated'
import type { Palette } from './theme'

/** 是否让 `usePalette()` 返回 v3 色板。默认 false，手机端保持现状。 */
export const THEME_V3_ENABLED = false

/** v3 色板：旧 `Palette` 形状 + 主按钮需要的墨色三项。 */
export interface PaletteV3 extends Palette {
  /** 主按钮底色（墨色） */
  ink: string
  /** 主按钮按下态底色（v3 另有 hover；当前按钮用透明度表达按下） */
  inkHover: string
  /** 主按钮文字 */
  onInk: string
}

function mapPalette(c: typeof v3Light | typeof v3Dark): PaletteV3 {
  return {
    // 中性底色：对话区 / 侧栏与页头 / 卡片与输入框 / 侧栏悬停与当前项
    bg0: c.bg,
    bg1: c.side,
    bg2: c.surface,
    bg3: c.hover,
    // 描边：控件用 line2、分隔线用 line，borderStr 取可用的最强一档
    border: c.line2,
    borderSoft: c.line,
    borderStr: c.line2,
    // 文字三级
    fg: c.fg,
    fgDim: c.fg2,
    fgMute: c.fg3,
    // 墨蓝只给焦点、选中与链接；onAccent 取墨色按钮文字，保证在 accent 上也可见
    accent: c.accent,
    accentSoft: c.sel,
    accentLine: c.accent,
    onAccent: c.onInk,
    // 状态色取文字用变体（run-t / ask-t / fail-t）：旧色板也把 ok/warn/err 当文字色用
    ok: c.runT,
    warn: c.askT,
    warnSoft: c.askBg,
    err: c.failT,
    errSoft: c.failBg,
    // 墨色主按钮
    ink: c.ink,
    inkHover: c.inkHover,
    onInk: c.onInk
  }
}

export const v3PaletteLight: PaletteV3 = mapPalette(v3Light)
export const v3PaletteDark: PaletteV3 = mapPalette(v3Dark)

/** 按主题取 v3 色板；调用方只传 'light' | 'dark'，不在这里读系统状态。 */
export function v3Palette(mode: 'light' | 'dark'): PaletteV3 {
  return mode === 'light' ? v3PaletteLight : v3PaletteDark
}
