import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const [outDir, dataDir] = process.argv.slice(2).map((path) => resolve(path))
if (!outDir || !dataDir) {
  console.error('用法：node scripts/shot-crash.ts <截图目录> <隔离数据目录>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })
const gameFolder = 'E:/pi-desktop/.tmp/inkstone-minecraft/m2b-game'
const missingVersion = '1.21.1-Fabric 缺失依赖'
const crashVersion = '1.21.1-Fabric 入口点崩溃'
const electronPath = createRequire(import.meta.url)('electron') as unknown as string
const port = 9400 + Math.floor(Math.random() * 400)
const env: NodeJS.ProcessEnv = { ...process.env, INKSTONE_MC_DATA: dataDir }
delete env.ELECTRON_RUN_AS_NODE
const app = spawn(electronPath, [resolve(import.meta.dirname, '..'), `--remote-debugging-port=${port}`], { env, stdio: 'ignore' })

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function pageSocket(): Promise<WebSocket> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
      const page = targets.find((target) => target.type === 'page')
      if (page) {
        const socket = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((done, fail) => {
          socket.onopen = done
          socket.onerror = fail
        })
        return socket
      }
    } catch {
    }
    await sleep(500)
  }
  throw new Error('等不到 Electron 页面')
}

const socket = await pageSocket()
let nextId = 1
const pending = new Map<number, (value: unknown) => void>()
socket.onmessage = (event) => {
  const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown }
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)?.(message.result)
    pending.delete(message.id)
  }
}
function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((done) => pending.set(id, done))
}
async function evaluate(expression: string): Promise<unknown> {
  const result = (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
  if (result.exceptionDetails) console.log('页面异常：', JSON.stringify(result.exceptionDetails).slice(0, 300))
  return result.result?.value
}
async function shot(name: string): Promise<void> {
  await sleep(900)
  const result = (await send('Page.captureScreenshot', { format: 'png' })) as { data: string }
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(result.data, 'base64'))
  console.log(`已截图 ${name}.png`)
}
const clickText = (text: string) =>
  evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (b) b.click(); return !!b })()`)
const clickStartsWith = (text: string) =>
  evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)})); if (b) b.click(); return !!b })()`)
const dialogText = () => evaluate(`document.querySelector('.crash-dialog')?.textContent ?? null`)
async function waitFor(expression: string, timeoutMs: number, stepMs = 1000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression)) return true
    await sleep(stepMs)
  }
  return false
}
const waitStatus = (expression: string, timeoutMs: number) => waitFor(`(async () => { const s = await window.craft.status(); return (${expression})(s) })()`, timeoutMs, 2000)
const waitDialog = (timeoutMs: number) => waitFor(`!!document.querySelector('.crash-dialog')`, timeoutMs, 1000)
const textInDialog = (pattern: string, timeoutMs: number) =>
  waitFor(`(() => { const t = document.querySelector('.crash-dialog')?.textContent ?? ''; return new RegExp(${JSON.stringify(pattern)}).test(t) })()`, timeoutMs, 1000)

try {
  await send('Page.enable')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await sleep(2500)
  await evaluate(
    `(async () => {
      const settings = await window.craft.settings()
      let account = settings.accounts.find((item) => item.kind === 'offline')
      if (!account) { const next = await window.craft.addOfflineAccount('Steve'); account = next.accounts.find((item) => item.kind === 'offline') }
      await window.craft.updateSettings({ folders: [{ name: 'm2b-game', path: ${JSON.stringify(gameFolder)} }], selectedFolder: ${JSON.stringify(gameFolder)}, selectedVersion: ${JSON.stringify(missingVersion)}, selectedAccountId: account ? account.id : null })
      return true
    })()`
  )
  await send('Page.reload')
  await sleep(3500)
  console.log('选中版本：', await evaluate(`document.querySelector('.side-launch__name')?.textContent ?? null`))
  await shot('01-启动页-选中的缺依赖版本')

  console.log('启动游戏：', await clickText('启动游戏'))
  const warned = await waitFor(`[...document.querySelectorAll('.ui-notice')].some((x) => x.textContent.includes('启动前检查'))`, 30000, 500)
  console.log('启动前检查出现：', warned, await evaluate(`[...document.querySelectorAll('.ui-notice')].map((n) => n.textContent).join(' | ')`))
  await shot('02-启动前检查-缺前置-Mod')

  console.log('仍然启动：', await clickText('仍然启动'))
  await sleep(1800)
  console.log('启动卡：', await evaluate(`document.querySelector('.launch-card')?.textContent ?? null`))
  await shot('03-启动卡-分步进行中')

  const crashed = await waitDialog(120000)
  console.log('崩溃对话框：', crashed, String((await dialogText()) ?? '').slice(0, 400))
  if (!crashed) {
    await shot('04-没等到崩溃对话框')
  } else {
    console.log('状态：', JSON.stringify(await evaluate(`window.craft.status()`)))
    await shot('04-崩溃对话框-缺前置原因')
    console.log('展开证据：', await clickStartsWith('展开'))
    await sleep(600)
    await shot('05-崩溃对话框-展开证据')
    console.log('导出报告：', await clickStartsWith('导出报告'))
    console.log('导出结果：', await textInDialog('诊断包已导出', 60000))
    await shot('06-导出诊断包')
    console.log('补全依赖：', await clickStartsWith('补全依赖'))
    console.log('补全结果：', await textInDialog('已补全', 180000))
    await shot('07-补全依赖结果')
    await evaluate(`document.querySelector('.crash-dialog [aria-label="关闭"]')?.click()`)
    await sleep(800)
  }

  console.log('再启动：', await clickText('启动游戏'))
  await sleep(1200)
  const warningsAgain = await waitFor(`[...document.querySelectorAll('.ui-notice')].some((x) => x.textContent.includes('启动前检查'))`, 15000, 500)
  if (warningsAgain) {
    console.log('仍有提醒：', await evaluate(`[...document.querySelectorAll('.ui-notice')].map((n) => n.textContent).join(' | ')`))
    await clickText('仍然启动')
  }
  console.log('运行：', await waitStatus(`(s) => s.state === 'running'`, 90000))
  await sleep(2000)
  await shot('08-启动卡-运行中')
  const windowed = await waitStatus(`(s) => (s.steps ?? []).some((x) => x.id === 'window' && x.state === 'done')`, 180000)
  console.log('窗口步骤完成：', windowed, JSON.stringify((await evaluate(`window.craft.status()`)) as Record<string, unknown>))
  await shot('09-启动卡-窗口已出现')
  console.log('日志按钮：', await clickText('日志'))
  await sleep(800)
  await shot('10-日志抽屉-打开文件夹')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(600)
  console.log('停止：', await clickText('停止'))
  await waitStatus(`(s) => s.state === 'exited' || s.state === 'failed'`, 30000)
  await sleep(1500)
  await shot('11-停止后-上次崩溃入口')

  await evaluate(`(async () => { await window.craft.updateSettings({ selectedVersion: ${JSON.stringify(crashVersion)} }); return true })()`)
  await send('Page.reload')
  await sleep(3500)
  console.log('切换版本：', await evaluate(`document.querySelector('.side-launch__name')?.textContent ?? null`))
  console.log('启动崩溃版本：', await clickText('启动游戏'))
  const crashed2 = await waitDialog(120000)
  console.log('崩溃对话框 2：', crashed2, String((await dialogText()) ?? '').slice(0, 400))
  if (crashed2) {
    await shot('12-崩溃对话框-入口点崩溃')
    console.log('停用 Mod：', await clickStartsWith('停用'))
    console.log('停用结果：', await textInDialog('已停用', 30000))
    await shot('13-停用嫌疑Mod结果')
    await evaluate(`document.querySelector('.crash-dialog [aria-label="关闭"]')?.click()`)
    await sleep(600)
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
    await shot('14-启动页-深色')
    await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 620, deviceScaleFactor: 1, mobile: false })
    await sleep(800)
    await shot('15-窄窗口-启动页-深色')
    await send('Emulation.clearDeviceMetricsOverride')
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  }
  const records = await evaluate(`(async () => (await window.craft.crashList(${JSON.stringify(gameFolder)}, ${JSON.stringify(crashVersion)})).length)()`)
  console.log('崩溃记录数：', records)
} finally {
  socket.close()
  app.kill()
}
