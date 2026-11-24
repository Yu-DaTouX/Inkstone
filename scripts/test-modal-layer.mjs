import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  globalThis.window = { yan: { setHotkeyGuard() {} } }
  const layer = await compile('src/renderer/src/lib/modalLayer.ts')
  const palette = Symbol('palette')
  const settings = Symbol('settings')
  const confirm = Symbol('confirm')

  layer.pushModal(palette)
  layer.pushModal(settings)
  ok(layer.modalsAbove(settings) === 0, '设置之前已打开的弹窗压在下面，不算设置上方的嵌套弹窗')
  layer.pushModal(confirm)
  ok(layer.modalsAbove(settings) === 1, '设置之后打开的确认框算作设置上方的嵌套弹窗')
  layer.popModal(confirm)
  ok(layer.modalsAbove(settings) === 0, '确认框关闭后设置恢复清晰')
  layer.popModal(palette)
  ok(layer.modalsAbove(settings) === 0 && layer.isModalOpen(), '下方弹窗关闭不影响设置')
  layer.popModal(settings)
  ok(layer.modalsAbove(settings) === 0 && !layer.isModalOpen(), '未登记的层上方计数为 0')
})
