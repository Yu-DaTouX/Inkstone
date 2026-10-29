/* 由 scripts/design/build-tokens.mjs 生成，不要手改。 */
export const APP_THEME_VARIABLES: Readonly<Record<string, string>> = {
  "--color-background-primary": "light-dark(#FFFFFF, #1F1F1E)",
  "--color-background-secondary": "light-dark(#FCFCFB, #181818)",
  "--color-background-tertiary": "light-dark(#F4F4F2, #131313)",
  "--color-background-inverse": "light-dark(#0B0B0B, #FFFFFF)",
  "--color-background-ghost": "transparent",
  "--color-background-info": "light-dark(rgba(42,120,214,.1), rgba(42,120,214,.2))",
  "--color-background-danger": "light-dark(#FCEBEB, rgba(236,126,126,.12))",
  "--color-background-success": "light-dark(#E6F4E4, rgba(50,215,75,.12))",
  "--color-background-warning": "light-dark(#FDF1D6, rgba(250,178,25,.12))",
  "--color-text-primary": "light-dark(#20211F, #D4D3CE)",
  "--color-text-secondary": "light-dark(#555750, #BAB9B3)",
  "--color-text-tertiary": "light-dark(#6B6A64, #A3A29C)",
  "--color-text-inverse": "light-dark(#FFFFFF, #0B0B0B)",
  "--color-text-info": "light-dark(#184F95, #6DA7EC)",
  "--color-text-danger": "light-dark(#8E2626, #EC7E7E)",
  "--color-text-success": "light-dark(#006300, #14AD14)",
  "--color-text-warning": "light-dark(#734500, #DB9300)",
  "--color-border-primary": "light-dark(rgba(11,11,11,.2), rgba(255,255,255,.2))",
  "--color-border-secondary": "light-dark(rgba(11,11,11,.2), rgba(255,255,255,.2))",
  "--color-border-tertiary": "light-dark(rgba(11,11,11,.1), rgba(255,255,255,.12))",
  "--color-ring-primary": "#2875D2",
  "--font-sans": "\"Segoe UI Variable Text\", \"Segoe UI Variable\", \"Segoe UI\", \"Noto Sans SC\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", \"PingFang SC\", \"Noto Sans CJK SC\", system-ui, sans-serif",
  "--font-mono": "\"Cascadia Mono\", \"Cascadia Code\", \"JetBrains Mono\", \"SF Mono\", Consolas, \"Microsoft YaHei UI\", monospace",
  "--font-weight-normal": "400",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "700",
  "--font-text-xs-size": "11px",
  "--font-text-sm-size": "12px",
  "--font-text-md-size": "13px",
  "--font-text-lg-size": "14px",
  "--font-heading-xs-size": "12px",
  "--font-heading-sm-size": "13px",
  "--font-heading-md-size": "14px",
  "--font-heading-lg-size": "16px",
  "--font-heading-xl-size": "20px",
  "--font-heading-2xl-size": "24px",
  "--font-heading-3xl-size": "28px",
  "--border-radius-xs": "4px",
  "--border-radius-sm": "6px",
  "--border-radius-md": "8px",
  "--border-radius-lg": "10px",
  "--border-radius-xl": "14px",
  "--border-radius-full": "9999px",
  "--border-width-regular": "1px",
  "--shadow-hairline": "0 0 0 1px light-dark(rgba(11,11,11,.1), rgba(255,255,255,.12))",
  "--shadow-sm": "0 0 0 1px light-dark(rgba(11,11,11,.1), rgba(255,255,255,.12))"
}

export const APP_THEME_SHADOW_VARIABLES: Readonly<
  Record<'light' | 'dark', Readonly<Record<string, string>>>
> = {
  "light": {
    "--shadow-md": "0 0 0 .5px rgba(31,31,30,.15), 0 4px 20px rgba(0,0,0,.035)",
    "--shadow-lg": "0 0 0 .5px rgba(11,11,11,.12), 0 8px 24px rgba(0,0,0,.1), 0 2px 6px rgba(0,0,0,.05)"
  },
  "dark": {
    "--shadow-md": "inset 0 0 0 var(--hair, 1px) rgba(255,255,255,.13)",
    "--shadow-lg": "inset 0 0 0 var(--hair, 1px) rgba(255,255,255,.1), 0 8px 24px rgba(0,0,0,.55), 0 2px 6px rgba(0,0,0,.35)"
  }
}
