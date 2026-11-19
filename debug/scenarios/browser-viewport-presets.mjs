import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { click } from '../lib/review-kit.mjs'

export const meta = { description: '内置浏览器固定尺寸预设：菜单切换、页面尺寸、触屏、标签独立与返回自适应；仅回环夹具' }

export default async function run({ cdp, newSession, check, waitFor, shot, runDir, sleep }) {
  const ev = (expr) => cdp.evaluate(expr)
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>viewport-fixture</title><body style="background:#e4ebf2;color:#262c36;font:24px system-ui"><p>Viewport fixture</p><script>setInterval(()=>{document.title=`probe:${innerWidth}×${innerHeight}:${navigator.maxTouchPoints > 1 ? "touch" : "mouse"}`},100)</script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const url = `http://127.0.0.1:${server.address().port}/`
    await newSession()
    await ev(`window.__yanStore.getState().openBrowser(${JSON.stringify(url)})`)
    await waitFor(`s.browserState.title?.startsWith('probe:')`)
    const menu = '[data-testid="browser-pane-viewport-menu"]'
    const choose = async (name) => {
      const item = `[data-testid="browser-pane-viewport-${name}"]`
      await click(cdp, menu)
      await waitFor(`!!document.querySelector(${JSON.stringify(item)})`)
      await click(cdp, item)
    }
    const active = `s.browserState.tabs.find(tab => tab.id === s.browserState.activeTabId)`
    const first = await ev(`window.__yanStore.getState().browserState.activeTabId`)
    for (const [name, expected] of [['mobile-wide', '430×932:touch'], ['tablet', '768×1024:mouse'], ['tablet-landscape', '1024×768:mouse'], ['desktop', '1280×800:mouse'], ['desktop-wide', '1440×900:mouse']]) {
      await choose(name)
      await waitFor(`${active}?.viewport === ${JSON.stringify(name)} && s.browserState.title === ${JSON.stringify('probe:' + expected)}`, 15000)
      check(`${name} 页面实际尺寸与输入模式正确`, true, expected)
      if (name === 'mobile-wide') {
        await sleep(900)
        const image = await ev('window.yan.browser.snapshot()')
        check('可截取内置网页层', image?.startsWith('data:image/jpeg;base64,'))
        if (image) writeFileSync(join(runDir, 'web-layer.jpg'), Buffer.from(image.split(',')[1], 'base64'))
        await shot('mobile-wide-fixed')
      }
    }
    await ev(`window.yan.browser.newTab(${JSON.stringify(url + 'second')})`)
    await waitFor(`s.browserState.activeTabId !== ${JSON.stringify(first)} && s.browserState.title?.startsWith('probe:')`)
    check('新标签不继承预设，原标签维持原设置', await ev(`(() => { const s = window.__yanStore.getState(); return !${active}?.viewport && s.browserState.tabs.find(t => t.id === ${JSON.stringify(first)})?.viewport === 'desktop-wide' })()`))
    await choose('mobile')
    await waitFor(`s.browserState.title === 'probe:375×812:touch'`)
    check('mobile 页面实际尺寸与触屏正确', true, '375×812:touch')
    await choose('responsive')
    await waitFor(`${active}?.viewport === 'responsive' && s.browserState.title?.endsWith(':mouse') && s.browserState.title !== 'probe:375×812:mouse'`)
    check('回到自适应后清除固定尺寸与触屏', true)
  } finally {
    server.close()
  }
}
