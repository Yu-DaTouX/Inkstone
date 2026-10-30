import {
  Bot,
  FileDiff,
  Files,
  Gauge,
  GitBranch,
  ScrollText,
  Smartphone,
  SquareStack,
  TerminalSquare,
  X,
  type LucideIcon
} from 'lucide-react'
import { type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/t3/components/ui/tooltip'
import { cn } from '@/t3/lib/utils'
import { AndroidIcon, AppleIcon } from '../icons/device'
import { PullRequestGlyph, PullRequestStateIcon } from '../pullRequest/pullRequestIcons'
import { PreviewFaviconIcon } from '../preview/PreviewFaviconIcon'
import { FileEntryIcon } from './FileEntryIcon'
import type { T3Surface } from './model'

export interface TabSurface extends T3Surface {
  faviconUrl?: string
  devicePlatform?: 'ios' | 'android'
  icon?: ReactNode
  muted?: boolean
}

const KIND_ICONS: Record<
  Exclude<T3Surface['kind'], 'file' | 'browser' | 'pullRequest' | 'pullRequests' | 'device'>,
  LucideIcon
> = {
  changes: FileDiff,
  files: Files,
  terminal: TerminalSquare,
  context: SquareStack,
  branch: GitBranch,
  logs: ScrollText,
  quota: Gauge,
  subagent: Bot
}

export function SurfaceIcon({ surface }: { surface: TabSurface }): ReactNode {
  if (surface.icon !== undefined) return surface.icon
  switch (surface.kind) {
    case 'file':
      return <FileEntryIcon pathValue={surface.detail ?? surface.label} className="size-3 text-current" />
    case 'browser':
      return <PreviewFaviconIcon url={surface.faviconUrl ?? null} />
    case 'pullRequest':
      return <PullRequestStateIcon state={surface.tone} />
    case 'pullRequests':
      return <PullRequestGlyph.link className="size-3 shrink-0" aria-hidden />
    case 'device':
      if (surface.devicePlatform === 'ios') return <AppleIcon className="size-3 shrink-0" />
      if (surface.devicePlatform === 'android') return <AndroidIcon className="size-3 shrink-0" />
      return <Smartphone className="size-3 shrink-0" aria-hidden />
    default: {
      const Icon = KIND_ICONS[surface.kind]
      return <Icon className="size-3 shrink-0" aria-hidden />
    }
  }
}

export interface TabChipProps {
  surface: TabSurface
  active: boolean
  controls?: string
  closeLabel: string
  focusable?: boolean
  dragging?: boolean
  offsetX?: number
  onActivate: () => void
  onClose: () => void
  onContextMenu: (anchor: HTMLElement) => void
  onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void
}

export function TabChip(props: TabChipProps) {
  const { surface, active } = props
  const title = surface.detail ?? surface.label

  const preventMiddleButtonDefault = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 1) return
    event.preventDefault()
  }

  return (
    <div
      data-tab-id={surface.id}
      data-active-tab={active}
      onMouseDown={preventMiddleButtonDefault}
      onMouseUp={preventMiddleButtonDefault}
      onAuxClick={(event) => {
        if (event.button !== 1) return
        event.preventDefault()
        event.stopPropagation()
        props.onClose()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        props.onContextMenu(event.currentTarget)
      }}
      onPointerDown={props.onPointerDown}
      style={
        props.dragging && props.offsetX
          ? { transform: `translateX(${props.offsetX}px)` }
          : undefined
      }
      className={cn(
        'group/tab flex h-6 max-w-36 shrink-0 cursor-pointer items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs',
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        props.dragging && 'relative z-10 cursor-grabbing'
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={props.closeLabel}
        className="group/close relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm hover:bg-muted"
        onClick={(event) => {
          event.stopPropagation()
          props.onClose()
        }}
      >
        <span className="relative flex size-3 items-center justify-center group-hover/tab:hidden group-focus-visible/close:hidden">
          <SurfaceIcon surface={surface} />
        </span>
        <X className="hidden size-3 group-hover/tab:block group-focus-visible/close:block" />
        {surface.badge === 'pending' ? (
          <span
            aria-hidden
            className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-current"
          />
        ) : null}
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              role="tab"
              id={`rp-tab-${surface.id}`}
              aria-selected={active}
              aria-controls={props.controls}
              tabIndex={props.focusable === false ? -1 : 0}
              className="flex min-w-0 cursor-pointer items-center rounded-sm bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={props.onActivate}
            />
          }
        >
          <span className="truncate">{surface.label}</span>
        </TooltipTrigger>
        <TooltipPopup>{title}</TooltipPopup>
      </Tooltip>
      {surface.muted ? (
        <span aria-hidden className="ml-0.5 size-1 rounded-full bg-current opacity-50" />
      ) : null}
    </div>
  )
}
