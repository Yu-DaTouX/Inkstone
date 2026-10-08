import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { splitTileKey, useSplitView, type SplitSessionRef } from '../../state/split-view'

/** 拖动时一列至少留这么宽（与会话磁贴的最小宽度一致；列里带工具时浏览器还会按内容再撑住） */
const MIN_COLUMN = 340
/** 键盘每按一下挪多少 */
const KEY_STEP = 24

/**
 * 分屏两列之间的分隔条：平时是一道竖线，拖它调两边的宽度（只在这两列之间分配，其他列不动）；
 * 获得焦点后左右方向键也能调。宽度按份额记（`useSplitView.weights`），窗口变宽变窄时各列按比例跟着变。
 */
export function SplitResizer({ left, right }: { left: SplitSessionRef; right: SplitSessionRef }) {
  const t = useT()
  const weightOf = (tile: SplitSessionRef): number => useSplitView.getState().weights[splitTileKey(tile)] ?? 1

  /* 两列合计的宽度与份额不变，按新的左列宽度重新分 */
  const shift = (el: HTMLElement, dx: number, start?: { a: number; b: number }): void => {
    const a = el.previousElementSibling as HTMLElement | null
    const b = el.nextElementSibling as HTMLElement | null
    if (!a || !b) return
    const wa = start?.a ?? a.getBoundingClientRect().width
    const wb = start?.b ?? b.getBoundingClientRect().width
    const total = wa + wb
    const next = Math.max(MIN_COLUMN, Math.min(total - MIN_COLUMN, wa + dx))
    const share = weightOf(left) + weightOf(right)
    useSplitView.getState().setWeights({ [splitTileKey(left)]: share * next / total, [splitTileKey(right)]: share * (total - next) / total })
  }

  return (
    <div
      className="split-resizer ui-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('tile.resizeWidth')}
      tabIndex={0}
      data-testid="split-resizer"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const el = e.currentTarget
        const a = (el.previousElementSibling as HTMLElement | null)?.getBoundingClientRect().width ?? 0
        const b = (el.nextElementSibling as HTMLElement | null)?.getBoundingClientRect().width ?? 0
        const x0 = e.clientX
        /* 拖动期间原生浏览器视图等浮层要让开，和磁贴之间的拖动条一样 */
        const release = useStore.getState().acquireOverlayBlocker('split-resize')
        document.body.classList.add('split-resizing')
        const move = (ev: PointerEvent): void => shift(el, ev.clientX - x0, { a, b })
        const up = (): void => {
          document.removeEventListener('pointermove', move)
          document.removeEventListener('pointerup', up)
          window.removeEventListener('blur', up)
          document.body.classList.remove('split-resizing')
          release()
        }
        document.addEventListener('pointermove', move)
        document.addEventListener('pointerup', up)
        window.addEventListener('blur', up)
      }}
      onDoubleClick={() => useSplitView.getState().setWeights({ [splitTileKey(left)]: 1, [splitTileKey(right)]: 1 })}
      onKeyDown={(e) => {
        const dx = e.key === 'ArrowLeft' ? -KEY_STEP : e.key === 'ArrowRight' ? KEY_STEP : 0
        if (!dx) return
        e.preventDefault()
        shift(e.currentTarget, dx)
      }}
    />
  )
}
