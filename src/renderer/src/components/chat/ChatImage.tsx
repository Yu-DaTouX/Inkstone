import { useStore } from '../../state/store'
import { useT } from '../../i18n'
import { classifyLink } from '../../../../shared/links'

/**
 * 对话里的图片（用户贴的、工具截的、模型在回复里引用的）统一走这里：
 *   · 懒加载 + 异步解码：长会话里几十张大图不在打开时一起解码；
 *   · 点击 → 右栏文件预览（与产物卡片的图同一个入口，可放大、另存、系统打开）。
 *
 * 只有落盘文件（`file://` 或本地路径）能点开预览；内联 base64（流式中还没落盘的）
 * 与网络图片只显示，网络图片点击交给内部浏览器。
 */
export function ChatImage({
  src,
  alt,
  sourceCwd,
  className
}: {
  src: string
  alt?: string
  sourceCwd?: string
  className?: string
}) {
  const t = useT()
  const previewFile = useStore((s) => s.previewFile)
  const openBrowser = useStore((s) => s.openBrowser)
  const target = src.startsWith('data:') ? null : classifyLink(src)
  const open =
    target?.kind === 'file'
      ? () => void previewFile(target.path, undefined, sourceCwd)
      : target?.kind === 'url'
        ? () => void openBrowser(target.url)
        : undefined
  return (
    <img
      src={src}
      alt={alt || (open ? t('chat.imageOpen') : '')}
      className={[className, open ? 'chat-image-open' : ''].filter(Boolean).join(' ') || undefined}
      loading="lazy"
      decoding="async"
      title={open ? t('chat.imageOpen') : undefined}
      onClick={open}
      role={open ? 'button' : undefined}
      tabIndex={open ? 0 : undefined}
      onKeyDown={
        open
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                open()
              }
            }
          : undefined
      }
    />
  )
}
