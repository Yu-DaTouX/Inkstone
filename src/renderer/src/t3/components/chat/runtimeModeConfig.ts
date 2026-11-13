import { SparklesIcon, ShieldOffIcon, type LucideIcon } from '../../../ui/icons'
import type { PermissionMode } from '../../../../../shared/approval'

export const runtimeModeIcons: Record<PermissionMode, LucideIcon> = {
  danger: SparklesIcon,
  all: ShieldOffIcon
}

export const runtimeModeOrder: readonly PermissionMode[] = ['danger', 'all']
