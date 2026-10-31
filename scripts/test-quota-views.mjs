import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

async function runQuotaForecastTests() {
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
      const weekly = win({ id: 'weekly', label: '本周', used: 50, durationMs: 7 * DAY, resetAt: now + 2 * DAY })
      const weeklySamples = series([[HOUR, 45], [30 * MIN, 47.5], [0, 50]])
      const short = win({ used: 50 })
      const limit = { window: short, samples: series([[HOUR, 0], [30 * MIN, 25], [0, 50]]) }
      const predict = (w = weekly, l = limit, samples = weeklySamples) => fc.forecastQuota(samples, w, now, l)
      eq(fc.forecastQuota(weeklySamples, weekly, now), { kind: 'sampling', needMs: 23 * HOUR }, '无短限额时按周窗口规则，历史不足一天先采样')
      eq(predict(), { kind: 'exhaust', exhaustAt: now + 23 * HOUR, limitedByFiveHour: true }, '周预测计入当前及后续五小时窗口耗尽后的等待')
      eq(predict({ ...weekly, resetAt: now + 12 * HOUR }), { kind: 'steady', atResetPct: 75, limitedByFiveHour: true }, '计入五小时暂停后，可能到周重置仍不会用完')
      eq(predict({ ...weekly, used: 99 }), { kind: 'exhaust', exhaustAt: now + 12 * MIN }, '周额度先用完时不额外加等待')
      eq(predict({ ...weekly, used: 55 }, limit, weeklySamples.map(sample => ({ ...sample, pct: sample.pct + 5 }))), { kind: 'exhaust', exhaustAt: now + 19 * HOUR, limitedByFiveHour: true }, '恰好用完一个未来窗口时不多等一轮')
      const slowLimit = { window: { ...short, used: 10 }, samples: series([[HOUR, 0], [30 * MIN, 5], [0, 10]]) }
      eq(predict(weekly, slowLimit), { kind: 'exhaust', exhaustAt: now + 10 * HOUR, limitedByFiveHour: false }, '短限额不约束当前速度时不拉长预测')
      const full = { window: { ...short, used: 100, exceeded: true }, samples: series([[HOUR, 50], [30 * MIN, 75], [0, 100]]) }
      eq(predict(weekly, full), { kind: 'exhaust', exhaustAt: now + 24 * HOUR, limitedByFiveHour: true }, '五小时已经用尽时，先等本次重置')
      const paused = { window: full.window, samples: series([[3 * HOUR, 0], [2 * HOUR, 50], [HOUR, 100], [0, 100]]) }
      eq(predict(weekly, paused, series([[3 * HOUR, 40], [2 * HOUR, 45], [HOUR, 50], [0, 50]])), { kind: 'exhaust', exhaustAt: now + 24 * HOUR, limitedByFiveHour: true }, '历史限流停顿不再重复扣算，只取同段实际消耗')
      eq(predict(weekly, { ...limit, samples: [] }), { kind: 'sampling', needMs: 15 * MIN }, '短限额缺采样时不沿用错误的单窗口预测')
      eq(predict(weekly, { ...limit, samples: series([[45 * MIN, 25], [0, 50]]) }), { kind: 'sampling', needMs: 15 * MIN }, '没有足够同时间采样时不混用不同观察区间')
      eq(predict(weekly, limit, series([[HOUR, 50], [30 * MIN, 50], [0, 50]])), { kind: 'steady', atResetPct: 50 }, '当前模型组合不消耗该周额度时不编造增长')
      eq(predict(weekly, { window: { ...short, used: 50 }, samples: series([[HOUR, 50], [30 * MIN, 50], [0, 50]]) }), { kind: 'sampling', needMs: 15 * MIN }, '短窗口没增长而周窗口增长时不据此捏造倍率')
      eq(predict(weekly, { ...limit, samples: series([[HOUR, 50], [30 * MIN, 25], [0, 50]]) }), { kind: 'sampling', needMs: 15 * MIN }, '异常下降的配对样本不跨重置周期算速率')
      for (const field of [{ allowsOverage: true }, { informational: true }]) {
        eq(predict(weekly, { ...limit, window: { ...short, ...field } }), { kind: 'sampling', needMs: 23 * HOUR }, '额外付费或参考窗口不强制暂停周消耗，按周窗口规则采样')
      }
      for (const resetAt of [undefined, now - MIN, Infinity]) {
        eq(predict(weekly, { ...limit, window: { ...short, resetAt } }), undefined, '五小时重置状态不可用时隐藏不可靠周预测')
      }
      check(fc.forecastQuota(weeklySamples, { ...weekly, resetAt: Infinity }, now) === undefined, '无穷重置时间不参与预测')
      check(fc.forecastQuota(weeklySamples, { ...weekly, durationMs: Infinity }, now) === undefined, '无穷窗口长度不参与预测')
    }

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
      const store = createQuotaSampleStore(join(temp, 'paired-samples.json'))
      const weekly = win({ id: 'secondary', label: '本周', durationMs: 7 * DAY, resetAt: now + 2 * DAY })
      let constrained
      let unconstrained
      for (const [ago, shortUsed, weeklyUsed] of [[HOUR, 0, 45], [30 * MIN, 25, 47.5], [0, 50, 50]]) {
        constrained = await store.withForecasts('account-a', [{ ...weekly, used: weeklyUsed }, win({ id: 'primary', used: shortUsed })], now - ago)
        unconstrained = await store.withForecasts('account-b', [win({ id: 'primary', used: shortUsed / 5 }), { ...weekly, used: weeklyUsed }], now - ago)
      }
      eq(constrained[0].forecast, { kind: 'exhaust', exhaustAt: now + 23 * HOUR, limitedByFiveHour: true }, '采样库先更新所有窗口，周窗口排在前面也能联动')
      eq(unconstrained[1].forecast, { kind: 'exhaust', exhaustAt: now + 10 * HOUR, limitedByFiveHour: false }, '不同账号的五小时采样不会串用')
      const paid = await store.withForecasts('account-a', [{ ...weekly, used: 50 }, win({ id: 'primary', used: 50, allowsOverage: true })], now)
      eq(paid[0].forecast, { kind: 'sampling', needMs: 23 * HOUR }, '额外付费账号不加硬暂停，按周窗口规则采样')
      const reset = await store.withForecasts('account-a', [{ ...weekly, used: 50 }, win({ id: 'primary', used: 1, resetAt: now + 7 * HOUR })], now + MIN)
      eq(reset[0].forecast, { kind: 'sampling', needMs: 15 * MIN }, '五小时重置后必须重新积累可配对采样')
      await store.flush()
    }

    {
      const good = { provider: 'openai-codex', supported: true, windows: [win()], checkedAt: now }
      const failed = { provider: 'openai-codex', supported: true, error: 'HTTP 500', checkedAt: now + 10 * MIN }
      eq(mergeLiveQuota(good, failed), { ...good, error: undefined, staleError: 'HTTP 500' }, '读取失败时保留上次成功的窗口并标记')
      eq(mergeLiveQuota(good, { ...failed, checkedAt: now + 25 * HOUR }), { ...failed, checkedAt: now + 25 * HOUR }, '超过 24 小时的旧数据不再沿用')
      eq(mergeLiveQuota(null, failed), failed, '没有旧数据时原样返回失败')
      const fresh = { ...good, checkedAt: now + MIN }
      eq(mergeLiveQuota(good, fresh), fresh, '成功读取直接替换')
      const unsupported = { provider: 'anthropic', supported: false, error: '该供应商没有可用的公开余额 API', checkedAt: now + MIN }
      eq(mergeLiveQuota({ ...good, provider: 'anthropic' }, unsupported), unsupported, '改用 API Key 后不再沿用旧订阅窗口')
    }

    console.log(`quota forecast: ${checks} checks passed`)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

async function runQuotaCardTests() {
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
        `export { quotaResetLine, quotaForecastLine } from ${JSON.stringify(posix(resolve(ROOT, 'src/renderer/src/patterns/QuotaWindowRow.tsx')))}\n` +
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
    const t = (key, vars) => `${key}:${JSON.stringify(vars ?? {})}`
    ok(mod.quotaResetLine(t, { id: 'five_hour', label: 'x', used: 0, total: 1 }, now).text === '', '没有重置时间不显示')
    ok(mod.quotaResetLine(t, { id: 'five_hour', label: 'x', used: 0, total: 1, resetAt: now - 1000 }, now).text.startsWith('quota.resetDue'), '已到点显示待刷新（不本地归零）')
    ok(mod.quotaResetLine(t, { id: 'monthly', label: 'x', used: 0, total: 1, resetAt: now + 5 * 86400_000 }, now).text.startsWith('quota.resetOn'), '月窗口显示日期')
    console.log(`\nv3-quota-card: ${checks} checks passed`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runQuotaForecastTests()
  await runQuotaCardTests()
}
