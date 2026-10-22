import type { Lang } from '../../../i18n'

export interface CanvasTimelineText {
  lang: Lang
  tool: string
  panelTitle: string
  play: string
  pause: string
  prevFrame: string
  nextFrame: string
  start: string
  end: string
  scrub: string
  tracks: string
  trackLabel: (index: number) => string
  clipHint: (label: string, start: string, end: string) => string
  clipCount: (count: number) => string
  fallback: string
  frameName: (width: number, height: number) => string
  keys: string
  exportVideo: string
  exportHint: string
  exporting: (frame: number, total: number) => string
  exportReady: (name: string) => string
  exportCancel: string
  exportOpen: string
  exportReveal: string
  exportDismiss: string
  exportFailed: (detail: string) => string
  exportFfmpegMissing: string
}

const ZH: CanvasTimelineText = {
  lang: 'zh-CN',
  tool: '时间轴',
  panelTitle: '视频时间轴',
  play: '播放（空格）',
  pause: '暂停（空格）',
  prevFrame: '上一帧（←）',
  nextFrame: '下一帧（→）',
  start: '回到开头（Home）',
  end: '跳到结尾（End）',
  scrub: '播放进度',
  tracks: '片段轨道',
  trackLabel: (index) => `轨道 ${index}`,
  clipHint: (label, start, end) => `${label}\n${start} → ${end}（点击跳到片段开头）`,
  clipCount: (count) => `${count} 个片段`,
  fallback: '页面没有 __timelines 控制器，改用页面动画的播放与定位。',
  frameName: (width, height) => `视频 ${width}×${height}`,
  keys: '空格 播放/暂停 · ←/→ 逐帧 · Shift+←/→ 1 秒 · Home/End 首尾',
  exportVideo: '导出 MP4',
  exportHint: '逐帧录成 MP4，只录画面、不混音（合成里的 <audio>/<video> 不参与）',
  exporting: (frame, total) => `导出中 ${frame}/${total} 帧`,
  exportReady: (name) => `已导出 ${name}`,
  exportCancel: '取消导出',
  exportOpen: '打开文件',
  exportReveal: '在文件夹中显示',
  exportDismiss: '关闭',
  exportFailed: (detail) => `导出失败：${detail}`,
  exportFfmpegMissing: '没有找到 FFmpeg，先装好再试：winget install Gyan.FFmpeg'
}

const EN: CanvasTimelineText = {
  lang: 'en-US',
  tool: 'Timeline',
  panelTitle: 'Video timeline',
  play: 'Play (Space)',
  pause: 'Pause (Space)',
  prevFrame: 'Previous frame (←)',
  nextFrame: 'Next frame (→)',
  start: 'Back to start (Home)',
  end: 'Jump to end (End)',
  scrub: 'Playback position',
  tracks: 'Clip tracks',
  trackLabel: (index) => `Track ${index}`,
  clipHint: (label, start, end) => `${label}\n${start} → ${end} (click to jump to the clip start)`,
  clipCount: (count) => (count === 1 ? '1 clip' : `${count} clips`),
  fallback: 'This page has no __timelines controller; page animations are used for playback and seeking.',
  frameName: (width, height) => `Video ${width}×${height}`,
  keys: 'Space play/pause · ←/→ frame · Shift+←/→ 1s · Home/End start/end',
  exportVideo: 'Export MP4',
  exportHint: 'Rendered frame by frame into MP4; picture only, <audio>/<video> in the composition are not mixed in',
  exporting: (frame, total) => `Exporting ${frame}/${total} frames`,
  exportReady: (name) => `Exported ${name}`,
  exportCancel: 'Cancel export',
  exportOpen: 'Open file',
  exportReveal: 'Show in folder',
  exportDismiss: 'Dismiss',
  exportFailed: (detail) => `Export failed: ${detail}`,
  exportFfmpegMissing: 'FFmpeg was not found. Install it first: winget install Gyan.FFmpeg'
}

export const CANVAS_TIMELINE_TEXT: Readonly<Record<Lang, CanvasTimelineText>> = {
  'zh-CN': ZH,
  'en-US': EN
}

export function timelineText(lang: Lang): CanvasTimelineText {
  return CANVAS_TIMELINE_TEXT[lang] ?? ZH
}
