import { useT } from '../../i18n'
import { splitDropZones, useSplitDrop } from '../../state/split-drop'

/**
 * 拖左栏会话时盖在每块会话磁贴上的落点（左半 / 右半）：松手把会话插到指针所在的位置。
 * 样式见 chat.css 末尾分屏段。
 */
export function SplitDropZone() {
  const t = useT()
  const dragging = useSplitDrop((s) => s.dragging)
  const over = useSplitDrop((s) => s.zone)
  if (!dragging) return null
  const zones = splitDropZones()
  if (!zones) return null
  return (
    <>
      {zones.map((z, i) => {
        const r = z.rect
        return (
          <div
            key={i}
            className={`split-drop ${i % 2 === 0 ? 'left' : 'right'}${over === i ? ' over' : ''}`}
            data-testid={`split-drop-${i}`}
            data-split-at={z.at}
            aria-hidden
            style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
          >
            {over === i ? <span className="split-drop-label">{t('split.dropHere')}</span> : null}
          </div>
        )
      })}
    </>
  )
}
