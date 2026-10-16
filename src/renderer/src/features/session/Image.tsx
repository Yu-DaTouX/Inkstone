/**
 * 消息里的图片（用户贴的、模型回复里引用的）。
 *
 * 与 v2 的 ChatImage 行为一致但不复用 v2 组件（CONTRACT：不引入 v2 控件）：
 * 只有落盘文件（`file://` / 本地路径）能点开右栏预览，内联 base64 与网络图片
 * 只显示；网络图片点击交给内部浏览器。
 */
import type { JSX } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { classifyLink } from '../../../../shared/links'

export function MessageImage({
  src,
  alt,
  sourceCwd,
  className
}: {
  src: string
  alt?: string
  sourceCwd?: string
  className?: string
}): JSX.Element {
  const t = useT()
  const previewFile = useStore((s) => s.previewFile)
  const openBrowser = useStore((s) => s.openBrowser)
  const target = src.startsWith('data:') ? null : classifyLink(src)
  const open =
    target?.kind === 'file'
      ? (): void => void previewFile(target.path, undefined, sourceCwd)
      : target?.kind === 'url'
        ? (): void => void openBrowser(target.url)
        : undefined
  return (
    <img
      src={src}
      alt={alt || (open ? t('chat.imageOpen') : '')}
      className={[className, open ? 'v3-img-open' : ''].filter(Boolean).join(' ') || undefined}
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
