import { useEffect, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import {
  UNSTABLE_Toast as RACToast,
  UNSTABLE_ToastContent as RACToastContent,
  UNSTABLE_ToastQueue,
  UNSTABLE_ToastRegion as RACToastRegion,
  composeRenderProps
} from 'react-aria-components'
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react'
import { useOptionalT } from '../i18n'
import { cx } from './cx'
import { Button } from './Button'
import { CloseButton } from './IconButton'
import { motionAllowed } from './motion-hooks'

export type ToastTone = 'info' | 'success' | 'warning' | 'danger'

export interface ToastContent {
  title: string
  description?: string
  tone?: ToastTone
  action?: { label: string; onAction: () => void }
}

type TransitionDocument = Document & { startViewTransition?: (options: { update: () => void; types?: string[] }) => unknown }

function withToastTransition(update: () => void, action: string): void {
  const doc = typeof document === 'undefined' ? null : (document as TransitionDocument)
  if (action === 'add' || !doc?.startViewTransition || !motionAllowed() || !doc.querySelector('.ui-toast')) {
    update()
    return
  }
  doc.startViewTransition({ update: () => flushSync(update), types: ['ui-toast'] })
}

export const toastQueue = new UNSTABLE_ToastQueue<ToastContent>({ maxVisibleToasts: 3, wrapUpdate: withToastTransition })

function toastTransitionName(key: string): string {
  return `ui-toast-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

export const DEFAULT_TOAST_TIMEOUT_MS = 6500

export interface ShowToastOptions extends Omit<ToastContent, 'title'> {
  timeout?: number
  onClose?: () => void
}

export function showToast(title: string, options: ShowToastOptions = {}): string {
  const { timeout = DEFAULT_TOAST_TIMEOUT_MS, onClose, ...content } = options
  const persistent = content.action != null && options.timeout == null
  return toastQueue.add({ title, ...content }, { timeout: persistent ? undefined : timeout, onClose })
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

export function ToastRegion({ className }: { className?: string } = {}) {
  const t = useOptionalT()
  useEffect(() => {
    const pause = (): void => toastQueue.pauseAll()
    const resume = (): void => toastQueue.resumeAll()
    window.addEventListener('blur', pause)
    window.addEventListener('focus', resume)
    return () => {
      window.removeEventListener('blur', pause)
      window.removeEventListener('focus', resume)
    }
  }, [])
  return (
    <RACToastRegion
      queue={toastQueue}
      className={composeRenderProps(className, (cn) => cx('ui-toast-region', cn))}
    >
      {({ toast }) => (
        <RACToast toast={toast} className={cx('ui-toast', `ui-toast--${toast.content.tone ?? 'info'}`)} style={{ viewTransitionName: toastTransitionName(toast.key) } as CSSProperties}>
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
          {toast.content.action ? (
            <Button
              size="sm"
              variant="secondary"
              className="ui-toast__action"
              onPress={() => {
                toast.content.action?.onAction()
                toastQueue.close(toast.key)
              }}
            >
              {toast.content.action.label}
            </Button>
          ) : null}
          <CloseButton
            aria-label={t('ui.closeToast')}
            size="md"
            className="ui-toast__close"
            onPress={() => toastQueue.close(toast.key)}
          />
        </RACToast>
      )}
    </RACToastRegion>
  )
}
