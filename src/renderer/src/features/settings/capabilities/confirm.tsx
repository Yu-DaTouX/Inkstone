import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import { ConfirmDialog, Notice } from '../../../ui'
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
        <ConfirmDialog
          overlayClassName="settings-confirm-overlay"
          size="md"
          isOpen
          onOpenChange={(open) => {
            if (!open && !busy) settle(false)
          }}
          title={pending.title}
          tone={pending.tone === 'danger' ? 'danger' : 'default'}
          cancelLabel={pending.cancelLabel ?? t('ui.cancel')}
          confirmLabel={pending.confirmLabel}
          confirmTestId="caps-confirm-accept"
          isPending={busy}
          closeOnConfirm={false}
          onConfirm={() => void accept()}
        >
          {pending.body ? <p className="settings-confirm-desc caps-confirm-body">{pending.body}</p> : null}
          {pending.detail ? <pre className="caps-confirm-detail">{pending.detail}</pre> : null}
          {error ? (
            <Notice tone="fail" compact>
              {error}
            </Notice>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext)
  if (!confirm) throw new Error('useConfirm 必须在 <ConfirmProvider> 内使用')
  return confirm
}
