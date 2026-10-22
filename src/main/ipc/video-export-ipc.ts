import { randomUUID } from 'node:crypto'
import { getSettings } from '../settings'
import { exportVideo, VideoExportError } from '../video-export'
import {
  VIDEO_EXPORT_CANCEL_CHANNEL,
  VIDEO_EXPORT_PROGRESS_CHANNEL,
  VIDEO_EXPORT_START_CHANNEL,
  type VideoExportErrorCode,
  type VideoExportRequest,
  type VideoExportResult
} from '../../shared/ipc'
import type { FileContextResult } from './files-ipc'
import type { IpcRegistrar } from './registrar'

export interface VideoExportIpcDeps {
  resolveFileContext(
    settings: Awaited<ReturnType<typeof getSettings>>,
    fallbackCwd: string,
    rawContext: unknown
  ): Promise<FileContextResult>
}

const jobs = new Map<string, AbortController>()

function field(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

const ERROR_CODES: readonly VideoExportErrorCode[] = [
  'export-busy',
  'bad-request',
  'ffmpeg-missing',
  'load-failed',
  'no-timeline',
  'too-long',
  'capture-failed',
  'encode-failed',
  'output-failed',
  'cancelled'
]

function failure(id: string, error: VideoExportErrorCode, detail?: string): VideoExportResult {
  return { ok: false, id, error, ...(detail ? { detail } : {}) }
}

export function registerVideoExportIpc(ipc: IpcRegistrar, deps: VideoExportIpcDeps): void {
  ipc.rawHandle(VIDEO_EXPORT_START_CHANNEL, async (event, raw: unknown): Promise<VideoExportResult> => {
    if (!isRecord(raw)) return failure('', 'bad-request', '参数无效')
    const request = raw as unknown as VideoExportRequest
    const id = field(request.id) || randomUUID()
    const target = field(request.path)
    if (!target) return failure(id, 'bad-request', '缺少 HTML 路径')
    if (jobs.has(id)) return failure(id, 'export-busy', '这个导出任务已经在跑')
    const settings = await getSettings()
    const fallback = field(request.cwd) || settings.cwd
    const resolved = await deps.resolveFileContext(settings, settings.cwd, { cwd: fallback })
    if (!resolved.ok) return failure(id, 'bad-request', '项目目录无效')
    const controller = new AbortController()
    jobs.set(id, controller)
    const sender = event.sender
    try {
      const result = await exportVideo({
        htmlPath: target,
        root: resolved.context.cwd,
        fps: typeof request.fps === 'number' ? request.fps : undefined,
        scale: typeof request.scale === 'number' ? request.scale : undefined,
        signal: controller.signal,
        onProgress: (progress) => {
          if (sender.isDestroyed()) return
          sender.send(VIDEO_EXPORT_PROGRESS_CHANNEL, { id, frame: progress.frame, total: progress.total })
        }
      })
      return {
        ok: true,
        id,
        path: result.path,
        frames: result.frames,
        fps: result.fps,
        width: result.width,
        height: result.height,
        duration: result.duration,
        bytes: result.bytes,
        elapsedMs: result.elapsedMs
      }
    } catch (error) {
      const code = error instanceof VideoExportError ? error.code : 'failed'
      const detail = error instanceof Error ? error.message : String(error)
      return failure(id, ERROR_CODES.includes(code) ? code : 'failed', detail)
    } finally {
      jobs.delete(id)
    }
  })

  ipc.handle(VIDEO_EXPORT_CANCEL_CHANNEL, (raw: unknown): boolean => {
    const id = field(raw)
    const controller = id ? jobs.get(id) : undefined
    if (!controller) return false
    controller.abort()
    return true
  })
}
