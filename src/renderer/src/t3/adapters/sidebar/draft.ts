import { useMemo } from 'react'
import { useStore } from '../../../state/store'
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
  const runtimes = useStore((s) => s.sessionRuntimes)
  const sessions = useStore((s) => s.sessions)
  const projectNames = useStore((s) => s.settings?.projectNames)
  const currentSessionId = useStore((s) => s.session?.sessionId)
  return useMemo(() => {
    const out: SidebarDraft[] = []
    for (const [draftId, entry] of Object.entries(runtimes)) {
      const text = entry.draft ?? ''
      if (!text.trim()) continue
      const session = sessions.find((item) => item.id === draftId)
      const cwd = session?.cwd ?? ''
      out.push({
        draftId,
        projectDisplayName: cwd ? ((projectNames ?? {})[cwd] ?? shortProject(cwd)) : null,
        preview: previewOf(text),
        active: draftId === currentSessionId,
        discard: () => useStore.getState().setSessionDraft('', draftId)
      })
    }
    return out
  }, [runtimes, sessions, projectNames, currentSessionId])
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
