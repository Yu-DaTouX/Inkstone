import assert from 'node:assert/strict'
import { build } from 'esbuild'

const built = await build({ stdin: { contents: `export * from './src/previewPlan'`, resolveDir: 'mobile', loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false })
const { planPreviews, PREVIEW_COUNT, PREVIEW_MIN_GAP_MS } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const sessions = Array.from({ length: 12 }, (_, index) => ({ id: `s${index}`, updatedAt: 1000 - index }))
const first = planPreviews(sessions, new Map(), new Map(), 0)
assert.equal(first.fetch.length, PREVIEW_COUNT, '只取最近 8 个会话的预览')
assert.equal(first.retryIn, null)

const versions = new Map(sessions.slice(0, PREVIEW_COUNT).map((s) => [s.id, s.updatedAt]))
assert.deepEqual(planPreviews(sessions, versions, new Map(), 10).fetch, [], '版本没变不重取')

const fetchedAt = new Map([['s0', 0]])
const bumped = sessions.map((s) => (s.id === 's0' ? { ...s, lastActivityAt: 5000 } : s))
const early = planPreviews(bumped, versions, fetchedAt, 1000)
assert.deepEqual(early.fetch, [], '间隔内推迟')
assert.equal(early.retryIn, PREVIEW_MIN_GAP_MS - 1000, '给出剩余等待时间')
assert.deepEqual(planPreviews(bumped, versions, fetchedAt, PREVIEW_MIN_GAP_MS + 1).fetch, ['s0'], '间隔过后补取')

let before = 0
let after = 0
const versionsNew = new Map()
const fetchedNew = new Map()
for (let tick = 0; tick < 80; tick++) {
  const now = tick * 750
  const live = [{ id: 'live', updatedAt: 1, lastActivityAt: 1000 + tick }]
  before += live.filter((s) => (versionsNew.get(s.id + 'old') ?? -1) !== s.lastActivityAt).length
  const plan = planPreviews(live, versionsNew, fetchedNew, now)
  for (const id of plan.fetch) {
    fetchedNew.set(id, now)
    versionsNew.set(id, live[0].lastActivityAt)
    after++
  }
}
if (process.env.MOBILE_BENCH) console.log(JSON.stringify({ streamPreviewRequests60s: { before, after } }))
assert.ok(after <= 13, '一分钟流式过程中预览请求不超过 13 次')
console.log('mobile-preview-plan: 预览请求节流通过')
