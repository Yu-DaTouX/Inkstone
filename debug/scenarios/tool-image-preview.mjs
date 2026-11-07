import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const meta = { description: '工具结果里的图片（如 read 读到的截图）可以点开大图预览，右键有复制与保存' }

export default async function run({ cdp, check, waitFor, sleep, shot }) {
  const ev = (expr) => cdp.evaluate(expr)
  await waitFor('s.conn === "ready"')
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN' })`)
  const data = readFileSync(resolve(import.meta.dirname, '../../build/icon.png')).toString('base64')
  await ev(`window.__yanStore.setState({ messages: [
    { id: 'img-u', role: 'user', text: '看看这张图', timestamp: Date.now() - 2000 },
    { id: 'img-a', role: 'assistant', text: '看完了。', timestamp: Date.now() - 1000, toolCalls: [
      { id: 'img-call', name: 'read', args: { path: 'shot.png' }, output: 'Read image file [image/png]', images: [{ mimeType: 'image/png', data: ${JSON.stringify(data)} }], status: 'ok', startedAt: Date.now() - 1500, endedAt: Date.now() - 1200 }
    ] }
  ], historyLoading: false, switchLoading: false })`)
  await sleep(500)
  for (let i = 0; i < 6 && !(await ev(`!!document.querySelector('.v3-step-images img')`)); i++) {
    await ev(`(() => { const t = [...document.querySelectorAll('button, [role="button"]')].find((el) => /读取|shot\\.png|read/.test(el.textContent ?? '') && el.getAttribute('aria-expanded') !== 'true'); t?.click() })()`)
    await sleep(400)
  }
  check('读取结果里显示图片', await ev(`!!document.querySelector('.v3-step-images img')`))
  check('图片可点击（按钮语义）', await ev(`document.querySelector('.v3-step-images img')?.getAttribute('role') === 'button'`))
  await ev(`document.querySelector('.v3-step-images img').click()`)
  await waitFor(`!!document.querySelector('[role="dialog"] img')`, 5000)
  check('点击后弹出大图预览', await ev(`!!document.querySelector('[role="dialog"] img')`))
  await sleep(600)
  await shot('tool-image-preview-open')
}
