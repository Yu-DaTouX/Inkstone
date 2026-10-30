import { useCallback, useState } from 'react'
import { useT } from '../../i18n'
import { levelLabel } from '../../patterns/ThinkingBadge'
import { currentThinkingLevels, useStore } from '../../state/store'
import {
  buildReasoningDescriptor,
  buildTraitsTriggerDisplay,
  isUltracodeSelection,
  type SelectDescriptor,
  type TraitsTriggerDisplay
} from './model-traits'

const ULTRACODE_LABEL = 'Ultracode'

export type ComposerTraitsAdapter = {
  descriptor: SelectDescriptor
  display: TraitsTriggerDisplay
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
  const descriptor = buildReasoningDescriptor({
    levels,
    current: level,
    ultracode,
    ultracodeLabel: ULTRACODE_LABEL,
    ultracodeDescription: t('picker.deepDesc'),
    sectionLabel: t('picker.think'),
    levelLabel: (entry) => levelLabel(t, entry)
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
