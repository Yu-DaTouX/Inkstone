import { useEffect, useRef } from 'react'
import { useT, type TFunc } from '../i18n'
import { useStore, type Notice } from '../state/store'
import { showToast, ToastRegion } from '../ui'

function noticeTitle(notice: Notice, t: TFunc): string {
  if (notice.action === 'search-api-hint') return t('search.apiHint')
  if (notice.action === 'app-update') return notice.text ? t('update.notice', { v: notice.text }) : t('update.available')
  return notice.text
}

export function NoticeBridge() {
  const t = useT()
  const notices = useStore((state) => state.notices)
  const forwarded = useRef(new Set<string>())
  useEffect(() => {
    for (const notice of notices) {
      if (forwarded.current.has(notice.id)) continue
      forwarded.current.add(notice.id)
      showToast(noticeTitle(notice, t), {
        tone: notice.type === 'error' ? 'danger' : notice.type,
        timeout: notice.type === 'error' || notice.type === 'warning' || notice.action ? 10000 : 5000
      })
      useStore.getState().dismissNotice(notice.id)
    }
    if (forwarded.current.size > 256) {
      const recent = [...forwarded.current].slice(-128)
      forwarded.current = new Set(recent)
    }
  }, [notices, t])
  return <ToastRegion />
}
