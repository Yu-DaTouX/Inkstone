import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'
import { Button } from './index'
import { createConfirmQueue, type ConfirmOptions, type ConfirmQueue, type ConfirmRequest } from './confirm-queue'

export type { ConfirmOptions, ConfirmTone } from './confirm-queue'

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmQueue | null>(null)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const queue = useMemo(() => createConfirmQueue(), [])
  useEffect(() => () => queue.cancelAll(), [queue])
  return (
    <ConfirmContext.Provider value={queue}>
      {children}
      <ConfirmHost queue={queue} />
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmFn {
  const queue = useContext(ConfirmContext)
  const scope = useMemo(() => Symbol('confirm-scope'), [])
  useEffect(() => {
    if (!queue) return undefined
    return () => queue.cancelScope(scope)
  }, [queue, scope])
  const confirm = useCallback((options: ConfirmOptions) => {
    if (!queue) throw new Error('useConfirm 必须在 <ConfirmProvider> 内使用')
    return queue.enqueue(options, scope)
  }, [queue, scope])
  if (!queue) throw new Error('useConfirm 必须在 <ConfirmProvider> 内使用')
  return confirm
}

export function useCancelConfirms(): () => void {
  const queue = useContext(ConfirmContext)
  const cancel = useCallback(() => queue?.cancelAll(), [queue])
  if (!queue) throw new Error('useCancelConfirms 必须在 <ConfirmProvider> 内使用')
  return cancel
}

function ConfirmHost({ queue }: { queue: ConfirmQueue }): React.JSX.Element | null {
  const acquireOverlayBlocker = useStore((s) => s.acquireOverlayBlocker)
  const requests = useSyncExternalStore(queue.subscribe, queue.snapshot)
  const active = requests.length > 0
  const closeHead = useCallback(() => {
    const head = queue.snapshot()[0]
    if (head) queue.settle(head.id, false)
  }, [queue])
  const { isTop } = useModalLayer(active, closeHead)
  useEffect(() => {
    if (!active) return undefined
    return acquireOverlayBlocker('confirm-dialog')
  }, [active, acquireOverlayBlocker])

  const current = requests[0]
  if (!current) return null
  return <ConfirmDialog key={current.id} queue={queue} request={current} queued={requests.length - 1} isTop={isTop} />
}

function ConfirmDialog({ queue, request, queued, isTop }: { queue: ConfirmQueue; request: ConfirmRequest; queued: number; isTop: boolean }): React.JSX.Element {
  const t = useT()
  const panel = useRef<HTMLDivElement>(null)
  const bodyId = useId()
  const detailId = useId()
  const { options } = request
  const close = useCallback(() => queue.settle(request.id, false), [queue, request.id])

  useFocusTrap(panel, true, isTop)

  const tone = options.tone ?? 'normal'
  const describedBy = [options.body ? bodyId : '', options.detail ? detailId : ''].filter(Boolean).join(' ') || undefined

  return (
    <div
      className="ui-confirm-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        className="ui-confirm"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={options.title}
        aria-describedby={describedBy}
        data-testid="confirm-dialog"
      >
        <div className="ui-confirm-head">
          <span className="ui-confirm-title">{options.title}</span>
          {queued > 0 ? <span className="ui-confirm-queued">{t('ui.confirmQueued', { n: queued })}</span> : null}
        </div>
        {options.body ? <div className="ui-confirm-body" id={bodyId}>{options.body}</div> : null}
        {options.detail ? <div className="ui-confirm-detail" id={detailId}>{options.detail}</div> : null}
        <div className="ui-confirm-foot">
          <Button onClick={close} data-testid="confirm-cancel">{options.cancelLabel ?? t('ui.cancel')}</Button>
          <span className="spacer" />
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} data-testid="confirm-ok" onClick={() => queue.settle(request.id, true)}>
            {options.confirmLabel ?? t('ui.confirm')}
          </Button>
        </div>
      </div>
    </div>
  )
}
