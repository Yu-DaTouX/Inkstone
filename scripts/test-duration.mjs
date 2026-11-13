export async function runDurationTests(ok) {
  const { formatDuration } = await import('../out/test/duration.mjs')

  console.log('\n--- 11.8 人读时长：唯一写法与边界 ---')

  ok(formatDuration(0) === '0s', '0ms → 0s', `实际 ${formatDuration(0)}`)
  ok(formatDuration(999) === '1s', '不足 1 秒四舍五入到 1s', `实际 ${formatDuration(999)}`)
  ok(formatDuration(59_400) === '59s', '59.4s 仍是秒档', `实际 ${formatDuration(59_400)}`)
  ok(formatDuration(59_500) === '1m 0s', '59.5s 进位到 60 秒后按分钟档显示（不出现 60s）', `实际 ${formatDuration(59_500)}`)
  ok(formatDuration(60_000) === '1m 0s', '整 1 分钟带零秒（不是裸 1m）', `实际 ${formatDuration(60_000)}`)
  ok(formatDuration(90_000) === '1m 30s', '90 秒 → 1m 30s（唯一写法，带空格）', `实际 ${formatDuration(90_000)}`)
  ok(formatDuration(3_600_000) === '1h 0m', '整 1 小时用时分档（不再写 60m 0s）', `实际 ${formatDuration(3_600_000)}`)
  ok(formatDuration(3_599_000) === '59m 59s', '不足 1 小时仍用分秒档', `实际 ${formatDuration(3_599_000)}`)
  ok(formatDuration(3_599_500) === '1h 0m', '59m59.5s 四舍五入进位到 1h 0m（不出现 60m 0s）', `实际 ${formatDuration(3_599_500)}`)
  ok(formatDuration(5_400_000) === '1h 30m', '90 分钟 → 1h 30m', `实际 ${formatDuration(5_400_000)}`)
  ok(formatDuration(7_320_000) === '2h 2m', '超过 1 小时只写时与分，不写秒', `实际 ${formatDuration(7_320_000)}`)
  ok(formatDuration(86_399_000) === '23h 59m', '临近 24 小时仍是时分档', `实际 ${formatDuration(86_399_000)}`)
  ok(formatDuration(86_399_600) === '24h 0m', '24 小时进位后仍是时分档', `实际 ${formatDuration(86_399_600)}`)
  ok(formatDuration(3_661_000, { minSeconds: 1 }) === '1h 1m', 'minSeconds 不影响小时档', `实际 ${formatDuration(3_661_000, { minSeconds: 1 })}`)

  ok(formatDuration(-5_000) === '0s', '负数（时钟回拨）钳到 0，不显示 -5s', `实际 ${formatDuration(-5_000)}`)
  ok(formatDuration(Number.NaN) === '0s', 'NaN 当作 0，不抛异常', `实际 ${formatDuration(Number.NaN)}`)
  ok(formatDuration(Number.POSITIVE_INFINITY) === '0s', 'Infinity 当作 0，不抛异常', `实际 ${formatDuration(Number.POSITIVE_INFINITY)}`)

  ok(
    formatDuration(400, { minSeconds: 1 }) === '1s',
    '子代理刚启动（400ms）显示 1s 而不是 0s',
    `实际 ${formatDuration(400, { minSeconds: 1 })}`
  )
  ok(
    formatDuration(-9_000, { minSeconds: 1 }) === '1s',
    'minSeconds 也是负数下限',
    `实际 ${formatDuration(-9_000, { minSeconds: 1 })}`
  )
  ok(
    formatDuration(65_000, { minSeconds: 1 }) === '1m 5s',
    'minSeconds 不影响正常的分钟写法',
    `实际 ${formatDuration(65_000, { minSeconds: 1 })}`
  )
}
