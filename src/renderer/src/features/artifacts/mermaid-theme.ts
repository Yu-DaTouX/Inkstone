/**
 * Mermaid 主题（WP-32 · 02 §11.5）。
 *
 * 深浅两套主题只差 `data-theme`，其余颜色全部来自 v3 令牌；这里保持**纯函数**：
 * 不读文档、不硬编码色值，输入一组令牌值，输出 mermaid 的 `themeVariables`。
 * `MermaidBlock` 负责从 `design/tokens.css` 取实际值，Node 单测直接驱动本模块。
 */

/** 生成 mermaid 主题需要的 v3 令牌（名字固定，值来自当前主题）。 */
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

/** 令牌名 → v3 CSS 变量；供运行时读取与静态核对共用。 */
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

/**
 * mermaid `theme: 'base'` 的变量映射：
 *   · 节点底/文字用 `surface` / `fg`，描边用强调色；
 *   · 连线与网格用 `line` / `fg3`（规范要求坐标轴与网格用 `line`/`fg3`）；
 *   · 注释、分组、边标签各取一层背景，不做额外发光或渐变。
 */
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
