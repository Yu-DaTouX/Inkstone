import { useEffect, useRef } from 'react'
import { useStore } from '../../state/store'
import { showPreview } from '../workbench/preview-bindings'
import { toAbsolutePath } from '../files/files-model'

function requestedPath(path: string, cwd: string): string {
  if (!cwd || /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)) return path
  return toAbsolutePath(cwd, path.replace(/^\.[\\/]/, ''))
}

export function useChatFilePreview(ownerKey: string | null): void {
  const ownerRef = useRef(ownerKey)
  ownerRef.current = ownerKey
  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        const next = state.filePreview
        if (!next || next === previous.filePreview || next.loading) return
        const data = next.data
        if (!data) return
        const target = data.abs || requestedPath(next.path, next.cwd || state.session?.cwd || state.settings?.cwd || '')
        if (!target) return
        const owner = ownerRef.current
        const show = (): void => showPreview(owner, target, { preview: true, line: next.line ?? undefined, lineEnd: next.lineEnd ?? undefined })
        if (data.issue === 'directory') {
          void window.yan.openPath(target).then((result) => { if (!result.ok) show() }, show)
          return
        }
        show()
      }),
    []
  )
}
