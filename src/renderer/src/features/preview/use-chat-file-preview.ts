import { useEffect, useRef } from 'react'
import { useStore } from '../../state/store'
import { showPreview } from '../workbench/tool-tiles'

export function useChatFilePreview(ownerKey: string | null): void {
  const ownerRef = useRef(ownerKey)
  ownerRef.current = ownerKey
  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        const next = state.filePreview
        if (!next || next === previous.filePreview || next.loading) return
        const data = next.data
        const path = data?.abs || ''
        if (!data || !path || data.issue === 'directory') return
        showPreview(ownerRef.current, path, { preview: true, line: next.line ?? undefined, lineEnd: next.lineEnd ?? undefined })
      }),
    []
  )
}
