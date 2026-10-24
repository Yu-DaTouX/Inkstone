import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const [outDir, dataDir] = process.argv.slice(2).map((path) => resolve(path))
if (!outDir || !dataDir) {
  console.error('用法：node scripts/shot-l4.ts <截图目录> <隔离数据目录>')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })
const gameFolder = 'E:/pi-desktop/.tmp/inkstone-minecraft/m2b-game'
const baseVersion = '1.21.1-Fabric L4'
const renamedVersion = `${baseVersion} 改名`
const copyVersion = `${baseVersion}-副本`
const problemVersion = '1.21.1-Fabric L4 问题'
const l3Crash = 'E:/pi-desktop/.tmp/inkstone-minecraft/data-l3/crash/20261024-213117-1.21.1-Fabric_入口点崩溃'

function writeCrashRecord(versionId: string): void {
  const crashDir = join(dataDir, 'crash', '20261024-213117-L4')
  mkdirSync(join(dataDir, 'crash'), { recursive: true })
  if (!existsSync(l3Crash)) {
    console.log('没有 L3 崩溃记录可以复用')
    return
  }
  cpSync(l3Crash, crashDir, { recursive: true })
  const diagnosisPath = join(crashDir, '诊断.json')
  const diagnosis = JSON.parse(readFileSync(diagnosisPath, 'utf8')) as Record<string, unknown>
  diagnosis.id = '20261024-213117-L4'
  diagnosis.folder = gameFolder
  diagnosis.versionId = versionId
  diagnosis.recordDir = crashDir
  writeFileSync(diagnosisPath, `${JSON.stringify(diagnosis, null, 2)}\n`, 'utf8')
}

const electronPath = createRequire(import.meta.url)('electron') as unknown as string
const port = 9400 + Math.floor(Math.random() * 400)
const env: NodeJS.ProcessEnv = { ...process.env, INKSTONE_MC_DATA: dataDir }
delete env.ELECTRON_RUN_AS_NODE
const app = spawn(electronPath, [resolve(import.meta.dirname, '..'), `--remote-debugging-port=${port}`, `--user-data-dir=${join(dataDir, 'electron')}`], { env, stdio: 'ignore' })

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
    } catch {}
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
let shotIndex = 0
async function shot(name: string): Promise<void> {
  await sleep(900)
  const result = (await send('Page.captureScreenshot', { format: 'png' })) as { data: string }
  shotIndex += 1
  writeFileSync(join(outDir, `${String(shotIndex).padStart(2, '0')}-${name}.png`), Buffer.from(result.data, 'base64'))
  console.log(`已截图 ${String(shotIndex).padStart(2, '0')}-${name}.png`)
}
const clickText = (text: string, scope = 'button') =>
  evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (b) b.click(); return !!b })()`)
const clickAria = (label: string) =>
  evaluate(`(() => { const b = document.querySelector('button[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']'); if (b) b.click(); return !!b })()`)
const navText = () => evaluate(`[...document.querySelectorAll('.subnav__item')].map((item) => item.textContent.trim()).join('|')`)
const goSection = (label: string) =>
  evaluate(`(() => { const b = [...document.querySelectorAll('.subnav__item')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (b) b.click(); return !!b })()`)
async function waitFor(expression: string, timeoutMs: number, stepMs = 400): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression)) return true
    await sleep(stepMs)
  }
  return false
}
const noticeText = () => evaluate(`[...document.querySelectorAll('.ui-notice')].map((node) => node.textContent.trim()).join(' | ')`)
const waitNotice = (pattern: string, timeoutMs = 20000) =>
  waitFor(`[...document.querySelectorAll('.ui-notice')].some((node) => node.textContent.includes(${JSON.stringify(pattern)}))`, timeoutMs)
const textOf = (selector: string) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`)
const scrollContent = (top: number) => evaluate(`(() => { const box = document.querySelector('.subnav-content'); if (box) box.scrollTop = ${top}; return box ? box.scrollHeight : 0 })()`)

async function openVersion(id: string): Promise<void> {
  if (await evaluate(`!!document.querySelector('.subnav__back')`)) {
    await clickAria('返回版本列表')
    await sleep(1000)
  }
  const ok = await clickAria(`管理 ${id}`)
  console.log(`打开版本 ${id}：`, ok)
  await waitFor(`!!document.querySelector('.subnav__back')`, 15000)
  await sleep(1200)
}

async function resetToLaunch(): Promise<void> {
  await send('Page.reload')
  await sleep(3500)
}

try {
  await send('Page.enable')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await sleep(2500)
  await evaluate(
    `(async () => {
      const settings = await window.craft.settings()
      let account = settings.accounts.find((item) => item.kind === 'offline')
      if (!account) { const next = await window.craft.addOfflineAccount('Steve'); account = next.accounts.find((item) => item.kind === 'offline') }
      await window.craft.updateSettings({ folders: [{ name: 'm2b-game', path: ${JSON.stringify(gameFolder)} }], selectedFolder: ${JSON.stringify(gameFolder)}, selectedVersion: ${JSON.stringify(baseVersion)}, selectedAccountId: account ? account.id : null })
      return true
    })()`
  )
  await resetToLaunch()

  await openVersion(problemVersion)
  console.log('问题提示：', await evaluate(`[...document.querySelectorAll('.overview-problems .ui-notice')].map((n) => n.textContent.trim()).join(' | ')`))
  console.log('修复按钮：', await evaluate(`[...document.querySelectorAll('.overview-problems button')].map((b) => b.textContent.trim()).join(' | ')`))
  await shot('概览-问题提示与修复按钮')

  await openVersion(baseVersion)
  console.log('子导航：', await navText())
  await shot('概览-版本信息与操作')
  await scrollContent(400)
  await sleep(500)
  await shot('概览-版本操作与回收站')

  await scrollContent(0)
  await clickText('复制为新版本')
  await sleep(700)
  await shot('复制为新版本-对话框')
  await clickText('复制', '.ui-modal button')
  console.log('复制结果：', (await waitNotice('已复制为')) ? await noticeText() : '没有等到复制提示')
  await shot('复制结果')

  await clickText('重命名')
  await sleep(700)
  await evaluate(`(() => { const input = document.querySelector('.ui-modal input'); if (input) { input.focus(); input.select() } return !!input })()`)
  await send('Input.insertText', { text: renamedVersion })
  await sleep(300)
  await shot('重命名-对话框')
  await clickText('重命名', '.ui-modal button')
  await waitFor(`document.querySelector('.version-head__name')?.textContent.trim() === ${JSON.stringify(renamedVersion)}`, 20000)
  await sleep(1200)
  console.log('改名后的版本名：', await textOf('.version-head__name'))
  await shot('重命名结果-页面标题与新名字')

  await clickText('删除到回收站')
  await sleep(700)
  await shot('删除-确认对话框')
  await clickText('移到回收站')
  await waitFor(`!!document.querySelector('.versions__list')`, 20000)
  await sleep(1200)
  console.log('删除后回到版本列表：', await evaluate(`!!document.querySelector('.versions__list')`))

  await openVersion(copyVersion)
  console.log('回收站：', await evaluate(`[...document.querySelectorAll('.setting-row, .ui-setting-row')].map((r) => r.textContent.trim()).filter((t) => t.includes('L4 改名')).join(' | ')`))
  await scrollContent(99999)
  await sleep(500)
  await shot('回收站-被删除的版本')
  await clickText('恢复')
  console.log('恢复结果：', (await waitNotice('已从回收站恢复')) ? await noticeText() : '没有等到恢复提示')
  await shot('回收站-恢复结果')

  await clickText('更换图标')
  await waitFor(`!!document.querySelector('.l4-icons')`, 20000)
  await sleep(800)
  await shot('更换图标-可用来源')
  const picked = await evaluate(`(() => { const b = document.querySelector('.l4-icon-option'); if (b) b.click(); return b ? b.textContent.trim() : null })()`)
  console.log('选用的图标来源：', picked)
  await sleep(1800)
  await shot('更换图标-结果')

  await evaluate(
    `(async () => { await window.craft.updateInstanceSettings(${JSON.stringify(gameFolder)}, ${JSON.stringify(renamedVersion)}, { server: '127.0.0.1:25565', autoEnter: true }); return true })()`
  )
  await resetToLaunch()
  await openVersion(renamedVersion)
  await goSection('设置')
  await sleep(1500)
  await scrollContent(99999)
  await sleep(600)
  await shot('版本设置-启动后自动进入服务器')

  await goSection('资源包')
  await waitFor(`document.querySelectorAll('.mod-row').length > 0`, 15000)
  await sleep(900)
  await shot('资源包-列表')
  console.log('点击资源包开关：', await evaluate(`(() => { const s = document.querySelector('.mod-row input[role="switch"]'); if (s) { s.click(); return true } return false })()`))
  console.log('启停结果：', (await waitNotice('已启用')) ? await noticeText() : '没有等到启停提示')
  await sleep(600)
  await shot('资源包-启用后')
  console.log('options.txt 已启用条目：', await evaluate(`(async () => { const r = await window.craft.versionResources(${JSON.stringify(gameFolder)}, ${JSON.stringify(renamedVersion)}); return r.resourcepacks.map((p) => p.file + (p.enabled ? '=开' : '=关')).join(' | ') })()`))

  await goSection('光影')
  await waitFor(`document.querySelectorAll('.mod-row').length > 0`, 15000)
  await shot('光影-列表')
  console.log('光影删除：', await evaluate(`(() => { const b = document.querySelector('.mod-row button[aria-label^="删除"]'); if (b) b.click(); return !!b })()`))
  await sleep(700)
  await shot('光影-删除确认')
  await clickText('移到 .trash', '.ui-modal button')
  console.log('光影删除结果：', (await waitNotice('已移到 .trash/shaderpacks')) ? await noticeText() : '没有等到删除提示')
  await sleep(700)
  await shot('光影-删除结果')

  await goSection('存档')
  await waitFor(`document.querySelectorAll('.mod-row').length > 0`, 15000)
  await sleep(700)
  await shot('存档-名称与最后游玩')

  await goSection('截图')
  await waitFor(`document.querySelectorAll('.l4-shot').length > 0`, 20000)
  await shot('截图-缩略图网格')
  await evaluate(`(() => { const b = document.querySelector('.l4-shot'); if (b) b.click(); return !!b })()`)
  await waitFor(`!!document.querySelector('.sheet img')`, 10000)
  await sleep(900)
  await shot('截图-点开大图')
  await evaluate(`(() => { const b = document.querySelector('.sheet [aria-label="关闭"]'); if (b) b.click(); return !!b })()`)
  await sleep(600)

  writeCrashRecord(renamedVersion)
  await goSection('日志与崩溃')
  await waitFor(`document.querySelectorAll('.mod-row').length > 0`, 15000)
  await sleep(900)
  console.log('崩溃记录：', await evaluate(`[...document.querySelectorAll('.mod-row__name')].map((n) => n.textContent.trim()).join(' | ')`))
  await shot('日志与崩溃-记录与结论')
  await clickText('看结论')
  await sleep(1200)
  await shot('日志与崩溃-看结论')
  await clickText('导出报告')
  console.log('导出结果：', (await waitNotice('诊断包已导出')) ? await noticeText() : '没有等到导出提示')
  await sleep(800)
  await shot('日志与崩溃-导出报告')

  await goSection('概览')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await sleep(900)
  await shot('概览-深色')
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 620, deviceScaleFactor: 1, mobile: false })
  await sleep(900)
  await shot('概览-窄窗口-深色')
  await send('Emulation.clearDeviceMetricsOverride')
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await sleep(600)

  await evaluate(`(async () => { await window.craft.updateSettings({ selectedVersion: ${JSON.stringify(renamedVersion)} }); return true })()`)
  await clickAria('返回版本列表')
  await sleep(1200)
  console.log('启动游戏：', await clickText('启动游戏'))
  await sleep(2000)
  const warnings = String((await evaluate(`[...document.querySelectorAll('.ui-notice')].map((n) => n.textContent.trim()).join(' | ')`)) ?? '')
  if (warnings.includes('启动前检查')) {
    console.log('启动前提醒：', warnings)
    await clickText('仍然启动')
  }
  const running = await waitFor(`(async () => (await window.craft.status()).state === 'running')()`, 120000, 2000)
  console.log('运行状态：', running)
  const autoServerLine = await waitFor(
    `(async () => (await window.craft.logs()).some((line) => line.stream === 'launcher' && line.text.includes('启动后自动进入服务器')))()`,
    30000,
    1000
  )
  console.log('自动进服日志：', autoServerLine, await evaluate(`(async () => (await window.craft.logs()).filter((line) => line.stream === 'launcher').map((line) => line.text).join(' || '))()`))
  await shot('启动-自动进服日志行')
  const command = await evaluate(`(async () => {
    const lines = await window.craft.logs()
    return lines.filter((line) => line.stream === 'launcher').map((line) => line.text).join(' || ')
  })()`)
  console.log('启动器日志：', command)
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '日志'); if (b) b.click(); return !!b })()`)
  await sleep(900)
  await shot('日志抽屉-自动进服')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(600)
  await clickText('停止')
  await waitFor(`(async () => ['exited', 'failed'].includes((await window.craft.status()).state))()`, 30000, 1000)
  console.log('已停止：', await evaluate(`window.craft.status()`))

  await evaluate(
    `(async () => { await window.craft.renameInstance(${JSON.stringify(gameFolder)}, ${JSON.stringify(renamedVersion)}, ${JSON.stringify(baseVersion)}); return true })()`
  ).catch((error: unknown) => console.log('改回原名失败：', String(error)))
  const versions = await evaluate(`(async () => (await window.craft.instances(${JSON.stringify(gameFolder)})).map((item) => item.id).filter((id) => id.includes('L4')).join(' | '))()`)
  console.log('L4 版本列表：', versions)
  const trash = await evaluate(`(async () => (await window.craft.trashedInstances(${JSON.stringify(gameFolder)})).map((item) => item.versionId).join(' | '))()`)
  console.log('回收站：', trash)
} finally {
  socket.close()
  app.kill()
}
