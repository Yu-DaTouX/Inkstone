/**
 * 手机端的颜色与尺寸，与桌面设计规范 v0.4（docs/DESIGN_SYSTEM.md）同源：
 * 暖中性底色、靛蓝单一强调、语义色只表达成功 / 警告 / 错误。
 * 手机按拇指操作放大控件：按钮最小 44pt 高（桌面是 28px）。
 */
import { useColorScheme } from 'react-native'

export interface Palette {
  bg0: string
  bg1: string
  bg2: string
  bg3: string
  border: string
  borderSoft: string
  fg: string
  fgDim: string
  fgMute: string
  accent: string
  accentSoft: string
  onAccent: string
  ok: string
  warn: string
  err: string
  errSoft: string
}

const dark: Palette = {
  bg0: '#151515',
  bg1: '#1b1b1a',
  bg2: '#222221',
  bg3: '#2b2b29',
  border: 'rgba(255,255,255,0.10)',
  borderSoft: 'rgba(255,255,255,0.06)',
  fg: '#ecece8',
  fgDim: '#b4b4ac',
  fgMute: '#92928a',
  accent: '#93a4f4',
  accentSoft: 'rgba(147,164,244,0.16)',
  onAccent: '#10131f',
  ok: '#34d399',
  warn: '#fbbf24',
  err: '#ff6467',
  errSoft: 'rgba(255,100,103,0.16)'
}

const light: Palette = {
  bg0: '#fcfcfa',
  bg1: '#f3f3f0',
  bg2: '#ffffff',
  bg3: '#eaeae6',
  border: 'rgba(0,0,0,0.13)',
  borderSoft: 'rgba(0,0,0,0.07)',
  fg: '#252522',
  fgDim: '#66665f',
  fgMute: '#73736b',
  accent: '#5264c8',
  accentSoft: 'rgba(82,100,200,0.10)',
  onAccent: '#ffffff',
  ok: '#059669',
  warn: '#b45309',
  err: '#dc2626',
  errSoft: 'rgba(220,38,38,0.10)'
}

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32 } as const
export const radius = { sm: 6, md: 8, lg: 12 } as const
export const font = { xs: 12, sm: 13, base: 15, body: 16, lg: 18, title: 22 } as const
export const touch = { min: 44 } as const
export const mono = 'monospace'

export function usePalette(): Palette {
  return useColorScheme() === 'light' ? light : dark
}
