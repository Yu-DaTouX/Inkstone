#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = join(root, 'src/renderer/src/design/tokens.json')
const tokens = JSON.parse(readFileSync(source, 'utf8'))
const HEADER = '由 scripts/design/build-tokens.mjs 从 design/tokens.json 生成，不要手改。'

const pair = ([light, dark]) => (light === dark ? light : `light-dark(${light}, ${dark})`)

function darkShadowLines(indent = '    ') {
  return Object.entries(tokens.shadow).map(([name, value]) => `${indent}--shadow-${name}: ${value[1]};`)
}

function buildCss() {
  const lines = []
  lines.push(`/* ${HEADER} */`)
  lines.push('@layer tokens {')
  lines.push('  :root {')
  lines.push('    color-scheme: light dark;')
  for (const [name, value] of Object.entries(tokens.color)) lines.push(`    --${name}: ${pair(value)};`)
  for (const [name, value] of Object.entries(tokens.syntax ?? {})) lines.push(`    --syn-${name}: ${pair(value)};`)
  const [inkLight, inkDark] = tokens.alphaInk
  tokens.alpha.forEach((a, i) => lines.push(`    --alpha-${i}: ${pair([`rgba(${inkLight},${a})`, `rgba(${inkDark},${a})`])};`))
  tokens.data.forEach((value, i) => lines.push(`    --data-${i + 1}: ${pair(value)};`))
  for (const [name, value] of Object.entries(tokens.shadow)) lines.push(`    --shadow-${name}: ${value[0]};`)
  for (const [name, value] of Object.entries(tokens.ring)) lines.push(`    --ring-${name}: ${value};`)
  for (const [name, value] of Object.entries(tokens.font)) lines.push(`    --font-${name}: ${value};`)
  for (const [name, [size, lh, weight]] of Object.entries(tokens.type)) {
    lines.push(`    --t-${name}: ${size}px;`)
    lines.push(`    --t-${name}-lh: ${lh}px;`)
    if (weight !== 400) lines.push(`    --t-${name}-w: ${weight};`)
  }
  for (const [name, v] of Object.entries(tokens.weight)) lines.push(`    --w-${name}: ${v};`)
  tokens.space.forEach((v) => lines.push(`    --s-${String(v).replace('.', '_')}: ${v}px;`))
  for (const [name, v] of Object.entries(tokens.radius)) lines.push(`    --r-${name}: ${v}px;`)
  for (const [name, v] of Object.entries(tokens.size)) lines.push(`    --size-${name}: ${v}px;`)
  for (const [name, v] of Object.entries(tokens.motion)) lines.push(`    --${name.startsWith('ease') ? name : `dur-${name}`}: ${v};`)
  lines.push(`    --press-scale: ${tokens.press.scale};`)
  for (const [name, v] of Object.entries(tokens.z ?? {})) lines.push(`    --z-${name}: ${v};`)
  for (const [k, v] of Object.entries(tokens.d)) lines.push(`    --d-${k}: ${v}px;`)
  lines.push('  }')
  lines.push("  :root[data-theme='light'] { color-scheme: light; }")
  lines.push("  :root[data-theme='dark'] { color-scheme: dark; }")
  lines.push('  @media (prefers-color-scheme: dark) {')
  lines.push("    :root:not([data-theme='light']) {")
  lines.push(...darkShadowLines('      '))
  lines.push('    }')
  lines.push('  }')
  lines.push("  :root[data-theme='dark'] {")
  lines.push(...darkShadowLines())
  lines.push('  }')
  for (const [name, values] of Object.entries(tokens.density)) {
    lines.push(`  :root[data-density='${name}'] {`)
    for (const [k, v] of Object.entries(values)) {
      if (Array.isArray(v)) {
        lines.push(`    --${k}: ${v[0]}px;`)
        lines.push(`    --${k}-lh: ${v[1]}px;`)
      } else lines.push(`    --${k}: ${v}px;`)
    }
    lines.push('  }')
  }
  lines.push('}')
  return lines.join('\n') + '\n'
}

function buildAppThemeShared() {
  const c = tokens.color
  const px = (v) => `${v}px`
  const vars = {
    '--color-background-primary': pair(c.surface),
    '--color-background-secondary': pair(c.bg),
    '--color-background-tertiary': pair(c.sunken),
    '--color-background-inverse': pair(c.ink),
    '--color-background-ghost': 'transparent',
    '--color-background-info': pair(c.sel),
    '--color-background-danger': pair(c['fail-bg']),
    '--color-background-success': pair(c['add-bg']),
    '--color-background-warning': pair(c['ask-bg']),
    '--color-text-primary': pair(c.fg),
    '--color-text-secondary': pair(c.fg2),
    '--color-text-tertiary': pair(c.fg3),
    '--color-text-inverse': pair(c['on-ink']),
    '--color-text-info': pair(c['accent-t']),
    '--color-text-danger': pair(c['fail-t']),
    '--color-text-success': pair(c['ok-t']),
    '--color-text-warning': pair(c['ask-t']),
    '--color-border-primary': pair(c.line2),
    '--color-border-secondary': pair(c.line2),
    '--color-border-tertiary': pair(c.line),
    '--color-ring-primary': pair(c.accent),
    '--font-sans': tokens.font.ui,
    '--font-mono': tokens.font.mono,
    '--font-weight-normal': '400',
    '--font-weight-medium': '500',
    '--font-weight-semibold': '600',
    '--font-weight-bold': '700',
    '--font-text-xs-size': px(tokens.type.caption[0]),
    '--font-text-sm-size': px(tokens.type.footnote[0]),
    '--font-text-md-size': px(tokens.type.body[0]),
    '--font-text-lg-size': px(tokens.type.prose[0]),
    '--font-heading-xs-size': px(tokens.type.footnote[0]),
    '--font-heading-sm-size': px(tokens.type.body[0]),
    '--font-heading-md-size': px(tokens.type.heading[0]),
    '--font-heading-lg-size': px(16),
    '--font-heading-xl-size': px(tokens.type.title[0]),
    '--font-heading-2xl-size': px(24),
    '--font-heading-3xl-size': px(28),
    '--border-radius-xs': px(tokens.radius.xs),
    '--border-radius-sm': px(tokens.radius.sm),
    '--border-radius-md': px(tokens.radius.md),
    '--border-radius-lg': px(tokens.radius.lg),
    '--border-radius-xl': px(tokens.radius.xl),
    '--border-radius-full': '9999px',
    '--border-width-regular': '1px',
    '--shadow-hairline': `0 0 0 1px ${pair(c.line)}`,
    '--shadow-sm': `0 0 0 1px ${pair(c.line)}`
  }
  const shadowVars = {
    light: {
      '--shadow-md': tokens.shadow.comp[0],
      '--shadow-lg': tokens.shadow.pop[0]
    },
    dark: {
      '--shadow-md': tokens.shadow.comp[1],
      '--shadow-lg': tokens.shadow.pop[1]
    }
  }
  return (
    `/* ${HEADER} */\n` +
    '/**\n' +
    ' * MCP Apps 标准主题变量 → 砚令牌（02 §5.11）。\n' +
    ' *\n' +
    ' * 主进程 MCP App 宿主在 `ui/initialize` 的 hostContext.styles.variables 中按当前明确主题\n' +
    ' * 下发这些值；每条 light-dark() 由宿主解析成具体值后再发送。\n' +
    ' */\n' +
    `export const APP_THEME_VARIABLES: Readonly<Record<string, string>> = ${JSON.stringify(vars, null, 2)}\n` +
    '\n/**\n' +
    ' * 阴影不是颜色，无法用 light-dark()；按主题分别给出，由宿主按当前主题取值下发。\n' +
    ' */\n' +
    `export const APP_THEME_SHADOW_VARIABLES: Readonly<\n  Record<'light' | 'dark', Readonly<Record<string, string>>>\n> = ${JSON.stringify(shadowVars, null, 2)}\n`
  )
}

function buildAppThemeRenderer() {
  return (
    `/* ${HEADER} */\n` +
    '/**\n' +
    ' * MCP Apps 标准主题变量（02 §5.11）的渲染端投影。\n' +
    ' * 真源生成物在 src/shared/mcp-app-theme.generated.ts，主进程宿主与渲染端共用。\n' +
    ' */\n' +
    "export { APP_THEME_SHADOW_VARIABLES, APP_THEME_VARIABLES } from '../../../shared/mcp-app-theme.generated'\n"
  )
}

function buildMobile() {
  const light = {}
  const dark = {}
  for (const [name, [l, d]] of Object.entries(tokens.color)) {
    const key = name.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())
    light[key] = l
    dark[key] = d
  }
  return `/* ${HEADER} */\n/** v3 色板（与桌面同源）；WP-60 接入前不被引用。 */\nexport const v3Light = ${JSON.stringify(light, null, 2)} as const\n\nexport const v3Dark = ${JSON.stringify(dark, null, 2)} as const\n\nexport const v3Radius = ${JSON.stringify(tokens.radius)} as const\n`
}

const outputs = [
  [join(root, 'src/renderer/src/design/tokens.css'), buildCss()],
  [join(root, 'src/shared/mcp-app-theme.generated.ts'), buildAppThemeShared()],
  [join(root, 'src/renderer/src/design/app-theme.generated.ts'), buildAppThemeRenderer()],
  [join(root, 'mobile/src/theme.v3.generated.ts'), buildMobile()]
]

const check = process.argv.includes('--check')
let stale = 0
for (const [file, content] of outputs) {
  const rel = relative(root, file).replaceAll('\\', '/')
  if (check) {
    const current = existsSync(file) ? readFileSync(file, 'utf8').replaceAll('\r\n', '\n') : null
    if (current !== content) {
      stale += 1
      console.error(`生成物过期：${rel}（运行 node scripts/design/build-tokens.mjs）`)
    }
  } else {
    writeFileSync(file, content)
    console.log(`已生成 ${rel}`)
  }
}
if (check) {
  if (stale) process.exit(1)
  console.log('令牌生成物与来源一致')
}
