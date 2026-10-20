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
                <Button variant="secondary" onPress={() => settle(false)}>
                  {pending.cancelLabel ?? t('ui.cancel')}
                </Button>
                <Button
                  variant={pending.tone === 'danger' ? 'danger' : 'primary'}
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
