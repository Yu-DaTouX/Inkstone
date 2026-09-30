/**
 * 「生活」风格令牌：A · 纸墨留白。
 *
 * 来源是 Claude 留下的设计概念（`.local-docs/archive/2026-09-28-ui-concepts/`：
 * 暖白 #F7F5EF、炭黑字、森林绿点缀、8px 圆角），用于生活助手入口与对话。
 * 「砚」风格仍在 theme.ts；两套共用同一组尺寸与控件，只换调色板。
 *
 * 注意：`npm run check:mobile-tokens` 只校验 theme.ts 与 tokens.css 同名同值，
 * 这套令牌不参与该校验，改动它不会影响桌面设计规范。
 */
import { useColorScheme } from 'react-native'
import type { Palette } from './theme'

const light: Palette = {
  bg0: '#F7F5EF',
  bg1: '#F2EFE7',
  bg2: '#FFFFFF',
  bg3: '#E9E4D8',
  border: 'rgba(34,37,42,0.14)',
  borderSoft: 'rgba(34,37,42,0.08)',
  borderStr: 'rgba(34,37,42,0.24)',
  fg: '#22252A',
  fgDim: '#54585F',
  fgMute: '#6B6B66',
  accent: '#2F6B4F',
  accentSoft: 'rgba(47,107,79,0.10)',
  accentLine: 'rgba(47,107,79,0.42)',
  onAccent: '#FFFFFF',
  ok: '#2F6B4F',
  warn: '#A15C11',
  warnSoft: 'rgba(161,92,17,0.12)',
  err: '#B3261E',
  errSoft: 'rgba(179,38,30,0.10)'
}

const dark: Palette = {
  bg0: '#181A1D',
  bg1: '#1E2125',
  bg2: '#22252A',
  bg3: '#2B2F34',
  border: 'rgba(236,234,230,0.14)',
  borderSoft: 'rgba(236,234,230,0.08)',
  borderStr: 'rgba(236,234,230,0.22)',
  fg: '#ECEAE6',
  fgDim: '#B9B6B0',
  fgMute: '#8E8B85',
  accent: '#7FB79A',
  accentSoft: 'rgba(127,183,154,0.16)',
  accentLine: 'rgba(127,183,154,0.46)',
  onAccent: '#0F1214',
  ok: '#7FB79A',
  warn: '#E0A85C',
  warnSoft: 'rgba(224,168,92,0.16)',
  err: '#F08A84',
  errSoft: 'rgba(240,138,132,0.16)'
}

/** 生活风格的调色板；浅色即 A · 纸墨留白。 */
export function useLifePalette(): Palette {
  return useColorScheme() === 'light' ? light : dark
}
