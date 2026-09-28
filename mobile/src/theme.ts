/**
 * 手机端的颜色与尺寸，与桌面设计规范 v0.5（docs/DESIGN_SYSTEM.md §7）同源：
 * 暖中性底色、靛蓝单一强调、语义色只表达成功 / 警告 / 错误。
 * 手机按拇指操作放大控件：按钮最小 44dp 高（桌面是 28px）。
 * 色值由 `npm run check:mobile-tokens` 与 tokens.css 比对。
 */
import { useColorScheme } from 'react-native'

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
  ok: string
  warn: string
  warnSoft: string
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
  borderStr: 'rgba(255,255,255,0.16)',
  fg: '#ecece8',
  fgDim: '#b4b4ac',
  fgMute: '#92928a',
  accent: '#93a4f4',
  accentSoft: 'rgba(147,164,244,0.16)',
  accentLine: 'rgba(147,164,244,0.52)',
  onAccent: '#10131f',
  ok: '#34d399',
  warn: '#fbbf24',
  warnSoft: 'rgba(251,191,36,0.16)',
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
  borderStr: 'rgba(0,0,0,0.2)',
  fg: '#252522',
  fgDim: '#66665f',
  fgMute: '#73736b',
  accent: '#5264c8',
  accentSoft: 'rgba(82,100,200,0.10)',
  accentLine: 'rgba(82,100,200,0.42)',
  onAccent: '#ffffff',
  ok: '#059669',
  warn: '#b45309',
  warnSoft: 'rgba(180,83,9,0.10)',
  err: '#dc2626',
  errSoft: 'rgba(220,38,38,0.10)'
}

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32 } as const
export const radius = { sm: 6, md: 8, lg: 12 } as const
export const font = { xs: 12, sm: 13, base: 15, body: 16, lg: 18, title: 22 } as const
/** 字重只用三档，与桌面 --fw-regular / --fw-medium / --fw-strong 一致 */
export const weight = { regular: '400', medium: '500', strong: '600' } as const
/** 图标只用三档：随文字 16、按钮与行首 20、页面级 24 */
export const icon = { sm: 16, md: 20, lg: 24 } as const
export const touch = { min: 44, compact: 36 } as const
/**
 * 骨架等宽、正文无衬线（与桌面 --font-ui / --font-body 同一分工）。
 * 等宽用系统 monospace，不在 APK 内嵌 Maple Mono CN：汉字回退到系统 CJK 字体，观感与桌面接近，
 * 安装包不因字体增加数 MB，也不必随桌面字体子集一起维护。
 */
export const mono = 'monospace'

export function usePalette(): Palette {
  return useColorScheme() === 'light' ? light : dark
}
