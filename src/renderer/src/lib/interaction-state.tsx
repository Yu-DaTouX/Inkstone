import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import type { InteractionValues } from '../../../shared/interaction-state'

export const InteractionSession = createContext('')
export const InteractionPart = createContext('')
type Snapshot = { values: InteractionValues; ready: boolean; error?: string }
const empty: Snapshot = { values: {}, ready: false }
const snapshots = new Map<string, Snapshot>()
const listeners = new Set<() => void>()
const pending = new Set<string>()
const subscribe = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
const publish = (id: string, value: Snapshot): void => { snapshots.set(id, value); listeners.forEach((fn) => fn()) }

export function useInteractionState() {
  const session = useContext(InteractionSession)
  const snapshot = useSyncExternalStore(subscribe, () => snapshots.get(session) ?? empty)
  useEffect(() => {
    if (!session || snapshots.has(session) || pending.has(session)) return
    pending.add(session)
    void window.yan.interactions.get(session).then((values) => publish(session, { values, ready: true }))
      .catch((e) => publish(session, { ...empty, error: String(e) }))
      .finally(() => pending.delete(session))
  }, [session])
  const save = async (key: string, value: string | null): Promise<void> => {
    if (!session || !snapshot.ready) throw new Error('Interaction state is not ready')
    const values = await window.yan.interactions.set(session, key, value)
    publish(session, { values, ready: true })
  }
  return { ...snapshot, session, save }
}
