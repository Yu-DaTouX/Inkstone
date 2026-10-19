/* 由 scripts/design/build-tokens.mjs 从 design/tokens.json 生成，不要手改。 */
/**
 * MCP Apps 标准主题变量 → 砚令牌（02 §5.11）。
 *
 * 主进程 MCP App 宿主在 `ui/initialize` 的 hostContext.styles.variables 中按当前明确主题
 * 下发这些值；每条 light-dark() 由宿主解析成具体值后再发送。
 */
export const APP_THEME_VARIABLES: Readonly<Record<string, string>> = {
  "--color-background-primary": "light-dark(#FFFFFF, #272725)",
  "--color-background-secondary": "light-dark(#FAFAF8, #1E1E1C)",
  "--color-background-tertiary": "light-dark(#F4F4F1, #171716)",
  "--color-background-inverse": "light-dark(#1D1D1B, #ECECE9)",
  "--color-background-ghost": "transparent",
  "--color-background-info": "light-dark(rgba(64,87,214,.10), rgba(142,161,245,.14))",
  "--color-background-danger": "light-dark(#FBEBEB, rgba(240,112,112,.12))",
  "--color-background-success": "light-dark(#E9F5EE, rgba(76,195,138,.12))",
  "--color-background-warning": "light-dark(#FBF3E2, rgba(230,180,80,.12))",
  "--color-text-primary": "light-dark(#1D1D1B, #ECECE9)",
  "--color-text-secondary": "light-dark(#4D4C47, #B5B4AF)",
  "--color-text-tertiary": "light-dark(#696861, #9B9A94)",
  "--color-text-inverse": "light-dark(#FFFFFF, #1E1E1C)",
  "--color-text-info": "light-dark(#4057D6, #8EA1F5)",
  "--color-text-danger": "light-dark(#B42B2B, #F28383)",
  "--color-text-success": "light-dark(#4057D6, #8EA1F5)",
  "--color-text-warning": "light-dark(#8F5B00, #E6B450)",
  "--color-border-primary": "light-dark(rgba(29,29,27,.14), rgba(255,255,255,.14))",
  "--color-border-secondary": "light-dark(rgba(29,29,27,.14), rgba(255,255,255,.14))",
  "--color-border-tertiary": "light-dark(rgba(29,29,27,.08), rgba(255,255,255,.08))",
  "--color-ring-primary": "light-dark(#4057D6, #8EA1F5)",
  "--font-sans": "\"Segoe UI Variable Text\", \"Segoe UI Variable\", \"Segoe UI\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", \"PingFang SC\", \"Noto Sans CJK SC\", system-ui, sans-serif",
  "--font-mono": "\"Cascadia Mono\", \"Cascadia Code\", \"JetBrains Mono\", \"SF Mono\", Consolas, \"Microsoft YaHei UI\", monospace",
  "--font-weight-normal": "400",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "700",
  "--font-text-xs-size": "12px",
  "--font-text-sm-size": "13.5px",
  "--font-text-md-size": "15px",
  "--font-text-lg-size": "17px",
  "--font-heading-xs-size": "12px",
  "--font-heading-sm-size": "13.5px",
  "--font-heading-md-size": "15px",
  "--font-heading-lg-size": "17px",
  "--font-heading-xl-size": "20px",
  "--font-heading-2xl-size": "24px",
  "--font-heading-3xl-size": "28px",
  "--border-radius-xs": "6px",
  "--border-radius-sm": "8px",
  "--border-radius-md": "12px",
  "--border-radius-lg": "14px",
  "--border-radius-xl": "20px",
  "--border-radius-full": "9999px",
  "--border-width-regular": "1px",
  "--shadow-hairline": "0 0 0 1px light-dark(rgba(29,29,27,.08), rgba(255,255,255,.08))",
  "--shadow-sm": "0 0 0 1px light-dark(rgba(29,29,27,.08), rgba(255,255,255,.08))"
}

/**
 * 阴影不是颜色，无法用 light-dark()；按主题分别给出，由宿主按当前主题取值下发。
 */
export const APP_THEME_SHADOW_VARIABLES: Readonly<
  Record<'light' | 'dark', Readonly<Record<string, string>>>
> = {
  "light": {
    "--shadow-md": "0 1px 2px rgba(0,0,0,.04), 0 8px 28px -10px rgba(0,0,0,.12)",
    "--shadow-lg": "0 0 0 1px rgba(0,0,0,.06), 0 16px 40px -10px rgba(0,0,0,.22)"
  },
  "dark": {
    "--shadow-md": "0 1px 2px rgba(0,0,0,.3), 0 10px 30px -10px rgba(0,0,0,.55)",
    "--shadow-lg": "0 0 0 1px rgba(255,255,255,.08), 0 18px 44px -10px rgba(0,0,0,.65)"
  }
}
