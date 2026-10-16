import { useI18n } from '../../i18n'

export type ArtifactTextKey =
  | 'fullscreen'
  | 'pip'
  | 'exitFullscreen'
  | 'exitPip'
  | 'dragHint'
  | 'resizeHint'

const ZH: Record<ArtifactTextKey, string> = {
  fullscreen: '展开全屏',
  pip: '画中画',
  exitFullscreen: '退出全屏（Esc）',
  exitPip: '关闭画中画',
  dragHint: '拖动移动',
  resizeHint: '拖动缩放'
}

const EN: Record<ArtifactTextKey, string> = {
  fullscreen: 'Fullscreen',
  pip: 'Picture-in-picture',
  exitFullscreen: 'Exit fullscreen (Esc)',
  exitPip: 'Close picture-in-picture',
  dragHint: 'Drag to move',
  resizeHint: 'Drag to resize'
}

export function artifactText(lang: string, key: ArtifactTextKey): string {
  return (lang === 'en-US' ? EN : ZH)[key]
}

export function useArtifactText(): (key: ArtifactTextKey) => string {
  const { lang } = useI18n()
  return (key) => artifactText(lang, key)
}
