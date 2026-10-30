import { useCallback, useReducer, useRef, useState, type ReactElement } from 'react'
import { RefreshCw, RotateCcw } from 'lucide-react'
import { Button, Collapsible, CollapsibleHeader, CollapsiblePanel, Notice, Spinner } from '../../ui'
import type { GhPrActionRequest, GhPrActionResult } from '../../../../shared/github'
import { canStartAction, failureCause, reduceAction, type PrActionPhase } from './pr-actions-model'
import type { PrActionText } from './pr-action-text'

export interface PrActionController {
  state: PrActionPhase
  busy: boolean
  run: (request: GhPrActionRequest) => Promise<GhPrActionResult | null>
  retry: () => void
  reset: () => void
}

export function usePrAction(cwd: string, onDone?: (request: GhPrActionRequest, result: GhPrActionResult) => void): PrActionController {
  const [state, dispatch] = useReducer(reduceAction, { phase: 'idle' } as PrActionPhase)
  const inflight = useRef(false)
  const last = useRef<GhPrActionRequest | null>(null)
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  const run = useCallback(
    async (request: GhPrActionRequest): Promise<GhPrActionResult | null> => {
      if (inflight.current || !canStartAction(state)) return null
      const github = window.yan?.github
      if (!github) return null
      inflight.current = true
      last.current = request
      dispatch({ type: 'start', kind: request.kind })
      try {
        const result = await github.action(cwd, request)
        dispatch({ type: 'result', result })
        if (result.ok) doneRef.current?.(request, result)
        return result
      } catch (cause) {
        dispatch({ type: 'error', message: cause instanceof Error ? cause.message : String(cause) })
        return null
      } finally {
        inflight.current = false
      }
    },
    [cwd, state]
  )

  const retry = useCallback(() => {
    if (state.phase !== 'failed' || state.recovery !== 'retry' || !last.current) return
    dispatch({ type: 'reset' })
    void run(last.current)
  }, [run, state])

  const reset = useCallback(() => dispatch({ type: 'reset' }), [])

  return { state, busy: state.phase === 'running', run, retry, reset }
}

export interface PrActionStatusProps {
  controller: PrActionController
  text: PrActionText['result']
  onRefresh: () => void
  className?: string
}

export function PrActionStatus({ controller, text, onRefresh, className }: PrActionStatusProps): ReactElement | null {
  const { state } = controller
  const [causeOpen, setCauseOpen] = useState(false)
  if (state.phase === 'idle') return null
  if (state.phase === 'running') {
    return (
      <Notice variant="hint" icon={<Spinner size="xs" />} className={className} data-testid="gh-pr-action-running">
        {text.running}
      </Notice>
    )
  }
  if (state.phase === 'done') {
    const notes = [text.done[state.kind] ?? '', state.pendingBranch ? text.pendingBranch : '', state.refreshFailed ? text.refreshFailed : ''].filter(Boolean)
    return (
      <Notice
        tone={state.refreshFailed || state.pendingBranch ? 'ask' : 'ok'}
        compact
        className={className}
        data-testid="gh-pr-action-done"
        action={
          <Button size="xs" variant="ghost" onPress={controller.reset}>
            {text.dismiss}
          </Button>
        }
      >
        {notes.join(' ')}
      </Notice>
    )
  }
  const { failure, recovery } = state
  const unknown = failure.code === 'timeout' || recovery === 'refresh'
  return (
    <Notice
      tone={unknown ? 'ask' : 'fail'}
      className={className}
      title={`${text.failed} · ${text.codes[failure.code] ?? failure.code}`}
      data-testid="gh-pr-action-failed"
      data-recovery={recovery}
      action={
        <span className="gh-pr-act__status-actions">
          {recovery === 'retry' ? (
            <Button size="xs" variant="secondary" icon={<RotateCcw size={12} aria-hidden />} onPress={controller.retry} data-testid="gh-pr-action-retry">
              {text.retry}
            </Button>
          ) : null}
          {recovery === 'refresh' ? (
            <Button
              size="xs"
              variant="secondary"
              icon={<RefreshCw size={12} aria-hidden />}
              onPress={() => {
                controller.reset()
                onRefresh()
              }}
              data-testid="gh-pr-action-refresh"
            >
              {text.refreshConfirm}
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" onPress={controller.reset}>
            {text.dismiss}
          </Button>
        </span>
      }
    >
      <span className="gh-pr-act__status-body">
        {unknown && failure.code === 'timeout' ? <span>{text.unknown}</span> : null}
        {failure.message ? <span>{failure.message}</span> : null}
        {failure.hint ? <span className="gh-pr-act__hint ui-meta-text">{failure.hint}</span> : null}
        <Collapsible isExpanded={causeOpen} onExpandedChange={setCauseOpen}>
          <CollapsibleHeader tone="muted" aria-label={causeOpen ? text.hideCause : text.cause} data-testid="gh-pr-action-cause">
            {causeOpen ? text.hideCause : text.cause}
          </CollapsibleHeader>
          <CollapsiblePanel>{causeOpen ? <pre className="gh-pr-act__cause ui-meta-num">{failureCause(failure)}</pre> : null}</CollapsiblePanel>
        </Collapsible>
      </span>
    </Notice>
  )
}
