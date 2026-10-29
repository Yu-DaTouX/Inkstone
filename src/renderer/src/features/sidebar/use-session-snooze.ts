import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../state/store'
import { nextSnoozeWake, snoozeTimerDelay, wakingSessions } from './session-snooze'

export function useSnoozeClock(): number {
  const sessions = useStore((s) => s.sessions)
  const [now, setNow] = useState(() => Date.now())
  const wakingRef = useRef(new Set<string>())

  useEffect(() => {
    const wake = nextSnoozeWake(sessions, Date.now())
    const delay = snoozeTimerDelay(wake, Date.now())
    if (delay === null) return undefined
    const timer = window.setTimeout(() => setNow(Date.now()), delay)
    return () => window.clearTimeout(timer)
  }, [sessions, now])

  useEffect(() => {
    const tick = (): void => setNow(Date.now())
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.removeEventListener('focus', tick)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [])

  useEffect(() => {
    const woken = wakingSessions(sessions, now).filter((session) => !wakingRef.current.has(session.id))
    if (!woken.length) return
    const store = useStore.getState()
    for (const session of woken) {
      wakingRef.current.add(session.id)
      void store
        .setSessionMarkedUnread(session.id, true)
        .then(() => store.setSessionSnoozed(session.id, null))
        .finally(() => wakingRef.current.delete(session.id))
    }
  }, [sessions, now])

  return now
}
