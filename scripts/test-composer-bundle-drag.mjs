import { runSuite } from './lib/test-suite.mjs'

const drag = (items, types = ['Files']) => ({ types, items: items.map(([kind, type]) => ({ kind, type })) })

await runSuite(import.meta.url, async (ok, compile) => {
  const { isSessionBundleDrag } = await compile('src/renderer/src/features/composer/session-bundle-drag.ts')
  ok(isSessionBundleDrag(drag([['file', 'application/json']])), '拖入 JSON 文件提示导入会话包')
  ok(!isSessionBundleDrag(drag([['file', '']])), '拖入文件夹或无类型文件不提示导入会话包')
  ok(!isSessionBundleDrag(drag([['file', 'image/png'], ['file', 'text/plain']])), '拖入图片和普通文件不提示导入会话包')
  ok(isSessionBundleDrag(drag([['file', ''], ['file', 'application/json']])), '混有 JSON 时提示导入会话包')
  ok(!isSessionBundleDrag(drag([['string', 'application/json']], ['text/plain'])) && !isSessionBundleDrag(null), '不是文件拖入时不提示')
})
