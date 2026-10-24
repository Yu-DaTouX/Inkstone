import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const [outDir, dataDir] = process.argv.slice(2).map((path) => resolve(path))
if (!outDir || !dataDir) {
  console.error('用法：node scripts/shot-launch-settings.ts <截图目录> <隔离数据目录>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })
const gameFolder = 'E:/pi-desktop/.tmp/inkstone-minecraft/m2b-game'
const versionId = '1.21.1-Fabric 0.20.1'
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
  await sleep(700)
  const result = (await send('Page.captureScreenshot', { format: 'png' })) as { data: string }
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(result.data, 'base64'))
  console.log(`已截图 ${name}.png`)
}
const clickText = (text: string) =>
  evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (b) b.click(); return !!b })()`)
async function waitFor(expression: string, timeoutMs: number, stepMs = 1000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression)) return true
    await sleep(stepMs)
  }
  return false
}
const waitStatus = (expression: string, timeoutMs: number) => waitFor(`(async () => { const s = await window.craft.status(); return (${expression})(s) })()`, timeoutMs, 2000)

try {
  await send('Page.enable')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await sleep(2500)
  const saved = await evaluate(
    `(async () => {
      const saved = await window.craft.updateInstanceSettings(${JSON.stringify(gameFolder)}, ${JSON.stringify(versionId)}, { maxMemoryMb: 3072, jvmArgs: '-XX:+UseG1GC -Dinkstone.copy=1', windowWidth: 1280, windowHeight: 720 })
      await window.craft.updateSettings({ selectedFolder: ${JSON.stringify(gameFolder)}, selectedVersion: ${JSON.stringify(versionId)} })
      return saved
    })()`
  )
  console.log('单版本设置：', JSON.stringify(saved))
  await send('Page.reload')
  await sleep(3500)
  console.log('选中版本：', await evaluate(`document.querySelector('.side-launch__name')?.textContent ?? null`))
  await shot('16-启动页-单版本设置已写入')

  console.log('启动游戏：', await clickText('启动游戏'))
  const checking = await waitFor(`[...document.querySelectorAll('.ui-notice')].some((x) => x.textContent.includes('启动前检查'))`, 15000, 500)
  console.log('启动前检查：', checking)
  const started = await waitFor(`!!document.querySelector('.launch-card')`, 60000, 300)
  console.log('启动卡出现：', started)
  console.log('生效值：', await evaluate(`document.querySelector('.launch-card__effective')?.textContent ?? null`))
  await shot('17-启动卡-生效值与来源')
  const running = await waitStatus(`(s) => s.state === 'running'`, 60000)
  console.log('运行：', running)
  await sleep(2500)
  console.log('生效值（运行中）：', await evaluate(`document.querySelector('.launch-card__effective')?.textContent ?? null`))
  await shot('18-启动卡-运行中-生效值与来源')
  console.log('状态参数：', JSON.stringify(await evaluate(`(async () => { const s = await window.craft.status(); return { effective: s.effective, steps: (s.steps ?? []).map((x) => x.label + ':' + x.state + ':' + x.detail) } })()`)))
  console.log('停止：', await clickText('停止'))
  await waitStatus(`(s) => s.state === 'exited' || s.state === 'failed'`, 30000)
} finally {
  socket.close()
  app.kill()
}
