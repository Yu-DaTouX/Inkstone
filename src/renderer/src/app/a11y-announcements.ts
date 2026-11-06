import { useEffect } from 'react'
import { approvalHeadline } from '../../../shared/approval'
import { useI18n } from '../i18n'
import { useStore } from '../state/store'
import { useSplitView } from '../state/split-view'
import { announce } from '../ui'

type StoreState = ReturnType<typeof useStore.getState>

const RUN_END_SETTLE_MS = 700

export function announcementText(zh: boolean) {
  return {
    running: zh ? '开始运行' : 'Run started',
    finished: zh ? '运行结束' : 'Run finished',
    approval: (headline: string) => (zh ? `需要你确认：${headline}` : `Approval needed: ${headline}`),
    approvalDone: zh ? '审批已处理' : 'Approval handled',
    question: zh ? '有问题等你回答' : 'A question needs your answer',
    switched: (title: string) => (zh ? `已切换到会话：${title}` : `Switched to session: ${title}`),
    tile: (n: number, total: number, title: string) => (zh ? `第 ${n} 格，共 ${total} 格：${title}` : `Pane ${n} of ${total}: ${title}`)
  }
}

function titleOf(s: StoreState, id: string | undefined): string {
  if (!id) return ''
  return s.manualTitles[id] || s.titles[id] || s.sessions.find((item) => item.id === id)?.title || ''
}

export function useA11yAnnouncements(): void {
  const { lang } = useI18n()
  useEffect(() => {
    const text = announcementText(lang !== 'en-US')
    const initial = useStore.getState()
    let sessionId = initial.session?.sessionId ?? null
    let running = !!(initial.session?.isAgentRunning || initial.session?.isStreaming)
    let approvals = new Set(initial.approvals.map((item) => item.id))
    let requests = new Set(initial.uiRequests.map((item) => item.id))
    let settle = 0
    const unsubscribe = useStore.subscribe((s) => {
      const nextId = s.session?.sessionId ?? null
      const nextRunning = !!(s.session?.isAgentRunning || s.session?.isStreaming)
      if (nextId !== sessionId) {
        const had = sessionId !== null
        sessionId = nextId
        running = nextRunning
        window.clearTimeout(settle)
        if (had && nextId) announce(text.switched(titleOf(s, nextId) || s.session?.sessionName || ''))
      } else if (nextRunning !== running) {
        running = nextRunning
        window.clearTimeout(settle)
        if (nextRunning) announce(text.running)
        else settle = window.setTimeout(() => {
          const now = useStore.getState().session
          if (!(now?.isAgentRunning || now?.isStreaming)) announce(text.finished)
        }, RUN_END_SETTLE_MS)
      }
      for (const item of s.approvals) if (!approvals.has(item.id)) announce(text.approval(approvalHeadline(item)), 'assertive')
      if (nextId === sessionId && [...approvals].some((id) => !s.approvals.some((item) => item.id === id))) announce(text.approvalDone)
      approvals = new Set(s.approvals.map((item) => item.id))
      for (const item of s.uiRequests) if (!requests.has(item.id)) announce(text.question, 'assertive')
      requests = new Set(s.uiRequests.map((item) => item.id))
    })
    let tile = useSplitView.getState().split?.live ?? -1
    const unsubscribeSplit = useSplitView.subscribe((state) => {
      const split = state.split
      const live = split?.live ?? -1
      if (split && live >= 0 && live !== tile && tile >= 0) {
        const ref = split.tiles[live]
        announce(text.tile(live + 1, split.tiles.length, titleOf(useStore.getState(), ref?.sessionId)))
      }
      tile = live
    })
    return () => {
      window.clearTimeout(settle)
      unsubscribe()
      unsubscribeSplit()
    }
  }, [lang])
}
