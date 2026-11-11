import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { deepseekPricePeriod } = await compile('src/shared/deepseek-pricing.ts')
  const cases = [
    ['2026-11-11T00:59:59.999Z', 'offPeak'],
    ['2026-11-11T01:00:00Z', 'peak'],
    ['2026-11-11T03:59:59.999Z', 'peak'],
    ['2026-11-11T04:00:00Z', 'offPeak'],
    ['2026-11-11T05:59:59.999Z', 'offPeak'],
    ['2026-11-11T06:00:00Z', 'peak'],
    ['2026-11-11T09:59:59.999Z', 'peak'],
    ['2026-11-11T10:00:00Z', 'offPeak'],
    ['2026-11-11T09:00:00+08:00', 'peak'],
    ['2026-11-11T12:00:00+08:00', 'offPeak'],
    ['2026-11-11T14:00:00+08:00', 'peak'],
    ['2026-11-11T18:00:00+08:00', 'offPeak'],
    ['2026-11-13T02:00:00Z', 'peak'],
    ['2026-11-14T02:00:00Z', 'offPeak'],
    ['2026-11-15T07:00:00Z', 'offPeak'],
    ['2026-11-16T02:00:00Z', 'peak'],
    ['2026-01-01T02:00:00Z', 'offPeak'],
    ['2026-01-02T07:00:00Z', 'offPeak'],
    ['2026-01-04T02:00:00Z', 'offPeak'],
    ['2026-02-14T07:00:00Z', 'offPeak'],
    ['2026-02-16T02:00:00Z', 'offPeak'],
    ['2026-02-23T07:00:00Z', 'offPeak'],
    ['2026-02-24T02:00:00Z', 'peak'],
    ['2026-02-28T07:00:00Z', 'offPeak'],
    ['2026-04-06T02:00:00Z', 'offPeak'],
    ['2026-05-01T07:00:00Z', 'offPeak'],
    ['2026-05-05T02:00:00Z', 'offPeak'],
    ['2026-05-06T02:00:00Z', 'peak'],
    ['2026-05-09T02:00:00Z', 'offPeak'],
    ['2026-06-19T02:00:00Z', 'offPeak'],
    ['2026-09-25T07:00:00Z', 'offPeak'],
    ['2026-10-01T02:00:00Z', 'offPeak'],
    ['2026-10-07T07:00:00Z', 'offPeak'],
    ['2026-10-08T02:00:00Z', 'peak'],
    ['2026-10-10T02:00:00Z', 'offPeak'],
    ['2027-01-01T02:00:00Z', 'offPeak'],
    ['2027-02-05T02:00:00Z', 'offPeak'],
    ['2027-02-12T07:00:00Z', 'offPeak'],
    ['2027-02-15T02:00:00Z', 'peak'],
    ['2027-04-05T02:00:00Z', 'offPeak'],
    ['2027-05-05T07:00:00Z', 'offPeak'],
    ['2027-06-09T07:00:00Z', 'offPeak'],
    ['2027-09-15T02:00:00Z', 'offPeak'],
    ['2027-10-07T07:00:00Z', 'offPeak'],
    ['2028-01-03T02:00:00Z', 'unknown'],
    ['2028-01-03T12:00:00Z', 'offPeak'],
    ['2028-01-02T02:00:00Z', 'offPeak']
  ]
  for (const [time, expected] of cases) {
    const actual = deepseekPricePeriod(Date.parse(time))
    ok(actual === expected, `${time} → ${expected}`, actual)
  }
  ok(deepseekPricePeriod(NaN) === 'unknown', '无效时间不编造峰谷状态')
  const prior = process.env.TZ
  try {
    for (const zone of ['America/Los_Angeles', 'Asia/Shanghai', 'Europe/London']) {
      process.env.TZ = zone
      ok(deepseekPricePeriod(Date.parse('2026-11-11T01:00:00Z')) === 'peak', `${zone} 本地时区不影响 UTC 峰价`)
      ok(deepseekPricePeriod(Date.parse('2026-02-23T07:00:00Z')) === 'offPeak', `${zone} 本地时区不影响中国节假日`)
    }
  } finally {
    if (prior === undefined) delete process.env.TZ
    else process.env.TZ = prior
  }
})
