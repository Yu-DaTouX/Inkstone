/**
 * v3 能力设置自己的确认对话框（S2 内部使用）。
 *
 * 为什么不复用 v2 的 `components/ui/confirm`：那是旧组件与旧样式，任务边界
 * 禁止引入。这里只用 v3 的 `ui/Dialog` 组合出一个 Promise 式确认，样式全在
 * `capabilities.css` 的 features 层。
 *
 * 用途仅限「用户点击后、真正调正式 IPC 之前」的确认（安装 / 卸载 / 导入）。
 * 不是第二套授权机制：放行与否仍由主进程的能力服务判断。
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import { Button, Dialog, Modal, ModalOverlay } from '../../../ui'
import { useT } from '../../../i18n'

export interface ConfirmOptions {
  title: string
  body?: string
  /** 细节块（预览 / 影响范围），按等宽可换行展示。 */
  detail?: string
  confirmLabel: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

export function ConfirmProvider({ children }: { children: ReactNode }): ReactElement {
  const t = useT()
  const [pending, setPending] = useState<PendingConfirm | null>(null)

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      setPending({ ...options, resolve })
    })
  }, [])

  const value = useMemo(() => confirm, [confirm])

  const settle = (ok: boolean): void => {
    setPending((current) => {
      current?.resolve(ok)
      return null
    })
  }

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending ? (
        <ModalOverlay
          className="caps-overlay"
          isOpen
          isDismissable
          onOpenChange={(open) => {
            if (!open) settle(false)
          }}
        >
          <Modal className="caps-modal">
            <Dialog title={pending.title} closeLabel={t('set.close')}>
              {pending.body ? <p className="caps-confirm-body">{pending.body}</p> : null}
              {pending.detail ? <pre className="caps-confirm-detail">{pending.detail}</pre> : null}
              <div className="caps-confirm-actions">
                <Button variant="secondary" size="sm" onPress={() => settle(false)}>
                  {pending.cancelLabel ?? t('ui.cancel')}
                </Button>
                <Button
                  variant={pending.tone === 'danger' ? 'danger' : 'primary'}
                  size="sm"
                  data-testid="caps-confirm-accept"
                  onPress={() => settle(true)}
                >
                  {pending.confirmLabel}
                </Button>
              </div>
            </Dialog>
          </Modal>
        </ModalOverlay>
      ) : null}
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext)
  if (!confirm) throw new Error('useConfirm 必须在 <ConfirmProvider> 内使用')
  return confirm
}
