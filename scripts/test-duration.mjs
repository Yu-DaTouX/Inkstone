/**
 * 人读时长的纯逻辑测试（实施-11 H-7）。
 *
 * 被测对象：`src/shared/duration.ts` 的 `formatDuration()` —— 回合页脚、
 * 图片生成进度与子代理列表共用它。抽出来的理由就是别再出现
 * 「消息里 `1m 30s`、子代理行里 `1m30s`」这种同值不同写。
 *
 * 为什么必须单测：写法差异在界面上不会报错，只会让人以为是两种度量；
 * 边界（59 / 60 / 61 秒、负数、NaN）也只有在这里才能一次钉全。
 */

export async function runDurationTests(ok) {
  const { formatDuration } = await import('../out/test/duration.mjs')

  console.log('\n--- 11.8 人读时长：唯一写法与边界 ---')

  ok(formatDuration(0) === '0s', '0ms → 0s', `实际 ${formatDuration(0)}`)
  ok(formatDuration(999) === '1s', '不足 1 秒四舍五入到 1s', `实际 ${formatDuration(999)}`)
  ok(formatDuration(59_400) === '59s', '59.4s 仍是秒档', `实际 ${formatDuration(59_400)}`)
  ok(formatDuration(59_500) === '1m 0s', '59.5s 进位到 60 秒后按分钟档显示（不出现 60s）', `实际 ${formatDuration(59_500)}`)
  ok(formatDuration(60_000) === '1m 0s', '整 1 分钟带零秒（不是裸 1m）', `实际 ${formatDuration(60_000)}`)
  ok(formatDuration(90_000) === '1m 30s', '90 秒 → 1m 30s（唯一写法，带空格）', `实际 ${formatDuration(90_000)}`)
  ok(formatDuration(3_600_000) === '60m 0s', '1 小时不另起小时档，沿用分', `实际 ${formatDuration(3_600_000)}`)

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
