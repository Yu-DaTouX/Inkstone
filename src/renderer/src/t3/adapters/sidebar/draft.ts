import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../../../state/store'
import { composerDraftKey } from '../../../state/composer-recovery'
import { shortProject } from '../../../features/sidebar/sidebar-model'

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

export function discardSidebarDraft(draftId: string): void {
  useStore.getState().setSessionDraft('', draftId)
}

export function useSidebarDraftIds(): string[] {
  return useStore(useShallow((s) => Object.entries(s.sessionRuntimes).flatMap(([id, entry]) => (entry.draft?.trim() ? [id] : []))))
}

export function useSidebarDrafts(only?: readonly string[]): SidebarDraft[] {
  const entries = useStore(
    useShallow((s) =>
      Object.entries(s.sessionRuntimes).flatMap(([id, entry]) =>
        entry.draft?.trim() && (!only || only.includes(id)) ? [id, previewOf(entry.draft)] : []
      )
    )
  )
  const sessions = useStore((s) => s.sessions)
  const projectNames = useStore((s) => s.settings?.projectNames)
  const currentDraftKey = useStore(composerDraftKey)
  return useMemo(() => {
    const out: SidebarDraft[] = []
    const byId = new Map(sessions.map((item) => [item.id, item]))
    for (let index = 0; index < entries.length; index += 2) {
      const draftId = entries[index]
      const preview = entries[index + 1]
      const session = byId.get(draftId)
      const cwd = session?.cwd ?? ''
      out.push({
        draftId,
        projectDisplayName: cwd ? ((projectNames ?? {})[cwd] ?? shortProject(cwd)) : null,
        preview,
        active: draftId === currentDraftKey,
        discard: () => discardSidebarDraft(draftId)
      })
    }
    return out
  }, [entries, sessions, projectNames, currentDraftKey])
}
