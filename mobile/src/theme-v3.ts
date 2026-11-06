import { v3Dark, v3Light } from './theme.v3.generated'
import type { Palette } from './theme'

export const THEME_V3_ENABLED = true

export interface PaletteV3 extends Palette {
  ink: string
  inkHover: string
  onInk: string
}

function mapPalette(c: typeof v3Light | typeof v3Dark): PaletteV3 {
  return {
    bg0: c.bg,
    bg1: c.side,
    bg2: c.surface,
    bg3: c.hover,
    bubble: c.bubble,
    field: c.field,
    surface: c.surface,
    surface3: c['surface-3'],
    sunken: c.sunken,
    border: c.line2,
    borderSoft: c.line,
    borderStr: c.line2,
    fg: c.fg,
    fgDim: c.fg2,
    fgMute: c.fg3,
    accent: c.accentT,
    accentSoft: c.sel,
    accentLine: c.accent,
    onAccent: c.onInk,
    ok: c.runT,
    online: c.ok,
    warn: c.askT,
    warnSoft: c.askBg,
    err: c.failT,
    errSoft: c.failBg,
    fail: c.fail,
    onFill: c.onFill,
    add: c.add,
    del: c.del,
    press: c.press,
    codeInline: c.codeInlineBg,
    btnPrimary: c.btnPrimary,
    onBtnPrimary: c.onBtnPrimary,
    ink: c.ink,
    inkHover: c.inkHover,
    onInk: c.onInk
  }
}

export const v3PaletteLight: PaletteV3 = mapPalette(v3Light)
export const v3PaletteDark: PaletteV3 = mapPalette(v3Dark)

export function v3Palette(mode: 'light' | 'dark'): PaletteV3 {
  return mode === 'light' ? v3PaletteLight : v3PaletteDark
}
