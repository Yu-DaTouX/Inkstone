import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../../../state/store'
import { composerDraftKey } from '../../../state/composer-recovery'
import { shortProject } from '../../../features/sidebar/sidebar-model'
import type { SidebarThreadView } from './types'
import { useSidebarSections } from './threads'

export interface SidebarDraft {
  draftId: string
  projectDisplayName: string | null
  preview: string
  active: boolean
  discard(): void
}

function previewOf(text: string): string {
  const line = text.split('\n').map((part) => part.trim()).find(Boolean) ?? ''
  return line.length > 120 ? `${line.slice(0, 120)}\u2026` : line
}

export function useSidebarDrafts(): SidebarDraft[] {
  const entries = useStore(useShallow((s) => Object.entries(s.sessionRuntimes).flatMap(([id, entry]) => entry.draft?.trim() ? [id, entry.draft] : [])))
  const sessions = useStore((s) => s.sessions)
  const projectNames = useStore((s) => s.settings?.projectNames)
  const currentDraftKey = useStore(composerDraftKey)
  return useMemo(() => {
    const out: SidebarDraft[] = []
    const byId = new Map(sessions.map((item) => [item.id, item]))
    for (let index = 0; index < entries.length; index += 2) {
      const draftId = entries[index]
      const text = entries[index + 1]
      const session = byId.get(draftId)
      const cwd = session?.cwd ?? ''
      out.push({
        draftId,
        projectDisplayName: cwd ? ((projectNames ?? {})[cwd] ?? shortProject(cwd)) : null,
        preview: previewOf(text),
        active: draftId === currentDraftKey,
        discard: () => useStore.getState().setSessionDraft('', draftId)
      })
    }
    return out
  }, [entries, sessions, projectNames, currentDraftKey])
}

export function useSidebarDraftViews(): Array<SidebarDraft & { thread: SidebarThreadView | null }> {
  const drafts = useSidebarDrafts()
  const sections = useSidebarSections()
  const byId = useMemo(() => {
    const map = new Map<string, SidebarThreadView>()
    for (const view of [...sections.pinned, ...sections.active, ...sections.working, ...sections.snoozed, ...sections.settled]) {
      map.set(view.id, view)
    }
    return map
  }, [sections])
  return drafts.map((draft) => ({ ...draft, thread: byId.get(draft.draftId) ?? null }))
}
