import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { build } from '../node_modules/esbuild/lib/main.js'

const OUT_DIR = '.tmp/browser-screenshot-timeout'
mkdirSync(OUT_DIR, { recursive: true })
await build({
  entryPoints: ['src/main/browser/CDPBridge.ts'],
  outfile: `${OUT_DIR}/bridge.mjs`,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})

const { CDPBridge, SCREENSHOT_TIMEOUT_MS, ScreenshotTimeoutError } = await import(`../${OUT_DIR}/bridge.mjs`)

function fakeContents(sendCommand) {
  return {
    debugger: {
      on() {},
      isAttached: () => true,
      attach() {},
      detach() {},
      sendCommand
    }
  }
}

assert.equal(SCREENSHOT_TIMEOUT_MS, 10_000, '默认截图超时是 10 秒')

{
  let cdpCalls = 0
  const contents = fakeContents(() => { cdpCalls++; return new Promise(() => {}) })
  contents.capturePage = async () => ({ isEmpty: () => false, toPNG: () => Buffer.from('painted') })
  const shot = await new CDPBridge(contents).screenshot(200)
  assert.equal(shot.toString(), 'painted', '优先用 webContents.capturePage，隐藏窗口里也能截到画面')
  assert.equal(cdpCalls, 0, 'capturePage 成功时不再走 CDP 截图')
  const blank = fakeContents(async () => ({ data: Buffer.from('cdp').toString('base64') }))
  blank.capturePage = async () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) })
  assert.equal((await new CDPBridge(blank).screenshot(200)).toString(), 'cdp', 'capturePage 拿到空图时回退到 CDP')
}

{
  const bridge = new CDPBridge(fakeContents((method) => (method === 'Page.captureScreenshot' ? new Promise(() => {}) : Promise.resolve({}))))
  const outcome = await Promise.race([
    bridge.screenshot(30).then(
      () => 'resolved',
      (error) => error
    ),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 3000))
  ])
  assert.notEqual(outcome, 'hung', '浏览器面板收起（Page.captureScreenshot 不返回）时截图不能一直挂着')
  assert(outcome instanceof Error, `截图应该以错误结束，实际是 ${String(outcome)}`)
  assert(outcome instanceof ScreenshotTimeoutError, '超时用专门的错误类型')
  assert.equal(outcome.code, 'SCREENSHOT_TIMEOUT', '超时错误带可读 code')
  assert(/面板/.test(outcome.message) && /yan browser open/.test(outcome.message), `错误里要说清面板没显示并给出显示面板的命令：${outcome.message}`)
}

{
  const bridge = new CDPBridge(fakeContents(async () => ({ data: Buffer.from('png-bytes').toString('base64') })))
  const data = await bridge.screenshot()
  assert(Buffer.isBuffer(data), '正常路径仍返回 Buffer')
  assert.equal(data.toString(), 'png-bytes', '正常路径返回截图数据')
}

{
  let seen = null
  const bridge = new CDPBridge(
    fakeContents(async (method) => {
      seen = method
      if (method === 'Page.captureScreenshot') return Promise.reject(new Error('Target closed'))
      return {}
    })
  )
  await assert.rejects(bridge.screenshot(50), /Target closed/, '底下的错误原样抛出，不伪装成超时')
  assert.equal(seen, 'Page.captureScreenshot', '出错前确实发过截图命令')
}

{
  const started = Date.now()
  const bridge = new CDPBridge(fakeContents((method) => (method === 'Page.captureScreenshot' ? new Promise(() => {}) : Promise.resolve({}))))
  await bridge.screenshot(20).catch(() => undefined)
  assert(Date.now() - started < 3000, '超时按设定生效，不拖到 10 秒')
}

console.log('browser-screenshot-timeout: 截图超时、错误文案、正常路径、错误透传 通过')
