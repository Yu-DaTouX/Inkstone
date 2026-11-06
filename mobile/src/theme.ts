import { useMemo } from 'react'
import { useColorScheme } from 'react-native'
import { v3Palette } from './theme-v3'
import { v3Data } from './theme.v3.generated'
import { AUTO_PROJECT_COLOR_COUNT, hashedProjectTone, projectMonogram } from '../../src/shared/project-monogram'

export interface Palette {
  bg0: string
  bg1: string
  bg2: string
  bg3: string
  bubble: string
  field: string
  surface: string
  surface3: string
  sunken: string
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
  online: string
  warn: string
  warnSoft: string
  err: string
  errSoft: string
  fail: string
  onFill: string
  add: string
  del: string
  press: string
  codeInline: string
  btnPrimary: string
  onBtnPrimary: string
}

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32 } as const
export const radius = { xs: 4, sm: 6, md: 8, lg: 10, bubble: 12, xl: 14, composer: 16, full: 999 } as const
export const font = { xs: 12, sm: 13, base: 14, body: 15, lg: 15, title: 20 } as const
export const weight = { regular: '400', medium: '500', strong: '600' } as const
export const lineHeight = { row: 24, body: 24 } as const
export const icon = { sm: 16, md: 18, lg: 24 } as const
export const touch = { min: 44, compact: 36 } as const
export const mono = 'monospace'

export function usePalette(): Palette {
  return v3Palette(useColorScheme() === 'light' ? 'light' : 'dark')
}

export function useProjectLook(ids: readonly string[]): (id: string, name: string) => { color: string; text: string } {
  const colors = v3Data[useColorScheme() === 'light' ? 'light' : 'dark']
  const key = ids.join('\n')
  const tones = useMemo(() => {
    const assigned = new Map<string, number>()
    const used = new Set<number>()
    for (const id of key ? key.split('\n') : []) {
      const preferred = hashedProjectTone(id)
      let tone = preferred
      for (let step = 0; step < AUTO_PROJECT_COLOR_COUNT; step++) {
        const candidate = ((preferred - 1 + step) % AUTO_PROJECT_COLOR_COUNT) + 1
        if (!used.has(candidate)) { tone = candidate; break }
      }
      assigned.set(id, tone)
      used.add(tone)
    }
    return assigned
  }, [key])
  return (id, name) => ({ color: colors[(tones.get(id) ?? hashedProjectTone(id)) - 1], text: projectMonogram(name) })
}
