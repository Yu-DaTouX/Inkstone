import { useCallback, useEffect, useRef } from 'react'

const DRAFT_TARGETS = '.v3-side, .v3-sidebar-resizer'

function writeDraft(width: number | null): void {
  for (const node of document.querySelectorAll<HTMLElement>(DRAFT_TARGETS)) {
    if (width === null) node.style.removeProperty('--sidebar-width')
    else node.style.setProperty('--sidebar-width', `${width}px`)
  }
}

export function useSidebarWidthDraft(commit: (width: number) => void): (width: number) => void {
  const commitRef = useRef(commit)
  commitRef.current = commit
  const draftRef = useRef<{ width: number; frame: number; observer: MutationObserver } | null>(null)

  const finish = useCallback(() => {
    const draft = draftRef.current
    if (!draft) return
    draftRef.current = null
    draft.observer.disconnect()
    if (draft.frame) cancelAnimationFrame(draft.frame)
    writeDraft(draft.width)
    commitRef.current(draft.width)
    requestAnimationFrame(() => {
      if (!draftRef.current) writeDraft(null)
    })
  }, [])

  useEffect(() => finish, [finish])

  return useCallback(
    (width: number) => {
      const root = document.documentElement
      if (root.dataset.splitterDragging === undefined) {
        finish()
        commitRef.current(width)
        return
      }
      let draft = draftRef.current
      if (!draft) {
        const observer = new MutationObserver(() => {
          if (root.dataset.splitterDragging === undefined) finish()
        })
        observer.observe(root, { attributes: true, attributeFilter: ['data-splitter-dragging'] })
        draft = { width, frame: 0, observer }
        draftRef.current = draft
      }
      draft.width = width
      if (draft.frame) return
      const active = draft
      active.frame = requestAnimationFrame(() => {
        active.frame = 0
        if (draftRef.current === active) writeDraft(active.width)
      })
    },
    [finish]
  )
}
