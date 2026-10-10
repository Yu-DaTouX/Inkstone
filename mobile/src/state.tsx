/**
 * 手机端的连接与数据状态。
 *
 * 一个 RemoteClient + 一条事件流；收到事件时只刷新受影响的那部分：
 *   · ui-request / ui-resolved / ui-deadline → 重新拉问题列表
 *   · state / runners / proc → 重新拉快照（运行中状态、可中止的 runId）
 *   · msg-* / tool / session-title → 通知正在看的会话刷新历史，并刷新会话列表
 * 收到 resync（电脑重启过或断线太久）就全部重拉。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RemoteEventEnvelope, RemotePendingQuestion, RemoteInfo, RemoteModel } from '../../src/shared/remote-protocol'
import { RemoteClient, RemoteEventStream, RemoteHttpError, type Connection, type SessionListItem, type StreamState } from './api/client'
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
  /** 订阅某个会话的消息事件（返回取消订阅） */
  onSessionEvent(sessionId: string, listener: () => void): () => void
}

const Ctx = createContext<RemoteState | null>(null)

export function useRemote(): RemoteState {
  const value = useContext(Ctx)
  if (!value) throw new Error('useRemote 必须在 RemoteProvider 里使用')
  return value
}

const MESSAGE_CHANNELS = new Set(['msg-add', 'msg-update', 'msg-remove', 'tool', 'session-title'])
const QUESTION_CHANNELS = new Set(['ui-request', 'ui-resolved', 'ui-deadline'])
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
        } catch { /* Keep the last successful preview while the desktop reconnects. */ }
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

  /** Bounded refresh frequency without waiting for a continuous stream to become quiet. */
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
    const events = new RemoteEventStream(connection, {
      onState: (state) => { setStream(state); if (state === 'open') void refreshInfo() },
      onUnauthorized,
      onResync: () => void refresh(),
      onEvent: (event) => {
        if (QUESTION_CHANNELS.has(event.channel)) debounce('questions', () => void refreshQuestions())
        if (STATUS_CHANNELS.has(event.channel)) {
          debounce('status', () => void refreshStatus())
          /*
           * 状态变化也要重取历史：流式的 `msg-add` 到达时电脑往往还没把消息写进会话文件，
           * 真正写完要等回合结束（`state.isAgentRunning=false`）。只靠消息事件刷新，
           * 手机端就会一直停在旧内容，必须手动下拉刷新才能看到最终回复。
           */
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
    /* 任一端看过都算已读：手机的已读标记与电脑记的打开时间取较晚者；电脑正开着的会话也算看过 */
    if (session.id === activeSessionId) return false
    const seen = Math.max(marks[session.id]?.at ?? 0, session.lastOpenedAt ?? 0)
    const readAt = seen || (marks._baseline?.at ?? Infinity)
    return marksReady && !!reply && reply.at > readAt
  }).map((session) => session.id)), [sessions, previews, marks, marksReady, activeSessionId])
  const value = useMemo<RemoteState>(
    () => ({ client, stream, sessions, questions, runners, activeSessionId, info, unread, marksReady, markRead, previews, error, refresh, onSessionEvent }),
    [client, stream, sessions, questions, runners, activeSessionId, info, unread, marksReady, markRead, previews, error, refresh, onSessionEvent]
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
