#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')
let checks = 0
const ok = (cond, label) => {
  assert.ok(cond, label)
  checks++
  console.log(`✓ ${label}`)
}

const storage = new Map()
globalThis.localStorage = {
  getItem: (k) => (storage.has(String(k)) ? storage.get(String(k)) : null),
  setItem: (k, v) => storage.set(String(k), String(v)),
  removeItem: (k) => storage.delete(String(k)),
  clear: () => storage.clear(),
  key: () => null,
  length: 0
}
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', clipboard: {} }, configurable: true })

await mkdir(join(ROOT, '.tmp'), { recursive: true })
const dir = await mkdtemp(join(ROOT, '.tmp', 'v3-quota-card-'))
try {
  const entry = join(dir, 'entry.ts')
  await writeFile(
    entry,
    `export { QuotaCard } from ${JSON.stringify(posix(resolve(ROOT, 'src/renderer/src/features/workbench/QuotaPane.tsx')))}\n` +
      `export { quotaResetLine } from ${JSON.stringify(posix(resolve(ROOT, 'src/renderer/src/patterns/QuotaWindowRow.tsx')))}\n` +
      `export { I18nProvider } from ${JSON.stringify(posix(resolve(ROOT, 'src/renderer/src/i18n/index.tsx')))}\n`
  )
  const out = join(dir, 'bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    jsx: 'automatic',
    loader: { '.json': 'json', '.css': 'empty' },
    external: ['react', 'react-dom', 'react-dom/server', 'react-aria-components', 'react-aria', 'react-stately', '@react-aria/*', '@react-stately/*', '@react-types/*', 'lucide-react']
  })
  const mod = await import(pathToFileURL(out).href)
  const now = Date.now()
  const base = { source: 'yan', provider: 'openai-codex', name: 'ChatGPT', checkedAt: now }
  const html = (card, props = {}) =>
    renderToStaticMarkup(
      createElement(
        mod.I18nProvider,
        null,
        createElement(mod.QuotaCard, { card: { ...base, status: 'ok', windows: [], ...card }, busy: false, locked: false, onSwitch() {}, ...props })
      )
    )

  const low = html({ key: 'k1', email: 'a@example.com', windows: [{ id: 'five_hour', label: '5 小时', used: 20, total: 100, resetAt: now + 3 * 3600_000 }] })
  ok(low.includes('data-tone="ok"') && low.includes('20.0%'), '低用量窗口：ok 色调与精确百分比')
  ok(low.includes('a@example.com'), '标题显示邮箱')

  const warn = html({ key: 'k2', windows: [{ id: 'weekly', label: '每周', used: 85, total: 100 }] })
  ok(warn.includes('data-tone="warn"'), '85% 窗口：warn 色调')

  const exceeded = html({ key: 'k3', status: 'limited', windows: [{ id: 'monthly', label: '本月', used: 100, total: 100, exceeded: true, estimated: true }] })
  ok(exceeded.includes('data-tone="err"'), '用尽窗口：err 色调')
  ok(exceeded.includes('ui-badge'), '推算窗口与已达上限都带徽标')

  const active = html({ key: 'k4', active: true, switchable: true })
  ok(!active.includes('v3-wb-quota-switch'), '活跃账号没有切换按钮')
  const other = html({ key: 'k5', switchable: true })
  ok(other.includes('v3-wb-quota-switch'), '可切换的非活跃账号有切换按钮')
  const locked = html({ key: 'k5', switchable: true }, { locked: true })
  ok(/data-testid="v3-wb-quota-switch"[^>]*disabled/.test(locked), '锁定期间切换按钮禁用')

  const balance = html({ key: 'k6', balance: { label: '余额', amount: 3.5, currency: 'USD' } })
  ok(balance.includes('余额') && /3\.5/.test(balance), '显示余额')

  const failed = html({ key: 'k7', status: 'error', error: 'boom' })
  ok(failed.includes('boom'), '查询失败的卡显示错误')
  const expired = html({ key: 'k8', status: 'expired', hint: '请重新登录' })
  ok(expired.includes('请重新登录'), '凭证过期的卡显示提示')

  const t = (key, vars) => `${key}:${JSON.stringify(vars ?? {})}`
  ok(mod.quotaResetLine(t, { id: 'five_hour', label: 'x', used: 0, total: 1 }, now).text === '', '没有重置时间不显示')
  ok(mod.quotaResetLine(t, { id: 'five_hour', label: 'x', used: 0, total: 1, resetAt: now - 1000 }, now).text.startsWith('quota.resetDue'), '已到点显示待刷新（不本地归零）')
  ok(mod.quotaResetLine(t, { id: 'monthly', label: 'x', used: 0, total: 1, resetAt: now + 5 * 86400_000 }, now).text.startsWith('quota.resetOn'), '月窗口显示日期')
  ok(mod.quotaResetLine(t, { id: 'five_hour', label: 'x', used: 0, total: 1, resetAt: now + 90 * 60_000 }, now).text.includes('quota.durHM'), '短窗口显示时分倒计时')
  ok(mod.quotaResetLine(t, { id: 'weekly', label: 'x', used: 0, total: 1, resetAt: now + 3 * 86400_000 + 3600_000 }, now).text.includes('quota.durDH'), '长窗口显示天时倒计时')
  console.log(`\nv3-quota-card: ${checks} checks passed`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
