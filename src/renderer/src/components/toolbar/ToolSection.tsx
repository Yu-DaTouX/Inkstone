import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { IconName } from '../../icons/sprite'
import { useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import type { ToolSectionId } from '../../../../shared/ipc'

const HandleCtx = createContext<React.ReactNode>(null)

export const HandleProvider = HandleCtx.Provider
export const useSectionHandle = (): React.ReactNode => useContext(HandleCtx)

export const SECTION_TITLE: Record<ToolSectionId, MessageKey> = {
  context: 'rp.context',
  quota: 'rp.quota',
  todo: 'rp.todo',
  queue: 'rp.queue',
  files: 'rp.files',
  ext: 'rp.ext',
  log: 'rp.log',
  actions: 'rp.actions'
}

export const SECTION_ICON: Partial<Record<ToolSectionId, IconName>> = {
  context: 'checklist'
}

export function Section({
  titleKey,
  extra,
  defaultOpen = true,
  compactWhenFloating = false,
  testId,
  handle,
  open: openProp,
  onOpenChange,
  children
}: {
  titleKey: MessageKey
  extra?: React.ReactNode
  defaultOpen?: boolean
  compactWhenFloating?: boolean
  testId?: string
  handle?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}) {
  const [openState, setOpenState] = useState(defaultOpen)
  const ctxHandle = useSectionHandle()
  const grip = handle ?? ctxHandle
  const open = openProp ?? (grip === null && !compactWhenFloating ? true : openState)
  const setOpen = (v: boolean): void => {
    setOpenState(v)
    onOpenChange?.(v)
  }
  const t = useT()

  const bodyRef = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(open)
  const [collapsedOnce, setCollapsedOnce] = useState(!open)
  const heading = <><span className="rp-sec-title">{t(titleKey)}</span><span className="spacer" />{extra}</>

  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    setCollapsedOnce(true)
    if (!mounted) return
    const el = bodyRef.current
    if (!el) {
      setMounted(false)
      return
    }
    const finish = (e: TransitionEvent): void => {
      if (e.target !== el) return
      el.removeEventListener('transitionend', finish)
      setMounted(false)
    }
    el.addEventListener('transitionend', finish)
    const timer = window.setTimeout(() => {
      el.removeEventListener('transitionend', finish)
      setMounted(false)
    }, 400)
    return () => {
      el.removeEventListener('transitionend', finish)
      window.clearTimeout(timer)
    }
  }, [open, mounted])

  return (
    <section className={`rp-sec ${open ? 'open' : ''} ${compactWhenFloating ? 'rp-summary-sec' : ''}`} data-sec={testId} data-testid={testId}>
      <div className="rp-sec-row">
        {grip}
        {grip === null ? (
          <div className="rp-sec-head" aria-expanded="true">{heading}</div>
        ) : (
          <button className="rp-sec-head" onClick={() => setOpen(!open)} aria-expanded={open}>{heading}</button>
        )}
      </div>
      <div
        ref={bodyRef}
        className={`rp-sec-body ${open ? 'open' : ''} ${open && collapsedOnce ? 'anim' : ''}`}
      >
        {mounted || open ? <div className="rp-sec-body-inner">{children}</div> : null}
      </div>
    </section>
  )
}
