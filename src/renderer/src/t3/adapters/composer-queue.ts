import { useCallback, useMemo } from 'react'
import type { QueueState } from '../../../../shared/ipc'
import { pendingSendsForView, useStore, type PendingSend } from '@/state/store'
import { useT } from '../../i18n'
import { showToast } from '../../ui'

export type QueueRowKind = 'pending' | 'steering' | 'followUp'

export interface QueueImage {
  data: string
  mimeType: string
}

export interface QueueRow {
  id: string
  kind: QueueRowKind
  text: string
  images: readonly QueueImage[]
  imageCount: number
  index: number
  count: number
  canSteer: boolean
  canMoveUp: boolean
  canMoveDown: boolean
}

export interface QueueAdapter {
  rows: QueueRow[]
  total: number
  running: boolean
  canSteer: boolean
  sendNow: (row: QueueRow) => void
  steer: (row: QueueRow) => void
  edit: (row: QueueRow, text: string) => void
  move: (row: QueueRow, direction: 'up' | 'down') => void
  retract: (row: QueueRow) => void
  drop: (row: QueueRow) => void
  restore: (row: QueueRow) => void
  discard: (row: QueueRow) => void
  clearAll: () => void
}

function rowsOfKind(
  kind: QueueRowKind,
  items: readonly { id: string; text: string; images?: readonly QueueImage[] }[],
  extra: (index: number, count: number) => Pick<QueueRow, 'canSteer' | 'canMoveUp' | 'canMoveDown'>
): QueueRow[] {
  return items.map((item, index) => ({
    id: item.id,
    kind,
    text: item.text,
    images: item.images ?? [],
    imageCount: item.images?.length ?? 0,
    index,
    count: items.length,
    ...extra(index, items.length)
  }))
}

export function buildQueueRows(
  queue: QueueState,
  pending: readonly PendingSend[]
): QueueRow[] {
  return [
    ...rowsOfKind('pending', pending, () => ({
      canSteer: false,
      canMoveUp: false,
      canMoveDown: false
    })),
    ...rowsOfKind('steering', queue.steering, (index, count) => ({
      canSteer: false,
      canMoveUp: index > 0,
      canMoveDown: index < count - 1
    })),
    ...rowsOfKind('followUp', queue.followUp, (index, count) => ({
      canSteer: true,
      canMoveUp: index > 0,
      canMoveDown: index < count - 1
    }))
  ]
}

function activeRunnerRunning(): boolean {
  const state = useStore.getState()
  return state.runners.find((r) => (r.runId ?? r.id) === state.activeRunnerId)?.running === true
}

async function requeueRows(rows: readonly QueueRow[]): Promise<void> {
  const store = useStore.getState()
  const running = activeRunnerRunning()
  const back: string[] = []
  for (const row of rows) {
    const images = row.images.map((image) => ({ ...image }))
    if (row.kind === 'pending') store.holdSend(row.text, images)
    else if (running) await store.send(row.text, images, row.kind === 'steering' ? 'steer' : 'followUp')
    else if (row.text) back.push(row.text)
  }
  if (back.length) {
    const text = back.join('\n')
    useStore.setState((state) => ({ queueRestore: state.queueRestore ? `${text}\n${state.queueRestore}` : text }))
  }
}

export function useQueueAdapter(): QueueAdapter {
  const t = useT()
  const queue = useStore((s) => s.queue)
  const allPending = useStore((s) => s.pendingSends)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const session = useStore((s) => s.session)
  const running = useStore(
    (s) => s.runners.find((r) => (r.runId ?? r.id) === s.activeRunnerId)?.running === true
  )

  const pending = useMemo(
    () => pendingSendsForView({ pendingSends: allPending, peekedSessionId, peekedPath, session }),
    [allPending, peekedSessionId, peekedPath, session]
  )

  const rows = useMemo(() => buildQueueRows(queue, pending), [queue, pending])

  const sendNow = useCallback((row: QueueRow) => {
    void useStore.getState().releaseSend(row.id, 'followUp')
  }, [])
  const steer = useCallback((row: QueueRow) => {
    const store = useStore.getState()
    if (row.kind === 'pending') {
      void store.releaseSend(row.id, 'steer')
      return
    }
    void store.steerQueued(row.id)
  }, [])
  const edit = useCallback((row: QueueRow, text: string) => {
    void useStore.getState().applyQueueOp({ op: 'edit', id: row.id, text })
  }, [])
  const move = useCallback((row: QueueRow, direction: 'up' | 'down') => {
    void useStore.getState().applyQueueOp({ op: 'move', id: row.id, direction })
  }, [])
  const retract = useCallback((row: QueueRow) => {
    void useStore.getState().removeQueued(row.id)
  }, [])
  const drop = useCallback((row: QueueRow) => {
    if (row.kind === 'pending') {
      useStore.getState().discardSend(row.id)
      return
    }
    void useStore.getState().applyQueueOp({ op: 'remove', id: row.id })
  }, [])
  const restore = useCallback((row: QueueRow) => {
    useStore.getState().restoreSend(row.id)
  }, [])
  const discard = useCallback((row: QueueRow) => {
    useStore.getState().discardSend(row.id)
  }, [])
  const clearAll = useCallback(() => {
    const state = useStore.getState()
    const cleared = buildQueueRows(state.queue, pendingSendsForView(state))
    for (const item of pendingSendsForView(state)) state.discardSend(item.id)
    void state.applyQueueOp({ op: 'clear' })
    if (!cleared.length) return
    let undone = false
    showToast(t('queue.cleared', { n: cleared.length }), {
      timeout: 8000,
      action: {
        label: t('queue.undoClear'),
        onAction: () => {
          if (undone) return
          undone = true
          void requeueRows(cleared)
        }
      }
    })
  }, [t])

  return {
    rows,
    total: rows.length,
    running,
    canSteer: running,
    sendNow,
    steer,
    edit,
    move,
    retract,
    drop,
    restore,
    discard,
    clearAll
  }
}
