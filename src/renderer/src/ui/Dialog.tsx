import { forwardRef, useEffect, useRef, type ReactNode } from 'react'
import { popModal, pushModal } from '../lib/modalLayer'
import {
  Dialog as RACDialog,
  DialogTrigger,
  Heading,
  Modal as RACModal,
  ModalOverlay as RACModalOverlay,
  composeRenderProps,
  type DialogProps as RACDialogProps,
  type ModalOverlayProps
} from 'react-aria-components'
import { X } from 'lucide-react'
import { cx } from './cx'
import { IconButton } from './IconButton'

export { DialogTrigger }
export type { DialogTriggerProps } from 'react-aria-components'

/**
 * 对话框遮罩。注意调用顺序：
 * `<DialogTrigger><Button/><ModalOverlay isDismissable><Modal><Dialog/></Modal></ModalOverlay></DialogTrigger>`。
 * 点击遮罩 / 按 Esc 关闭与关闭后焦点归还触发元素由 RAC 的 ModalOverlay 负责。
 */
export const ModalOverlay = forwardRef<HTMLDivElement, ModalOverlayProps>(function ModalOverlay(
  { className, ...props },
  ref
) {
  return (
    <RACModalOverlay
      {...props}
      ref={ref}
      className={composeRenderProps(className, (cn) => cx('ui-modal-overlay', cn))}
    />
  )
})

/** 对话框面板（遮罩内的表面）。宽度上限与内边距在 `ui.css` 里。 */
export const Modal = forwardRef<HTMLDivElement, ModalOverlayProps>(function Modal({ className, ...props }, ref) {
  return (
    <RACModal {...props} ref={ref} className={composeRenderProps(className, (cn) => cx('ui-modal', cn))} />
  )
})

export interface DialogProps extends RACDialogProps {
  /** 标题会作为对话框的 `aria-labelledby`；没有标题时请传 `aria-label`。 */
  title?: ReactNode
  /** 右上角关闭按钮的读屏名称。 */
  closeLabel?: string
  /** 关闭按钮（默认显示）。 */
  showClose?: boolean
}

/**
 * 对话框内容。`children` 可以是节点，也可以是 `({ close }) => …`，
 * 用 `close()` 从自定义按钮里关闭而不必自己管理开关状态。
 */
export const Dialog = forwardRef<HTMLElement, DialogProps>(function Dialog(
  { title, closeLabel = '关闭', showClose = true, className, children, ...props },
  ref
) {
  const token = useRef(Symbol('v3-dialog'))
  // RAC 管焦点与 Esc；宿主热键暂停仍走共享模态协调，避免 Shift+Tab 被主进程截走。
  useEffect(() => {
    const current = token.current
    pushModal(current)
    return () => popModal(current)
  }, [])
  return (
    <RACDialog {...props} ref={ref} className={cx('ui-dialog', className)}>
      {(renderProps) => (
        <>
          {title != null || showClose ? (
            <div className="ui-dialog__head">
              {title != null ? (
                <Heading slot="title" className="ui-dialog__title">
                  {title}
                </Heading>
              ) : (
                <span />
              )}
              {showClose ? (
                <IconButton
                  aria-label={closeLabel}
                  variant="ghost"
                  className="ui-dialog__close"
                  onPress={renderProps.close}
                >
                  <X size={16} aria-hidden="true" />
                </IconButton>
              ) : null}
            </div>
          ) : null}
          <div className="ui-dialog__body">
            {typeof children === 'function' ? children(renderProps) : children}
          </div>
        </>
      )}
    </RACDialog>
  )
})
