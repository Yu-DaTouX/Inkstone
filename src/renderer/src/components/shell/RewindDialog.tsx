/**
 * 回退代码的确认框：先列出会改哪些文件，确认后才动；做完可以一键撤销。
 * 会话里的对话不变，只恢复项目文件。
 */
import { useEffect, useState } from 'react'
import type { CheckpointPreview } from '../../../../shared/checkpoints'
import { useT } from '../../i18n'
import { Icon } from '../../icons/Icon'
import { useStore } from '../../state/store'
import { Button } from '../ui'

type Phase = 'loading' | 'ready' | 'working' | 'done' | 'undone' | 'failed'

export function RewindDialog() {
  const t = useT()
  const rewind = useStore((s) => s.rewind)
  const close = useStore((s) => s.closeRewind)
  const acquireOverlayBlocker = useStore((s) => s.acquireOverlayBlocker)
  const [phase, setPhase] = useState<Phase>('loading')
  const [preview, setPreview] = useState<CheckpointPreview | null>(null)
  const [undoId, setUndoId] = useState<string | undefined>()
  const [message, setMessage] = useState('')
  const recordId = rewind?.recordId

  useEffect(() => {
    if (!recordId) return undefined
    setPhase('loading')
    setPreview(null)
    setUndoId(undefined)
    setMessage('')
    let alive = true
    void window.yan.checkpoints.preview(recordId).then((result) => {
      if (!alive) return
      setPreview(result)
      if (result.ok) setPhase('ready')
      else {
        setMessage(result.error ?? '')
        setPhase('failed')
      }
    }).catch((error: unknown) => {
      if (!alive) return
      setMessage(error instanceof Error ? error.message : String(error))
      setPhase('failed')
    })
    return () => { alive = false }
  }, [recordId])

  useEffect(() => {
    if (!recordId) return undefined
    const release = acquireOverlayBlocker('rewind')
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && phase !== 'working') close() }
    window.addEventListener('keydown', onKey)
    return () => {
      release()
      window.removeEventListener('keydown', onKey)
    }
  }, [recordId, phase, acquireOverlayBlocker, close])

  if (!rewind) return null

  const run = async (): Promise<void> => {
    setPhase('working')
    const result = await window.yan.checkpoints.restore(rewind.recordId).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error), restored: 0, undoId: undefined as string | undefined }))
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
    setPhase('working')
    const result = await window.yan.checkpoints.undo(undoId).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error), restored: 0 }))
    if (result.ok) {
      setMessage(t('rewind.undone'))
      setPhase('undone')
    } else {
      setMessage(t('rewind.failed', { error: result.error ?? '' }))
      setPhase('failed')
    }
  }

  const counts = preview ? {
    m: preview.changes.filter((c) => c.status === 'M').length,
    a: preview.changes.filter((c) => c.status === 'A').length,
    d: preview.changes.filter((c) => c.status === 'D').length
  } : null
  const label = { A: t('rewind.sA'), D: t('rewind.sD'), M: t('rewind.sM') } as const

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label={t('rewind.title')} data-testid="rewind-dialog" onPointerDown={(e) => { if (e.target === e.currentTarget && phase !== 'working') close() }}>
      <div className="modal rewind-dialog">
        <div className="modal-head">
          <Icon name="back" size={12} />
          <span className="modal-title">{t('rewind.title')}</span>
        </div>
        <div className="modal-message">
          {t('rewind.lead')}
          {`\n「${rewind.preview.replace(/\s+/g, ' ').slice(0, 60)}」`}
        </div>
        <div className="rewind-body">
          {phase === 'loading' ? <div className="rewind-dim">{t('rewind.loading')}</div> : null}
          {phase === 'ready' && preview && preview.total === 0 ? <div className="rewind-dim">{t('rewind.nothing')}</div> : null}
          {phase === 'ready' && preview && preview.total > 0 && counts ? (
            <>
              <div className="rewind-counts">{t('rewind.counts', { m: counts.m, a: counts.a, d: counts.d })}</div>
              <ul className="rewind-files" data-testid="rewind-files">
                {preview.changes.map((c) => (
                  <li key={c.path}><span className={`rewind-tag s-${c.status}`}>{label[c.status]}</span><span className="rewind-path" title={c.path}>{c.path}</span></li>
                ))}
                {preview.total > preview.changes.length ? <li className="rewind-dim">{t('rewind.more', { n: preview.total - preview.changes.length })}</li> : null}
              </ul>
              <div className="rewind-dim">{t('rewind.note')}</div>
            </>
          ) : null}
          {message ? <div className={phase === 'failed' ? 'rewind-error' : 'rewind-dim'} role="status">{message}</div> : null}
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          {phase === 'ready' && preview && preview.total > 0 ? <Button variant="primary" onClick={() => void run()} data-testid="rewind-confirm">{t('rewind.confirm')}</Button> : null}
          {phase === 'done' && undoId ? <Button onClick={() => void undo()} data-testid="rewind-undo">{t('rewind.undo')}</Button> : null}
          <Button onClick={close} disabled={phase === 'working'}>{phase === 'done' || phase === 'undone' ? t('rewind.close') : t('rewind.cancel')}</Button>
        </div>
      </div>
    </div>
  )
}
