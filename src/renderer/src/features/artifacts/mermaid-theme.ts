export interface MermaidTokenSet {
  readonly dark: boolean
  readonly bg: string
  readonly surface: string
  readonly surfaceAlt: string
  readonly sunken: string
  readonly fg: string
  readonly fgMute: string
  readonly line2: string
  readonly accent: string
  readonly font: string
}

export const MERMAID_THEME_TOKEN_NAMES = {
  bg: '--bg',
  surface: '--surface',
  surfaceAlt: '--hover',
  sunken: '--sunken',
  fg: '--fg',
  fgMute: '--fg3',
  line2: '--line2',
  accent: '--accent',
  font: '--font-ui'
} as const

export type MermaidThemeVariables = Record<string, string | boolean>

export function mermaidThemeVariables(tokens: MermaidTokenSet): MermaidThemeVariables {
  return {
    darkMode: tokens.dark,
    fontSize: '13px',
    fontFamily: tokens.font,
    background: tokens.bg,
    primaryColor: tokens.surface,
    primaryTextColor: tokens.fg,
    primaryBorderColor: tokens.accent,
    secondaryColor: tokens.surfaceAlt,
    tertiaryColor: tokens.sunken,
    lineColor: tokens.fgMute,
    textColor: tokens.fg,
    noteBkgColor: tokens.surfaceAlt,
    noteTextColor: tokens.fg,
    noteBorderColor: tokens.line2,
    edgeLabelBackground: tokens.bg,
    clusterBkg: tokens.surface,
    clusterBorder: tokens.line2
  }
}
