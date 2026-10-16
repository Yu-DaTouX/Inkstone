import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useStore } from '../../state/store'
import { beforeFromDrop, orderAfterDrag } from '../../../../shared/rail-order'
import type { AppSettings, ProjectGroup, ProjectRecord } from '../../../../shared/ipc'
import { splitDropHit, useSplitDrop } from '../../state/split-drop'
import { openInSplit } from './SessionRow'

const DRAG_THRESHOLD = 4

type DragKind = 'project' | 'group' | 'session'
interface DropHint {
  kind: DragKind
  id: string
  after: boolean
}
interface DropInto {
  key: string
  projectId: string | null
}
interface DragSession {
  kind: DragKind
  id: string
  groupId: string
  from: string
  startX: number
  startY: number
  active: boolean
}

export function useRailDrag({ query, projectsOpen, displayProjects, projectRecords, projectGroups, patchSettings, expandAllProjects }: {
  query: string
  projectsOpen: boolean
  displayProjects: ReadonlyArray<{ projectId?: string }>
  projectRecords: ProjectRecord[]
  projectGroups: ProjectGroup[]
  patchSettings: (p: Partial<AppSettings>) => Promise<void>
  expandAllProjects: () => void
}) {
  const [dragItem, setDragItem] = useState<{ kind: DragKind; id: string } | null>(null)
  const [dropHint, setDropHint] = useState<DropHint | null>(null)
  const [dropInto, setDropInto] = useState<DropInto | null>(null)
  const dragRef = useRef<DragSession | null>(null)
  const dropHintRef = useRef<DropHint | null>(null)
  const dropIntoRef = useRef<DropInto | null>(null)
  const renderedGroupIds = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const project of displayProjects) {
      const gid = project.projectId ? projectRecords.find((record) => record.id === project.projectId)?.groupId : undefined
      if (gid && !seen.has(gid)) {
        seen.add(gid)
        out.push(gid)
      }
    }
    return out
  }, [displayProjects, projectRecords])
  const orderRef = useRef({ projects: displayProjects, groups: renderedGroupIds })
  useEffect(() => {
    orderRef.current = { projects: displayProjects, groups: renderedGroupIds }
  }, [displayProjects, renderedGroupIds])
  useEffect(() => () => document.body.classList.remove('rail-dragging'), [])

  const setHint = (hint: DropHint | null): void => {
    dropHintRef.current = hint
    setDropHint(hint)
  }

  const setInto = (into: DropInto | null): void => {
    dropIntoRef.current = into
    setDropInto(into)
  }

  function cleanupDrag(keepSession: boolean): void {
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragUp)
    window.removeEventListener('pointercancel', onDragCancel)
    window.removeEventListener('keydown', onDragKey)
    document.body.classList.remove('rail-dragging')
    useSplitDrop.getState().set({ dragging: false, zone: null, at: null })
    setDragItem(null)
    setHint(null)
    setInto(null)
    if (!keepSession) dragRef.current = null
  }

  function intoAt(x: number, y: number): DropInto | null {
    const under = document.elementFromPoint(x, y) as HTMLElement | null
    const row = under?.closest<HTMLElement>('[data-drop-into]')
    const key = row?.dataset.dropInto
    if (!row || !key) return null
    return { key, projectId: key.startsWith('project:') ? key.slice('project:'.length) : null }
  }

  function hintAt(x: number, y: number, session: DragSession): DropHint | null {
    const under = document.elementFromPoint(x, y) as HTMLElement | null
    const row = under?.closest<HTMLElement>(`[data-drag-kind="${session.kind}"]`)
    const id = row?.dataset.dragId
    if (!row || !id || id === session.id) return null
    if (session.kind === 'project' && (row.dataset.dragGroup ?? '') !== session.groupId) return null
    const rect = row.getBoundingClientRect()
    return { kind: session.kind, id, after: y > rect.top + rect.height / 2 }
  }

  function onDragMove(e: PointerEvent): void {
    const session = dragRef.current
    if (!session) return
    if (!session.active) {
      if (Math.hypot(e.clientX - session.startX, e.clientY - session.startY) < DRAG_THRESHOLD) return
      session.active = true
      expandAllProjects()
      setDragItem({ kind: session.kind, id: session.id })
      document.body.classList.add('rail-dragging')
    }
    e.preventDefault()
    if (session.kind === 'session') {
      const hit = splitDropHit(e.clientX, e.clientY)
      useSplitDrop.getState().set({ dragging: true, zone: hit?.zone ?? null, at: hit?.at ?? null })
      setInto(hit ? null : intoAt(e.clientX, e.clientY))
    } else setHint(hintAt(e.clientX, e.clientY, session))
  }

  function onDragUp(): void {
    const session = dragRef.current
    const hint = dropHintRef.current
    const into = dropIntoRef.current
    const toAt = useSplitDrop.getState().at
    cleanupDrag(true)
    if (!session?.active) return
    if (session.kind === 'session' && toAt !== null) {
      const target = useStore.getState().sessions.find((x) => x.id === session.id)
      if (target) openInSplit(target, toAt)
      return
    }
    if (session.kind === 'session') {
      if (!into || into.key === session.from) return
      void useStore.getState().moveSession(session.id, into.projectId)
      return
    }
    if (!hint) return
    const { projects: list, groups } = orderRef.current
    if (session.kind === 'group') {
      const nextIds = orderAfterDrag(groups, session.id, beforeFromDrop(groups, hint.id, hint.after))
      if (nextIds.join('\u0000') === groups.join('\u0000')) return
      const byId = new Map(projectGroups.map((group) => [group.id, group]))
      const ordered = nextIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
      const rest = projectGroups.filter((group) => !nextIds.includes(group.id))
      void patchSettings({ projectGroups: [...ordered, ...rest] })
      return
    }
    const ids = list.flatMap((project) => (project.projectId ? [project.projectId] : []))
    const nextIds = orderAfterDrag(ids, session.id, beforeFromDrop(ids, hint.id, hint.after))
    if (nextIds.join('\u0000') === ids.join('\u0000')) return
    void patchSettings({ projectOrder: nextIds })
  }

  function onDragCancel(): void {
    cleanupDrag(false)
  }

  function onDragKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return
    e.preventDefault()
    cleanupDrag(false)
  }

  function beginDrag(e: ReactPointerEvent, kind: DragKind, id: string, groupId = '', from = ''): void {
    if (e.button !== 0) return
    if (query) return
    if (!projectsOpen) return
    const target = e.target as HTMLElement
    if (kind === 'session') {
      if (target.closest('.srow-acts, .srow-btoggle, input')) return
    } else if (target.closest('button:not(.proj-pick), input, [role="button"]')) return
    dragRef.current = { kind, id, groupId, from, startX: e.clientX, startY: e.clientY, active: false }
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragUp)
    window.addEventListener('pointercancel', onDragCancel)
    window.addEventListener('keydown', onDragKey)
  }

  function consumeDragClick(): boolean {
    if (!dragRef.current?.active) return false
    dragRef.current = null
    return true
  }

  return { dragItem, dropHint, dropInto, beginDrag, consumeDragClick }
}
