import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const [outDir, dataDir, devProject] = process.argv.slice(2).map((path) => resolve(path))
if (!outDir || !dataDir) {
  console.error('用法：node scripts/shot.ts <截图目录> <隔离数据目录>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })
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
  const result = (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as { result?: { value?: unknown } }
  return result.result?.value
}
async function shot(name: string): Promise<void> {
  await sleep(1200)
  const result = (await send('Page.captureScreenshot', { format: 'png' })) as { data: string }
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(result.data, 'base64'))
  console.log(`已截图 ${name}.png`)
}
const click = (text: string) => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (b) b.click(); return !!b })()`)
const within = (scope: string, text: string) => evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)} + ' button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (b) b.click(); return !!b })()`)
const nav = (text: string) => within('.shell__nav', text)
const sub = (text: string) => within('.subnav', text)
async function key(name: string, code: number): Promise<void> {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code })
}
const currentAccount = () => evaluate(`(() => { const slide = document.querySelector('.carousel__slide:not([aria-hidden="true"])'); return slide ? slide.querySelector('.carousel__name').textContent + ' / ' + slide.querySelector('.ui-badge').textContent : null })()`)

async function swipe(dx: number): Promise<void> {
  const box = (await evaluate(`(() => { const r = document.querySelector('.carousel__viewport').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)) as { x: number; y: number }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let step = 1; step <= 8; step += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + (dx * step) / 8, y: box.y, button: 'left', buttons: 1 })
    await sleep(40)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + dx, y: box.y, button: 'left', buttons: 0, clickCount: 1 })
}

try {
  await send('Page.enable')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await sleep(2500)
  await shot('01-首次打开-设置导入')
  console.log('迁移按钮：', await click('迁移这些设置'))
  await sleep(2500)
  await shot('02-启动页')
  console.log('版本行数：', await evaluate(`document.querySelectorAll('.version').length`), '图标：', await evaluate(`document.querySelectorAll('.version img.res-icon').length`))
  console.log('当前账号：', await currentAccount())
  await swipe(-140)
  await sleep(600)
  console.log('左滑后当前：', await currentAccount())
  await swipe(140)
  await sleep(600)
  console.log('管理：', await evaluate(`(() => { const b = document.querySelector('.version[data-selected] .version__manage') ?? document.querySelector('.version__manage'); b?.click(); return b?.getAttribute('aria-label') })()`))
  await shot('03-版本概览')
  await sub('Mod')
  await shot('04-版本-Mod')
  await sub('日志与崩溃')
  await shot('05-版本-日志与崩溃')
  await evaluate(`document.querySelector('[aria-label="返回版本列表"]')?.click()`)
  await sleep(600)
  console.log('日志按钮：', await click('日志'))
  await shot('06-日志抽屉')
  await key('Escape', 27)
  await sleep(500)
  await nav('下载')
  await shot('07-下载')
  await nav('设置')
  await shot('08-设置-账号')
  await sub('下载')
  await shot('09-设置-下载')
  await sub('关于')
  await shot('10-设置-关于')
  await sub('账号')
  await sleep(500)
  await evaluate(`document.querySelector('.subpage [aria-label^="移除 "]')?.click()`)
  await shot('11-移除确认')
  await click('取消')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await nav('启动')
  await shot('12-启动页-深色')
  await send('Emulation.setDeviceMetricsOverride', { width: 860, height: 600, deviceScaleFactor: 1, mobile: false })
  await evaluate(`document.querySelector('.version__manage')?.click()`)
  await shot('13-窄窗口-版本页-深色')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await send('Emulation.clearDeviceMetricsOverride')
  if (devProject) {
    await evaluate(`(() => { window.localStorage.setItem('craft-dev:recent-projects', JSON.stringify([${JSON.stringify(devProject)}])); return true })()`)
    await send('Page.reload')
    await sleep(3000)
  }
  await nav('开发')
  if (devProject) {
    console.log('打开最近项目：', await click('打开'))
    await sleep(2000)
  }
  await shot('14-开发-运行')
  await evaluate(`(() => { const n = document.querySelector('.subnav-content'); if (n) n.scrollTop = 520; return true })()`)
  await shot('14b-开发-运行-操作')
  await sub('项目')
  await evaluate(`(() => { const n = document.querySelector('.subnav-content'); if (n) n.scrollTop = 0; return true })()`)
  await shot('15-开发-项目')
  await sub('日志')
  await shot('16-开发-日志')
  await sub('崩溃')
  await shot('17-开发-崩溃')

  const gameFolder = 'E:\\pi-desktop\\.tmp\\inkstone-minecraft\\m2b-game'
  await evaluate(
    `(async () => { const path = ${JSON.stringify(gameFolder)}; const settings = await window.craft.settings(); const offline = settings.accounts.find((account) => account.kind === 'offline'); await window.craft.updateSettings({ folders: [{ name: 'm2b-game', path }], selectedFolder: path, selectedVersion: '1.21.1', ...(offline ? { selectedAccountId: offline.id } : {}) }); return true })()`
  )
  await send('Page.reload')
  await sleep(3000)
  await nav('下载')
  await sleep(2500)
  console.log('下载页版本行数：', await evaluate(`document.querySelectorAll('.install-row').length`))
  console.log('置顶最新：', await evaluate(`document.querySelector('.install-row')?.textContent ?? null`))
  await shot('18-下载-安装-版本列表')
  console.log(
    '选 1.21.1：',
    await evaluate(`(() => { const row = [...document.querySelectorAll('.install-row')].find((element) => element.querySelector('.install-row__name')?.textContent.trim() === '1.21.1'); if (row) row.click(); return !!row })()`)
  )
  await sleep(3500)
  console.log(
    '加载器卡片：',
    await evaluate(
      `[...document.querySelectorAll('.install-loader')].map((card) => card.querySelector('.install-loader__name').textContent + ' / ' + (card.dataset.disabled ? '置灰' : '可选') + ' / ' + card.querySelector('.install-loader__hint').textContent).join(' | ')`
    )
  )
  console.log('默认名称：', await evaluate(`document.querySelector('.install-form input')?.value ?? null`))
  await evaluate(`document.querySelectorAll('.install-loader')[1]?.querySelector('.install-loader__pick')?.click()`)
  await sleep(700)
  await evaluate(`document.querySelector('.install-loader[data-selected] .ui-select__trigger')?.click()`)
  await sleep(700)
  const fabricExisting = readdirSync(join(gameFolder, 'versions')).filter((name) => name.startsWith('1.21.1-Fabric ')).length
  console.log('已有 Fabric 版本数：', fabricExisting)
  for (let step = 0; step < fabricExisting; step += 1) {
    await key('ArrowDown', 40)
    await sleep(200)
  }
  await key('Enter', 13)
  await sleep(800)
  const focus = (selector: string) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node?.scrollIntoView({ block: 'center' }); return !!node })()`)
  console.log('Fabric 版本：', await evaluate(`document.querySelector('.install-loader[data-selected] .ui-select__value')?.textContent ?? null`))
  const fabricName = (await evaluate(`document.querySelector('.install-form input')?.value ?? null`)) as string | null
  console.log('Fabric 名称：', fabricName)
  await focus('.install-loaders')
  await shot('19-下载-安装-加载器')
  await focus('.install-form')
  await shot('19b-下载-安装-名称与目录')
  console.log('开始安装：', await click('安装'))
  let installShot = false
  let installState = 'running'
  for (let step = 0; step < 120; step += 1) {
    installState = (await evaluate(`document.querySelector('.install-progress')?.dataset.state ?? 'running'`)) as string
    if (installState !== 'running' && installState !== 'queued') break
    if (!installShot && step > 1) {
      await focus('.install-progress')
      await shot('20-下载-安装-进行中')
      installShot = true
    }
    await sleep(1000)
  }
  console.log('安装状态：', installState, await evaluate(`document.querySelector('.install-progress')?.textContent ?? null`))
  await focus('.install-progress')
  await shot('21-下载-安装-完成')
  console.log('游戏目录新版本：', readdirSync(join(gameFolder, 'versions')).join(' | '))
  await nav('启动')
  await sleep(2500)
  console.log('启动页版本数：', await evaluate(`document.querySelectorAll('.version').length`))
  if (fabricName) {
    console.log(
      '选中新版本：',
      await evaluate(
        `(() => { const row = [...document.querySelectorAll('.version')].find((item) => item.querySelector('.version__name')?.textContent.trim() === ${JSON.stringify(fabricName)}); row?.querySelector('.version__pick')?.click(); return !!row })()`
      )
    )
    await sleep(1200)
  }
  console.log('启动页选中：', await evaluate(`document.querySelector('.version[data-selected] .version__name')?.textContent ?? null`))
  await shot('22-启动页-安装后刷新')
  await evaluate(`document.querySelector('.version[data-selected] .version__manage')?.click()`)
  await sleep(1200)
  console.log('版本页：', await evaluate(`document.querySelector('.version-head__name')?.textContent ?? null`))
  await sub('修复')
  await shot('23-版本-修复')
  const repairFile = join(gameFolder, 'libraries', 'com', 'google', 'code', 'gson', 'gson', '2.10.1', 'gson-2.10.1.jar')
  rmSync(repairFile, { force: true })
  console.log('删掉库文件：', repairFile, '存在=', existsSync(repairFile))
  console.log('检查并修复：', await click('检查并修复'))
  let repairState = 'running'
  let repairShot = false
  for (let step = 0; step < 90; step += 1) {
    repairState = (await evaluate(`document.querySelector('.install-progress')?.dataset.state ?? 'running'`)) as string
    if (repairState !== 'running' && repairState !== 'queued') break
    if (!repairShot && step > 0) {
      await shot('24-版本-修复-进行中')
      repairShot = true
    }
    await sleep(1000)
  }
  console.log('修复状态：', repairState, await evaluate(`document.querySelector('.install-progress')?.textContent ?? null`))
  await shot('25-版本-修复-结果')
  console.log('库文件已补回：', existsSync(repairFile), existsSync(repairFile) ? statSync(repairFile).size : 0)
  await nav('下载')
  await sleep(2500)
  console.log(
    '选 26.1.2：',
    await evaluate(`(() => { const row = [...document.querySelectorAll('.install-row')].find((element) => element.querySelector('.install-row__name')?.textContent.trim() === '26.1.2'); if (row) row.click(); return !!row })()`)
  )
  await sleep(5000)
  console.log(
    '26.1.2 加载器：',
    await evaluate(
      `[...document.querySelectorAll('.install-loader')].slice(0, 3).map((card) => card.querySelector('.install-loader__name').textContent + ' / ' + (card.dataset.disabled ? '置灰' : '可选') + ' / ' + card.querySelector('.install-loader__hint').textContent).join(' | ')`
    )
  )
  await evaluate(`document.querySelectorAll('.install-loader')[1]?.querySelector('.install-loader__pick')?.click()`)
  await sleep(1000)
  console.log('26.1.2 名称：', await evaluate(`document.querySelector('.install-form input')?.value ?? null`))
  console.log('开始安装 26.1.2：', await click('安装'))
  let latestState = 'running'
  let latestShot = false
  for (let step = 0; step < 400; step += 1) {
    latestState = (await evaluate(`document.querySelector('.install-progress')?.dataset.state ?? 'running'`)) as string
    if (latestState !== 'running' && latestState !== 'queued') break
    if (!latestShot && step === 3) {
      await focus('.install-progress')
      await shot('26-下载-安装-26.1.2-进行中')
      latestShot = true
    }
    await sleep(3000)
  }
  console.log('26.1.2 安装状态：', latestState, await evaluate(`document.querySelector('.install-progress')?.textContent ?? null`))
  await focus('.install-progress')
  await shot('27-下载-安装-26.1.2-完成')
  console.log('游戏目录版本：', readdirSync(join(gameFolder, 'versions')).filter((name) => name.startsWith('26.1.2')).join(' | '))
} finally {
  socket.close()
  app.kill()
}
