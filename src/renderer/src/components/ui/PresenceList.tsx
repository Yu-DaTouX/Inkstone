import { useEffect, useReducer, useRef } from 'react'
import { Grow } from './index'
import { prefersReducedMotion } from '../../lib/usePresence'
import { createListPresence, LIST_EXIT_MS, type ListPhase } from '../../lib/list-presence'

export function PresenceList<T>({
  items,
  getKey,
  scope,
  children
}: {
  items: readonly T[]
  getKey: (item: T, index: number) => string
  scope?: string
  children: (item: T, phase: ListPhase) => React.ReactNode
}): React.JSX.Element {
  const helper = useRef(createListPresence<T>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const lastScope = useRef(scope)
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const reduced = prefersReducedMotion()

  if (lastScope.current !== scope) {
    helper.current.reset()
    lastScope.current = scope
  }

  const rows = helper.current.reconcile(
    items.map((item, index) => ({ id: getKey(item, index), item })),
    { motion: !reduced }
  )

  useEffect(() => {
    const exiting = new Set(rows.filter((row) => row.phase === 'exiting').map((row) => row.id))
    for (const [id, timer] of timers.current) {
      if (!exiting.has(id)) {
        clearTimeout(timer)
        timers.current.delete(id)
      }
    }
    for (const id of exiting) {
      if (timers.current.has(id)) continue
      const timer = setTimeout(() => {
        timers.current.delete(id)
        helper.current.settle(id)
        bump()
      }, reduced ? 1 : LIST_EXIT_MS)
      timers.current.set(id, timer)
    }
  })

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer)
      timers.current.clear()
      helper.current.reset()
    },
    []
  )

  return (
    <>
      {rows.map((row) => (
        <Grow key={row.id} open={row.phase !== 'exiting'} enter={row.phase === 'entering'}>
          {children(row.item, row.phase)}
        </Grow>
      ))}
    </>
  )
}
