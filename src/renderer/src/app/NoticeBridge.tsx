import { useEffect, useRef } from 'react'
import { subagentQuotaAttentionProviders, type SubagentRun } from '../../../shared/subagent-run'
import { pick } from '../../../shared/ui-lang'
import { useT, type TFunc } from '../i18n'
import { useStore, type Notice } from '../state/store'
import { showToast, toastQueue, ToastRegion, type ToastContent } from '../ui'

const TOAST_REGION_WIDTH = 360
const TOAST_EDGE = 16

function composerClearance(): number {
  const root = document.documentElement
  const viewWidth = root.clientWidth
  const viewHeight = root.clientHeight
  const insetRight = Number.parseFloat(getComputedStyle(root).getPropertyValue('--toast-inset-right')) || 0
  const right = viewWidth - insetRight - TOAST_EDGE
  const left = right - Math.min(TOAST_REGION_WIDTH, viewWidth - TOAST_EDGE * 2)
  let clearance = 0
  for (const composer of document.querySelectorAll<HTMLElement>('.v3-composer')) {
    const rect = (composer.firstElementChild ?? composer).getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0 || rect.right <= left || rect.left >= right || rect.bottom <= 0) continue
    clearance = Math.max(clearance, viewHeight - rect.top)
  }
  return Math.max(0, Math.round(clearance))
}

function useToastClearance(): void {
  useEffect(() => {
    const root = document.documentElement
    const apply = (): void => {
      const value = toastQueue.visibleToasts.length > 0 ? composerClearance() : 0
      root.style.setProperty('--toast-clearance', `${value}px`)
    }
    const unsubscribe = toastQueue.subscribe(apply)
    window.addEventListener('resize', apply)
    apply()
    return () => {
      unsubscribe()
      window.removeEventListener('resize', apply)
      root.style.removeProperty('--toast-clearance')
    }
  }, [])
}

function noticeTitle(notice: Notice, t: TFunc): string {
  if (notice.action === 'search-api-hint') return t('search.apiHint')
  if (notice.action === 'app-update') return notice.text ? t('update.notice', { v: notice.text }) : t('update.available')
  return notice.text
}

function noticeAction(notice: Notice, t: TFunc): ToastContent['action'] {
  if (notice.action === 'git-install') return { label: t('git.goInstall'), onAction: () => useStore.getState().openSettings('git') }
  if (notice.action === 'copy-share-link' && notice.actionValue) {
    const url = notice.actionValue
    return { label: t('state.native.copyShareLink'), onAction: () => {
      void navigator.clipboard.writeText(url).catch(() => useStore.getState().notify('error', t('state.error.copyFailedClipboard')))
    } }
  }
  return undefined
}

function useSubagentQuotaToasts(): void {
  useEffect(() => {
    const open = new Map<string, string>()
    const reconcile = (runs: readonly SubagentRun[]): void => {
      const providers = subagentQuotaAttentionProviders(runs)
      for (const [provider, key] of open) {
        if (providers.has(provider)) continue
        open.delete(provider)
        toastQueue.close(key)
      }
      for (const provider of providers) {
        if (open.has(provider)) continue
        const key = showToast(pick(`${provider} 的子 Agent 在等额度`, `${provider} subagents are waiting for quota`), {
          tone: 'warning',
          description: pick('可在额度页手动换号，或等额度恢复后自动继续。', 'Switch accounts on the quota page, or wait for quota to reset and the subagents will continue.'),
          timeout: 10000
        })
        open.set(provider, key)
      }
    }
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.subagents !== previous.subagents) reconcile(state.subagents)
    })
    reconcile(useStore.getState().subagents)
    return () => {
      unsubscribe()
      for (const key of open.values()) toastQueue.close(key)
    }
  }, [])
}

export function NoticeBridge() {
  const t = useT()
  const notices = useStore((state) => state.notices)
  const forwarded = useRef(new Set<string>())
  useToastClearance()
  useSubagentQuotaToasts()
  useEffect(() => {
    for (const notice of notices) {
      if (forwarded.current.has(notice.id)) continue
      forwarded.current.add(notice.id)
      showToast(noticeTitle(notice, t), {
        tone: notice.type === 'error' ? 'danger' : notice.type,
        action: noticeAction(notice, t),
        timeout: notice.action ? undefined : notice.type === 'error' || notice.type === 'warning' ? 10000 : undefined
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
