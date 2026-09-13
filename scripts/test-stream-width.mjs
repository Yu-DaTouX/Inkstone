/**
 * 对话宽度（streamWidth）的纯逻辑测试。
 *
 * `clampStreamWidth` 同时被主进程（落盘前校验）和渲染端（拖动/滑块）调用，
 * 是「设置文件被手改成脏值也不会把界面撑坏」的唯一防线 —— 值得钉住边界：
 *   · 0 / 负数 / 非数字 → 0（= 用设计默认值）
 *   · 下限、上限、取整
 */
export async function runStreamWidthTests(ok) {
  const { clampStreamWidth, STREAM_MIN, STREAM_MAX } = await import('../out/test/ipc.mjs')

  ok(clampStreamWidth(0) === 0, '0 → 0（用设计默认值）')
  ok(clampStreamWidth(-100) === 0, '负数 → 0')
  ok(clampStreamWidth('not-a-number') === 0, '非数字 → 0')
  ok(clampStreamWidth(null) === 0, 'null → 0')
  ok(clampStreamWidth(STREAM_MIN - 200) === STREAM_MIN, `低于下限夹到 ${STREAM_MIN}`)
  ok(clampStreamWidth(STREAM_MAX + 200) === STREAM_MAX, `高于上限夹到 ${STREAM_MAX}`)
  ok(clampStreamWidth(1000) === 1000, '区间内原样保留')
  ok(clampStreamWidth(900.4) === 900, '取整（向下）')
  ok(clampStreamWidth(900.6) === 901, '取整（向上）')
  ok(
    Number.isFinite(clampStreamWidth('1040')) && clampStreamWidth('1040') === 1040,
    '数字字符串按数字处理（设置文件里可能是字符串）'
  )
}
