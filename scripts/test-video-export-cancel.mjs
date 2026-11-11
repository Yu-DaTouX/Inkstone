import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let checks = 0
const ok = (condition, label, detail) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : ` ← ${JSON.stringify(detail)}`}`)
  checks++
}
const wait = async (predicate, ms = 3000) => {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  return predicate()
}

const exportStubs = {
  electron: `
    export class BrowserWindow {
      constructor() {
        this.destroyed = false
        globalThis.__ve.windows.push(this)
        this.webContents = {
          setWindowOpenHandler() {},
          on() {},
          enableDeviceEmulation() {},
          setZoomFactor() {},
          executeJavaScript: async (script) => {
            if (String(script).includes('data-composition-id')) return { id: 'c1', width: 640, height: 360, duration: 4, ready: true, clips: [] }
            return true
          },
          capturePage: async () => ({ isEmpty: () => false, getSize: () => ({ width: 640, height: 360 }), toPNG: () => Buffer.from([1, 2, 3, 4]) })
        }
      }
      loadURL() { return Promise.resolve() }
      setContentSize() {}
      isDestroyed() { return this.destroyed }
      destroy() { this.destroyed = true }
    }
  `,
  'node:child_process': `
    import { EventEmitter } from 'node:events'
    export function spawn() {
      const child = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = Object.assign(new EventEmitter(), {
        destroyed: false,
        writable: true,
        write() { globalThis.__ve.writes += 1; return !globalThis.__ve.backpressure },
        end() { setTimeout(() => child.emit('close', 0), 0) }
      })
      child.kill = (signal) => {
        globalThis.__ve.kills.push(signal)
        if (!globalThis.__ve.neverClose) setTimeout(() => { globalThis.__ve.order.push('close'); child.emit('close', null) }, globalThis.__ve.closeDelay ?? 0)
      }
      globalThis.__ve.children.push(child)
      return child
    }
  `,
  'node:fs/promises': `
    export async function stat() { globalThis.__ve.stats += 1; globalThis.__ve.onStat?.(); return { size: 10 } }
    export async function rename(from, to) { globalThis.__ve.renames.push([from, to]) }
    export async function unlink(path) { globalThis.__ve.order.push('unlink'); globalThis.__ve.unlinks.push(path) }
  `,
  './html-artifact-preview': `
    export const htmlArtifactPreviews = {
      prepare: async () => { globalThis.__ve.prepares += 1; if (globalThis.__ve.prepareGate) await globalThis.__ve.prepareGate; return { ok: true, url: 'http://127.0.0.1/preview' } },
      release(url) { globalThis.__ve.released.push(url) }
    }
  `
}
const ipcStubs = {
  '../settings': `export async function getSettings() { return { cwd: 'C:/project' } }`,
  '../video-export': `
    export class VideoExportError extends Error {
      constructor(code, message) { super(message); this.code = code }
    }
    export async function exportVideo(input) {
      globalThis.__ve.inputs.push(input)
      return new Promise((resolve, reject) => {
        const finish = () => reject(new VideoExportError('cancelled', '导出已取消'))
        if (globalThis.__ve.finishNow) return resolve({ path: 'C:/project/a.mp4', frames: 1, fps: 30, width: 2, height: 2, duration: 1, bytes: 1, elapsedMs: 1 })
        if (input.signal.aborted) return finish()
        input.signal.addEventListener('abort', finish, { once: true })
      })
    }
  `
}
const makePlugin = (stubs) => ({
  name: 'fixtures',
  setup(api) {
    api.onResolve({ filter: /.*/ }, (args) => (Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'fixture' } : undefined))
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: stubs[args.path], loader: 'js', resolveDir: process.cwd() }))
  }
})

const dir = await mkdtemp(join(tmpdir(), 'inkstone-video-export-cancel-'))
const previousFfmpeg = process.env.YAN_FFMPEG
try {
  globalThis.__ve = { windows: [], children: [], writes: 0, kills: [], released: [], inputs: [], finishNow: false, backpressure: true, order: [], renames: [], unlinks: [], stats: 0, prepares: 0 }
  process.env.YAN_FFMPEG = process.execPath
  const exportOut = join(dir, 'video-export.mjs')
  await build({ entryPoints: ['src/main/video-export.ts'], outfile: exportOut, bundle: true, platform: 'node', format: 'esm', plugins: [makePlugin(exportStubs)], logLevel: 'silent' })
  const { exportVideo } = await import(pathToFileURL(exportOut).href)

  const controller = new AbortController()
  const running = exportVideo({ htmlPath: join(dir, 'a.html'), root: dir, outPath: join(dir, 'out.mp4'), signal: controller.signal })
  const settled = running.then((value) => ({ value }), (error) => ({ error }))
  ok(await wait(() => globalThis.__ve.writes > 0), '导出进入写帧阶段，FFmpeg 的 stdin 背压让写入停在等待 drain')
  const startedAt = Date.now()
  controller.abort()
  const outcome = await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 2000))])
  ok(!outcome.timeout, 'abort 后导出立刻结束，不再等 drain 或 FFmpeg 退出', Date.now() - startedAt)
  ok(outcome.error?.code === 'cancelled', 'abort 后以 cancelled 结束', outcome.error?.code)
  ok(globalThis.__ve.kills.length >= 1, 'abort 后结束 FFmpeg 子进程', globalThis.__ve.kills)
  ok(globalThis.__ve.windows.every((win) => win.destroyed), 'abort 后销毁隐藏页面')
  ok(globalThis.__ve.released.length === 1, 'abort 后释放预览页', globalThis.__ve.released)

  ok(globalThis.__ve.order.indexOf('close') >= 0 && globalThis.__ve.order.indexOf('close') < globalThis.__ve.order.indexOf('unlink'), '清理临时文件前先等 FFmpeg close（避免 Windows 文件占用）', globalThis.__ve.order)

  {
    const ve = globalThis.__ve
    Object.assign(ve, { windows: [], children: [], kills: [], released: [], order: [], writes: 0, neverClose: true })
    const c = new AbortController()
    const run = exportVideo({ htmlPath: join(dir, 'a.html'), root: dir, outPath: join(dir, 'out.mp4'), signal: c.signal })
    const settledNever = run.then(() => 'done', (error) => error.code)
    ok(await wait(() => ve.writes > 0), '（FFmpeg 不退出场景）进入写帧阶段')
    const t0 = Date.now()
    c.abort()
    const code = await settledNever
    const took = Date.now() - t0
    ok(code === 'cancelled' && took >= 1000 && took < 4000, 'FFmpeg 迟迟不 close 时等待有上限，取消仍然完成', { code, took })
    ve.neverClose = false
  }

  {
    const ve = globalThis.__ve
    Object.assign(ve, { windows: [], children: [], released: [], prepares: 0, backpressure: false })
    let openGate
    ve.prepareGate = new Promise((resolve) => { openGate = resolve })
    const c = new AbortController()
    const run = exportVideo({ htmlPath: join(dir, 'a.html'), root: dir, outPath: join(dir, 'out.mp4'), signal: c.signal })
    const settledPrepare = run.then(() => 'done', (error) => error.code)
    ok(await wait(() => ve.prepares === 1), '导出停在 prepare 阶段')
    c.abort()
    openGate()
    ok((await settledPrepare) === 'cancelled', 'prepare 期间取消：导出以 cancelled 结束')
    ok(ve.windows.length === 0, 'prepare 期间取消后不再创建隐藏页')
    ok(ve.released.length === 1, 'prepare 期间取消后释放预览页', ve.released)
    ve.prepareGate = null
  }

  {
    const ve = globalThis.__ve
    Object.assign(ve, { windows: [], children: [], released: [], renames: [], stats: 0, order: [] })
    const done = await exportVideo({ htmlPath: join(dir, 'a.html'), root: dir, outPath: join(dir, 'out.mp4') })
    ok(done.path && ve.renames.length === 1, '对照：不取消时编码完成后提交输出', ve.renames)
    ve.renames.length = 0
    const c = new AbortController()
    ve.onStat = () => c.abort()
    const outcome = await exportVideo({ htmlPath: join(dir, 'a.html'), root: dir, outPath: join(dir, 'out.mp4'), signal: c.signal }).then(() => ({ ok: true }), (error) => ({ code: error.code }))
    ve.onStat = null
    ok(outcome.code === 'cancelled', '编码完成后、提交前取消：不返回成功', outcome)
    ok(ve.renames.length === 0, '提交前取消：不 rename 输出文件', ve.renames)
    ve.backpressure = true
  }

  const again = await exportVideo({ htmlPath: join(dir, 'a.html'), root: dir, outPath: join(dir, 'out.mp4'), signal: AbortSignal.abort() }).catch((error) => error)
  ok(again?.code === 'cancelled', '导出结束后忙标记已复位，已取消的信号直接 cancelled', again?.code)

  const ipcOut = join(dir, 'video-export-ipc.mjs')
  await build({ entryPoints: ['src/main/ipc/video-export-ipc.ts'], outfile: ipcOut, bundle: true, platform: 'node', format: 'esm', plugins: [makePlugin(ipcStubs)], logLevel: 'silent' })
  const { registerVideoExportIpc } = await import(pathToFileURL(ipcOut).href)
  const { EventEmitter } = await import('node:events')
  const handlers = new Map()
  registerVideoExportIpc(
    { rawHandle: (channel, fn) => handlers.set(channel, fn), handle: (channel, fn) => handlers.set(channel, fn) },
    { resolveFileContext: async (_settings, _cwd, raw) => ({ ok: true, context: { cwd: raw.cwd } }) }
  )
  const startChannel = [...handlers.keys()].find((name) => /start/i.test(name))
  ok(Boolean(startChannel), '注册了导出入口', [...handlers.keys()])
  const makeEvent = () => {
    const sender = Object.assign(new EventEmitter(), { destroyed: false, isDestroyed() { return this.destroyed }, send() {} })
    return { sender }
  }

  globalThis.__ve.inputs.length = 0
  const first = makeEvent()
  const pending = handlers.get(startChannel)(first, { id: 'job-1', path: 'C:/project/a.html' })
  await wait(() => globalThis.__ve.inputs.length === 1)
  ok(first.sender.listenerCount('destroyed') === 1, '导出期间监听发起窗口的 destroyed')
  first.sender.destroyed = true
  first.sender.emit('destroyed')
  ok(globalThis.__ve.inputs[0].signal.aborted === true, '发起窗口销毁时 abort 导出任务')
  const aborted = await pending
  ok(aborted.ok === false && aborted.error === 'cancelled', '销毁后返回 cancelled 结果', aborted)

  globalThis.__ve.inputs.length = 0
  globalThis.__ve.finishNow = true
  const second = makeEvent()
  const done = await handlers.get(startChannel)(second, { id: 'job-2', path: 'C:/project/a.html' })
  ok(done.ok === true, '正常完成不受影响')
  ok(second.sender.listenerCount('destroyed') === 0, '完成后摘掉 destroyed 监听，不累积')
  ok(globalThis.__ve.inputs[0].signal.aborted === false, '窗口存活时不会误取消')

  globalThis.__ve.inputs.length = 0
  globalThis.__ve.finishNow = false
  const gone = makeEvent()
  gone.sender.destroyed = true
  const early = await handlers.get(startChannel)(gone, { id: 'job-3', path: 'C:/project/a.html' })
  ok(early.ok === false && early.error === 'cancelled', '发起窗口在开始前已销毁则直接取消', early)
} finally {
  if (previousFfmpeg === undefined) delete process.env.YAN_FFMPEG
  else process.env.YAN_FFMPEG = previousFfmpeg
  delete globalThis.__ve
  await rm(dir, { recursive: true, force: true })
}
console.log(`video-export cancel: ${checks} checks passed`)
