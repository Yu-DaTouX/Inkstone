import { SparklesIcon, ShieldOffIcon, type LucideIcon } from 'lucide-react'
import type { PermissionMode } from '../../../../../shared/approval'

export const runtimeModeIcons: Record<PermissionMode, LucideIcon> = {
  danger: SparklesIcon,
  all: ShieldOffIcon
}

export const runtimeModeOrder: readonly PermissionMode[] = ['danger', 'all']
