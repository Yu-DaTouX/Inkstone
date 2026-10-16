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
  onOpen?: (run: RunSnapshot) => void
  onShowAll?: () => void
  className?: string
}

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
