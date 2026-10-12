import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import type { InteractionValues } from '../../../shared/interaction-state'

export const InteractionSession = createContext('')
export const InteractionPart = createContext('')
type Snapshot = { values: InteractionValues; ready: boolean; error?: string }
const empty: Snapshot = { values: {}, ready: false }
const snapshots = new Map<string, Snapshot>()
const listeners = new Set<() => void>()
const pending = new Set<string>()
const active = new Map<string, number>()
/**
 * 内存里的互动状态快照按会话封顶。
 *
 * 每条快照是 `Record<string, string>`，主进程侧单会话上限 4MB、单值 64KB，
 * 而以前只写不删（无 `.delete`/`.clear`）：打开过的会话越多，这张表越大。
 * 淘汰最久未访问的；正在显示的会话会在“使用”里被移到末尾，不会被选中。
 */
const MAX_SNAPSHOTS = 24
const touch = (id: string): void => {
  const value = snapshots.get(id)
  if (!value) return
  snapshots.delete(id)
  snapshots.set(id, value)
}
const subscribe = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
const publish = (id: string, value: Snapshot): void => {
  snapshots.delete(id)
  snapshots.set(id, value)
  for (const key of snapshots.keys()) {
    if (snapshots.size <= MAX_SNAPSHOTS) break
    if (key === id || active.has(key) || pending.has(key)) continue
    snapshots.delete(key)
  }
  listeners.forEach((fn) => fn())
}

export function useInteractionState() {
  const session = useContext(InteractionSession)
  const snapshot = useSyncExternalStore(subscribe, () => snapshots.get(session) ?? empty)
  useEffect(() => {
    if (!session) return
    active.set(session, (active.get(session) ?? 0) + 1)
    return () => {
      const count = (active.get(session) ?? 1) - 1
      if (count > 0) active.set(session, count)
      else active.delete(session)
    }
  }, [session])
  useEffect(() => {
    if (!session) return
    if (snapshot.ready || pending.has(session)) { touch(session); return }
    pending.add(session)
    void window.yan.interactions.get(session).then((values) => publish(session, { values, ready: true }))
      .catch((e) => publish(session, { ...empty, error: String(e) }))
      .finally(() => pending.delete(session))
  }, [session, snapshot.ready])
  const save = async (key: string, value: string | null): Promise<void> => {
    if (!session || !snapshot.ready) throw new Error('Interaction state is not ready')
    const values = await window.yan.interactions.set(session, key, value)
    publish(session, { values, ready: true })
  }
  return { ...snapshot, session, save }
}
