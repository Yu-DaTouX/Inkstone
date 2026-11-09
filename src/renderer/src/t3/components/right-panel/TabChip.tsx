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
import { useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { motionAllowed, motionMs } from '../../../ui/motion-hooks'
import { Focusable, TooltipTrigger, Tooltip, TooltipHint } from '../../../ui'
import { cx } from '@/ui/cx'
import { AndroidIcon, AppleIcon } from '../icons/device'
import { PullRequestGlyph, PullRequestStateIcon } from '../pullRequest/pullRequestIcons'
import { PreviewFaviconIcon } from '../preview/PreviewFaviconIcon'
import { FileEntryIcon } from './FileEntryIcon'
import type { T3Surface } from './model'
import './TabChip.css'

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
      return <FileEntryIcon pathValue={surface.detail ?? surface.label} className="t3-icon--xs" />
    case 'browser':
      return <PreviewFaviconIcon url={surface.faviconUrl ?? null} />
    case 'pullRequest':
      return <PullRequestStateIcon state={surface.tone} />
    case 'pullRequests':
      return <PullRequestGlyph.link className="t3-icon--xs" aria-hidden />
    case 'device':
      if (surface.devicePlatform === 'ios') return <AppleIcon className="t3-icon--xs" />
      if (surface.devicePlatform === 'android') return <AndroidIcon className="t3-icon--xs" />
      return <Smartphone className="t3-icon--xs" aria-hidden />
    default: {
      const Icon = KIND_ICONS[surface.kind]
      return <Icon className="t3-icon--xs" aria-hidden />
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
  const [leaving, setLeaving] = useState(false)
  const requestClose = () => {
    if (leaving) return
    if (!motionAllowed()) {
      props.onClose()
      return
    }
    setLeaving(true)
    window.setTimeout(props.onClose, motionMs('quick'))
  }

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
        requestClose()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        props.onContextMenu(event.currentTarget)
      }}
      onPointerDown={props.onPointerDown}
      style={
        leaving
          ? { maxWidth: 0, opacity: 0, paddingInline: 0, pointerEvents: 'none' }
          : props.dragging && props.offsetX
            ? { transform: `translateX(${props.offsetX}px)` }
            : undefined
      }
      className={cx(
        'rp-tab-chip t3-tab-chip',
        active ? 't3-tab-chip--active' : 't3-tab-chip--idle',
        props.dragging && 't3-tab-chip--dragging'
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={props.closeLabel}
        className="t3-tab-chip__close"
        onClick={(event) => {
          event.stopPropagation()
          requestClose()
        }}
      >
        <span className="t3-tab-chip__glyph">
          <SurfaceIcon surface={surface} />
        </span>
        <X className="t3-icon--xs t3-tab-chip__x" />
        {surface.badge === 'pending' ? (
          <span
            aria-hidden
            className="t3-tab-chip__pending"
          />
        ) : null}
      </button>
      <TooltipTrigger isDisabled={!surface.detail}>
        <Focusable><button type="button" role="tab" id={`rp-tab-${surface.id}`} aria-selected={active} aria-controls={props.controls} tabIndex={props.focusable === false ? -1 : 0} className="t3-tab-chip__tab" onClick={props.onActivate}>
          <span className="t3-tab-chip__label">{surface.label}</span>
        </button></Focusable>
        <Tooltip placement="bottom" offset={8}><TooltipHint label={title} /></Tooltip>
      </TooltipTrigger>
      {surface.muted ? (
        <span aria-hidden className="t3-tab-chip__muted" />
      ) : null}
    </div>
  )
}
