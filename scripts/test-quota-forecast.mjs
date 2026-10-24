import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const temp = await mkdtemp(join(tmpdir(), 'inkstone-quota-forecast-'))
try {
  const bundle = async (entry, name, platform) => {
    await build({ entryPoints: [entry], bundle: true, platform, format: 'esm', outfile: join(temp, name), logLevel: 'silent' })
    return import(pathToFileURL(resolve(temp, name)).href)
  }
  const fc = await bundle('src/shared/quota-forecast.ts', 'quota-forecast.mjs', 'neutral')
  const { createQuotaSampleStore } = await bundle('src/main/quota-samples.ts', 'quota-samples.mjs', 'node')
  const { mergeLiveQuota } = await bundle('src/renderer/src/state/live-quota.ts', 'live-quota.mjs', 'node')

  let checks = 0
  const check = (condition, message) => {
    assert.ok(condition, message)
    checks += 1
  }
  const eq = (actual, expected, message) => {
    assert.deepEqual(actual, expected, message)
    checks += 1
  }

  const now = Date.UTC(2026, 9, 17, 12)
  const win = (o) => ({ id: 'fiveHour', label: '5 小时', used: 40, total: 100, durationMs: 5 * HOUR, resetAt: now + 2 * HOUR, ...o })
  const series = (points) => points.map(([ago, pct]) => ({ at: now - ago, pct }))

  eq(fc.forecastSpan(5 * HOUR), { lookbackMs: HOUR, minSpanMs: 15 * MIN }, '5h 窗口回看 1 小时、至少 15 分钟')
  eq(fc.forecastSpan(DAY), { lookbackMs: 6 * HOUR, minSpanMs: HOUR }, '日窗口回看 6 小时')
  eq(fc.forecastSpan(7 * DAY), { lookbackMs: 3 * DAY, minSpanMs: DAY }, '周窗口至少观察一天，不用短时消耗外推整周')
  eq(fc.forecastSpan(30 * DAY), { lookbackMs: 7 * DAY, minSpanMs: 2 * DAY }, '月窗口至少观察两天')

  {
    const f = fc.forecastQuota(series([[5 * MIN, 38], [0, 40]]), win(), now)
    eq(f, { kind: 'sampling', needMs: 10 * MIN }, '样本跨度不足：采样中并给出还需时长')
    eq(fc.forecastQuota([], win(), now), { kind: 'sampling', needMs: 15 * MIN }, '没有样本也是采样中')
  }

  {
    const f = fc.forecastQuota(series([[30 * MIN, 35], [0, 40]]), win(), now)
    eq(f, { kind: 'steady', atResetPct: 60 }, '每 30 分钟 5 点、还剩 2 小时：重置时约 60%')
    eq(fc.forecastProjectionPct(f), 60, '投影终点取重置时百分比')
  }

  {
    const f = fc.forecastQuota(series([[30 * MIN, 20], [0, 40]]), win(), now)
    eq(f, { kind: 'exhaust', exhaustAt: now + 90 * MIN }, '每 30 分钟 20 点：90 分钟后用完')
    eq(fc.forecastProjectionPct(f), 100, '会用完时投影画满')
  }

  {
    const f = fc.forecastQuota(series([[30 * MIN, 40], [0, 40]]), win(), now)
    eq(f, { kind: 'steady', atResetPct: 40 }, '没有增长：重置时保持当前')
    eq(fc.forecastProjectionPct(f), 40, '投影不超过当前时 Meter 不画延伸')
  }

  {
    const old = series([[3 * HOUR, 0], [2 * HOUR, 30], [30 * MIN, 38], [0, 40]])
    eq(fc.forecastQuota(old, win(), now), { kind: 'steady', atResetPct: 48 }, '只用回看窗口内的样本算速度')
  }

  check(fc.forecastQuota(series([[HOUR, 1], [0, 40]]), win({ informational: true }), now) === undefined, '仅供参考的窗口不预测')
  check(fc.forecastQuota(series([[HOUR, 1], [0, 40]]), win({ exceeded: true }), now) === undefined, '已超限的窗口不预测')
  check(fc.forecastQuota(series([[HOUR, 1], [0, 40]]), win({ resetAt: now - MIN }), now) === undefined, '重置时间已过不预测')
  check(fc.forecastQuota(series([[HOUR, 1], [0, 40]]), win({ durationMs: undefined }), now) === undefined, '不知道窗口长度不预测')
  check(fc.forecastQuota(series([[HOUR, 1], [0, 99.8]]), win({ used: 99.8 }), now) === undefined, '剩余不足 0.5 点不再预测')

  {
    let samples = []
    samples = fc.appendQuotaSample(samples, { at: now, pct: 10 })
    samples = fc.appendQuotaSample(samples, { at: now + MIN, pct: 11 })
    samples = fc.appendQuotaSample(samples, { at: now + 2 * MIN, pct: 12 })
    eq(samples.map((s) => s.pct), [10, 12], '4 分钟内连续读取只替换末尾，不堆积')
    samples = fc.appendQuotaSample(samples, { at: now + 10 * MIN, pct: 15 })
    eq(samples.map((s) => s.pct), [10, 12, 15], '间隔够了正常追加')
    samples = fc.appendQuotaSample(samples, { at: now + 20 * MIN, pct: 2 })
    eq(samples, [{ at: now + 20 * MIN, pct: 2 }], '下降超过 5 点视为重置，清空旧样本')
    const aged = fc.appendQuotaSample([{ at: now - 9 * DAY, pct: 1 }, { at: now - DAY, pct: 2 }], { at: now, pct: 3 })
    eq(aged.map((s) => s.pct), [2, 3], '超过 8 天的样本丢弃')
  }

  check(fc.quotaReadingStale(now - 31 * MIN, now, false), '超过 30 分钟算过期')
  check(!fc.quotaReadingStale(now - 29 * MIN, now, false), '30 分钟内算新鲜')
  check(fc.quotaReadingStale(now, now, true), '读取失败一律算过期')
  check(fc.windowAwaitingReset(win({ resetAt: now - 1 }), now), '重置时间已过：待更新')
  {
    const week = win({ id: 'weekly', used: 2, durationMs: 7 * DAY, resetAt: now + 6 * DAY + 21 * HOUR })
    eq(fc.forecastQuota(series([[HOUR, 0], [0, 2]]), week, now), { kind: 'sampling', needMs: 23 * HOUR }, '截图中的周用量2%配短历史，不显示耗尽倒计时')
    const longWeek = { ...week, resetAt: now + 5 * DAY }
    const flat = Array.from({ length: 7 }, (_, i) => ({ at: now - DAY + i * 4 * HOUR, pct: 2 * i / 6 }))
    eq(fc.forecastQuota(flat, longWeek, now), { kind: 'uncertain' }, '一天内只变化2个百分点，精度不足以预测')
    eq(fc.forecastProjectionPct({ kind: 'uncertain' }), null, '不可靠预测不把用量条填满')
    const stable = Array.from({ length: 7 }, (_, i) => ({ at: now - DAY + i * 4 * HOUR, pct: 20 + 5 * i }))
    const forecast = fc.forecastQuota(stable, { ...longWeek, used: 50 }, now)
    check(forecast?.kind === 'exhaust' && forecast.earliestAt < forecast.exhaustAt && forecast.latestAt > forecast.exhaustAt && forecast.basedOnMs === DAY, '足够稳定的长历史给范围，不伪装精确时刻')
    const burst = stable.map((point, i) => ({ ...point, pct: i < 4 ? 20 : 20 + 15 * (i - 3) }))
    eq(fc.forecastQuota(burst, { ...longWeek, used: 65 }, now), { kind: 'uncertain' }, '闲置后突增的短时爆发不当作未来常速')
    check(fc.forecastQuota(stable.map((point) => ({ ...point, at: point.at - HOUR })), { ...longWeek, used: 50 }, now) === undefined, '过期样本不预测')
    const previous = [{ at: now, pct: 3 }]
    eq(fc.appendQuotaSample(previous, { at: now - MIN, pct: 2 }), previous, '乱序返回不截掉较新的样本')
    eq(fc.appendQuotaSample(previous, { at: now, pct: 3 }), previous, '相同时间缓存读数不堆成更多样本')
  }
  check(!fc.windowAwaitingReset(win({ resetAt: undefined }), now), '没有重置时间不算待更新')

  {
    const a = win({ id: 'fiveHour', used: 30 })
    const b = win({ id: 'weekly', used: 70, durationMs: 7 * DAY })
    const info = win({ id: 'extra', used: 99, informational: true })
    eq(fc.bindingQuotaWindow([a, b, info])?.id, 'weekly', '圆环取用量最高的非参考窗口')
    check(fc.bindingQuotaWindow([info]) === null, '只有参考窗口时不显示圆环')
  }

  eq(fc.windowSpan({ id: 'x', label: '', durationMs: 5 * HOUR }).span, 'fiveHour', '按时长识别 5 小时窗口')
  eq(fc.windowSpan({ id: 'x', label: '', durationMs: 7 * DAY }).span, 'week', '按时长识别周窗口')
  eq(fc.windowSpan({ id: 'x', label: '', durationMs: 30 * DAY }).span, 'month', '按时长识别月窗口')
  eq(fc.windowSpan({ id: 'x', label: '', durationMs: 3 * HOUR }), { span: 'hours', hours: 3 }, '其他小时窗口给出小时数')
  eq(fc.windowSpan({ id: 'weekly', label: '每周' }).span, 'week', '没有时长时按 id 识别')

  {
    const file = join(temp, 'samples', 'quota-samples.json')
    const store = createQuotaSampleStore(file)
    const reads = [[40 * MIN, 30], [20 * MIN, 35], [0, 40]]
    let out = []
    for (const [ago, used] of reads) out = await store.withForecasts('provider|t', [win({ used })], now - ago)
    eq(out[0].forecast, { kind: 'steady', atResetPct: 70 }, '采样库按读取累积并给出预测')
    await store.flush()
    const saved = JSON.parse(await readFile(file, 'utf8'))
    eq(saved.series['provider|t|fiveHour'].samples.length, 3, '样本写盘')
    const reopened = createQuotaSampleStore(file)
    const again = await reopened.withForecasts('provider|t', [win({ used: 41 })], now + 5 * MIN)
    check(again[0].forecast?.kind === 'steady', '重开后沿用磁盘上的样本')
    const shifted = await reopened.withForecasts('provider|t', [win({ used: 1, resetAt: now + 7 * HOUR })], now + 6 * MIN)
    eq(shifted[0].forecast, { kind: 'sampling', needMs: 15 * MIN }, '重置时间前移超过 10 分钟视为新周期')
    const info = await reopened.withForecasts('provider|t', [win({ id: 'credits', informational: true, forecast: { kind: 'steady', atResetPct: 1 } })], now)
    eq(info[0].forecast, { kind: 'steady', atResetPct: 1 }, '参考窗口原样返回')
    await reopened.flush()
  }

  {
    const good = { provider: 'openai-codex', supported: true, windows: [win()], checkedAt: now }
    const failed = { provider: 'openai-codex', supported: true, error: 'HTTP 500', checkedAt: now + 10 * MIN }
    eq(mergeLiveQuota(good, failed), { ...good, error: undefined, staleError: 'HTTP 500' }, '读取失败时保留上次成功的窗口并标记')
    eq(mergeLiveQuota(good, { ...failed, checkedAt: now + 25 * HOUR }), { ...failed, checkedAt: now + 25 * HOUR }, '超过 24 小时的旧数据不再沿用')
    eq(mergeLiveQuota(null, failed), failed, '没有旧数据时原样返回失败')
    const fresh = { ...good, checkedAt: now + MIN }
    eq(mergeLiveQuota(good, fresh), fresh, '成功读取直接替换')
  }

  console.log(`quota forecast: ${checks} checks passed`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
