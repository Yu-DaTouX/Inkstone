import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { TFunc } from '../../i18n'
import { useStore } from '../../state/store'
import { deriveRunProgress, resolveRunClock, type RunClock, type RunProgress } from '../../../../shared/run-progress'
import { compactionRunningText } from '../../state/compaction-view'
import { isStopRequested, stopIntent, subscribeStopIntent } from './stop-intent'
import { trackThinking, turnOutputTokens, workingLine, type ThinkingClock, type WorkingLine } from './working-line-model'

const ASKING_METHODS = new Set(['select', 'confirm', 'input', 'editor'])

export function useWorkingLine(): WorkingLine | null {
  const progress = useRunProgress()
  const session = useStore((s) => s.session)
  const messages = useStore((s) => s.messages)
  const approvals = useStore((s) => s.approvals)
  const uiRequests = useStore((s) => s.uiRequests)
  const intent = useSyncExternalStore(subscribeStopIntent, stopIntent)
  const thinkingRef = useRef<ThinkingClock | null>(null)
  const now = Date.now()

  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      lastUser = i
      break
    }
  }
  const userId = lastUser >= 0 ? messages[lastUser].id : null
  let assistant: (typeof messages)[number] | null = null
  for (let i = messages.length - 1; i > lastUser; i -= 1) {
    if (messages[i].role === 'assistant') {
      assistant = messages[i]
      break
    }
  }
  const sessionId = session?.sessionId ?? null
  const thinking = trackThinking(thinkingRef.current, {
    identity: `${sessionId ?? ''}|${userId ?? ''}`,
    live: !!assistant?.thinkingLive,
    ms: assistant?.thinkingMs,
    now
  })
  thinkingRef.current = thinking

  const running = !!progress
  const elapsedMs = progress ? progress.elapsedMs : null
  const runStartedAt = progress ? now - progress.elapsedMs : null
  const waiting = approvals.some((request) => !request.subagentId && (!request.sessionId || request.sessionId === sessionId))
    || uiRequests.some((request) => ASKING_METHODS.has(request.method))

  return workingLine({
    running,
    stopping: isStopRequested(intent, sessionId, runStartedAt),
    waiting: running && waiting,
    retry: session?.retry ?? null,
    compacting: !!session?.isCompacting || progress?.phase === 'compacting',
    toolRunning: progress?.phase === 'tool',
    streaming: progress?.phase === 'responding',
    requested: !!assistant,
    thinking,
    elapsedMs,
    now,
    tokens: turnOutputTokens(messages, userId),
    quiet: messages.slice(lastUser + 1).some((message) => message.role === 'assistant' && message.toolCalls?.some((call) => call.status === 'running' || call.status === 'pending')) || !!assistant?.thinkingLive && !!assistant.thinking?.trim()
  })
}

export function useRunProgress(): RunProgress | null {
  const session = useStore((s) => s.session)
  const messages = useStore((s) => s.messages)
  const runnerId = useStore((s) => s.activeRunnerId)
  const compacting = !!session?.isCompacting
  const running = !!session?.isAgentRunning || !!session?.isStreaming || compacting
  const startedRef = useRef<RunClock | null>(null)
  const [now, setNow] = useState(() => Date.now())

  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      lastUser = i
      break
    }
  }
  const turn = messages.slice(lastUser + 1)
  const user = messages[lastUser]
  const standaloneCompaction = compacting && !session?.isAgentRunning
  const identity = JSON.stringify([session?.sessionId, runnerId, user?.id, user?.timestamp,
    standaloneCompaction ? session?.compaction?.startedAt ?? 'compact' : 'turn'])
  const reportedStartedAt = standaloneCompaction ? session?.compaction?.startedAt : user?.timestamp ?? turn[0]?.timestamp
  const clock = resolveRunClock(startedRef.current, { identity, running, startedAt: reportedStartedAt, now })

  useEffect(() => {
    startedRef.current = resolveRunClock(startedRef.current, { identity, running, startedAt: reportedStartedAt, now: Date.now() })
    if (!running) return undefined
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [identity, running, reportedStartedAt])

  if (!running) return null

  let tool: { name: string; startedAt?: number } | null = null
  let thinking = false
  for (let i = turn.length - 1; i >= 0; i -= 1) {
    const message = turn[i]
    if (message.thinkingLive) thinking = true
    if (!tool) {
      const call = [...(message.toolCalls ?? [])].reverse().find((item) => item.status === 'running')
      if (call) {
        tool = { name: runLabel(call), ...(call.startedAt !== undefined ? { startedAt: call.startedAt } : {}) }
      }
    }
  }

  const requested = !!session?.isStreaming || turn.some((message) => message.role === 'assistant')

  return deriveRunProgress({
    running: true,
    streaming: !!session?.isStreaming,
    compacting,
    tool,
    thinking,
    requested,
    terminal: null,
    startedAt: clock?.startedAt ?? null,
    now
  })
}

function runLabel(call: { name: string; args?: unknown }): string {
  const a = (call.args && typeof call.args === 'object' ? call.args : {}) as Record<string, unknown>
  if (typeof a.command === 'string' && a.command.trim()) return `$ ${a.command.trim().split(/\r?\n/)[0]}`
  const target = [a.path, a.file_path, a.pattern, a.query, a.url].find((v) => typeof v === 'string' && v)
  return target ? `${call.name} ${String(target)}` : call.name
}


export function runPhaseText(t: TFunc, progress: RunProgress | null, compaction: Parameters<typeof compactionRunningText>[1]): string {
  if (!progress) return ''
  switch (progress.phase) {
    case 'compacting': return compactionRunningText(t, compaction)
    case 'tool': return t('run.tool', { name: progress.detail ?? '' })
    case 'thinking': return t('run.thinking')
    case 'responding': return t('run.responding')
    case 'requesting': return t('run.requesting')
    case 'preparing': return t('run.preparing')
    case 'failed': return t('run.failed')
    case 'cancelled': return t('run.cancelled')
    default: return t('chat.working')
  }
}
