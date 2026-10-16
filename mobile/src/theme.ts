import { useColorScheme } from 'react-native'
import { THEME_V3_ENABLED, v3Palette } from './theme-v3'

export interface Palette {
  bg0: string
  bg1: string
  bg2: string
  bg3: string
  border: string
  borderSoft: string
  borderStr: string
  fg: string
  fgDim: string
  fgMute: string
  accent: string
  accentSoft: string
  accentLine: string
  onAccent: string
  ink?: string
  inkHover?: string
  onInk?: string
  ok: string
  warn: string
  warnSoft: string
  err: string
  errSoft: string
}

const dark: Palette = {
  bg0: '#17191d',
  bg1: '#1f2228',
  bg2: '#282c34',
  bg3: '#2d3340',
  border: 'rgba(255,255,255,0.11)',
  borderSoft: 'rgba(255,255,255,0.07)',
  borderStr: 'rgba(255,255,255,0.18)',
  fg: '#e5e7eb',
  fgDim: '#b3bac5',
  fgMute: '#929caa',
  accent: '#93a8ff',
  accentSoft: 'rgba(147,168,255,0.16)',
  accentLine: 'rgba(147,168,255,0.5)',
  onAccent: '#17191d',
  ok: '#82c7a0',
  warn: '#e8b17b',
  warnSoft: 'rgba(232,177,123,0.14)',
  err: '#f5a2a2',
  errSoft: 'rgba(245,162,162,0.13)'
}

const light: Palette = {
  bg0: '#f6f7f9',
  bg1: '#eef0f3',
  bg2: '#ffffff',
  bg3: '#e3e7ee',
  border: 'rgba(20,30,50,0.13)',
  borderSoft: 'rgba(20,30,50,0.07)',
  borderStr: 'rgba(20,30,50,0.2)',
  fg: '#242830',
  fgDim: '#505966',
  fgMute: '#5e6876',
  accent: '#4059ad',
  accentSoft: 'rgba(64,89,173,0.10)',
  accentLine: 'rgba(64,89,173,0.42)',
  onAccent: '#ffffff',
  ok: '#216a4b',
  warn: '#8a430d',
  warnSoft: 'rgba(138,67,13,0.10)',
  err: '#a53030',
  errSoft: 'rgba(165,48,48,0.09)'
}

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32 } as const
export const radius = { xs: 3, sm: 4, md: 6, lg: 8 } as const
export const font = { xs: 12, sm: 13, base: 14, body: 16, lg: 17, title: 20 } as const
export const weight = { regular: '400', medium: '400', strong: '400' } as const
export const lineHeight = { row: 24, body: 26 } as const
export const icon = { sm: 16, md: 20, lg: 24 } as const
export const touch = { min: 44, compact: 36 } as const
export const mono = 'monospace'

export function usePalette(): Palette {
  const mode = useColorScheme() === 'light' ? 'light' : 'dark'
  return THEME_V3_ENABLED ? v3Palette(mode) : mode === 'light' ? light : dark
}
