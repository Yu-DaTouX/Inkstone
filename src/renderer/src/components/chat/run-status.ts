import { useEffect, useRef, useState } from 'react'
import type { TFunc } from '../../i18n'
import { useStore } from '../../state/store'
import { deriveRunProgress, resolveRunClock, type RunClock, type RunProgress } from '../../../../shared/run-progress'
import { compactionRunningText } from '../../state/compaction-view'

/**
 * 本回合的运行阶段：回合活动行、输入框的「停止 + 计时」与诊断共用同一份投影，
 * 因此各处的阶段文字与计时同拍。
 *
 * 数据全部来自已有 store 快照，不新增 IPC：running（agent_start → settled）、
 * 正文流、最后一条 running 的 toolCall、可见思考流（`thinkingLive`）。
 * 阶段本身由 `deriveRunProgress` 纯投影决定，这里只负责把快照凑齐。
 */
export function useRunProgress(): RunProgress | null {
  const session = useStore((s) => s.session)
  const messages = useStore((s) => s.messages)
  const runnerId = useStore((s) => s.activeRunnerId)
  const compacting = !!session?.isCompacting
  /* 压缩可以独立发生（/compact、回合之间的自动压缩），此时没有 agent_start，也算运行 */
  const running = !!session?.isAgentRunning || !!session?.isStreaming || compacting
  const startedRef = useRef<RunClock | null>(null)
  const [now, setNow] = useState(() => Date.now())

  /* 只看本回合：最后一条用户消息之后的部分 */
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
    /* 秒级心跳只为了耗时，不推进阶段；切会话时清理旧实例的心跳。 */
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

/** 运行中的工具说明：命令原文（`$ npm run check`）或「工具名 目标」，比光秃秃的工具名有用 */
function runLabel(call: { name: string; args?: unknown }): string {
  const a = (call.args && typeof call.args === 'object' ? call.args : {}) as Record<string, unknown>
  if (typeof a.command === 'string' && a.command.trim()) return `$ ${a.command.trim().split(/\r?\n/)[0]}`
  const target = [a.path, a.file_path, a.pattern, a.query, a.url].find((v) => typeof v === 'string' && v)
  return target ? `${call.name} ${String(target)}` : call.name
}



/**
 * 阶段文案只说真的发生了的事。超过 30 秒后仍保留当前阶段和工具名，
 * 避免长任务的活动行一直只显示「仍在运行」。耗时由活动行单独显示。
 */
export function runPhaseText(t: TFunc, progress: RunProgress | null, compaction: Parameters<typeof compactionRunningText>[1]): string {
  if (!progress) return ''
  switch (progress.phase) {
    case 'compacting': return compactionRunningText(t, compaction)
    default: break
  }
  switch (progress.phase) {
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
