import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import { Button, Dialog, DialogFooter, Modal, ModalOverlay, Notice } from '../../../ui'
import { useT } from '../../../i18n'
import { runConfirmAction } from './confirm-action'

interface ConfirmOptions {
  title: string
  body?: string
  detail?: string
  confirmLabel: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
  action?: () => Promise<void> | void
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

export function ConfirmProvider({ children }: { children: ReactNode }): ReactElement {
  const t = useT()
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      setBusy(false)
      setError(undefined)
      setPending({ ...options, resolve })
    })
  }, [])

  const value = useMemo(() => confirm, [confirm])

  const settle = (ok: boolean): void => {
    setBusy(false)
    setError(undefined)
    setPending((current) => {
      current?.resolve(ok)
      return null
    })
  }

  const accept = async (): Promise<void> => {
    if (busy) return
    if (!pending?.action) {
      settle(true)
      return
    }
    setBusy(true)
    setError(undefined)
    const outcome = await runConfirmAction(pending.action)
    if (outcome.ok) {
      settle(true)
      return
    }
    setBusy(false)
    setError(outcome.error ?? t('cap.skillActionFailed'))
  }

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending ? (
        <ModalOverlay
          className="settings-confirm-overlay"
          isOpen
          isDismissable={false}
          isKeyboardDismissDisabled={busy}
          onOpenChange={(open) => {
            if (!open && !busy) settle(false)
          }}
        >
          <Modal data-dialog-size="md">
            <Dialog title={pending.title} alert closeLabel={t('set.close')}>
              {pending.body ? <p className="settings-confirm-desc caps-confirm-body">{pending.body}</p> : null}
              {pending.detail ? <pre className="caps-confirm-detail">{pending.detail}</pre> : null}
              {error ? (
                <Notice tone="fail" compact>
                  {error}
                </Notice>
              ) : null}
              <DialogFooter>
                <Button variant="ghost" isDisabled={busy} onPress={() => settle(false)}>
                  {pending.cancelLabel ?? t('ui.cancel')}
                </Button>
                <Button
                  autoFocus
                  variant={pending.tone === 'danger' ? 'destructive' : 'primary'}
                  isPending={busy}
                  aria-busy={busy || undefined}
                  data-testid="caps-confirm-accept"
                  onPress={() => void accept()}
                >
                  {pending.confirmLabel}
                </Button>
              </DialogFooter>
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
