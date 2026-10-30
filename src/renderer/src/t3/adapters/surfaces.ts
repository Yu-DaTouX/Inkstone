import type { T3Surface } from '../components/right-panel/model'
import { fileSurface, isPanelToolKind, pullRequestSurface, subagentSurface, toolSurface, type PanelToolKind, type PrSurfaceState, type RightPanelSurface } from '../../state/right-panel'
import { WORKBENCH_ACTIVE_TABS } from '../../features/workbench/types'

export interface SurfaceLabelContext {
  toolLabel: (kind: PanelToolKind) => string
  pullRequestLabel: (number: number) => string
  subagentLabel: (runId: string) => string
  terminalLabel: string | null
  blockedKinds: ReadonlySet<string>
}

const FILE_PREFIX = 'file:'
const PR_PREFIX = 'pr:'
const SUBAGENT_PREFIX = 'subagent:'
const PR_STATES: ReadonlySet<string> = new Set<PrSurfaceState>(['open', 'draft', 'merged', 'closed'])

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export function blockedKindsOf(blocked: boolean): ReadonlySet<string> {
  return blocked ? WORKBENCH_ACTIVE_TABS : EMPTY_KINDS
}

const EMPTY_KINDS: ReadonlySet<string> = new Set<string>()

export function surfaceLabelOf(surface: RightPanelSurface, ctx: SurfaceLabelContext): string {
  if (surface.kind === 'file') return baseName(surface.path)
  if (surface.kind === 'pullRequest') return ctx.pullRequestLabel(surface.number)
  if (surface.kind === 'subagent') return ctx.subagentLabel(surface.runId)
  return ctx.toolLabel(surface.kind)
}

export function t3SurfaceOf(surface: RightPanelSurface, ctx: SurfaceLabelContext): T3Surface {
  const base = { id: surface.id, kind: surface.kind, label: surfaceLabelOf(surface, ctx) }
  const badge = ctx.blockedKinds.has(surface.kind) ? { badge: 'blocked' as const } : {}
  if (surface.kind === 'file') return { ...base, ...badge, detail: surface.path }
  if (surface.kind === 'pullRequest') return { ...base, ...badge, detail: surface.title ? `#${surface.number} ${surface.title}` : undefined, tone: surface.state }
  if (surface.kind === 'subagent') return { ...base, ...badge, detail: surface.runId }
  if (surface.kind === 'terminal') return { ...base, ...badge, detail: ctx.terminalLabel ?? undefined }
  return { ...base, ...badge }
}

export function surfaceFromT3(surface: T3Surface): RightPanelSurface | null {
  if (surface.kind === 'file') {
    const path = surface.id.startsWith(FILE_PREFIX) ? surface.id.slice(FILE_PREFIX.length) : surface.detail ?? ''
    return path ? fileSurface(path) : null
  }
  if (surface.kind === 'pullRequest') {
    if (!surface.id.startsWith(PR_PREFIX)) return null
    const number = Number(surface.id.slice(PR_PREFIX.length))
    if (!Number.isInteger(number) || number < 1) return null
    const state = surface.tone && PR_STATES.has(surface.tone) ? (surface.tone as PrSurfaceState) : undefined
    return pullRequestSurface(number, state ? { state } : {})
  }
  if (surface.kind === 'subagent') {
    if (!surface.id.startsWith(SUBAGENT_PREFIX)) return null
    const runId = surface.id.slice(SUBAGENT_PREFIX.length)
    return runId ? subagentSurface(runId) : null
  }
  return isPanelToolKind(surface.kind) ? toolSurface(surface.kind) : null
}
