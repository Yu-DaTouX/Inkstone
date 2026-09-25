/**
 * 宿主提问等待时间（src/shared/ui-timeout.ts）的纯逻辑验证。
 *
 * 为什么要有它：这一段的口径同时被四处读（主进程默认值 / 主进程延长 /
 * 渲染端倒计时 / `yan question ask` 的帮助文案），任何一处漂移都不会报错 ——
 * 只会在真实提问里表现成「面板显示 3 分钟，但 2 分钟就超时」这种难查的错。
 * 所以这里把边界钉死，并顺带核对帮助文案里的例子与实际默认值一致。
 *
 * 用法：npm run test:unit（由 test-unit.mjs 调起）
 */
import { readFileSync } from 'node:fs'

export async function runUiTimeoutTests(ok) {
  const {
    UI_TIMEOUT_DEFAULT,
    UI_TIMEOUT_EXTEND,
    UI_TIMEOUT_MAX,
    UI_TIMEOUT_MIN,
    UI_TIMEOUT_REMAINING_MAX,
    extendDeadline,
    formatCountdown,
    requestedTimeout
  } = await import('../out/test/ui-timeout.mjs')

  /* ── 默认值与区间 ─────────────────────────────────── */

  ok(UI_TIMEOUT_DEFAULT === 180_000, '默认等待是 3 分钟（用户 2026-09-26 拍板）', String(UI_TIMEOUT_DEFAULT))
  ok(UI_TIMEOUT_EXTEND === 120_000, '点一下加 2 分钟', String(UI_TIMEOUT_EXTEND))
  ok(
    UI_TIMEOUT_MIN === 5_000 && UI_TIMEOUT_MAX === 600_000 && UI_TIMEOUT_REMAINING_MAX === 1_800_000,
    '区间常量：声明 5 秒 ~ 10 分钟；延长后剩余封顶 30 分钟',
    `${UI_TIMEOUT_MIN}/${UI_TIMEOUT_MAX}/${UI_TIMEOUT_REMAINING_MAX}`
  )

  ok(requestedTimeout(undefined) === UI_TIMEOUT_DEFAULT, '没声明 timeout → 默认 3 分钟')
  ok(requestedTimeout(null) === UI_TIMEOUT_DEFAULT, 'null → 默认值')
  ok(requestedTimeout('abc') === UI_TIMEOUT_DEFAULT, '非数字 → 默认值（不该让等待时间成为失败原因）')
  ok(requestedTimeout(-1) === UI_TIMEOUT_DEFAULT, '负数 → 默认值')
  ok(requestedTimeout(0) === UI_TIMEOUT_DEFAULT, '0 → 默认值')
  ok(requestedTimeout(1) === UI_TIMEOUT_MIN, '过小 → 夹到下限', String(requestedTimeout(1)))
  ok(requestedTimeout(999_999_999) === UI_TIMEOUT_MAX, '过大 → 夹到上限', String(requestedTimeout(999_999_999)))
  ok(requestedTimeout(180_000) === 180_000, '合法值原样保留')
  ok(requestedTimeout('60000') === 60_000, '字符串数字也认（CLI 参数是字符串）')

  /* ── 延长 ─────────────────────────────────────────── */

  const now = 1_000_000
  ok(extendDeadline(now + 60_000, now) === now + 60_000 + UI_TIMEOUT_EXTEND, '默认增量 = 2 分钟')
  ok(
    extendDeadline(now + 60_000, now, UI_TIMEOUT_EXTEND * 5) === now + 60_000 + UI_TIMEOUT_EXTEND,
    '单次增量有上限：传 10 分钟也只加 2 分钟',
    String(extendDeadline(now + 60_000, now, UI_TIMEOUT_EXTEND * 5) - now)
  )
  ok(extendDeadline(now + 60_000, now, -5) === now + 60_000 + UI_TIMEOUT_EXTEND, '非法增量退回默认增量')
  ok(
    extendDeadline(now + UI_TIMEOUT_REMAINING_MAX, now) === now + UI_TIMEOUT_REMAINING_MAX,
    '剩余时间封顶 30 分钟：点再多也不会无限延长'
  )
  ok(
    extendDeadline(now + UI_TIMEOUT_REMAINING_MAX - 1_000, now) === now + UI_TIMEOUT_REMAINING_MAX,
    '临近封顶时只补到上限（不会越过）'
  )

  /* ── 倒计时文本 ───────────────────────────────────── */

  ok(formatCountdown(180_000) === '03:00', '3 分钟 → 03:00', formatCountdown(180_000))
  ok(formatCountdown(59_400) === '01:00', '59.4 秒向上取整到 01:00（不会停在 00:00 还活着）', formatCountdown(59_400))
  ok(formatCountdown(59_000) === '00:59', '59 秒 → 00:59', formatCountdown(59_000))
  ok(formatCountdown(0) === '00:00', '0 → 00:00')
  ok(formatCountdown(-5_000) === '00:00', '负数 → 00:00（不出现负号闪动）')
  ok(formatCountdown(3_600_000) === '1:00:00', '超过 1 小时改用 h:mm:ss', formatCountdown(3_600_000))

  /* ── 与实际文案一致性 ─────────────────────────────── */

  const cli = readFileSync('resources/yan-cli/yan.mjs', 'utf8')
  const example = /"timeout":(\d+)/.exec(cli)
  ok(
    example?.[1] === String(UI_TIMEOUT_DEFAULT),
    '`yan question ask` 帮助里的 timeout 例子与实现的默认值一致',
    `文档=${example?.[1] ?? '缺失'} 实现=${UI_TIMEOUT_DEFAULT}`
  )
}
