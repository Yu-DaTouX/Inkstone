import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { moonPhase, landscapeSky, traceMoon } = await compile('src/renderer/src/features/ambient/landscape-sky.ts')
  const local = (hour, minute = 0, second = 0) => new Date(2026, 10, 11, hour, minute, second).getTime()
  for (const [hour, minute, second, kind] of [
    [0, 0, 0, 'moon'], [5, 59, 59, 'moon'], [6, 0, 0, 'sun'],
    [12, 0, 0, 'sun'], [17, 59, 59, 'sun'], [18, 0, 0, 'moon'], [23, 59, 59, 'moon']
  ]) {
    const sky = landscapeSky(local(hour, minute, second))
    ok(sky.kind === kind, `本地 ${hour}:${minute}:${second} 显示${kind === 'sun' ? '太阳' : '月亮'}`)
    ok(sky.progress >= 0 && sky.progress < 1 && (kind === 'moon' ? sky.moon !== null : sky.moon === null), '轨迹有界，只有夜晚计算月相')
  }
  ok(landscapeSky(local(6)).progress === 0 && landscapeSky(local(18)).progress === 0, '日出和入夜各从轨迹起点开始')
  ok(landscapeSky(local(12)).progress === 0.5 && landscapeSky(local(0)).progress === 0.5, '正午与午夜到达各自轨迹中央')
  ok(landscapeSky(local(9)).progress < landscapeSky(local(12)).progress && landscapeSky(local(12)).progress < landscapeSky(local(15)).progress, '太阳从早到晚向前移动')
  ok(landscapeSky(local(21)).progress < landscapeSky(local(0)).progress && landscapeSky(local(0)).progress < landscapeSky(local(3)).progress, '月亮跨午夜继续向前移动')
  ok(Math.abs(landscapeSky(local(0)).progress - landscapeSky(local(23, 59, 59)).progress) < 0.00003, '午夜不重置月亮轨迹')
  ok(landscapeSky(local(9, 30, 30)).progress > landscapeSky(local(9, 30)).progress, '轨迹包含分钟和秒，不只按整点跳动')
  for (const at of [NaN, Infinity, -Infinity, 8.65e15]) {
    ok(moonPhase(at) === null && landscapeSky(at) === null, '非法时间不生成 NaN 月相或轨迹')
  }

  const phases = [
    ['2026-01-03T10:03:00Z', 0.5], ['2026-01-10T15:48:00Z', 0.75],
    ['2026-01-18T19:52:00Z', 0], ['2026-01-26T04:47:00Z', 0.25],
    ['2026-04-02T02:12:00Z', 0.5], ['2026-04-10T04:51:00Z', 0.75],
    ['2026-04-17T11:52:00Z', 0], ['2026-04-24T02:32:00Z', 0.25],
    ['2026-07-14T09:43:00Z', 0], ['2026-07-21T11:05:00Z', 0.25],
    ['2026-07-29T14:36:00Z', 0.5], ['2026-08-06T02:21:00Z', 0.75],
    ['2026-11-09T07:02:00Z', 0], ['2026-11-17T11:48:00Z', 0.25],
    ['2026-11-24T14:53:00Z', 0.5], ['2026-12-01T06:08:00Z', 0.75]
  ]
  for (const [time, expected] of phases) {
    const moon = moonPhase(Date.parse(time))
    const distance = Math.abs(moon.phase - expected)
    ok(Math.min(distance, 1 - distance) < 0.01, `${time} 对照 USNO 四季朔望弦，角相位误差小于 0.01 周`, moon.phase)
    const lit = (1 - Math.cos(expected * 2 * Math.PI)) / 2
    ok(Math.abs(moon.illumination - lit) < 0.025, '朔望弦亮面比例符合近似显示范围', moon.illumination)
  }
  ok(moonPhase(Date.parse('2026-11-13T12:00:00Z')).waxing, '朔后为盈月，亮面在右')
  ok(!moonPhase(Date.parse('2026-12-05T12:00:00Z')).waxing, '望后为亏月，亮面在左')
  for (const year of [1900, 1970, 1999, 2000, 2026, 2027, 2050, 2100]) {
    const moon = moonPhase(Date.UTC(year, 0, 1))
    ok(moon.phase >= 0 && moon.phase < 1 && moon.illumination >= 0 && moon.illumination <= 1, `${year} 年月相归一化，无未来年份表限制`)
  }
  const midnight = Date.parse('2026-12-31T23:59:30Z')
  ok(Math.abs(moonPhase(midnight).illumination - moonPhase(midnight + 60_000).illumination) < 0.001, '月相跨年连续，不在零点跳变')

  const timezone = process.env.TZ
  const at = Date.parse('2026-11-11T02:00:00Z')
  const moon = JSON.stringify(moonPhase(at))
  try {
    for (const [zone, kind, progress] of [
      ['UTC', 'moon', 8 / 12], ['Asia/Shanghai', 'sun', 4 / 12],
      ['America/New_York', 'moon', 3 / 12], ['Australia/Sydney', 'sun', 7 / 12]
    ]) {
      process.env.TZ = zone
      const sky = landscapeSky(at)
      ok(sky.kind === kind && Math.abs(sky.progress - progress) < 1e-9, `${zone} 昼夜与轨迹使用电脑当地时间`, sky)
      ok(JSON.stringify(moonPhase(at)) === moon, '同一时刻的月相不因时区变化而改变')
    }
  } finally {
    if (timezone === undefined) delete process.env.TZ
    else process.env.TZ = timezone
  }

  for (const waxing of [true, false]) {
    for (const illumination of [0, 0.05, 0.25, 0.5, 0.75, 0.95, 1]) {
      const calls = []
      const ctx = Object.fromEntries(['beginPath', 'moveTo', 'arc', 'ellipse', 'lineTo', 'closePath'].map((name) => [name, (...args) => calls.push({ name, args })]))
      traceMoon(ctx, 100, 200, 40, { phase: 0, illumination, waxing })
      const limb = calls.find(({ name }) => name === 'arc')
      const terminator = calls.find(({ name }) => name === 'ellipse')
      ok(limb.args.at(-1) === !waxing, `${waxing ? '盈' : '亏'}月 ${illumination} 外缘位于正确侧`)
      if (illumination === 0.5) ok(!terminator && calls.some(({ name }) => name === 'lineTo'), '上下弦使用直线终止界，不传退化椭圆')
      else ok(terminator.args[2] >= 0 && terminator.args[2] <= 40 && terminator.args.at(-1) === (waxing === (illumination < 0.5)), '新月、蛾眉、凸月、满月终止界方向正确')
      ok(calls[0].name === 'beginPath' && calls.at(-1).name === 'closePath', '月相路径独立闭合，不擦除山水或绘制不透明遮罩')
    }
  }
})
