import { useEffect, useRef } from 'react'
import type { RunPhase, RunSnapshot } from '../../../shared/runs'
import { useI18n } from '../i18n'
import { showToast, toastQueue, type ToastTone } from '../ui'
import { useStore } from '../state/store'
import { attentionPills, phaseDetail, phaseWord, runUiText, useRunsV3 } from '../state/runs-v3'

const DETAIL_MAX = 140
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

function clip(text: string | null): string | undefined {
  const flat = text?.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX)}…` : flat
}

export function RunAttentionToasts({ onOpen }: { onOpen: (run: RunSnapshot) => void }): null {
  const { lang } = useI18n()
  const runs = useRunsV3((s) => s.runs)
  const sessionId = useStore((s) => s.session?.sessionId)
  const sessionPath = useStore((s) => s.session?.sessionFile)
  const peekedPath = useStore((s) => s.peekedPath)
  const open = useRef(new Map<string, string>())
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen

  useEffect(() => {
    const text = runUiText(lang)
    const visible = { sessionId, sessionPath, peekedPath: peekedPath ?? undefined }
    const current = new Map(attentionPills(runs, visible, 8).map((run) => [phaseSignature(run), run]))

    for (const [signature, key] of open.current) {
      if (current.has(signature)) continue
      toastQueue.close(key)
      open.current.delete(signature)
    }

    for (const [signature, run] of current) {
      if (toasted.has(signature)) continue
      toasted.add(signature)
      const key = showToast(`${run.code} ${run.title || text.untitled} · ${phaseWord(lang, run.phase)}`, {
        tone: toneOf(run.phase),
        description: clip(phaseDetail(lang, run.phase)),
        action: { label: text.openSession, onAction: () => onOpenRef.current(run) },
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
  }, [runs, sessionId, sessionPath, peekedPath, lang])

  return null
}
