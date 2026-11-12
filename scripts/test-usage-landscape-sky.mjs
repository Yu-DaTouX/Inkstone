import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { moonPhase, landscapeSky, traceMoon, sunPosition, moonPosition, observerFor } = await compile('src/renderer/src/features/ambient/landscape-sky.ts')
  const sydney = observerFor('Australia/Sydney', 0)
  const shanghai = observerFor('Asia/Shanghai', 0)
  const at = (local, offset) => Date.parse(`${local}:00${offset}`)
  const syd = (local) => at(local, '+11:00')
  const sha = (local) => at(local, '+08:00')
  const crossing = (fn, observer, from, horizon, kind) => {
    let prev = fn(from, observer).altitude - horizon
    for (let minute = 1; minute <= 1440; minute += 1) {
      const time = from + minute * 60_000
      const now = fn(time, observer).altitude - horizon
      if (kind === 'rise' ? prev <= 0 && now > 0 : prev > 0 && now <= 0) return time
      prev = now
    }
    return NaN
  }
  const near = (time, expected, minutes) => Math.abs(time - expected) <= minutes * 60_000

  ok(sydney.latitude < -33 && sydney.longitude > 151 && shanghai.latitude > 31, '常用时区带城市坐标')
  ok(observerFor('Etc/Unknown', Date.UTC(2026, 0, 1)).latitude === 35 && observerFor('America/Argentina/Buenos_Aires', 0).latitude < 0, '未知时区按时区偏移估经度，南半球时区取南纬')

  const day = syd('2026-11-12T00:00')
  ok(near(crossing(sunPosition, sydney, day, -0.833, 'rise'), syd('2026-11-12T05:45'), 3), '悉尼 11/12 日出与 timeanddate 5:45 相差 3 分钟内')
  ok(near(crossing(sunPosition, sydney, day, -0.833, 'set'), syd('2026-11-12T19:33'), 3), '悉尼 11/12 日落与 timeanddate 19:33 相差 3 分钟内')
  const evening = sunPosition(syd('2026-11-12T19:05'), sydney)
  ok(Math.abs(evening.azimuth - 251.7) < 0.5 && Math.abs(evening.altitude - 4.75) < 0.5, '悉尼 19:05 太阳方位与高度对照 timeanddate', evening)
  const shaDay = sha('2026-11-12T00:00')
  ok(near(crossing(sunPosition, shanghai, shaDay, -0.833, 'rise'), sha('2026-11-12T06:20'), 10) && near(crossing(sunPosition, shanghai, shaDay, -0.833, 'set'), sha('2026-11-12T17:00'), 10), '上海冬季约 6:20 日出、17:00 日落')
  const summer = sha('2026-06-21T00:00')
  ok(near(crossing(sunPosition, shanghai, summer, -0.833, 'rise'), sha('2026-06-21T04:51'), 10) && near(crossing(sunPosition, shanghai, summer, -0.833, 'set'), sha('2026-06-21T19:01'), 10), '上海夏至约 4:51 日出、19:01 日落，昼长随季节变化')
  const fullRise = crossing(moonPosition, shanghai, sha('2026-11-24T12:00'), -0.3, 'rise')
  ok(near(fullRise, sha('2026-11-24T16:40'), 45), '满月前后黄昏月出', new Date(fullRise).toISOString())

  const dusk = landscapeSky(syd('2026-11-12T19:05'), sydney)
  ok(dusk.sun && dusk.sun.x > 0.9 && dusk.sun.altitude < 6, '用户截图时刻：悉尼 19:05 太阳仍在、低悬画面右侧', dusk.sun)
  ok(dusk.moon && dusk.moon.waxing && dusk.moon.illumination < 0.15 && dusk.moon.fade < 0.6, '同一时刻娥眉月已升起，日间显示为淡月', dusk.moon)
  ok(Math.cos(dusk.moon.tilt) > 0 && Math.sin(dusk.moon.tilt) > 0.5, '傍晚娥眉月亮面朝向右下方太阳，南半球呈仰月', dusk.moon.tilt)
  const night = landscapeSky(syd('2026-11-12T21:00'), sydney)
  ok(!night.sun && night.moon && night.moon.fade === 1 && night.moon.x > dusk.moon.x, '日落后只剩月亮，月亮继续向右移动')
  ok(!landscapeSky(syd('2026-11-12T23:30'), sydney).moon && !landscapeSky(syd('2026-11-12T23:30'), sydney).sun, '月落后夜空没有日月')
  const morning = landscapeSky(syd('2026-11-12T07:00'), sydney)
  const noon = landscapeSky(syd('2026-11-12T13:00'), sydney)
  ok(morning.sun.x < noon.sun.x && noon.sun.x < dusk.sun.x && noon.sun.height > morning.sun.height && noon.sun.height > dusk.sun.height, '太阳从左升起、正午最高、向右落下（南半球同样左升右落）')
  ok(Math.abs(landscapeSky(sha('2026-11-12T11:38'), shanghai).sun.x - 0.5) < 0.03, '当地太阳正午位于画面中央')
  ok(!landscapeSky(sha('2026-11-12T05:30'), shanghai).sun && landscapeSky(sha('2026-11-12T06:40'), shanghai).sun, '上海冬季 5:30 还没日出，6:40 已出太阳')
  const winter = landscapeSky(sha('2026-12-21T11:50'), shanghai).sun
  const june = landscapeSky(sha('2026-06-21T11:50'), shanghai).sun
  ok(winter.height < june.height, '冬季正午太阳比夏季低')
  const full = landscapeSky(sha('2026-11-24T00:00'), shanghai).moon
  ok(full && full.illumination > 0.95 && Math.abs(full.x - 0.5) < 0.15 && full.height > 0.9, '满月午夜高悬中天附近', full)
  const lastQuarter = landscapeSky(sha('2026-12-01T06:00'), shanghai).moon
  ok(lastQuarter && !lastQuarter.waxing && Math.cos(lastQuarter.tilt) < 0, '凌晨下弦月亮面朝左侧（东方）将升的太阳')
  ok(!landscapeSky(sha('2026-11-09T23:00'), shanghai).moon, '新月夜里月亮在地平线下，不画')
  const later = landscapeSky(sha('2026-11-24T00:00') + 30_000, shanghai).moon
  ok(later.x > full.x && later.x - full.x < 0.001, '位置随秒连续变化，不按整点跳动')

  for (const invalid of [NaN, Infinity, -Infinity, 8.65e15]) {
    ok(moonPhase(invalid) === null && landscapeSky(invalid, shanghai) === null, '非法时间不生成 NaN 月相或轨迹')
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
  ok(moonPhase(Date.parse('2026-11-13T12:00:00Z')).waxing, '朔后为盈月')
  ok(!moonPhase(Date.parse('2026-12-05T12:00:00Z')).waxing, '望后为亏月')
  for (const year of [1900, 1970, 1999, 2000, 2026, 2027, 2050, 2100]) {
    const moon = moonPhase(Date.UTC(year, 0, 1))
    ok(moon.phase >= 0 && moon.phase < 1 && moon.illumination >= 0 && moon.illumination <= 1, `${year} 年月相归一化，无未来年份表限制`)
  }
  const midnight = Date.parse('2026-12-31T23:59:30Z')
  ok(Math.abs(moonPhase(midnight).illumination - moonPhase(midnight + 60_000).illumination) < 0.001, '月相跨年连续，不在零点跳变')

  const timezone = process.env.TZ
  const instant = Date.parse('2026-11-11T02:00:00Z')
  try {
    for (const [zone, sunUp] of [['Asia/Shanghai', true], ['Australia/Sydney', true], ['America/New_York', false], ['Europe/London', false]]) {
      process.env.TZ = zone
      const sky = landscapeSky(instant)
      ok(!!sky.sun === sunUp, `${zone} 按电脑时区所在地判断昼夜`, sky.sun)
    }
  } finally {
    if (timezone === undefined) delete process.env.TZ
    else process.env.TZ = timezone
  }

  for (const tilt of [0, Math.PI / 3, Math.PI, -Math.PI / 2]) {
    for (const illumination of [0, 0.05, 0.25, 0.5, 0.75, 0.95, 1]) {
      const calls = []
      const ctx = Object.fromEntries(['beginPath', 'moveTo', 'arc', 'ellipse', 'lineTo', 'closePath'].map((name) => [name, (...args) => calls.push({ name, args })]))
      traceMoon(ctx, 100, 200, 40, { phase: 0, illumination, waxing: true }, tilt)
      const limb = calls.find(({ name }) => name === 'arc')
      const terminator = calls.find(({ name }) => name === 'ellipse')
      ok(Math.abs(limb.args[3] + Math.PI / 2 - tilt) < 1e-9 && Math.abs(limb.args[4] - Math.PI / 2 - tilt) < 1e-9 && limb.args[5] === false, `亮缘半圆朝向 ${tilt.toFixed(2)} 的太阳方向`)
      if (illumination === 0.5) ok(!terminator && calls.some(({ name }) => name === 'lineTo'), '上下弦使用直线终止界，不传退化椭圆')
      else ok(terminator.args[2] >= 0 && terminator.args[2] <= 40 && terminator.args[4] === tilt && terminator.args.at(-1) === (illumination < 0.5), '终止界随亮面一起旋转，蛾眉与凸月方向正确')
      ok(calls[0].name === 'beginPath' && calls.at(-1).name === 'closePath', '月相路径独立闭合，不擦除山水或绘制不透明遮罩')
    }
  }
  const defaults = []
  const recorder = Object.fromEntries(['beginPath', 'moveTo', 'arc', 'ellipse', 'lineTo', 'closePath'].map((name) => [name, (...args) => defaults.push({ name, args })]))
  traceMoon(recorder, 0, 0, 10, { phase: 0.8, illumination: 0.3, waxing: false })
  ok(Math.abs(defaults.find(({ name }) => name === 'arc').args[3] - Math.PI / 2) < 1e-9, '未给方向时亏月亮面默认在左')
})
