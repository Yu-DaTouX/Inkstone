/*
 * 额度摘要派生单测（src/shared/quota-mini.ts，实施-20 U2）。
 *
 * 这一片的用户问题是「mini 摘要错位 / 摘要与明细对不上」，
 * 所以断言集中在：同一份窗口数据、同一套格式化，摘要与明细拿到的
 * 数字必须来自同一次除法（只有小数位渲染不同）。
 */

export async function runQuotaMiniTests(ok, mod) {
  const { money, quotaCompactWindows, windowPct, CURRENCY_SYMBOL } = mod

  /* ── money：余额只写一个数字 + 一个单位 ── */
  ok(money(9.92, 'USD') === '$9.92', 'money：美元用 $ 前缀')
  ok(money(9.92, 'CNY') === '¥9.92', 'money：人民币用 ¥（DeepSeek 余额的真实场景）')
  ok(money(28, 'PERCENT') === '28.0%', 'money：PERCENT 伪币种渲染成百分比而不是 $28.00')
  ok(money(12.5, 'XYZ') === '12.50 XYZ', 'money：未知币种退回「数字 + 代码」，不猜符号')
  ok(money(3) === '$3.00', 'money：缺省币种按美元')
  ok(Object.keys(CURRENCY_SYMBOL).includes('JPY'), 'money：符号表含 JPY')

  /* ── quotaCompactWindows：只显示接口真的返回了的短周期 ── */
  const w = (id, label, used, total) => ({ id, label, used, total })
  const five = w('fiveHour', '5 小时', 25, 100)
  const week = w('weekly', '每周', 40, 100)
  const month = w('monthly', '本月', 100, 1000)

  const fiveWeek = quotaCompactWindows([five, week, month])
  ok(fiveWeek.length === 2, '紧凑栏：有小时窗口时只显示「小时 + 周」，不塞进来月')
  ok(fiveWeek[0].label === '5h', '紧凑栏：小时窗口标签缩成 5h')
  ok(fiveWeek[1].label === '周', '紧凑栏：周窗口标签为 周')
  ok(fiveWeek[0].window.id === 'fiveHour', '紧凑栏：标签是显示用的，window 仍是原对象')

  const weekMonth = quotaCompactWindows([week, month])
  ok(
    weekMonth.length === 2 && weekMonth[0].label === '周' && weekMonth[1].label === '月',
    '紧凑栏：没有小时窗口时退成「周 + 月」'
  )
  ok(quotaCompactWindows([]).length === 0, '紧凑栏：没有窗口就是空（不推算缺失窗口）')
  ok(
    quotaCompactWindows([w('primary', '已用', 1, 10)])[0].label === '5h',
    '紧凑栏：primary 无数字标签时仍给出 5h'
  )

  /* ── windowPct：摘要与明细共用同一次除法 ── */
  ok(windowPct(w('x', 'x', 5, 0)) === null, 'windowPct：total 为 0 时返回 null（不假装 0%）')
  ok(windowPct(w('x', 'x', 25, 100)) === 25, 'windowPct：整数百分比在 0 位下是 25')
  ok(windowPct(w('x', 'x', 25, 100), 1) === 25, 'windowPct：同一次除法在 1 位下仍是 25')
  ok(windowPct(w('x', 'x', 1, 3)) === 33, 'windowPct：1/3 在 0 位下四舍五入到 33')
  ok(windowPct(w('x', 'x', 1, 3), 1) === 33.3, 'windowPct：1/3 在 1 位下是 33.3')
  ok(
    windowPct(w('x', 'x', 1, 3)) === Number(windowPct(w('x', 'x', 1, 3), 1).toFixed(0)),
    'windowPct：摘要（0 位）与明细（1 位）来自同一次除法，不会各算一次'
  )
  ok(windowPct(w('x', 'x', 150, 100), 1) === 150, 'windowPct：超过 100% 如实返回（不夹取）')
}

export default runQuotaMiniTests
