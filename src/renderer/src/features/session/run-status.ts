import { useRef, useSyncExternalStore } from 'react'
import { useStore } from '../../state/store'
import { deriveRunProgress, resolveRunClock, type RunClock, type RunProgress } from '../../../../shared/run-progress'
import { isStopRequested, stopIntent, subscribeStopIntent } from './stop-intent'
import { trackThinking, turnOutputTokens, workingLine, type ThinkingClock, type WorkingLine } from './working-line-model'
import { useTurnScope } from './turn-scope'
import { useRunNow } from './run-clock'

const ASKING_METHODS = new Set(['select', 'confirm', 'input', 'editor'])

export function useWorkingLine(): WorkingLine | null {
  const progress = useRunProgress()
  const scope = useTurnScope()
  const ownSession = useStore((s) => s.session)
  const ownMessages = useStore((s) => s.messages)
  const session = scope ? scope.session : ownSession
  const messages = scope ? scope.messages : ownMessages
  const approvals = useStore((s) => s.approvals)
  const uiRequests = useStore((s) => s.uiRequests)
  const intent = useSyncExternalStore(subscribeStopIntent, stopIntent)
  const thinkingRef = useRef<ThinkingClock | null>(null)
  const now = useRunNow(!!progress)

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
  const waiting = approvals.some((request) => !request.subagentId && (request.sessionId ? request.sessionId === sessionId : !scope))
    || (!scope && uiRequests.some((request) => ASKING_METHODS.has(request.method)))

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
  const scope = useTurnScope()
  const ownSession = useStore((s) => s.session)
  const ownMessages = useStore((s) => s.messages)
  const session = scope ? scope.session : ownSession
  const messages = scope ? scope.messages : ownMessages
  const runnerId = useStore((s) => s.activeRunnerId)
  const compacting = !!session?.isCompacting
  const running = !!session?.isAgentRunning || !!session?.isStreaming || compacting
  const startedRef = useRef<RunClock | null>(null)
  const now = useRunNow(running)

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
  startedRef.current = clock

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
