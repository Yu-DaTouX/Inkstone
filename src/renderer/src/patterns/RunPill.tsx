import { useMemo, useState, type ReactElement } from 'react'
import { X } from 'lucide-react'
import type { RunSnapshot } from '../../../shared/runs'
import { useI18n } from '../i18n'
import { IconButton } from '../ui'
import { useStore } from '../state/store'
import {
  attentionPills,
  isStickyRun,
  isUnreadRun,
  phaseWord,
  runTone,
  runUiText
} from '../state/runs-v3'
import { useRunsV3 } from '../state/runs-v3'
import { RunDot } from './RunDot'
import './run-status.css'

export interface RunPillProps {
  /**
   * 点开某个运行。缺省走正式路径 `useStore.switchSession(path)` 回到会话；
   * 父会话若要直接跳到那条请求 / 路由，用自己的实现覆盖。
   */
  onOpen?: (run: RunSnapshot) => void
  /** 展开全部运行（父会话可打开运行总览页）。不给就不显示入口。 */
  onShowAll?: () => void
  className?: string
}

/** 同一 runId 在阶段真正变化后才重新出现（关掉「运行中」不代表关掉「失败」）。 */
function phaseSignature(run: RunSnapshot): string {
  const phase = run.phase
  switch (phase.kind) {
    case 'failed':
    case 'stopped':
    case 'done':
      return `${phase.kind}:${phase.at}`
    case 'needs-you':
      return `${phase.kind}:${phase.request.id}`
    default:
      return `${phase.kind}:${phase.since}`
  }
}

/**
 * 多会话提醒条（WP-13）。
 *
 * 自订阅运行列表，只显示需要用户注意的运行：等你确认 > 停滞 > 失败。
 * 同一会话最多一条、最多两条；当前正在看的会话会被过滤，避免与对话内提示重复。
 * 低优先的可以关掉，但「等你确认」永远不可隐去 —— 提醒条不能替用户丢掉待审批。
 */
export function RunPill({ onOpen, onShowAll, className }: RunPillProps): ReactElement | null {
  const { lang } = useI18n()
  const text = runUiText(lang)
  const runs = useRunsV3((s) => s.runs)
  const sessionId = useStore((s) => s.session?.sessionId)
  const sessionPath = useStore((s) => s.session?.sessionFile)
  const peekedPath = useStore((s) => s.peekedPath)
  const sessions = useStore((s) => s.sessions)
  const switchSession = useStore((s) => s.switchSession)
  const [dismissed, setDismissed] = useState<Record<string, string>>({})

  const pills = useMemo(() => {
    const visible = { sessionId, sessionPath, peekedPath: peekedPath ?? undefined }
    /* 多取几条再过滤已关闭的，避免关掉一条低优先后空出位置却不补下一条。 */
    return attentionPills(runs, visible, 8)
      .filter((run) => isStickyRun(run) || dismissed[run.runId] !== phaseSignature(run))
      .slice(0, 2)
  }, [runs, sessionId, sessionPath, peekedPath, dismissed])

  if (pills.length === 0) return null

  const open = (run: RunSnapshot): void => {
    if (onOpen) {
      onOpen(run)
      return
    }
    const path = run.sessionPath ?? sessions.find((s) => s.id === run.sessionId)?.path
    if (path) void switchSession(path)
  }

  const dismiss = (run: RunSnapshot): void => {
    setDismissed((prev) => ({ ...prev, [run.runId]: phaseSignature(run) }))
  }

  return (
    <div className={`run-pills ${className ?? ''}`.trim()} role="list" aria-label={text.attention}>
      {pills.map((run) => {
        const title = run.title || text.untitled
        const word = phaseWord(lang, run.phase)
        return (
          <span className="run-pill" data-tone={runTone(run.phase)} role="listitem" key={run.runId}>
            <button
              type="button"
              className="run-pill-main"
              onClick={() => open(run)}
              title={`${run.code} · ${title} · ${word}`}
            >
              <RunDot phase={run.phase} code={run.code} unread={isUnreadRun(run)} />
              <span className="run-pill-code">{run.code}</span>
              <span className="run-pill-title">{title}</span>
              <span className="run-pill-word">{word}</span>
            </button>
            {isStickyRun(run) ? null : (
              <IconButton
                aria-label={`${text.dismiss} ${run.code}`}
                size="sm"
                variant="ghost"
                className="run-pill-close"
                onPress={() => dismiss(run)}
              >
                <X size={14} aria-hidden="true" />
              </IconButton>
            )}
          </span>
        )
      })}
      {onShowAll ? (
        <button type="button" className="run-pill-all" onClick={onShowAll}>
          {text.showAll}
        </button>
      ) : null}
    </div>
  )
}
