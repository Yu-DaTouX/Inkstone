import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RemoteEventEnvelope, RemotePendingQuestion, RemoteInfo, RemoteModel } from '../../src/shared/remote-protocol'
import { RemoteClient, RemoteEventStream, RemoteHttpError, type Connection, type RemoteProject, type SessionListItem, type StreamState } from './api/client'
import { deviceInfo, readMarks, writeMarks, type ReadMark } from './device'
import { saveConnection } from './storage'

export interface RunnerInfo {
  runId: string
  sessionId?: string
  running: boolean
  waiting: boolean
  isActive?: boolean
  failed?: boolean
  model?: RemoteModel
}

interface RemoteState {
  client: RemoteClient
  stream: StreamState
  sessions: SessionListItem[]
  projects: RemoteProject[]
  questions: RemotePendingQuestion[]
  runners: RunnerInfo[]
  activeSessionId: string | null
  info: RemoteInfo | null
  unread: Set<string>
  marksReady: boolean
  markRead(sessionId: string, message: ReadMark): void
  previews: Record<string, { text: string; role: string; at?: number; reply?: ReadMark }>
  error: string | null
  refresh(): Promise<void>
  onSessionEvent(sessionId: string, listener: () => void): () => void
}

const Ctx = createContext<RemoteState | null>(null)

export function useRemote(): RemoteState {
  const value = useContext(Ctx)
  if (!value) throw new Error('useRemote 必须在 RemoteProvider 里使用')
  return value
}

const MESSAGE_CHANNELS = new Set(['msg-add', 'msg-update', 'msg-remove', 'tool', 'session-title'])
const QUESTION_CHANNELS = new Set(['ui-request', 'ui-resolved', 'ui-deadline', 'approval', 'approval-close'])
const STATUS_CHANNELS = new Set(['state', 'runners', 'proc'])

function sessionOfEvent(event: RemoteEventEnvelope): string | null {
  const runtime = event.runtime as { sessionId?: unknown } | undefined
  if (typeof runtime?.sessionId === 'string') return runtime.sessionId
  const payload = event.payload as { sessionId?: unknown } | undefined
  return typeof payload?.sessionId === 'string' ? payload.sessionId : null
}

export function RemoteProvider({
  connection,
  onUnauthorized,
  children
}: {
  connection: Connection
  onUnauthorized: () => void
  children: ReactNode
}) {
  const client = useMemo(() => new RemoteClient(connection), [connection])
  const [stream, setStream] = useState<StreamState>('connecting')
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [projects, setProjects] = useState<RemoteProject[]>([])
  const [questions, setQuestions] = useState<RemotePendingQuestion[]>([])
  const [runners, setRunners] = useState<RunnerInfo[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [info, setInfo] = useState<RemoteInfo | null>(null)
  const [marks, setMarks] = useState<Record<string, ReadMark>>({})
  const marksRef = useRef(marks)
  const [marksReady, setMarksReady] = useState(false)
  const markScope = `${connection.baseUrl}|${connection.deviceId}`
  const [previews, setPreviews] = useState<Record<string, { text: string; role: string; at?: number; reply?: ReadMark }>>({})
  const previewVersions = useRef(new Map<string, number>())
  const [error, setError] = useState<string | null>(null)
  const listeners = useRef(new Map<string, Set<() => void>>())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    let alive = true
    void readMarks(markScope).then((saved) => {
      if (!alive) return
      const next = { ...saved, _baseline: saved._baseline ?? { id: 'baseline', at: Date.now() } }
      marksRef.current = next; setMarks(next); setMarksReady(true)
      void writeMarks(markScope, next).catch(() => undefined)
    })
    return () => { alive = false }
  }, [markScope])

  const markRead = useCallback((sessionId: string, message: ReadMark) => {
    const old = marksRef.current[sessionId]
    if (!message.at || (old && old.at >= message.at)) return
    const next = { ...marksRef.current, [sessionId]: message }
    marksRef.current = next; setMarks(next)
    void writeMarks(markScope, next).catch(() => undefined)
  }, [markScope])

  const guard = useCallback(
    async (task: () => Promise<void>): Promise<void> => {
      try {
        await task()
        setError(null)
      } catch (err) {
        if (err instanceof RemoteHttpError && err.status === 401) onUnauthorized()
        else setError(err instanceof Error ? err.message : '请求失败')
      }
    },
    [onUnauthorized]
  )

  const refreshStatus = useCallback(
    () =>
      guard(async () => {
        const snapshot = await client.status()
        const agent = snapshot.agent as { runners?: RunnerInfo[]; activeSessionId?: string | null } | undefined
        setRunners(agent?.runners ?? [])
        setActiveSessionId(agent?.activeSessionId ?? null)
        const list = snapshot.sessions as SessionListItem[] | undefined
        if (list) setSessions(list)
        if (Array.isArray(snapshot.projects)) setProjects(snapshot.projects as RemoteProject[])
      }),
    [client, guard]
  )

  const refreshInfo = useCallback(() => guard(async () => {
    const next = await client.info()
    if (next.capabilities.includes('device-name') && next.device && ['我的手机', '未命名设备'].includes(next.device.name)) {
      next.device = await client.renameDevice((await deviceInfo()).name)
    }
    setInfo(next)
    if (next.computer?.name || next.device?.name) await saveConnection({ ...connection, computerName: next.computer?.name ?? connection.computerName, deviceName: next.device?.name ?? connection.deviceName })
  }), [client, connection, guard])

  useEffect(() => {
    let cancelled = false
    const recent = [...sessions].sort((a, b) => (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt)).slice(0, 8)
    const queue = recent.filter((session) => previewVersions.current.get(session.id) !== (session.lastActivityAt ?? session.updatedAt))
    const work = async () => {
      while (queue.length && !cancelled) {
        const session = queue.shift()!
        try {
          const history = await client.history(session.id, 12)
          if (cancelled) return
          const last = [...history.messages].reverse().find((message) => (message.role === 'assistant' || message.role === 'user') && message.text?.trim())
          const reply = [...history.messages].reverse().find((message) => message.role === 'assistant' && message.text?.trim())
          setPreviews((current) => ({ ...current, [session.id]: { text: last?.text?.replace(/\s+/g, ' ').trim().slice(0, 180) ?? '', role: last?.role ?? '', at: last?.timestamp, reply: reply?.timestamp ? { id: reply.id, at: reply.timestamp } : undefined } }))
          previewVersions.current.set(session.id, session.lastActivityAt ?? session.updatedAt)
        } catch { }
      }
    }
    void Promise.all([work(), work(), work()])
    return () => { cancelled = true }
  }, [client, sessions])

  const refreshQuestions = useCallback(() => guard(async () => setQuestions(await client.questions())), [client, guard])

  const refresh = useCallback(async () => {
    await Promise.all([refreshStatus(), refreshQuestions(), refreshInfo()])
    for (const set of listeners.current.values()) for (const listener of set) listener()
  }, [refreshStatus, refreshQuestions, refreshInfo])

  const debounce = useCallback((key: string, run: () => void) => {
    const existing = timers.current.get(key)
    if (existing) return
    timers.current.set(key, setTimeout(() => {
      timers.current.delete(key)
      run()
    }, 750))
  }, [])

  const notifySession = useCallback((sessionId: string) => {
    debounce(`session:${sessionId}`, () => {
      for (const listener of listeners.current.get(sessionId) ?? []) listener()
    })
  }, [debounce])

  useEffect(() => {
    void refresh()
    let streamTimer: ReturnType<typeof setTimeout> | null = null
    const events = new RemoteEventStream(connection, {
      onState: (state) => {
        if (streamTimer) { clearTimeout(streamTimer); streamTimer = null }
        if (state === 'open') setStream(state)
        else streamTimer = setTimeout(() => { streamTimer = null; setStream(state) }, 1500)
        if (state === 'open') void refreshInfo()
      },
      onUnauthorized,
      onResync: () => void refresh(),
      onEvent: (event) => {
        if (QUESTION_CHANNELS.has(event.channel)) debounce('questions', () => void refreshQuestions())
        if (STATUS_CHANNELS.has(event.channel)) {
          debounce('status', () => void refreshStatus())
          const sessionId = sessionOfEvent(event)
          if (sessionId) notifySession(sessionId)
        }
        if (MESSAGE_CHANNELS.has(event.channel)) {
          const sessionId = sessionOfEvent(event)
          debounce('status', () => void refreshStatus())
          if (sessionId) notifySession(sessionId)
        }
      }
    })
    events.start()
    return () => {
      if (streamTimer) clearTimeout(streamTimer)
      events.stop()
      for (const timer of timers.current.values()) clearTimeout(timer)
      timers.current.clear()
    }
  }, [connection, debounce, notifySession, onUnauthorized, refresh, refreshInfo, refreshQuestions, refreshStatus])

  const onSessionEvent = useCallback((sessionId: string, listener: () => void) => {
    const set = listeners.current.get(sessionId) ?? new Set()
    set.add(listener)
    listeners.current.set(sessionId, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) listeners.current.delete(sessionId)
    }
  }, [])

  const unread = useMemo(() => new Set(sessions.filter((session) => {
    const reply = session.lastReply ?? previews[session.id]?.reply
    if (session.id === activeSessionId) return false
    const seen = Math.max(marks[session.id]?.at ?? 0, session.lastOpenedAt ?? 0)
    const readAt = seen || (marks._baseline?.at ?? Infinity)
    return marksReady && !!reply && reply.at > readAt
  }).map((session) => session.id)), [sessions, previews, marks, marksReady, activeSessionId])
  const value = useMemo<RemoteState>(
    () => ({ client, stream, sessions, projects, questions, runners, activeSessionId, info, unread, marksReady, markRead, previews, error, refresh, onSessionEvent }),
    [client, stream, sessions, projects, questions, runners, activeSessionId, info, unread, marksReady, markRead, previews, error, refresh, onSessionEvent]
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
