import { useEffect, useRef, useState, type JSX } from 'react'
import type { CheckpointPreview } from '../../../../shared/checkpoints'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Badge, Button, Dialog, DialogFooter, Modal, ModalOverlay, Notice, Spinner, type BadgeTone } from '../../ui'
import './rewind-dialog.css'

const CHANGE_TONE: Record<'A' | 'D' | 'M', BadgeTone> = { A: 'fail', D: 'ok', M: 'stall' }

type Phase = 'loading' | 'ready' | 'working' | 'done' | 'undone' | 'failed'

export function RewindDialogV3({ ownerKey, active }: { ownerKey: string; active: boolean }): JSX.Element | null {
  const t = useT()
  const rewind = useStore((s) => s.rewind)
  const close = useStore((s) => s.closeRewind)
  const [phase, setPhase] = useState<Phase>('loading')
  const [preview, setPreview] = useState<CheckpointPreview | null>(null)
  const [undoId, setUndoId] = useState<string | undefined>(undefined)
  const [message, setMessage] = useState('')
  const recordId = rewind?.recordId

  const openedFor = useRef<string | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    if (!rewind) {
      openedFor.current = null
      return
    }
    if (openedFor.current === null) {
      openedFor.current = ownerKey
    } else if (openedFor.current !== ownerKey) {
      close()
      return
    }
    if (!active) close()
  }, [rewind, ownerKey, active, close])

  useEffect(() => {
    const gen = ++generation.current
    if (!recordId) return undefined
    setPhase('loading')
    setPreview(null)
    setUndoId(undefined)
    setMessage('')
    let alive = true
    void window.yan.checkpoints.preview(recordId).then((result) => {
      if (!alive || generation.current !== gen) return
      setPreview(result)
      if (result.ok) setPhase('ready')
      else {
        setMessage(result.error ?? '')
        setPhase('failed')
      }
    }).catch((error: unknown) => {
      if (!alive || generation.current !== gen) return
      setMessage(error instanceof Error ? error.message : String(error))
      setPhase('failed')
    })
    return () => { alive = false }
  }, [recordId])

  if (!rewind) return null

  const run = async (): Promise<void> => {
    const gen = generation.current
    setPhase('working')
    const result = await window.yan.checkpoints.restore(rewind.recordId).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      restored: 0,
      undoId: undefined as string | undefined
    }))
    if (generation.current !== gen) return
    setUndoId(result.undoId)
    if (result.ok) {
      setMessage(t('rewind.done', { n: result.restored }))
      setPhase('done')
    } else {
      setMessage(t('rewind.failed', { error: result.error ?? '' }))
      setPhase('failed')
    }
  }
  const undo = async (): Promise<void> => {
    if (!undoId) return
    const gen = generation.current
    setPhase('working')
    const result = await window.yan.checkpoints.undo(undoId).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      restored: 0
    }))
    if (generation.current !== gen) return
    if (result.ok) {
      setMessage(t('rewind.undone'))
      setPhase('undone')
    } else {
      setMessage(t('rewind.failed', { error: result.error ?? '' }))
      setPhase('failed')
    }
  }

  const counts = preview ? {
    m: preview.changes.filter((change) => change.status === 'M').length,
    a: preview.changes.filter((change) => change.status === 'A').length,
    d: preview.changes.filter((change) => change.status === 'D').length
  } : null
  const label = { A: t('rewind.sA'), D: t('rewind.sD'), M: t('rewind.sM') } as const

  return (
    <ModalOverlay
      isDismissable={phase !== 'working'}
      isOpen
      onOpenChange={(open) => { if (!open && phase !== 'working') close() }}
    >
      <Modal className="rewind-dialog">
        <Dialog title={t('rewind.title')} closeLabel={t('rewind.cancel')} showClose={phase !== 'working'} data-testid="rewind-dialog">
          <p className="rewind-lead">
            {t('rewind.lead')}
            <br />
            {`「${rewind.preview.replace(/\s+/g, ' ').slice(0, 60)}」`}
          </p>
          <div className="rewind-body">
            {phase === 'loading' ? <div className="rewind-dim rewind-loading" role="status"><Spinner size="sm" />{t('rewind.loading')}</div> : null}
            {phase === 'ready' && preview && preview.total === 0 ? <div className="rewind-dim">{t('rewind.nothing')}</div> : null}
            {phase === 'ready' && preview && preview.total > 0 && counts ? (
              <>
                <div className="rewind-counts">{t('rewind.counts', { m: counts.m, a: counts.a, d: counts.d })}</div>
                <ul className="rewind-files" data-testid="rewind-files">
                  {preview.changes.map((change) => (
                    <li key={change.path}>
                      <Badge tone={CHANGE_TONE[change.status]} className="rewind-tag">{label[change.status]}</Badge>
                      <span className="rewind-path" title={change.path}>{change.path}</span>
                    </li>
                  ))}
                  {preview.total > preview.changes.length ? <li className="rewind-dim">{t('rewind.more', { n: preview.total - preview.changes.length })}</li> : null}
                </ul>
                <div className="rewind-dim">{t('rewind.note')}</div>
              </>
            ) : null}
            {message ? (phase === 'failed' ? <Notice tone="fail" compact>{message}</Notice> : <div className="rewind-dim" role="status">{message}</div>) : null}
          </div>
          <DialogFooter>
            {phase === 'ready' && preview && preview.total > 0 ? <Button variant="primary" onPress={() => void run()} data-testid="rewind-confirm">{t('rewind.confirm')}</Button> : null}
            {phase === 'done' && undoId ? <Button onPress={() => void undo()} data-testid="rewind-undo">{t('rewind.undo')}</Button> : null}
            <Button onPress={close} isDisabled={phase === 'working'} data-testid="rewind-done">{phase === 'done' || phase === 'undone' ? t('rewind.close') : t('rewind.cancel')}</Button>
          </DialogFooter>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
