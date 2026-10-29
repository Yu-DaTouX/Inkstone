import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const directory = await mkdtemp(resolve('.tmp', 'quota-refresh-'))
const originalWindow = globalThis.window
const originalNow = Date.now
let now = 1_000_000
let calls = 0
let response
const snapshot = (used, checkedAt = now) => ({ provider: 'openai-codex', supported: true, windows: [{ id: 'primary', label: '五小时', used, total: 100 }], checkedAt })
const report = (key, used, checkedAt = now) => ({ cards: [{ key, source: 'yan', provider: 'openai-codex', name: 'ChatGPT', active: true, status: 'ok', windows: snapshot(used).windows, checkedAt }], checkedAt })
Date.now = () => now
try {
  globalThis.window = { yan: { providerQuota: () => { calls++; return response ?? Promise.resolve(snapshot(10)) } } }
  const file = resolve(directory, 'live-quota.mjs')
  await build({ entryPoints: ['src/renderer/src/state/live-quota.ts'], outfile: file, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const quota = await import(pathToFileURL(file).href)
  assert.equal(quota.LIVE_QUOTA_POLL_MS, 30_000)
  assert.equal(quota.LIVE_QUOTA_MIN_GAP_MS, 15_000)
  await quota.refreshLiveQuota('openai-codex')
  assert.equal(calls, 1)
  await quota.refreshLiveQuota('openai-codex')
  assert.equal(calls, 1, '短时间重复触发合并为缓存读取')
  now += 15_000
  await quota.refreshLiveQuota('openai-codex')
  assert.equal(calls, 2, '15 秒后允许刷新，不再被一分钟限流挡住')
  await quota.refreshLiveQuota('openai-codex', { force: true })
  assert.equal(calls, 3, '回合结束强制刷新不受最短间隔限制')

  let finish
  response = new Promise((done) => { finish = done })
  const pending = quota.refreshLiveQuota('openai-codex', { force: true })
  assert.equal(quota.refreshLiveQuota('openai-codex', { force: true }), pending, '并发刷新只发一个请求')
  now += 1_000
  quota.publishAccountQuotaReport(report('account-a', 62))
  assert.equal(quota.useLiveQuota.getState().entries['openai-codex'].snapshot.windows[0].used, 62, '账户面板读数立即同步到侧栏')
  finish(snapshot(33, now - 1_000))
  await pending
  assert.equal(quota.useLiveQuota.getState().entries['openai-codex'].snapshot.windows[0].used, 62, '旧侧栏请求不能覆盖账户面板的新读数')

  now += 1_000
  quota.publishAccountQuotaReport(report('account-a', 12, now - 2_000))
  assert.equal(quota.useLiveQuota.getState().entries['openai-codex'].snapshot.windows[0].used, 62, '旧账户报告不回退新读数')
  const next = report('account-b', 23)
  next.cards.push({ ...next.cards[0], key: 'inactive', active: false, windows: snapshot(99).windows })
  quota.publishAccountQuotaReport(next)
  assert.equal(quota.useLiveQuota.getState().entries['openai-codex'].accountKey, 'account-b')
  assert.equal(quota.useLiveQuota.getState().entries['openai-codex'].snapshot.windows[0].used, 23, '选当前账户而非备用账户')

  let reject
  response = new Promise((_, fail) => { reject = fail })
  const failed = quota.refreshLiveQuota('openai-codex', { force: true })
  now += 1_000
  quota.publishAccountQuotaReport(report('account-c', 42))
  reject(new Error('old connection failed'))
  await failed
  assert.equal(quota.useLiveQuota.getState().entries['openai-codex'].snapshot.windows[0].used, 42)
  assert.equal(quota.useLiveQuota.getState().entries['openai-codex'].snapshot.staleError, undefined, '旧请求失败也不能污染换号后的读数')

  const overview = await readFile('src/renderer/src/features/workbench/OverviewPane.tsx', 'utf8')
  const pane = await readFile('src/renderer/src/features/workbench/QuotaPane.tsx', 'utf8')
  assert.ok(overview.includes('refreshLive(provider, runEnded > 0 || authProviders.length > 0)'), '回合结束接线强制刷新')
  assert.ok(overview.includes("document.addEventListener('visibilitychange', onFocus)"))
  assert.ok(pane.includes('publishAccountQuotaReport(next)'))
  assert.ok(pane.includes('}, LIVE_QUOTA_POLL_MS)'))
  assert.ok(!pane.includes('AUTO_REFRESH_MS = 5 * 60_000'))
  console.log('live-quota-refresh: passed; synthetic IPC only')
} finally {
  Date.now = originalNow
  if (originalWindow === undefined) delete globalThis.window
  else globalThis.window = originalWindow
  await rm(directory, { recursive: true, force: true })
}
