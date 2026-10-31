import { useCallback, useState } from 'react'
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

function effortLabel(level: string): string {
  return EFFORT_LABELS[level] ?? level
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
  const setThinking = useStore((s) => s.setThinking)
  const setUltracode = useStore((s) => s.setUltracode)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const busy = !!session?.isStreaming || !!session?.isCompacting
  const ultracode = !!session?.ultracode
  const level = session?.thinkingLevel ?? 'off'
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
      if (busy) return
      if (isUltracodeSelection(value)) {
        requestUltracode()
        return
      }
      if (ultracode) void setUltracode(false)
      if (value !== level) void setThinking(value)
    },
    [busy, level, requestUltracode, setThinking, setUltracode, ultracode]
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
