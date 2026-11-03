import { useCallback, useState, useSyncExternalStore } from 'react'
import { useT } from '../../i18n'
import { currentThinkingLevels, useStore } from '../../state/store'
import {
  buildLockedReasoningDescriptor,
  buildReasoningDescriptor,
  buildTraitsTriggerDisplay,
  isUltracodeSelection,
  type SelectDescriptor,
  type TraitsTriggerDisplay
} from './model-traits'

const ULTRACODE_LABEL = 'Ultracode'

const EFFORT_LABELS: Record<string, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max'
}

const EFFORT_HINT_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export const EFFORT_TITLE = 'Thinking'

type PendingThinking = { sessionId: string; level: string } | null

let pendingThinking: PendingThinking = null
let sendingThinking = false
let queuedThinking: { sessionId: string; level: string } | null = null
const pendingListeners = new Set<() => void>()

function setPendingThinking(next: PendingThinking): void {
  pendingThinking = next
  for (const listener of pendingListeners) listener()
}

function subscribePendingThinking(listener: () => void): () => void {
  pendingListeners.add(listener)
  return () => pendingListeners.delete(listener)
}

function pendingThinkingSnapshot(): PendingThinking {
  return pendingThinking
}

async function sendThinking(sessionId: string, level: string): Promise<void> {
  sendingThinking = true
  try {
    await useStore.getState().setThinking(level)
  } finally {
    const next = queuedThinking
    queuedThinking = null
    if (next && next.sessionId === sessionId && next.level !== level) {
      void sendThinking(next.sessionId, next.level)
    } else {
      sendingThinking = false
      if (pendingThinking?.sessionId === sessionId) setPendingThinking(null)
    }
  }
}

export function requestThinkingLevel(sessionId: string, level: string): void {
  setPendingThinking({ sessionId, level })
  if (sendingThinking) {
    queuedThinking = { sessionId, level }
    return
  }
  void sendThinking(sessionId, level)
}

function effortLabel(level: string): string {
  return EFFORT_LABELS[level] ?? level
}

export function effortHint(t: ReturnType<typeof useT>, level: string): string {
  return EFFORT_HINT_LEVELS.has(level) ? t(`picker.effortHint.${level}` as 'picker.effortHint.off') : ''
}

export type ComposerTraitsAdapter = {
  descriptor: SelectDescriptor
  display: TraitsTriggerDisplay
  levels: readonly string[]
  unsupportedReason: string | null
  unsupportedShortLabel: string | null
  busy: boolean
  ultracode: boolean
  canUltracode: boolean
  ultracodeConfirmOpen: boolean
  select: (value: string) => void
  requestUltracode: () => void
  confirmUltracode: () => void
  cancelUltracode: () => void
}

export function useComposerTraits(): ComposerTraitsAdapter | null {
  const t = useT()
  const session = useStore((s) => s.session)
  const levels = useStore(currentThinkingLevels)
  const pending = useSyncExternalStore(subscribePendingThinking, pendingThinkingSnapshot)
  const setUltracode = useStore((s) => s.setUltracode)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const busy = !!session?.isStreaming || !!session?.isCompacting
  const ultracode = !!session?.ultracode
  const sessionId = session?.sessionId ?? ''
  const level = pending && pending.sessionId === sessionId ? pending.level : session?.thinkingLevel ?? 'off'
  const unsupportedReason =
    levels.length > 1
      ? null
      : levels.length === 0
        ? t('picker.thinkUnknown')
        : t('picker.thinkUnsupported')
  const unsupportedShortLabel =
    levels.length > 1
      ? null
      : levels.length === 0
        ? t('picker.thinkUnknownShort')
        : t('picker.thinkUnsupportedShort')
  const descriptor =
    buildReasoningDescriptor({
      levels,
      current: level,
      ultracode,
      ultracodeLabel: ULTRACODE_LABEL,
      ultracodeDescription: t('picker.deepDesc'),
      sectionLabel: t('picker.think'),
      levelLabel: effortLabel
    }) ??
    buildLockedReasoningDescriptor({
      sectionLabel: t('picker.think'),
      levelLabel: effortLabel
    })
  const canUltracode = levels.length > 1 && !!session?.sessionId && !ultracode && !busy

  const requestUltracode = useCallback(() => {
    if (!canUltracode) return
    setConfirmOpen(true)
  }, [canUltracode])

  const confirmUltracode = useCallback(() => {
    setConfirmOpen(false)
    void setUltracode(true)
  }, [setUltracode])

  const cancelUltracode = useCallback(() => setConfirmOpen(false), [])

  const select = useCallback(
    (value: string) => {
      if (isUltracodeSelection(value)) {
        requestUltracode()
        return
      }
      if (ultracode) void setUltracode(false)
      if (value !== level && sessionId) requestThinkingLevel(sessionId, value)
    },
    [level, requestUltracode, sessionId, setUltracode, ultracode]
  )

  if (!descriptor) return null

  return {
    descriptor,
    display: buildTraitsTriggerDisplay(descriptor),
    levels: levels.length > 1 ? levels : ['off'],
    unsupportedReason,
    unsupportedShortLabel,
    busy,
    ultracode,
    canUltracode,
    ultracodeConfirmOpen: confirmOpen,
    select,
    requestUltracode,
    confirmUltracode,
    cancelUltracode
  }
}
