import type { T3Surface } from '../components/right-panel/model'
import type { PanelToolKind, RightPanelSurface } from '../../state/right-panel'
import { WORKBENCH_ACTIVE_TABS } from '../../features/workbench/types'

export interface SurfaceLabelContext {
  toolLabel: (kind: PanelToolKind) => string
  pullRequestLabel: (number: number) => string
  subagentLabel: (runId: string) => string
  terminalLabel: string | null
  blockedKinds: ReadonlySet<string>
}

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
