import { useEffect, useState } from 'react'
import type { PeerApprovalRequest, PeerOperation } from '../../../shared/peer-protocol'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import { Button, Checkbox, CheckboxGroup, Dialog, DialogFooter, Modal, ModalOverlay, Notice } from '../ui'
import { peerDecisionOutcome, withoutApprovalRequest } from './peer-approval-model'
import './peer-approval.css'

export function PeerApprovalDialog() {
  const t = useT()
  const acquireOverlayBlocker = useStore((s) => s.acquireOverlayBlocker)
  const [queue, setQueue] = useState<PeerApprovalRequest[]>([])
  const [projects, setProjects] = useState<string[]>([])
  const [operations, setOperations] = useState<string[]>([])
  const [now, setNow] = useState(Date.now())
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const current = queue[0]

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
    setError('')
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

  if (!current) return null

  const decide = async (approve: boolean): Promise<void> => {
    if (pending) return
    const requestId = current.requestId
    setPending(true)
    setError('')
    let accepted: boolean | null = null
    try {
      accepted = await window.yan.peer.hostDecide({
        requestId,
        approve,
        projectIds: projects,
        operations: operations as PeerOperation[]
      })
    } catch {
      accepted = null
    } finally {
      setPending(false)
    }
    const outcome = peerDecisionOutcome(accepted)
    if (outcome === 'failed') {
      setError(t('peer.decideFailed'))
      return
    }
    setQueue((list) => withoutApprovalRequest(list, requestId))
  }
  const seconds = Math.max(0, Math.ceil((current.expiresAt - now) / 1000))

  return (
    <ModalOverlay isOpen isDismissable onOpenChange={(open) => { if (!open) void decide(false) }}>
      <Modal className="peer-approval">
        <Dialog title={t('peer.approveTitle')} closeLabel={t('peer.deny')} data-testid="peer-approval">
          <p className="peer-approval-timer" role="timer">{t('peer.approveExpires', { seconds })}</p>
          <p className="peer-approval-lead">{t('peer.approveWho', { name: current.deviceName })}</p>
          {current.note ? <p className="peer-approval-lead">{t('peer.approveNote', { note: current.note })}</p> : null}
          <p className="peer-approval-dim">{t('peer.approveRule')}</p>
          <CheckboxGroup
            label={t('peer.approveProjects')}
            value={projects}
            onChange={setProjects}
            description={current.projects.length === 0 ? t('peer.approveNoProjects') : undefined}
          >
            {current.projects.map((project) => (
              <Checkbox key={project.id} value={project.id}>{project.name}</Checkbox>
            ))}
          </CheckboxGroup>
          <CheckboxGroup label={t('peer.approveOperations')} value={operations} onChange={setOperations}>
            {current.operations.map((op) => (
              <Checkbox key={op} value={op}>{t(`peer.op.${op}` as 'peer.op.read')}</Checkbox>
            ))}
          </CheckboxGroup>
          {error ? <Notice tone="fail" compact>{error}</Notice> : null}
          <p className="peer-approval-dim">{t('peer.approveNotShared')}</p>
          <DialogFooter>
            <Button variant="ghost" isDisabled={pending} onPress={() => void decide(false)} data-testid="peer-deny">{t('peer.deny')}</Button>
            <Button
              variant="primary"
              isDisabled={pending || !projects.length || !operations.length}
              onPress={() => void decide(true)}
              data-testid="peer-approve"
            >
              {t('peer.approve')}
            </Button>
          </DialogFooter>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
