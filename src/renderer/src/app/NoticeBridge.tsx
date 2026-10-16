import { useEffect, useRef } from 'react'
import { useStore } from '../state/store'
import { showToast, ToastRegion } from '../ui'

export function NoticeBridge() {
  const notices = useStore((state) => state.notices)
  const forwarded = useRef(new Set<string>())
  useEffect(() => {
    for (const notice of notices) {
      if (forwarded.current.has(notice.id)) continue
      forwarded.current.add(notice.id)
      showToast(notice.text, {
        tone: notice.type === 'error' ? 'danger' : notice.type,
        timeout: notice.type === 'error' || notice.type === 'warning' ? 10000 : 5000
      })
      useStore.getState().dismissNotice(notice.id)
    }
    if (forwarded.current.size > 256) {
      const recent = [...forwarded.current].slice(-128)
      forwarded.current = new Set(recent)
    }
  }, [notices])
  return <ToastRegion />
}
