import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Icon } from '../../icons/Icon'
import { ICON_NAMES, type IconName } from '../../icons/sprite'
import type { VisualSource } from '../../../../shared/visual-blocks'

/** 结构化回答块共用的小件：链接打开方式、来源标签、图标名校验。 */

/** 单击在内置浏览器打开，双击交给系统浏览器（与消息里的普通链接一致） */
export function useOpenLink(): { open: (url: string) => (e: React.MouseEvent) => void; external: (url: string) => (e: React.MouseEvent) => void } {
  const openBrowser = useStore((s) => s.openBrowser)
  return {
    open: (url) => (e) => { e.preventDefault(); e.stopPropagation(); void openBrowser(url) },
    external: (url) => (e) => { e.preventDefault(); e.stopPropagation(); void window.yan.browser.openExternal(url) }
  }
}

const hostOf = (url: string): string => {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

export function VisualSources({ items }: { items?: VisualSource[] }) {
  const t = useT()
  const link = useOpenLink()
  if (!items?.length) return null
  return (
    <div className="vb-sources" aria-label={t('vb.sources')}>
      {items.map((s, i) => (
        <a key={i} className="vb-source" href={s.url} title={`${s.url}\n${t('link.dblclickHint')}`} onClick={link.open(s.url)} onDoubleClick={link.external(s.url)}>
          <span className="vb-source-host">{hostOf(s.url)}</span>
          {s.label ? <span className="vb-source-label">{s.label}</span> : null}
        </a>
      ))}
    </div>
  )
}

const isIcon = (name?: string): name is IconName => !!name && (ICON_NAMES as readonly string[]).includes(name)

/** 只认砚的图标名；不认识的名字直接不画（不报错，也不用占位） */
export function BlockIcon({ name, size = 16, className }: { name?: string; size?: 12 | 14 | 16; className?: string }) {
  return isIcon(name) ? <Icon name={name} size={size} className={className} /> : null
}
