#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = await mkdtemp(join(tmpdir(), 'yan-session-snooze-'))

async function load(name, entry) {
  const outfile = join(dir, `${name}.mjs`)
  await build({ entryPoints: [join(ROOT, entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' })
  return import(pathToFileURL(outfile).href)
}

const snooze = await load('session-snooze', 'src/renderer/src/features/sidebar/session-snooze.ts')
const status = await load('session-status', 'src/renderer/src/features/sidebar/session-status.ts')
await rm(dir, { recursive: true, force: true })

let pass = 0
function check(label, fn) {
  fn()
  pass += 1
  process.stdout.write(`  ✓ ${label}\n`)
}

const HOUR = 3_600_000
const local = (year, month, day, hour, minute = 0) => new Date(year, month - 1, day, hour, minute, 0, 0).getTime()

check('预设：工作日白天给出四个选项，按唤醒时间排序', () => {
  const now = local(2026, 3, 5, 10)
  const options = snooze.resolveSnoozeOptions(now)
  assert.deepEqual(options.map((o) => o.id), ['in-1h', 'tonight', 'tomorrow-morning', 'next-monday'])
  assert.deepEqual(options.map((o) => o.until), [
    now + HOUR,
    local(2026, 3, 5, 18),
    local(2026, 3, 6, 9),
    local(2026, 3, 9, 9)
  ])
  assert.deepEqual(options.map((o) => o.labelKey), [
    'rail.snoozeInHour',
    'rail.snoozeTonight',
    'rail.snoozeTomorrow',
    'rail.snoozeNextMonday'
  ])
})

check('预设：今晚已过就落到明早，与明早选项合并成一条', () => {
  const now = local(2026, 3, 5, 20)
  const options = snooze.resolveSnoozeOptions(now)
  assert.deepEqual(options.map((o) => o.id), ['in-1h', 'tonight', 'next-monday'])
  assert.equal(options[1].until, local(2026, 3, 6, 9), '今晚已过，唤醒时间改到明早 9 点')
  assert.equal(options[1].labelKey, 'rail.snoozeTomorrow', '标签跟着实际时间叫明早')
  assert.equal(options.filter((o) => o.until === local(2026, 3, 6, 9)).length, 1, '同一唤醒时间只留一条')
})

check('预设：周日时下周一就是明早，两者合并；周一当天下周一在一周后', () => {
  const sunday = local(2026, 3, 8, 10)
  const monday = local(2026, 3, 9, 10)
  const sundayOptions = snooze.resolveSnoozeOptions(sunday)
  assert.equal(snooze.pickSnoozeOption('next-monday', sunday), undefined)
  assert.equal(
    sundayOptions.find((o) => o.id === 'tomorrow-morning').until,
    local(2026, 3, 9, 9),
    '周日看到的明早就是下周一'
  )
  assert.equal(snooze.pickSnoozeOption('next-monday', monday).until, local(2026, 3, 16, 9), '周一当天不指向当天')
})

check('预设：1 小时后严格晚于当前时间，未知 id 返回 undefined', () => {
  const now = local(2026, 3, 5, 23, 30)
  const option = snooze.pickSnoozeOption('in-1h', now)
  assert.ok(option.until > now)
  assert.equal(snooze.pickSnoozeOption('nope', now), undefined)
})

check('分组：snooze 中的会话不在正常列表，到点的会话算醒来', () => {
  const now = local(2026, 3, 5, 12)
  const sessions = [
    { id: 'a' },
    { id: 'b', snoozedUntil: now + HOUR },
    { id: 'c', snoozedUntil: now - 1 },
    { id: 'd', snoozedUntil: now }
  ]
  assert.deepEqual(snooze.activeSessions(sessions, now).map((s) => s.id), ['a', 'c', 'd'])
  assert.deepEqual(snooze.snoozedSessions(sessions, now).map((s) => s.id), ['b'])
  assert.deepEqual(snooze.wakingSessions(sessions, now).map((s) => s.id), ['c', 'd'], '到点（含正好到点）的会话醒来')
  assert.equal(snooze.isSnoozed(sessions[3], now), false, '只看未来，到点就不再算 snooze')
})

check('分组：稍后列表按唤醒时间由近到远', () => {
  const now = local(2026, 3, 5, 12)
  const sessions = [
    { id: 'late', snoozedUntil: now + 5 * HOUR },
    { id: 'soon', snoozedUntil: now + HOUR },
    { id: 'mid', snoozedUntil: now + 2 * HOUR }
  ]
  assert.deepEqual(snooze.snoozedSessions(sessions, now).map((s) => s.id), ['soon', 'mid', 'late'])
})

check('定时器：只在最近的唤醒时间排一次，没有 snooze 就不排', () => {
  const now = local(2026, 3, 5, 12)
  const sessions = [
    { id: 'late', snoozedUntil: now + 5 * HOUR },
    { id: 'soon', snoozedUntil: now + HOUR }
  ]
  assert.equal(snooze.nextSnoozeWake(sessions, now), now + HOUR)
  assert.equal(snooze.nextSnoozeWake([{ id: 'plain' }], now), null)
  assert.equal(snooze.nextSnoozeWake([{ id: 'past', snoozedUntil: now - 1 }], now), null)
  assert.equal(snooze.snoozeTimerDelay(null, now), null)
  const delay = snooze.snoozeTimerDelay(now + HOUR, now)
  assert.ok(delay > HOUR - 2000 && delay < HOUR + 2000, '在唤醒时间附近触发，不是每秒轮询')
  assert.equal(snooze.snoozeTimerDelay(now + 999 * 24 * HOUR, now), snooze.MAX_SNOOZE_TIMER_MS, '超长延迟夹到定时器上限')
})

check('自定义：解析本地日期时间，过去的与格式不对的都不接受', () => {
  const now = local(2026, 3, 5, 12)
  assert.equal(snooze.customSnoozeUntil('2026-03-05', '13:00', now), local(2026, 3, 5, 13))
  assert.equal(snooze.customSnoozeUntil('2026-03-05', '11:00', now), null, '过去的时间不接受')
  assert.equal(snooze.customSnoozeUntil('2026-03-05', '12:00', now), null, '同一分钟不接受')
  assert.equal(snooze.customSnoozeUntil('2026/03/05', '13:00', now), null)
  assert.equal(snooze.customSnoozeUntil('2026-03-05', '25:00', now), null)
  assert.equal(snooze.customSnoozeUntil('2026-02-30', '09:00', now), null, '不存在的日期不静默进位')
})

check('自定义：日期与时间输入框回填本地值', () => {
  const at = local(2026, 3, 5, 9, 5)
  assert.equal(snooze.localDateValue(at), '2026-03-05')
  assert.equal(snooze.localTimeValue(at), '09:05')
})

check('唤醒时间文案：当天只给时间，跨天带上星期', () => {
  const now = local(2026, 3, 5, 12)
  const today = snooze.formatSnoozeWake(local(2026, 3, 5, 18), now, 'zh-CN')
  const later = snooze.formatSnoozeWake(local(2026, 3, 9, 9), now, 'zh-CN')
  assert.equal(today, '18:00')
  assert.match(later, /^周一\s?09:00$/, '下周一显示星期加时间')
  assert.match(snooze.formatSnoozeWake(local(2026, 3, 9, 9), now, 'en-US'), /\d{2}:\d{2}/)
})

check('未读标记：没跑过时 markedUnread 就是未读，正在跑或已归档不被覆盖', () => {
  assert.equal(status.sessionStatusKind({ phase: null, unread: false, archived: false, markedUnread: true }), 'unread')
  assert.equal(status.sessionStatusKind({ phase: null, unread: false, archived: false }), 'idle')
  assert.equal(status.sessionStatusKind({ phase: { kind: 'running', since: 1 }, unread: false, archived: false, markedUnread: true }), 'running')
  assert.equal(status.sessionStatusKind({ phase: null, unread: false, archived: true, markedUnread: true }), 'archived')
  assert.equal(status.sessionStatusKind({ phase: { kind: 'done', at: 2, seen: true }, unread: false, archived: false, markedUnread: true }), 'unread')
})

process.stdout.write(`\nsession-snooze: ${pass} 组检查通过\n`)
