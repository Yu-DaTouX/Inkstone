import { useEffect, useRef } from 'react'
import type { RunPhase, RunRequestType, RunSnapshot } from '../../../shared/runs'
import { useI18n } from '../i18n'
import { showToast, toastQueue, type ToastTone } from '../ui'
import { useStore } from '../state/store'
import { useSplitView } from '../state/split-view'
import { attentionPills, phaseDetail, phaseWord, runUiText, useRunsV3 } from '../state/runs-v3'
import { errorCardModel, errorTitleKey } from '../features/session/turn-lines'
import { sessionText } from '../features/session/text'
import { focusAskDockFor } from '../features/session/AskDock'

const DETAIL_MAX = 140
const TITLE_MAX = 60
const toasted = new Set<string>()

function phaseSignature(run: RunSnapshot): string {
  const phase = run.phase
  switch (phase.kind) {
    case 'failed':
    case 'stopped':
    case 'done':
      return `${run.runId}|${phase.kind}:${phase.at}`
    case 'needs-you':
      return `${run.runId}|${phase.kind}:${phase.request.id}`
    default:
      return `${run.runId}|${phase.kind}:${phase.since}`
  }
}

function toneOf(phase: RunPhase): ToastTone {
  return phase.kind === 'failed' ? 'danger' : 'warning'
}

function toastDetail(lang: Parameters<typeof phaseDetail>[0], phase: RunPhase): string | null {
  const model = phase.kind === 'failed' && phase.message ? errorCardModel(phase.message) : null
  return model ? sessionText(lang, errorTitleKey(model)) : phaseDetail(lang, phase)
}

const approvalRequest = (type: RunRequestType): boolean => type === 'danger' || type === 'confirm'

function askTitle(lang: Parameters<typeof phaseDetail>[0], name: string, type: RunRequestType): string {
  if (lang === 'en-US') return approvalRequest(type) ? `"${name}" needs your approval` : `"${name}" is waiting for your answer`
  return approvalRequest(type) ? `「${name}」在等你确认` : `「${name}」在等你回答`
}

function askAction(lang: Parameters<typeof phaseDetail>[0], type: RunRequestType): string {
  if (lang === 'en-US') return approvalRequest(type) ? 'Review' : 'Answer'
  return approvalRequest(type) ? '去处理' : '去回答'
}

function clip(text: string | null | undefined, max = DETAIL_MAX): string | undefined {
  const flat = text?.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export function RunAttentionToasts({ onOpen }: { onOpen: (run: RunSnapshot) => void }): null {
  const { lang } = useI18n()
  const runs = useRunsV3((s) => s.runs)
  const sessionId = useStore((s) => s.session?.sessionId)
  const sessionPath = useStore((s) => s.session?.sessionFile)
  const peekedPath = useStore((s) => s.peekedPath)
  const splitTiles = useSplitView((s) => s.split?.tiles)
  const open = useRef(new Map<string, string>())
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen

  useEffect(() => {
    const text = runUiText(lang)
    const visible = { sessionId, sessionPath, peekedPath: peekedPath ?? undefined }
    const inSplit = (run: RunSnapshot): boolean =>
      !!splitTiles?.some((tile) => (!!tile.sessionId && tile.sessionId === run.sessionId) || (!!tile.path && tile.path === run.sessionPath))
    const current = new Map(attentionPills(runs, visible, 8).filter((run) => !inSplit(run)).map((run) => [phaseSignature(run), run]))

    for (const [signature, key] of open.current) {
      if (current.has(signature)) continue
      toastQueue.close(key)
      open.current.delete(signature)
    }

    for (const [signature, run] of current) {
      if (toasted.has(signature)) continue
      toasted.add(signature)
      const asking = run.phase.kind === 'needs-you' ? run.phase : null
      const name = clip(run.title, TITLE_MAX) || text.untitled
      const key = showToast(asking ? askTitle(lang, name, asking.request.type) : `${run.code} ${name} · ${phaseWord(lang, run.phase)}`, {
        tone: toneOf(run.phase),
        description: clip(asking ? asking.request.summary : toastDetail(lang, run.phase)),
        action: {
          label: asking ? askAction(lang, asking.request.type) : text.openSession,
          onAction: () => {
            onOpenRef.current(run)
            if (asking && run.sessionId) focusAskDockFor(run.sessionId)
          }
        },
        timeout: run.phase.kind === 'needs-you' ? 0 : 10000,
        onClose: () => open.current.delete(signature)
      })
      open.current.set(signature, key)
    }

    if (toasted.size > 512) {
      const recent = [...toasted].slice(-256)
      toasted.clear()
      for (const signature of recent) toasted.add(signature)
    }
  }, [runs, sessionId, sessionPath, peekedPath, splitTiles, lang])

  return null
}
