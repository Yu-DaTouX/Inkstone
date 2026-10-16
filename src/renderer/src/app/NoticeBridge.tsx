import { useEffect, useRef } from 'react'
import { useStore } from '../state/store'
import { showToast, ToastRegion } from '../ui'

/** 既有 store 的操作结果在 v3 中保持可见，不另建通知或任务状态。 */
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
      // Toast 队列接管显示与关闭后再移除旧记录，避免 StrictMode 重复转发。
      useStore.getState().dismissNotice(notice.id)
    }
    if (forwarded.current.size > 256) {
      const recent = [...forwarded.current].slice(-128)
      forwarded.current = new Set(recent)
    }
  }, [notices])
  return <ToastRegion />
}
