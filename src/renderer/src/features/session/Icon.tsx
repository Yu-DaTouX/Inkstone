/**
 * 会话模块用到的图标（lucide-react 薄封装）。
 *
 * 图标不是控件，也不含外观样式；这里只做「语义名 → lucide 组件」的映射，
 * 让会话标语不必散落各处 import。控件统一来自共享 `ui/`。
 */
import type { JSX } from 'react'
import {
  AlertCircle,
  ArrowDown,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleStop,
  Clock,
  Copy,
  ExternalLink,
  File,
  FolderOpen,
  GitBranch,
  Image,
  Layers,
  ListTree,
  LoaderCircle,
  MessageSquare,
  Minus,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  TriangleAlert,
  Undo2,
  Wrench,
  X
} from 'lucide-react'

const ICONS = {
  alert: AlertCircle,
  'arrow-down': ArrowDown,
  brain: Brain,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-up': ChevronUp,
  stop: CircleStop,
  clock: Clock,
  copy: Copy,
  external: ExternalLink,
  file: File,
  folder: FolderOpen,
  branch: GitBranch,
  image: Image,
  layers: Layers,
  tree: ListTree,
  spinner: LoaderCircle,
  message: MessageSquare,
  minus: Minus,
  play: Play,
  refresh: RefreshCw,
  search: Search,
  shield: ShieldCheck,
  sparkles: Sparkles,
  terminal: Terminal,
  warn: TriangleAlert,
  back: Undo2,
  wrench: Wrench,
  close: X
}

export type SessionIconName = keyof typeof ICONS

export function Icon({ name, size = 16, className }: { name: SessionIconName; size?: number; className?: string }): JSX.Element {
  const Cmp = ICONS[name]
  return <Cmp size={size} strokeWidth={1.75} className={className} aria-hidden />
}
