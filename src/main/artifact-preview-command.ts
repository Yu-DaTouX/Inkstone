import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { formatArtifactLint, lintArtifactHtml, type ArtifactLintFinding } from './artifact-lint'
import { CapabilityCommandError } from './capability-server'
import { PREVIEW_VIDEO_OVERFLOW_SLACK_PX, parsePreviewAt, previewSampleLabel } from './video-composition'

export type PreviewHtml = (htmlPath: string, root: string, options?: { at?: number[] }) => Promise<unknown>

interface PreviewShot {
  scheme: string
  viewport: string
  path: string
  horizontalOverflow: boolean
  pageHeight?: number
  screens?: number
  truncated?: boolean
}

interface PreviewVideoSample {
  at: number
  path: string
  overflow: string[]
  seeked: boolean
}

interface PreviewVideoShots {
  compositionId: string
  width: number
  height: number
  duration: number
  timelineReady: boolean
  screenWidth: number
  screenHeight: number
  sheetPath: string
  samples: PreviewVideoSample[]
}

const LINT_NOTE = 'lint 是按 open-design 反 AI 套路规则对源码做的静态检查：[必须改] 和控制台错误同等对待，这一轮一并改掉；[建议改] 能顺手改就改。片段用来定位，确属误报时忽略。'

async function lintArtifactFile(htmlPath: string): Promise<ArtifactLintFinding[]> {
  try {
    return lintArtifactHtml(await readFile(htmlPath, 'utf8'))
  } catch {
    return []
  }
}

interface PreviewResult {
  shots: PreviewShot[]
  consoleErrors: string[]
  loadError?: string
  video?: PreviewVideoShots
}

export async function runArtifactPreview(
  previewHtml: PreviewHtml | undefined,
  rawPath: unknown,
  cwd: string,
  rawAt?: unknown
): Promise<{ data?: unknown; summary: Record<string, unknown> }> {
  const raw = typeof rawPath === 'string' ? rawPath.trim() : ''
  if (!raw) throw new CapabilityCommandError('artifact_path_missing', 'artifact.preview 需要 path')
  if (!/\.html?$/i.test(raw)) throw new CapabilityCommandError('artifact_preview_type', 'artifact.preview 只支持 .html / .htm 文件')
  if (!previewHtml) throw new CapabilityCommandError('artifact_preview_unavailable', '当前环境不能渲染预览截图')
  const at = parsePreviewAt(rawAt)
  if (at.invalid !== null) {
    throw new CapabilityCommandError('artifact_preview_at', `--at 需要逗号分隔的秒数（例如 --at 1.5,4），收到 ${at.invalid}`)
  }
  const htmlPath = isAbsolute(raw) ? raw : resolve(cwd, raw)
  try {
    const result = await previewHtml(htmlPath, cwd, at.times.length ? { at: at.times } : {}) as PreviewResult
    const lintFindings = await lintArtifactFile(htmlPath)
    const lint = formatArtifactLint(lintFindings)
    if (result.video) {
      const video = result.video
      const issues = video.samples.filter((sample) => sample.overflow.length > 0 || !sample.seeked)
      return {
        data: { ...result, lint: lintFindings },
        summary: {
          composition: `${video.compositionId}：${video.width}×${video.height}，${video.duration} 秒${video.timelineReady ? '' : '（没等到 window.__timelines 控制器，seek 可能没生效，画面可能都停在同一帧）'}`,
          sheet: `${video.sheetPath}（总览图：从左到右、从上到下按时间先后排列，每格左下角标注 t=秒；截图 ${video.screenWidth}×${video.screenHeight}，画幅 ${video.width}×${video.height}）`,
          samples: video.samples.map((sample) => `${previewSampleLabel(sample.at)}: ${sample.path}${sample.seeked ? '' : '（seek 失败）'}`),
          overflow: issues.map((sample) => `${previewSampleLabel(sample.at)}: ${sample.overflow.join('；') || 'seek 失败'}`),
          consoleErrors: result.consoleErrors.length,
          lint,
          ...(result.loadError ? { loadError: result.loadError } : {}),
          note: `这是 hyperframes 视频合成，按合成画幅逐时间点 seek 后截图：默认取每个片段（每镜）的中点加结尾帧（总时长 - 0.001 秒），拼成一张总览图；用 read 打开总览图逐格检查：不空白、不重叠、文字没被裁掉、结尾那一帧不是黑屏，overflow 里列出的元素是包围盒超出画框的可见元素（超过 ${PREVIEW_VIDEO_OVERFLOW_SLACK_PX}px），有就回去改构图。想看别的时刻用 --at 1.5,4（秒，逗号分隔）覆盖默认时间点；consoleErrors 是页面控制台错误，有一个都得修。${lint.length ? LINT_NOTE : ''}`
        }
      }
    }
    return {
      data: { ...result, lint: lintFindings },
      summary: {
        shots: result.shots.map((shot) => `${shot.scheme}-${shot.viewport}: ${shot.path}${shot.screens && shot.screens > 1 ? `（整页 ${shot.pageHeight}px，${shot.screens} 屏拼版${shot.truncated ? '，中段省略，最后一格是页尾' : ''}）` : ''}`),
        horizontalOverflow: result.shots.filter((shot) => shot.horizontalOverflow).map((shot) => `${shot.scheme}-${shot.viewport}`),
        consoleErrors: result.consoleErrors.length,
        lint,
        ...(result.loadError ? { loadError: result.loadError } : {}),
        note: '每张截图是整页按屏拼成的拼版（从左到右、从上到下依次是第 1、2… 屏，灰色间隔分屏）；用 read 打开检查桌面和窄屏下的整页内容（页面只有一套配色时浅色、深色两组截图相同）；预览与砚内沙箱一致：同一文件夹里的相对路径 css/js/图片/字体能加载，网络资源和 fetch 都会被拦截。' + (lint.length ? LINT_NOTE : '')
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'preview_outside') throw new CapabilityCommandError('artifact_path_outside', 'HTML 文件必须在当前项目目录内')
    if (message === 'preview_size') throw new CapabilityCommandError('artifact_too_large', 'HTML 文件为空或超过 5MB')
    if (message === 'preview_busy') throw new CapabilityCommandError('artifact_preview_busy', '预览数量已达上限，稍后再试')
    throw new CapabilityCommandError('artifact_preview_failed', `预览失败：${message}`)
  }
}
