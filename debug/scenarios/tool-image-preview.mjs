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
  const thumb = `document.querySelector('.v3-step-images img')`
  const viewer = `document.querySelector('[role="dialog"] .imgv-image')`
  const press = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers })
  }
  await press('Escape', 'Escape', 27)
  await waitFor(`!${viewer}`, 5000)
  for (const [key, code, vk] of [['Enter', 'Enter', 13], [' ', 'Space', 32]]) {
    await ev(`${thumb}.focus()`)
    await press(key, code, vk)
    const opened = await waitFor(`${viewer}?.naturalWidth > 0`, 3000).then(() => true, () => false)
    check(`${code} 打开已解码的大图`, opened)
    if (!opened) continue
    await press('Escape', 'Escape', 27)
    await waitFor(`!${viewer}`, 5000)
    check(`${code} 打开后按 Esc 关闭并回焦缩略图`, await waitFor(`document.activeElement === ${thumb}`, 2000).then(() => true, () => false))
  }
  const menu = `document.querySelector('[data-testid="v3-message-menu"]')`
  await ev(`${thumb}.focus()`)
  await press('F10', 'F10', 121, 8)
  await waitFor(`${menu}?.contains(document.activeElement)`, 5000)
  const items = await ev(`[...${menu}.querySelectorAll('[role="menuitem"]')].map(el => el.textContent.trim())`)
  check('Shift+F10 打开图片菜单并聚焦复制与另存为菜单', items.length === 2 && items.includes('复制图片') && items.includes('另存为'), items)
  await press('Escape', 'Escape', 27)
  await waitFor(`!${menu}`, 5000)
  check('关闭图片菜单后回焦缩略图', await waitFor(`document.activeElement === ${thumb}`, 2000).then(() => true, () => false))
}
