import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`✓ ${label}`)
}

function statsOf(shared, { main, subagents }, range, now) {
  return shared.aggregateUsageSources({ main: main ?? [], subagents: subagents ?? [] }, range, now)
}

function installGlobals() {
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (k) => (storage.has(String(k)) ? storage.get(String(k)) : null),
    setItem: (k, v) => storage.set(String(k), String(v)),
    removeItem: (k) => storage.delete(String(k)),
    clear: () => storage.clear()
  }
  function ElementShim() {}
  ElementShim.prototype = { focus() {}, blur() {}, addEventListener() {}, removeEventListener() {} }
  globalThis.HTMLElement = ElementShim
  globalThis.Element = ElementShim
  globalThis.Node = ElementShim
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
  globalThis.window = {
    yan: new Proxy({}, { get: () => async () => undefined }),
    HTMLElement: ElementShim,
    Element: ElementShim,
    Node: ElementShim,
    addEventListener: () => {},
    removeEventListener: () => {},
    getComputedStyle: globalThis.getComputedStyle,
    screen: { orientation: { angle: 0 } },
    location: { href: 'http://localhost/' }
  }
  globalThis.document = {
    readyState: 'loading',
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: {},
    visibilityState: 'visible'
  }
}

async function buildBundle(outdir) {
  const here = process.cwd()
  const p = (rel) => join(here, rel).replace(/\\/g, '/')
  const entry = [
    "import * as React from 'react'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    `import { V3EmptyState } from '${p('src/renderer/src/features/session/V3EmptyState.tsx')}'`,
    `import * as View from '${p('src/renderer/src/features/usage/UsageOverviewView.tsx')}'`,
    `import * as Pattern from '${p('src/renderer/src/patterns/UsagePattern.tsx')}'`,
    `import * as i18n from '${p('src/renderer/src/i18n/index.tsx')}'`,
    `import * as shared from '${p('src/shared/usage-stats.ts')}'`,
    'export { React, renderToStaticMarkup, V3EmptyState, View, Pattern, i18n, shared }'
  ].join('\n')
  const outfile = join(outdir, 'v3-empty-usage.bundle.cjs')
  await build({
    stdin: { contents: entry, resolveDir: here, loader: 'ts' },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.css': 'empty' }
  })
  return outfile
}

async function main() {
  installGlobals()
  const outdir = await mkdtemp(join(tmpdir(), 'inkstone-v3-empty-usage-'))
  const require = createRequire(import.meta.url)
  const bundle = require(await buildBundle(outdir))
  const { React, renderToStaticMarkup, V3EmptyState, View, Pattern, i18n, shared } = bundle
  const { createElement } = React

  const now = new Date(2026, 9, 15, 12, 0, 0).getTime()
  const recent = shared.localDay(now)
  const day = (date, m, t, hour, models) => ({ [date]: { m, t, h: { [hour]: m }, models } })
  const tOf = (lang) => (key, vars) => i18n.translate(lang, key, vars)

  const childOnly = statsOf(shared, { subagents: [day(recent, 3, 80000, 9, { 'p/b': 80000 })] }, 'all', now)
  const empty = statsOf(shared, {}, 'all', now)

  const usageView = (stats, lang = 'zh-CN', renderToggle) =>
    createElement(View.UsageOverviewView, {
      stats,
      range: 'all',
      tab: 'overview',
      models: [],
      t: tOf(lang),
      onTabChange: () => {},
      onRangeChange: () => {},
      renderToggle
    })

  const renderEmpty = (usage, lang = 'zh-CN') => {
    globalThis.localStorage.setItem('yan.lang', lang)
    return renderToStaticMarkup(createElement(i18n.I18nProvider, null, createElement(V3EmptyState, { usage })))
  }

  const childHtml = renderEmpty(usageView(childOnly, 'zh-CN', Pattern.renderUsageToggle))
  ok(childHtml.includes('data-testid="usage-overview"') && childHtml.includes('80K'), '只有子代理时空态仍渲染用量面板')

  const emptyHtml = renderEmpty(usageView(empty, 'zh-CN', Pattern.renderUsageToggle))
  ok(!emptyHtml.includes('data-testid="usage-overview"'), '无历史时空态不渲染用量面板')

  const keepView = (stats) => createElement(View.UsageOverviewView, {
    stats, range: 'all', tab: 'overview', models: [], t: tOf('zh-CN'), onTabChange: () => {}, onRangeChange: () => {},
    renderToggle: Pattern.renderUsageToggle, keepWhenEmpty: true, emptyNote: '还没有用量记录'
  })
  const keepEmpty = renderEmpty(keepView(empty))
  ok(keepEmpty.includes('data-testid="usage-overview"') && keepEmpty.includes('data-testid="usage-empty-note"'), 'v3 无记录时仍渲染用量框架并给出说明')
  ok(keepEmpty.includes('>0</dd>'), 'v3 无记录时计数显示 0')
  const keepPending = renderEmpty(keepView(null))
  ok(keepPending.includes('data-testid="usage-overview"') && keepPending.includes('data-pending=""'), 'v3 取数中仍渲染用量框架并标记 pending')
  ok(keepPending.includes('>—</span>') && keepPending.includes('>—</dd>'), 'v3 取数中数字显示「—」占位')
  ok(!keepPending.includes('usage-empty-note'), '取数中不误报「无记录」')

  await rm(outdir, { recursive: true, force: true })
  console.log(`\nv3-empty-usage: ${checks} checks passed`)
}

await main()
