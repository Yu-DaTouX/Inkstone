import { useEffect, useRef, useState } from 'react'
import type { PeerApprovalRequest, PeerOperation } from '../../../../shared/peer-protocol'
import { useT } from '../../i18n'
import { Icon } from '../../icons/Icon'
import { useStore } from '../../state/store'
import { Button } from '../ui'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'

export function PeerApprovalDialog() {
  const t = useT()
  const acquireOverlayBlocker = useStore((s) => s.acquireOverlayBlocker)
  const [queue, setQueue] = useState<PeerApprovalRequest[]>([])
  const [projects, setProjects] = useState<string[]>([])
  const [operations, setOperations] = useState<PeerOperation[]>([])
  const [now, setNow] = useState(Date.now())
  const current = queue[0]
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.yan.peer.hostPending().then(setQueue).catch(() => undefined)
    return window.yan.onPush((msg) => {
      if (msg.ch === 'peer-request') setQueue((list) => [...list.filter((item) => item.requestId !== msg.payload.requestId), msg.payload])
      else if (msg.ch === 'peer-request-closed') setQueue((list) => list.filter((item) => item.requestId !== msg.payload.requestId))
    })
  }, [])

  useEffect(() => {
    setProjects([])
    setOperations(current?.operations ?? [])
  }, [current?.requestId])

  useEffect(() => {
    if (!current) return undefined
    const release = acquireOverlayBlocker('peer-approval')
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      release()
      window.clearInterval(id)
    }
  }, [current?.requestId, acquireOverlayBlocker])

  const decide = (approve: boolean): void => {
    if (!current) return
    void window.yan.peer.hostDecide({ requestId: current.requestId, approve, projectIds: projects, operations })
    setQueue((list) => list.filter((item) => item.requestId !== current.requestId))
  }
  const { isTop } = useModalLayer(!!current, () => decide(false))
  useFocusTrap(panel, !!current, isTop)

  if (!current) return null
  const toggle = <T,>(list: T[], value: T): T[] => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value])
  const seconds = Math.max(0, Math.ceil((current.expiresAt - now) / 1000))

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label={t('peer.approveTitle')} data-testid="peer-approval">
      <div className="modal peer-approval" ref={panel}>
        <div className="modal-head">
          <Icon name="shield-check" size={12} />
          <span className="modal-title">{t('peer.approveTitle')}</span>
          <span className="spacer" />
          <span className="peer-approval-timer">{t('peer.approveExpires', { seconds })}</span>
        </div>
        <div className="modal-message">
          {t('peer.approveWho', { name: current.deviceName })}
          {current.note ? `\n${t('peer.approveNote', { note: current.note })}` : ''}
          {`\n${t('peer.approveRule')}`}
        </div>
        <fieldset className="peer-approval-group">
          <legend className="ui-row-name">{t('peer.approveProjects')}</legend>
          {current.projects.length === 0 ? <div className="ui-row-desc">{t('peer.approveNoProjects')}</div> : null}
          {current.projects.map((project) => (
            <label className="peer-approval-option" key={project.id}>
              <input type="checkbox" checked={projects.includes(project.id)} onChange={() => setProjects((list) => toggle(list, project.id))} />
              <span>{project.name}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="peer-approval-group">
          <legend className="ui-row-name">{t('peer.approveOperations')}</legend>
          {current.operations.map((op) => (
            <label className="peer-approval-option" key={op}>
              <input type="checkbox" checked={operations.includes(op)} onChange={() => setOperations((list) => toggle(list, op))} />
              <span>{t(`peer.op.${op}` as 'peer.op.read')}</span>
            </label>
          ))}
        </fieldset>
        <div className="modal-foot">
          <span className="ui-row-desc">{t('peer.approveNotShared')}</span>
          <span className="spacer" />
          <Button onClick={() => decide(false)} data-testid="peer-deny">
            {t('peer.deny')}
          </Button>
          <Button variant="primary" disabled={!projects.length || !operations.length} onClick={() => decide(true)} data-testid="peer-approve">
            {t('peer.approve')}
          </Button>
        </div>
      </div>
    </div>
  )
}
