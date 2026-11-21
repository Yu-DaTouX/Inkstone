import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
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
const LOCKED_LEVELS = ['off'] as const

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

type ThinkingRequest = { sessionId: string; owner: string; level: string }
type PendingThinking = ThinkingRequest | null

let pendingThinking: PendingThinking = null
let sendingThinking = false
let queuedThinking: PendingThinking = null
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

function thinkingOwner(state: ReturnType<typeof useStore.getState>): string {
  const { session, activeRunnerId, peekedSessionId } = state
  return JSON.stringify([peekedSessionId, session?.sessionId, activeRunnerId, session?.model?.provider, session?.model?.id])
}

async function sendThinking(request: ThinkingRequest): Promise<void> {
  sendingThinking = true
  try {
    const state = useStore.getState()
    if (thinkingOwner(state) === request.owner) await state.setThinking(request.level)
  } finally {
    const next = queuedThinking
    queuedThinking = null
    if (next && (next.owner !== request.owner || next.level !== request.level) && thinkingOwner(useStore.getState()) === next.owner) {
      void sendThinking(next)
    } else {
      sendingThinking = false
      setPendingThinking(null)
    }
  }
}

export function requestThinkingLevel(sessionId: string, level: string): void {
  const state = useStore.getState()
  if (state.session?.sessionId !== sessionId || state.peekedSessionId) return
  const request = { sessionId, owner: thinkingOwner(state), level }
  setPendingThinking(request)
  if (sendingThinking) {
    queuedThinking = request
    return
  }
  void sendThinking(request)
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

export function selectComposerThinking({ session }: Pick<ReturnType<typeof useStore.getState>, 'session'>) {
  const antigravity = session?.model?.provider === 'antigravity'
  return {
    antigravity,
    busy: !!session?.isStreaming || !!session?.isCompacting || (antigravity && !!session?.isAgentRunning),
    ultracode: !!session?.ultracode,
    sessionId: session?.sessionId ?? '',
    storedLevel: session?.thinkingLevel || 'off',
    options: antigravity ? session?.antigravity?.thinking?.options : undefined
  }
}

export function useComposerTraits(): ComposerTraitsAdapter | null {
  const t = useT()
  const { antigravity, busy, ultracode, sessionId, storedLevel, options } = useStore(useShallow(selectComposerThinking))
  const owner = useStore(thinkingOwner)
  const levels = useStore(useShallow(currentThinkingLevels))
  const pending = useSyncExternalStore(subscribePendingThinking, pendingThinkingSnapshot)
  const setUltracode = useStore((s) => s.setUltracode)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const level = pending?.owner === owner && (!antigravity || levels.includes(pending.level)) ? pending.level : storedLevel
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
  const descriptor = useMemo(() => {
    const labelOf = (value: string) => options?.find((option) => option.id === value)?.name ??
      (antigravity && !levels.length ? t('picker.thinkUnknownShort') : effortLabel(value))
    return buildReasoningDescriptor({
      levels,
      current: level,
      ultracode,
      ultracodeLabel: antigravity ? '' : ULTRACODE_LABEL,
      ultracodeDescription: t('picker.deepDesc'),
      sectionLabel: t('picker.think'),
      levelLabel: labelOf
    }) ?? buildLockedReasoningDescriptor({
      sectionLabel: t('picker.think'),
      levelLabel: () => antigravity && levels.length === 1 ? labelOf(level) : labelOf('off')
    })
  }, [antigravity, level, levels, options, t, ultracode])
  const canUltracode = !antigravity && levels.length > 1 && !!sessionId && !ultracode && !busy

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
      if (antigravity && busy) return
      if (isUltracodeSelection(value)) {
        requestUltracode()
        return
      }
      if (ultracode) void setUltracode(false)
      if (value !== level && sessionId) requestThinkingLevel(sessionId, value)
    },
    [antigravity, busy, level, requestUltracode, sessionId, setUltracode, ultracode]
  )

  return useMemo(() => descriptor ? {
    descriptor,
    display: buildTraitsTriggerDisplay(descriptor),
    levels: levels.length > 1 ? levels : LOCKED_LEVELS,
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
  } : null, [descriptor, levels, unsupportedReason, unsupportedShortLabel, busy, ultracode, canUltracode, confirmOpen, select, requestUltracode, confirmUltracode, cancelUltracode])
}
