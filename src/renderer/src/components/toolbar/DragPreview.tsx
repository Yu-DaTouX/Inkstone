import { createPortal } from 'react-dom'
import { Icon } from '../../icons/Icon'
import type { IconName } from '../../icons/sprite'

/**
 * 拖动预览（2026-09-25）。
 *
 * 用户提的问题是：拖磁贴时「看不到自己在搬什么」——
 *   · 栏内重排：只有一条插入线，说明「会插到哪」，但搬的是哪块要回头看原位置
 *   · 拖出到中栏 / 从浮窗拖回栏内：指针一离开工具栏，插入线全没了，
 *     整个拖拽在视觉上等于消失
 * 所以补一个跟着指针的小胶囊：磁贴图标 + 名字（+ 落点提示）。
 *
 * 用 portal 挂到 `document.body`：`.rp-body` 上有 overflow，父级链上也
 * 可能引入 transform —— fixed 定位落在那类祖先里会改参考系，跟着指针走
 * 的位置就全错。
 */

/** 指针位置 → 浮层左上角（让开指针本身，别盖住落点判定用的那一点） */
const OFFSET_X = 14
const OFFSET_Y = 12

export function DragPreview({
  x,
  y,
  icon,
  label,
  hint,
  /** move = 栏内重排；float = 拖出成浮动磁贴（换成强调色，提示「会变成浮窗」） */
  tone = 'move'
}: {
  x: number
  y: number
  icon?: IconName
  label: string
  hint?: string
  tone?: 'move' | 'float'
}): React.ReactPortal {
  return createPortal(
    <div
      className={`rp-drag-preview ${tone}`}
      data-testid="rp-drag-preview"
      style={{ transform: `translate3d(${x + OFFSET_X}px, ${y + OFFSET_Y}px, 0)` }}
      aria-hidden
    >
      {icon ? (
        <Icon name={icon} size={14} className="rp-drag-preview-icon" />
      ) : (
        /* 没有图标的分区在卡片上也是这个把手，保持一致 */
        <span className="rp-drag-preview-grip">⠿</span>
      )}
      <span className="rp-drag-preview-label">{label}</span>
      {hint ? <span className="rp-drag-preview-hint">{hint}</span> : null}
    </div>,
    document.body
  )
}

/**
 * 落位预览框：拖到工作区时，画出这块磁贴**将来变成的浮窗**占在哪、多大。
 *
 * 尺寸必须和真正落位时一致，否则松手会「跳一下」。落点算法在
 * `RightPanel.floatPxRectAt()` 里，两处共用同一个函数（见那里的注释）。
 */
export function DragDropRect({
  rect,
  label
}: {
  rect: { left: number; top: number; width: number; height: number }
  label: string
}): React.ReactPortal {
  return createPortal(
    <div
      className="rp-drop-rect"
      data-testid="rp-drop-rect"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      aria-hidden
    >
      <span className="rp-drop-rect-label">{label}</span>
    </div>,
    document.body
  )
}
