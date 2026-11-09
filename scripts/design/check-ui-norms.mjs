#!/usr/bin/env node
import { globSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const renderer = 'src/renderer/src'

const PALETTE = 'white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
const COLOR_UTILITY = 'text|bg|border(?:-[trblxyse])?|ring|outline|fill|stroke|from|via|to|shadow|inset-shadow|divide|decoration|placeholder|caret|accent'
const paletteClass = new RegExp(`(?<=^|[\\s"'\`:])(?:${COLOR_UTILITY})-(?:${PALETTE})(?:-\\d{2,3})?(?:\\/\\d+)?(?![\\w-])`, 'g')
const arbitraryLiteral = /\[[^\]\s]*(?:rgba?\(|hsla?\(|oklch\(|#[0-9a-fA-F]{3,8}\b|--theme\(--color-)[^\]\s]*\]/g
const transitionAllClass = /(?<=^|[\s"'`:])transition-all(?![\w-])/g
const cssTransitionAll = /transition(?:-property)?\s*:\s*all\b/g
const cssColorLiteral = /rgba?\(|hsla?\(|oklch\(|#[0-9a-fA-F]{3,8}\b/g

const files = (pattern) => globSync(pattern, { cwd: root }).map((file) => file.split(sep).join('/')).filter((file) => !file.includes('.stories.'))
const lineOf = (text, index) => text.slice(0, index).split('\n').length

const problems = []
const report = (file, text, index, message) => problems.push(`${file}:${lineOf(text, index)}  ${message}`)

function scanAll(file, text, re, message) {
  for (const match of text.matchAll(re)) report(file, text, match.index, `${message}：${match[0]}`)
}

function tagEnd(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === '>' && depth === 0) return i
  }
  return text.length
}

function iconButtonsWithoutLabel(file, text) {
  for (const match of text.matchAll(/<(?:Button|T3Button)\b/g)) {
    if (/render=\{\s*$/.test(text.slice(Math.max(0, match.index - 12), match.index))) continue
    const tag = text.slice(match.index, tagEnd(text, match.index) + 1)
    if (!/\bsize=["']icon/.test(tag)) continue
    if (/aria-label(?:ledby)?=/.test(tag) || /\{\.\.\.[^}]+\}/.test(tag) || /\brender=/.test(tag)) continue
    report(file, text, match.index, '只有图标的按钮缺 aria-label')
  }
}

for (const file of files(`${renderer}/**/*.{ts,tsx}`)) {
  const text = readFileSync(resolve(root, file), 'utf8')
  if (file.startsWith(`${renderer}/t3/`) || text.includes('className')) {
    scanAll(file, text, paletteClass, '用了 Tailwind 调色板色，改用令牌（如 text-(--ok-t)）')
    scanAll(file, text, arbitraryLiteral, '方括号里写死了颜色或阴影，改用令牌')
    scanAll(file, text, transitionAllClass, '不要 transition-all，写明要过渡的属性')
  }
  if (file.endsWith('.tsx')) iconButtonsWithoutLabel(file, text)
}

for (const file of files(`${renderer}/**/*.css`)) {
  const text = readFileSync(resolve(root, file), 'utf8')
  scanAll(file, text, cssTransitionAll, '不要 transition: all')
  if (file.startsWith(`${renderer}/t3/`) && file.endsWith('.css')) scanAll(file, text, cssColorLiteral, 't3 版面 CSS 只能引用令牌，不能写死颜色')
}

if (problems.length) {
  console.error(problems.join('\n'))
  console.error(`\nUI 规范检查：${problems.length} 处不合规（规则见 .local-docs 的 UI 风格规范；颜色、阴影来自 src/renderer/src/design/tokens.json）`)
  process.exit(1)
}
console.log(`UI 规范检查通过：${relative(root, resolve(root, renderer))} 下无调色板色、写死阴影、transition-all，T3 版面 CSS 只引用令牌`)
