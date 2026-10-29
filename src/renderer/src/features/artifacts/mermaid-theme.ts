export const MERMAID_COLOR_TOKENS = {
  '--pele-bg': '--bg',
  '--pele-fg': '--fg',
  '--pele-muted': '--fg3',
  '--pele-line': '--fg3',
  '--pele-surface': '--surface',
  '--pele-surface-alt': '--hover',
  '--pele-border': '--line2',
  '--pele-accent': '--accent',
  '--pele-critical': '--fail',
  '--pele-series-1': '--data-1',
  '--pele-series-2': '--data-2',
  '--pele-series-3': '--data-3',
  '--pele-series-4': '--data-4',
  '--pele-series-5': '--data-5',
  '--pele-series-6': '--data-6',
  '--pele-series-7': '--data-7',
  '--pele-series-8': '--data-8'
} as const

export const MERMAID_TEXT_TOKENS = {
  '--pele-font': '--font-ui',
  '--pele-font-mono': '--font-mono',
  '--pele-radius': '--r-xs'
} as const

export const MERMAID_FONT_SIZE = 13
export const MERMAID_MIN_SCALE = 0.8

export type MermaidThemeVariable = keyof typeof MERMAID_COLOR_TOKENS | keyof typeof MERMAID_TEXT_TOKENS

export function mermaidThemeStyle(): Record<MermaidThemeVariable, string> {
  const style = {} as Record<MermaidThemeVariable, string>
  for (const [name, token] of Object.entries({ ...MERMAID_COLOR_TOKENS, ...MERMAID_TEXT_TOKENS })) {
    style[name as MermaidThemeVariable] = `var(${token})`
  }
  return style
}

function attributeValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

export function withMinWidth(svg: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return svg
  return svg.replace(/^<svg([^>]*?)\sstyle="/, `<svg$1 style="min-width:${Math.ceil(width * MERMAID_MIN_SCALE)}px;`)
}

export function inlineMermaidTheme(svg: string, values: Partial<Record<MermaidThemeVariable, string>>): string {
  const declarations = Object.entries(values)
    .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
    .map(([name, value]) => `${name}:${attributeValue((value as string).trim())};`)
  const background = values['--pele-bg']?.trim()
  if (background) declarations.push(`background-color:${attributeValue(background)};`)
  if (declarations.length === 0) return svg
  return svg.replace(/^<svg([^>]*?)\sstyle="/, `<svg$1 style="${declarations.join('')}`)
}
