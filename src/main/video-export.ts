import { BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { rename, stat, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { htmlArtifactPreviews } from './html-artifact-preview'
import { delay } from '../shared/delay'
import { VIDEO_COMPOSITION_PROBE, normalizeVideoComposition, videoSeekScript, type VideoCompositionInfo } from './video-composition'

export const VIDEO_EXPORT_DEFAULT_FPS = 30
export const VIDEO_EXPORT_MAX_FPS = 60
export const VIDEO_EXPORT_MIN_SCALE = 0.25
export const VIDEO_EXPORT_MAX_WIDTH = 3840
export const VIDEO_EXPORT_MAX_HEIGHT = 2160
export const VIDEO_EXPORT_MAX_DURATION = 600
export const VIDEO_EXPORT_MAX_FRAMES = 30 * 600
export const VIDEO_EXPORT_TIMELINE_TIMEOUT_MS = 10_000
export const VIDEO_EXPORT_CRF = 18
export const VIDEO_EXPORT_INSTALL_HINT =
  'winget install Gyan.FFmpeg（或用环境变量 YAN_FFMPEG 指定 ffmpeg 可执行文件）'

const LOAD_TIMEOUT_MS = 30_000
const STEP_TIMEOUT_MS = 20_000
const SETTLE_MS = 200
const TIMELINE_POLL_MS = 100
const CONSOLE_ERROR_LIMIT = 10

export type VideoExportErrorCode =
  | 'export-busy'
  | 'bad-request'
  | 'ffmpeg-missing'
  | 'load-failed'
  | 'no-timeline'
  | 'too-long'
  | 'capture-failed'
  | 'encode-failed'
  | 'output-failed'
  | 'cancelled'

export class VideoExportError extends Error {
  readonly code: VideoExportErrorCode

  constructor(code: VideoExportErrorCode, message: string) {
    super(message)
    this.name = 'VideoExportError'
    this.code = code
  }
}

export interface VideoExportInput {
  htmlPath: string
  root: string
  outPath?: string
  fps?: number
  scale?: number
  signal?: AbortSignal
  onProgress?: (progress: { frame: number; total: number }) => void
}

export interface VideoExportOutput {
  path: string
  frames: number
  fps: number
  width: number
  height: number
  duration: number
  bytes: number
  elapsedMs: number
  ffmpeg: string
  consoleErrors: string[]
}

export interface VideoExportPixelSize {
  width: number
  height: number
  scale: number
  zoom: number
}

export type FfmpegFinder = (candidate: string) => boolean

async function within<T>(work: Promise<T>, code: VideoExportErrorCode, label: string, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new VideoExportError(code, `${label}_timeout`)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function normalizeExportFps(value: unknown): number {
  const fps = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(fps) || fps <= 0) return VIDEO_EXPORT_DEFAULT_FPS
  return Math.min(VIDEO_EXPORT_MAX_FPS, Math.max(1, Math.round(fps)))
}

export function exportFrameCount(duration: number, fps: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  if (!Number.isFinite(fps) || fps <= 0) return 0
  return Math.max(1, Math.ceil(Number((duration * fps).toFixed(6))))
}

export function exportWithinLimits(frames: number, fps: number): boolean {
  if (!Number.isFinite(frames) || frames <= 0) return false
  if (!Number.isFinite(fps) || fps <= 0) return false
  return frames <= VIDEO_EXPORT_MAX_FRAMES && frames / fps <= VIDEO_EXPORT_MAX_DURATION
}

function evenPixels(value: number): number {
  const rounded = Math.max(2, Math.round(value))
  return rounded % 2 === 0 ? rounded : rounded + 1
}

export function exportPixelSize(width: number, height: number, scale = 1): VideoExportPixelSize {
  const sourceWidth = Number.isFinite(width) && width > 0 ? width : 1920
  const sourceHeight = Number.isFinite(height) && height > 0 ? height : 1080
  const requested = Number.isFinite(scale) && scale > 0 ? scale : 1
  const cap = Math.min(1, VIDEO_EXPORT_MAX_WIDTH / sourceWidth, VIDEO_EXPORT_MAX_HEIGHT / sourceHeight)
  const effective = Math.max(Math.min(requested, cap), Math.min(VIDEO_EXPORT_MIN_SCALE, cap))
  const outWidth = evenPixels(sourceWidth * effective)
  const outHeight = evenPixels(sourceHeight * effective)
  return { width: outWidth, height: outHeight, scale: outWidth / sourceWidth, zoom: outWidth / sourceWidth }
}

export function ffmpegEncodeArgs(input: { fps: number; outPath: string; crf?: number }): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-f',
    'image2pipe',
    '-framerate',
    String(input.fps),
    '-i',
    '-',
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    String(input.crf ?? VIDEO_EXPORT_CRF),
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    input.outPath
  ]
}

export function findFfmpeg(
  options: {
    env?: NodeJS.ProcessEnv
    pathValue?: string
    platform?: NodeJS.Platform
    exists?: FfmpegFinder
  } = {}
): string | null {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync
  const override = (env.YAN_FFMPEG ?? '').trim()
  if (override && exists(override)) return override
  const separator = platform === 'win32' ? ';' : ':'
  const pathValue = options.pathValue ?? env.PATH ?? env.Path ?? ''
  const names = platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg']
  for (const entry of pathValue.split(separator)) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1')
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

export function ffmpegMissingMessage(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.YAN_FFMPEG ?? '').trim()
  if (override) return `没有找到 FFmpeg：YAN_FFMPEG 指向的路径（${override}）不存在，装好后重试：${VIDEO_EXPORT_INSTALL_HINT}`
  return `没有找到 FFmpeg：把它放进 PATH 或设置 YAN_FFMPEG；安装：${VIDEO_EXPORT_INSTALL_HINT}`
}

export function uniqueVideoPath(target: string, taken: (path: string) => boolean): string {
  if (!taken(target)) return target
  const dir = dirname(target)
  const name = basename(target)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : '.mp4'
  for (let index = 2; index < 1000; index++) {
    const candidate = join(dir, `${stem}-${index}${extension}`)
    if (!taken(candidate)) return candidate
  }
  return join(dir, `${stem}-${Date.now().toString(36)}${extension}`)
}

export function defaultVideoPath(htmlPath: string, taken: (path: string) => boolean): string {
  const stem = basename(htmlPath).replace(/\.[^.]+$/, '') || 'video'
  return uniqueVideoPath(join(dirname(htmlPath), `${stem}.mp4`), taken)
}

async function readComposition(win: BrowserWindow): Promise<VideoCompositionInfo | null> {
  const value = await within(
    win.webContents.executeJavaScript(VIDEO_COMPOSITION_PROBE, true),
    'capture-failed',
    'probe',
    STEP_TIMEOUT_MS
  )
  return normalizeVideoComposition(value)
}

async function waitForComposition(win: BrowserWindow): Promise<VideoCompositionInfo> {
  const deadline = Date.now() + VIDEO_EXPORT_TIMELINE_TIMEOUT_MS
  let info = await readComposition(win)
  if (!info) throw new VideoExportError('no-timeline', '这个 HTML 里没有带 data-composition-id 的合成根元素')
  while (!info.ready && Date.now() < deadline) {
    await delay(TIMELINE_POLL_MS)
    info = await readComposition(win)
    if (!info) throw new VideoExportError('no-timeline', '等待控制器时合成根元素不见了')
  }
  if (!info.ready) {
    throw new VideoExportError(
      'no-timeline',
      `等了 ${VIDEO_EXPORT_TIMELINE_TIMEOUT_MS / 1000} 秒没等到 window.__timelines[${JSON.stringify(info.id)}] 的控制器（需要有 seek）`
    )
  }
  if (!info.width || !info.height) throw new VideoExportError('no-timeline', '合成根元素缺少 data-width / data-height')
  if (!info.duration) throw new VideoExportError('no-timeline', '拿不到合成时长：控制器没有 duration()，根元素也没有 data-duration')
  return info
}

let busy = false

export async function exportVideo(input: VideoExportInput): Promise<VideoExportOutput> {
  if (busy) throw new VideoExportError('export-busy', '已经有一个视频在导出，等它结束再试')
  busy = true
  try {
    return await runVideoExport(input)
  } finally {
    busy = false
  }
}

async function runVideoExport(input: VideoExportInput): Promise<VideoExportOutput> {
  const startedAt = Date.now()
  const throwIfCancelled = (): void => {
    if (input.signal?.aborted) throw new VideoExportError('cancelled', '导出已取消')
  }
  throwIfCancelled()
  const fps = normalizeExportFps(input.fps)
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) throw new VideoExportError('ffmpeg-missing', ffmpegMissingMessage())
  const target = input.outPath
    ? uniqueVideoPath(input.outPath, existsSync)
    : defaultVideoPath(input.htmlPath, existsSync)

  const prepared = await htmlArtifactPreviews.prepare(input.htmlPath, input.root)
  if (!prepared.ok) {
    if (prepared.error === 'outside') throw new VideoExportError('bad-request', 'HTML 文件必须在当前项目目录内')
    if (prepared.error === 'type') throw new VideoExportError('bad-request', '只支持 .html / .htm 文件')
    if (prepared.error === 'size') throw new VideoExportError('bad-request', 'HTML 文件为空或超过 5MB')
    if (prepared.error === 'busy') throw new VideoExportError('export-busy', '同时渲染的预览太多，等它们结束再试')
    throw new VideoExportError('load-failed', '读不了这个 HTML 文件')
  }
  const url = prepared.url
  const tempPath = join(dirname(target), `.yan-export-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.mp4`)

  const win = new BrowserWindow({
    show: false,
    width: 640,
    height: 360,
    useContentSize: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: true
    }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  const consoleErrors: string[] = []
  win.webContents.on('console-message', (details) => {
    const level = (details as unknown as { level?: string | number }).level
    if ((level === 'error' || level === 3) && consoleErrors.length < CONSOLE_ERROR_LIMIT) {
      consoleErrors.push(String((details as unknown as { message?: string })?.message ?? '').slice(0, 200))
    }
  })

  let child: ReturnType<typeof spawn> | null = null
  const killChild = (): void => {
    if (!child) return
    try {
      child.kill('SIGKILL')
    } catch {
      child = null
    }
  }
  const onAbort = (): void => killChild()
  input.signal?.addEventListener('abort', onAbort)

  try {
    await within(win.loadURL(url), 'load-failed', 'load', LOAD_TIMEOUT_MS)
    throwIfCancelled()
    await within(
      win.webContents.executeJavaScript('(document.fonts ? document.fonts.ready.then(() => true) : Promise.resolve(true))', true),
      'capture-failed',
      'fonts',
      STEP_TIMEOUT_MS
    ).catch(() => true)
    const composition = await waitForComposition(win)
    throwIfCancelled()
    const frames = exportFrameCount(composition.duration, fps)
    if (!exportWithinLimits(frames, fps)) {
      throw new VideoExportError(
        'too-long',
        `合成太长：${composition.duration} 秒 / ${frames} 帧，上限 ${VIDEO_EXPORT_MAX_DURATION} 秒、${VIDEO_EXPORT_MAX_FRAMES} 帧`
      )
    }
    const size = exportPixelSize(composition.width, composition.height, input.scale ?? 1)
    win.setContentSize(size.width, size.height)
    win.webContents.enableDeviceEmulation({
      screenPosition: 'desktop',
      screenSize: { width: size.width, height: size.height },
      viewPosition: { x: 0, y: 0 },
      viewSize: { width: size.width, height: size.height },
      deviceScaleFactor: 1,
      scale: 1
    })
    win.webContents.setZoomFactor(size.zoom)
    await delay(SETTLE_MS)
    throwIfCancelled()

    child = spawn(ffmpeg, ffmpegEncodeArgs({ fps, outPath: tempPath }), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    const stdin = child.stdin
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000)
    })
    stdin?.on('error', () => undefined)
    const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
      child?.once('error', (error: Error) => resolve({ code: null, error }))
      child?.once('close', (code: number | null) => resolve({ code }))
    })

    const writeFrame = (png: Buffer): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        if (!stdin || stdin.destroyed || !stdin.writable) {
          const tail = stderr.trim().split('\n').slice(-1)[0]
          reject(new VideoExportError('encode-failed', `FFmpeg 提前退出${tail ? `：${tail}` : ''}`))
          return
        }
        const failed = (error: Error): void => reject(new VideoExportError('encode-failed', `写入 FFmpeg 失败：${error.message}`))
        stdin.once('error', failed)
        const flushed = (): void => {
          stdin.removeListener('error', failed)
          resolve()
        }
        if (stdin.write(png)) flushed()
        else stdin.once('drain', flushed)
      })

    input.onProgress?.({ frame: 0, total: frames })
    for (let index = 0; index < frames; index++) {
      throwIfCancelled()
      await within(
        win.webContents.executeJavaScript(videoSeekScript(composition.id, index / fps), true),
        'capture-failed',
        'seek',
        STEP_TIMEOUT_MS
      )
      const image = await within(
        win.webContents.capturePage({ x: 0, y: 0, width: size.width, height: size.height }),
        'capture-failed',
        'capture',
        STEP_TIMEOUT_MS
      )
      if (!image || image.isEmpty()) throw new VideoExportError('capture-failed', `第 ${index + 1} 帧截图为空`)
      const actual = image.getSize()
      const png =
        actual.width === size.width && actual.height === size.height
          ? image.toPNG()
          : image.resize({ width: size.width, height: size.height, quality: 'best' }).toPNG()
      if (!png.length) throw new VideoExportError('capture-failed', `第 ${index + 1} 帧截图为空`)
      await writeFrame(png)
      input.onProgress?.({ frame: index + 1, total: frames })
    }
    throwIfCancelled()
    stdin?.end()
    const exit = await exited
    if (exit.error) throw new VideoExportError('encode-failed', `FFmpeg 启动失败：${exit.error.message}`)
    if (exit.code !== 0) {
      const tail = stderr.trim().split('\n').slice(-2).join(' ')
      throw new VideoExportError('encode-failed', `FFmpeg 编码失败（退出码 ${exit.code ?? 'unknown'}）${tail ? `：${tail}` : ''}`)
    }
    child = null
    const written = await stat(tempPath).catch(() => null)
    if (!written || written.size <= 0) throw new VideoExportError('output-failed', 'FFmpeg 没有写出文件')
    const finalPath = uniqueVideoPath(target, existsSync)
    await rename(tempPath, finalPath)
    const bytes = (await stat(finalPath).catch(() => null))?.size ?? written.size
    return {
      path: finalPath,
      frames,
      fps,
      width: size.width,
      height: size.height,
      duration: composition.duration,
      bytes,
      elapsedMs: Date.now() - startedAt,
      ffmpeg,
      consoleErrors
    }
  } catch (error) {
    if (input.signal?.aborted && !(error instanceof VideoExportError && error.code === 'cancelled')) {
      throw new VideoExportError('cancelled', '导出已取消')
    }
    throw error
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
    killChild()
    htmlArtifactPreviews.release(url)
    if (!win.isDestroyed()) win.destroy()
    await unlink(tempPath).catch(() => undefined)
  }
}
