#!/usr/bin/env node
import './lib/test-isolate.mjs'
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
  assert.equal(sundayOptions.find((o) => o.id === 'next-monday'), undefined)
  assert.equal(
    sundayOptions.find((o) => o.id === 'tomorrow-morning').until,
    local(2026, 3, 9, 9),
    '周日看到的明早就是下周一'
  )
  assert.equal(snooze.resolveSnoozeOptions(monday).find((o) => o.id === 'next-monday').until, local(2026, 3, 16, 9), '周一当天不指向当天')
})

check('预设：1 小时后严格晚于当前时间，未知 id 返回 undefined', () => {
  const now = local(2026, 3, 5, 23, 30)
  const option = snooze.resolveSnoozeOptions(now).find((o) => o.id === 'in-1h')
  assert.ok(option.until > now)
  assert.equal(snooze.resolveSnoozeOptions(now).find((o) => o.id === 'nope'), undefined)
})

check('格式化器：按 locale 与同日/跨日选项复用，不跨选项串用', () => {
  const Original = Intl.DateTimeFormat
  let count = 0
  Intl.DateTimeFormat = function (...args) {
    count++
    return new Original(...args)
  }
  try {
    const now = local(2026, 3, 5, 12)
    for (const lang of ['zh-CN', 'en-US']) {
      for (const until of [local(2026, 3, 5, 18), local(2026, 3, 9, 9)]) {
        const expected = new Original(lang, { hour: '2-digit', minute: '2-digit', hour12: false, ...(until > local(2026, 3, 6, 0) ? { weekday: 'short' } : {}) }).format(until)
        for (let n = 0; n < 100; n++) assert.equal(snooze.formatSnoozeWake(until, now, lang), expected)
      }
    }
    assert.equal(count, 4, '400 次调用只建立 4 个格式化器')
    assert.notEqual(snooze.formatSnoozeWake(local(2026, 3, 9, 9), now, 'en-US'), snooze.formatSnoozeWake(local(2026, 3, 9, 9), local(2026, 3, 9, 0), 'en-US'), '过午夜应切回只显示时间')
    assert.equal(count, 4)
  } finally {
    Intl.DateTimeFormat = Original
  }
})

check('唤醒时间文案：当天只给时间，跨天带上星期', () => {
  const now = local(2026, 3, 5, 12)
  const today = snooze.formatSnoozeWake(local(2026, 3, 5, 18), now, 'zh-CN')
  const later = snooze.formatSnoozeWake(local(2026, 3, 9, 9), now, 'zh-CN')
  assert.equal(today, '18:00')
  assert.match(later, /^周一\s?09:00$/, '下周一显示星期加时间')
  assert.match(snooze.formatSnoozeWake(local(2026, 3, 9, 9), now, 'en-US'), /\d{2}:\d{2}/)
})

process.stdout.write(`\nsession-snooze: ${pass} 组检查通过\n`)
