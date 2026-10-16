/**
 * v3 成果框架自有的少量文案（WP-32 宿主形态）。
 *
 * ⚠️ 为什么不放两份 i18n：任务边界禁止修改 `i18n/`（并发代理也在用）。
 * 这里只收「形态切换」相关的短句；迁移完成后应并入正式 i18n 并删除本文件。
 * 已有的 `artifact.htmlReload` / `artifact.htmlCollapse` 等仍走正式 i18n。
 */
import { useI18n } from '../../i18n'

export type ArtifactTextKey =
  /** 内联溢出 / 工具条：展开全屏 */
  | 'fullscreen'
  /** 工具条：进入画中画 */
  | 'pip'
  /** 全屏头部：退出全屏并归还焦点 */
  | 'exitFullscreen'
  /** 画中画头部：关闭并使用户回到会话 */
  | 'exitPip'
  /** 画中画头部：拖动移动 */
  | 'dragHint'
  /** 画中画角落：拖动缩放 */
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
