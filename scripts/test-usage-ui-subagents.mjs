import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`✓ ${label}`)
}

export async function runUsageUiTests() {
  const outdir = await mkdtemp(join(tmpdir(), 'inkstone-usage-ui-'))
  const here = process.cwd()
  const p = (rel) => join(here, rel).replace(/\\/g, '/')
  const entry = [
    "import * as React from 'react'",
    "import { renderToStaticMarkup } from 'react-dom/server'",
    `import * as UsageOverviewView from '${p('src/renderer/src/features/usage/UsageOverviewView.tsx')}'`,
    `import * as UsageStatsGrid from '${p('src/renderer/src/features/settings/usage/UsageStatsGrid.tsx')}'`,
    `import * as i18n from '${p('src/renderer/src/i18n/index.tsx')}'`,
    `import * as settingsText from '${p('src/renderer/src/features/settings/settings-text.ts')}'`,
    `import * as shared from '${p('src/shared/usage-stats.ts')}'`,
    'export { React, renderToStaticMarkup, UsageOverviewView, UsageStatsGrid, i18n, settingsText, shared }'
  ].join('\n')
  const outfile = join(outdir, 'usage-ui.bundle.cjs')
  await build({
    stdin: { contents: entry, resolveDir: here, loader: 'ts' },
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    logLevel: 'silent'
  })

  const bundle = createRequire(import.meta.url)(outfile)
  const view = bundle.UsageOverviewView
  const grid = bundle.UsageStatsGrid
  const i18n = bundle.i18n
  const settingsText = bundle.settingsText
  const shared = bundle.shared
  const createElement = bundle.React.createElement
  const renderToStaticMarkup = bundle.renderToStaticMarkup

  const now = new Date(2026, 9, 15, 12, 0, 0).getTime()
  const recent = shared.localDay(now)
  const old = '2026-01-05'
  const day = (date, m, t, hour, models) => ({ [date]: { m, t, h: { [hour]: m }, models } })

  const tOf = (lang) => (key, vars) => i18n.translate(lang, key, vars)

  const mainSub = shared.aggregateUsageSources(
    {
      main: [day(recent, 1, 20000, 9, { 'p/a': 20000 })],
      subagents: [day(recent, 3, 80000, 9, { 'p/b': 80000 })]
    },
    'all',
    now
  )
  const renderOverview = (stats, extra = {}) =>
    renderToStaticMarkup(
      createElement(view.UsageOverviewView, {
        stats,
        range: 'all',
        tab: 'overview',
        models: [],
        t: tOf('zh-CN'),
        onTabChange: () => {},
        onRangeChange: () => {},
        ...extra
      })
    )

  ok(mainSub.tokens === 100000 && mainSub.tokenBreakdown.main === 20000 && mainSub.tokenBreakdown.subagents === 80000, 'production 聚合：tokens = 主 + 子')
  const zhHtml = renderOverview(mainSub)
  ok(zhHtml.includes('data-testid="usage-tokens"') && zhHtml.includes('100K'), '主数字渲染 Token 合计 100K')
  ok(!zhHtml.includes('usage-token-breakdown') && !zhHtml.includes('主会话 20K'), '主数字下只显示总数，不再拆主会话 / 子代理')
  ok(zhHtml.includes('title="Token 含子代理与缓存读写；会话、消息、活跃天数仍只计主会话。"'), '主数字带口径 tooltip')
  ok(zhHtml.includes('1') && zhHtml.includes('>会话<'), '会话数仍来自主会话（1）')

  const legacy = { ...mainSub }
  delete legacy.tokenBreakdown
  const legacyFallback = shared.tokenBreakdownOf(legacy)
  ok(legacyFallback.main === 100000 && legacyFallback.subagents === 0, 'tokenBreakdownOf 缺字段回退为全主会话')
  const legacyHtml = renderOverview(legacy)
  ok(!legacyHtml.includes('子代理 0'), '缺 breakdown 的旧结果同样不出现拆分行')

  const childOnly = shared.aggregateUsageSources(
    { main: [], subagents: [day(recent, 3, 80000, 9, { 'p/b': 80000 })] },
    'all',
    now
  )
  ok(childOnly.sessions === 0 && childOnly.tokens === 80000, 'production 聚合：只有子代理时 sessions=0、tokens=80K')
  const childHtml = renderOverview(childOnly)
  ok(childHtml.includes('data-testid="usage-overview"') && childHtml.includes('80K'), '只有子代理时用量面板仍然显示')
  ok(!childHtml.includes('主会话 0'), '只有子代理时也不出现拆分行')
  ok(childHtml.includes('data-testid="usage-overview"') && childHtml.includes('>0</dd>'), '主会话会话数如实渲染 0')

  const none = shared.aggregateUsageSources({ main: [], subagents: [] }, 'all', now)
  ok(renderOverview(none) === '', '无任何用量时（全部范围）用量面板不渲染')

  const rangeMain = [day(recent, 1, 20000, 9, { 'p/a': 20000 }), day(old, 1, 50000, 9, { 'p/a': 50000 })]
  const rangeAll = shared.aggregateUsageSources({ main: rangeMain, subagents: [] }, 'all', now)
  const range7 = shared.aggregateUsageSources({ main: rangeMain, subagents: [] }, '7d', now)
  const allHtml = renderOverview(rangeAll)
  const sevenHtml = renderOverview(range7, { range: '7d' })
  ok(allHtml.includes('70K'), '全部范围渲染累计 70K')
  ok(sevenHtml.includes('20K') && !sevenHtml.includes('70K'), '近 7 天范围只渲染范围内的 20K，更早的 50K 不计入')
  ok(sevenHtml.includes('aria-pressed="true"') && sevenHtml.includes('7 天'), '范围切换按钮按下态跟随传入 range')

  const enHtml = renderOverview(mainSub, { t: tOf('en-US') })
  ok(!enHtml.includes('Subagents 80K'), '英文同样只显示总数')
  ok(enHtml.includes('Tokens include subagents plus cache read/write; sessions, messages and active days still count main sessions only.'), '英文 tooltip 来自 en-US catalog')

  const modelsHtml = renderOverview(mainSub, { tab: 'models' })
  ok(modelsHtml.includes('20K') && modelsHtml.includes('80K'), '模型页同时显示主会话模型 20K 与子代理模型 80K')
  ok(modelsHtml.includes('title="p/b"'), '子代理模型键直接来自 stats.models')
  ok(zhHtml.includes(`${recent} · 100K token`), '热力图单元格 token 数含子代理（当日 100K）')

  const zhText = settingsText.settingsText('zh-CN')
  const enText = settingsText.settingsText('en-US')
  const gridZh = renderToStaticMarkup(createElement(grid.UsageStatsGrid, { stats: mainSub, text: zhText }))
  ok(!gridZh.includes('settings-usage-breakdown') && !gridZh.includes('主会话 20K'), '设置页只显示总数，不再拆分')
  ok(gridZh.includes('data-testid="settings-usage-tokens"') && gridZh.includes('100K'), '设置页 Token 值仍是合计 100K')
  ok(gridZh.includes(`title="${zhText.usageTokensHint}"`), '设置页 Token 值带口径 tooltip')
  const gridEn = renderToStaticMarkup(createElement(grid.UsageStatsGrid, { stats: mainSub, text: enText }))
  ok(!gridEn.includes('Subagents 80K'), '设置页英文同样不拆分')
  const gridLegacy = renderToStaticMarkup(createElement(grid.UsageStatsGrid, { stats: legacy, text: zhText }))
  ok(!gridLegacy.includes('子代理 0'), '设置页缺 breakdown 的旧结果同样不拆分')

  await rm(outdir, { recursive: true, force: true })
  console.log(`usage-ui-subagents: ${checks} checks passed`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runUsageUiTests()
}
