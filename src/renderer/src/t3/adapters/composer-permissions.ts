import { useCallback, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  DEFAULT_PERMISSION_MODE,
  normalizePermissionMode,
  type PermissionMode
} from '../../../../shared/approval'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { runtimeModeIcons, runtimeModeOrder } from '../components/chat/runtimeModeConfig'

export type RuntimeModeOption = {
  mode: PermissionMode
  label: string
  description: string
  icon: LucideIcon
}

export function usePermissionAdapter(): {
  mode: PermissionMode
  matchesDefault: boolean
  options: readonly RuntimeModeOption[]
  pendingMode: PermissionMode | null
  requestMode: (mode: PermissionMode) => void
  confirmPending: () => void
  cancelPending: () => void
} {
  const t = useT()
  const stored = useStore((s) => s.settings?.permissionMode)
  const patchSettings = useStore((s) => s.patchSettings)
  const notify = useStore((s) => s.notify)
  const [pendingMode, setPendingMode] = useState<PermissionMode | null>(null)
  const mode = normalizePermissionMode(stored)

  const options: RuntimeModeOption[] = runtimeModeOrder.map((entry) => ({
    mode: entry,
    label: t(`permission.label.${entry}` as 'permission.label.danger'),
    description: t(`permission.hint.${entry}` as 'permission.hint.danger'),
    icon: runtimeModeIcons[entry]
  }))

  const apply = useCallback(
    (next: PermissionMode) => {
      void patchSettings({ permissionMode: next }).catch((error) =>
        notify('error', String(error))
      )
    },
    [notify, patchSettings]
  )

  const requestMode = useCallback(
    (next: PermissionMode) => {
      if (next === mode) return
      if (next === 'all') {
        setPendingMode(next)
        return
      }
      apply(next)
    },
    [apply, mode]
  )

  const confirmPending = useCallback(() => {
    if (pendingMode) apply(pendingMode)
    setPendingMode(null)
  }, [apply, pendingMode])

  const cancelPending = useCallback(() => setPendingMode(null), [])

  return {
    mode,
    matchesDefault: mode === DEFAULT_PERMISSION_MODE,
    options,
    pendingMode,
    requestMode,
    confirmPending,
    cancelPending
  }
}
