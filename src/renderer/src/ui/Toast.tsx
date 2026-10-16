import {
  UNSTABLE_Toast as RACToast,
  UNSTABLE_ToastContent as RACToastContent,
  UNSTABLE_ToastQueue,
  UNSTABLE_ToastRegion as RACToastRegion,
  composeRenderProps
} from 'react-aria-components'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import { cx } from './cx'
import { IconButton } from './IconButton'

export type ToastTone = 'info' | 'success' | 'warning' | 'danger'

export interface ToastContent {
  title: string
  description?: string
  tone?: ToastTone
}

/** 全局唯一的提示队列。只承载「视野外发生的结果」，原位确认不要用它。 */
export const toastQueue = new UNSTABLE_ToastQueue<ToastContent>({ maxVisibleToasts: 3 })

export interface ShowToastOptions extends Omit<ToastContent, 'title'> {
  /** 自动关闭时间（毫秒），默认 5 秒。 */
  timeout?: number
  onClose?: () => void
}

/** 推一条提示。返回队列 key，可用 `toastQueue.close(key)` 手动收起。 */
export function showToast(title: string, options: ShowToastOptions = {}): string {
  const { timeout = 5000, onClose, ...content } = options
  return toastQueue.add({ title, ...content }, { timeout, onClose })
}

function toneIcon(tone: ToastTone | undefined) {
  switch (tone) {
    case 'success':
      return <CircleCheck size={16} />
    case 'warning':
      return <TriangleAlert size={16} />
    case 'danger':
      return <CircleAlert size={16} />
    default:
      return <Info size={16} />
  }
}

/**
 * 提示区域。挂在应用根部一次即可（建议在 Shell 最外层），
 * 用 `showToast(...)` 推入。悬停/聚焦会暂停自动关闭（RAC 行为）。
 */
export function ToastRegion({ className }: { className?: string } = {}) {
  return (
    <RACToastRegion
      queue={toastQueue}
      className={composeRenderProps(className, (cn) => cx('ui-toast-region', cn))}
    >
      {({ toast }) => (
        <RACToast toast={toast} className={cx('ui-toast', `ui-toast--${toast.content.tone ?? 'info'}`)}>
          <RACToastContent className="ui-toast__content">
            <span className="ui-toast__icon" aria-hidden="true">
              {toneIcon(toast.content.tone)}
            </span>
            <span className="ui-toast__text">
              <span className="ui-toast__title">{toast.content.title}</span>
              {toast.content.description ? (
                <span className="ui-toast__desc">{toast.content.description}</span>
              ) : null}
            </span>
          </RACToastContent>
          <IconButton
            aria-label="关闭提示"
            variant="ghost"
            className="ui-toast__close"
            onPress={() => toastQueue.close(toast.key)}
          >
            <X size={15} aria-hidden="true" />
          </IconButton>
        </RACToast>
      )}
    </RACToastRegion>
  )
}
