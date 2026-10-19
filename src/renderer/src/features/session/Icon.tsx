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
  PencilLine,
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
  edit: PencilLine,
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
