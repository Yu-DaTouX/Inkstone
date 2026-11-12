import { realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CapabilityCommandError } from '../capability-server'
import type { CapabilityRunOptions } from '../agent'

type ExportResult = { data?: unknown; summary: Record<string, unknown> }

async function realPathWithin(root: string, target: string): Promise<boolean> {
  const rootReal = await realpath(root).catch(() => resolve(root))
  let probe = target
  let tail = ''
  for (;;) {
    try {
      const rel = relative(rootReal, join(await realpath(probe), tail))
      return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    } catch {
      const parent = dirname(probe)
      if (parent === probe) return false
      tail = join(basename(probe), tail)
      probe = parent
    }
  }
}

export async function runArtifactExportVideoCommand(
  cwd: string,
  exporter: CapabilityRunOptions['exportVideo'],
  params: Record<string, unknown>
): Promise<ExportResult> {
  const raw = typeof params.path === 'string' ? params.path.trim() : ''
  if (!raw) throw new CapabilityCommandError('artifact_path_missing', 'artifact.exportVideo 需要 path')
  if (!/\.html?$/i.test(raw)) throw new CapabilityCommandError('artifact_export_type', 'artifact.exportVideo 只支持 .html / .htm 文件')
  if (!exporter) throw new CapabilityCommandError('artifact_export_unavailable', '当前环境不能导出视频')
  const fps = params.fps === undefined || params.fps === true ? undefined : Number(params.fps)
  if (fps !== undefined && (!Number.isFinite(fps) || fps <= 0)) throw new CapabilityCommandError('artifact_export_fps', '--fps 需要大于 0 的数字')
  const scale = params.scale === undefined || params.scale === true ? undefined : Number(params.scale)
  if (scale !== undefined && (!Number.isFinite(scale) || scale <= 0)) throw new CapabilityCommandError('artifact_export_scale', '--scale 需要大于 0 的数字')
  const outRaw = typeof params.out === 'string' ? params.out.trim() : typeof params.outPath === 'string' ? params.outPath.trim() : ''
  const htmlPath = isAbsolute(raw) ? raw : resolve(cwd, raw)
  const outResolved = outRaw ? (isAbsolute(outRaw) ? resolve(outRaw) : resolve(cwd, outRaw)) : undefined
  const outPath = outResolved && extname(outResolved).toLowerCase() !== '.mp4' ? `${outResolved}.mp4` : outResolved
  if (outPath && !(await realPathWithin(cwd, outPath))) {
    throw new CapabilityCommandError('artifact_export_out', '--out 只能写到当前项目目录里')
  }
  try {
    const result = (await exporter(htmlPath, cwd, {
      ...(fps !== undefined ? { fps } : {}),
      ...(scale !== undefined ? { scale } : {}),
      ...(outPath ? { outPath } : {})
    })) as {
      path: string
      frames: number
      fps: number
      width: number
      height: number
      duration: number
      bytes: number
      elapsedMs: number
      consoleErrors?: string[]
    }
    return {
      data: result,
      summary: {
        path: result.path,
        frames: result.frames,
        fps: result.fps,
        size: `${result.width}x${result.height}`,
        durationSeconds: result.duration,
        bytes: result.bytes,
        elapsedMs: result.elapsedMs,
        ...(result.consoleErrors?.length ? { consoleErrors: result.consoleErrors.length } : {}),
        note: 'MP4 只包含画面：合成里的 <audio>/<video> 本次不混音；输出是 H.264（yuv420p，CRF 18），可直接在系统播放器里打开。'
      }
    }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'ffmpeg-missing') throw new CapabilityCommandError('artifact_export_ffmpeg_missing', message)
    if (code === 'export-busy') throw new CapabilityCommandError('artifact_export_busy', message)
    if (code === 'no-timeline') throw new CapabilityCommandError('artifact_export_no_timeline', message)
    if (code === 'too-long') throw new CapabilityCommandError('artifact_export_too_long', message)
    if (code === 'bad-request') throw new CapabilityCommandError('artifact_path_outside', message)
    if (code === 'cancelled') throw new CapabilityCommandError('artifact_export_cancelled', message)
    throw new CapabilityCommandError('artifact_export_failed', `导出失败：${message}`)
  }
}

export async function runArtifactExportImageCommand(
  cwd: string,
  exporter: CapabilityRunOptions['exportImage'],
  params: Record<string, unknown>
): Promise<ExportResult> {
  const raw = typeof params.path === 'string' ? params.path.trim() : ''
  if (!raw) throw new CapabilityCommandError('artifact_path_missing', 'artifact.exportImage 需要 path')
  if (!/\.html?$/i.test(raw)) throw new CapabilityCommandError('artifact_export_type', 'artifact.exportImage 只支持 .html / .htm 文件')
  if (!exporter) throw new CapabilityCommandError('artifact_export_unavailable', '当前环境不能导出图片')
  const number = (key: string, flag: string): number | undefined => {
    const value = params[key]
    if (value === undefined || value === true) return undefined
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) throw new CapabilityCommandError('artifact_export_size', `--${flag} 需要大于 0 的数字`)
    return parsed
  }
  const width = number('width', 'width')
  const height = number('height', 'height')
  const scale = number('scale', 'scale')
  const selector = typeof params.selector === 'string' && params.selector.trim() ? params.selector.trim() : undefined
  const outRaw = typeof params.out === 'string' ? params.out.trim() : typeof params.outPath === 'string' ? params.outPath.trim() : ''
  const htmlPath = isAbsolute(raw) ? raw : resolve(cwd, raw)
  const outResolved = outRaw ? (isAbsolute(outRaw) ? resolve(outRaw) : resolve(cwd, outRaw)) : undefined
  const outPath = outResolved && extname(outResolved).toLowerCase() !== '.png' ? `${outResolved}.png` : outResolved
  if (outPath && !(await realPathWithin(cwd, outPath))) {
    throw new CapabilityCommandError('artifact_export_out', '--out 只能写到当前项目目录里')
  }
  try {
    const result = (await exporter(htmlPath, cwd, {
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(scale !== undefined ? { scale } : {}),
      ...(selector ? { selector } : {}),
      ...(outPath ? { outPath } : {})
    })) as { path: string; width: number; height: number; scale: number; pixelWidth: number; pixelHeight: number; target: string; bytes: number; consoleErrors?: string[] }
    return {
      data: result,
      summary: {
        path: result.path,
        size: `${result.width}x${result.height}`,
        pixels: `${result.pixelWidth}x${result.pixelHeight}`,
        target: result.target,
        bytes: result.bytes,
        ...(result.consoleErrors?.length ? { consoleErrors: result.consoleErrors.length } : {}),
        note: result.target === 'poster' ? '自动识别为页面中央的单个画面并只截它；要整页或指定区域用 --width / --selector。' : result.target === 'page' ? '截的是整页。' : '截的是 --selector 指定的元素。'
      }
    }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'export-busy') throw new CapabilityCommandError('artifact_export_busy', message)
    if (code === 'bad-request') throw new CapabilityCommandError('artifact_path_outside', message)
    if (code === 'selector-missing') throw new CapabilityCommandError('artifact_export_selector', message)
    throw new CapabilityCommandError('artifact_export_failed', `导出失败：${message}`)
  }
}
