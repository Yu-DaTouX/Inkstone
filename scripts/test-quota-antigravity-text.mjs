import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { AntigravityQuotaDetails, antigravityQuotaSummary } = await compile('src/renderer/src/features/workbench/AntigravityQuota.tsx', {
    jsx: 'automatic', loader: { '.css': 'empty' }, packages: 'external'
  })
  const now = new Date(2026, 10, 23, 12, 0).getTime()
  const model = { id: 'fixture-model' }
  const groups = [{ name: 'Fixture', models: [model.id], windows: [
    { id: 'five-hour', name: 'Five hour', period: '5h', remainingFraction: 0.75, resetAt: now + 90 * 60_000 },
    { id: 'week', name: 'Weekly', period: 'weekly', remainingFraction: 0.5, resetAt: now + 48 * 60 * 60_000 }
  ] }]
  const snapshot = { groups, staleSince: now, error: 'fixture timeout' }
  for (const [lang, expected] of [
    ['en-US', ['Refresh quota', 'Resets 13:30 · in 1h 30m', 'Remaining 75% (25% used)', 'Showing the last successful allowance. fixture timeout', '5h 75% · Wk 50% · Stale']],
    ['zh-CN', ['刷新额度', '重置 13:30 · 1时30分后', '剩余 75% (25% 已用)', '正在显示上次成功查询的额度。fixture timeout', '5h 75% · 每周 50% · 旧数据']]
  ]) {
    const detail = renderToStaticMarkup(createElement(AntigravityQuotaDetails, { lang, now, model, quota: { snapshot, loading: false, refresh() {} } }))
    for (const phrase of expected.slice(0, -1)) ok(detail.includes(phrase), `${lang}：${phrase}`)
    ok(antigravityQuotaSummary(snapshot, model, lang) === expected.at(-1), `${lang}：额度摘要保留完整文案`)
  }
})
