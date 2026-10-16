export function runIpcErrorTests(ok, mod) {
  const { stripIpcErrorPrefix } = mod

  ok(
    stripIpcErrorPrefix("Error invoking remote method 'yan:browser:open': Error: 只允许打开 http(s) 网页") ===
      '只允许打开 http(s) 网页',
    "剥掉「Error invoking remote method '…' + 内层 Error:」两层壳"
  )

  ok(
    stripIpcErrorPrefix("Error invoking remote method 'yan:compact': pi 未运行") === 'pi 未运行',
    '内层没有 Error: 前缀时也能剥（只有一层壳）'
  )

  ok(
    stripIpcErrorPrefix('pi 未运行') === 'pi 未运行',
    '本来就没有壳的消息原样返回'
  )

  ok(
    stripIpcErrorPrefix("Error invoking remote method 'yan:x': Error: Error: 嵌套的两层") === 'Error: 嵌套的两层',
    '只剥最外层一次 —— 正文里自己的 Error: 要留着'
  )

  ok(
    stripIpcErrorPrefix("Error invoking remote method 'yan:x':Error:无空格") === '无空格',
    '冒号后没有空格也能剥'
  )

  ok(
    stripIpcErrorPrefix('Error invoking remote method') === 'Error invoking remote method',
    '不匹配完整形状时不误伤（宁可原样显示）'
  )

  ok(
    stripIpcErrorPrefix('') === '',
    '空消息不炸'
  )
}
