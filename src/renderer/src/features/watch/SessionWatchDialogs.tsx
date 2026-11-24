import { useEffect, useState, type JSX } from 'react'
import { Check, Copy, X } from '../../ui/icons'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { useRightPanel, watchSurface } from '../../state/right-panel'
import { listenSessionWatch, useSessionWatch } from '../../state/session-watch'
import { Button, Dialog, DialogFooter, IconButton, Modal, ModalOverlay, Notice, TextArea } from '../../ui'
import { openSettingsDialog } from '../settings/root/deep-link'
import { watchText } from './watch-text'
import './watch.css'

function ShareBody({ sessionId, title, onClose }: { sessionId: string; title: string; onClose: () => void }): JSX.Element {
  const { lang } = useI18n()
  const text = watchText(lang)
  const share = useSessionWatch((s) => s.shares[sessionId])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [remoteOff, setRemoteOff] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    void window.yan.sessionShare.get(sessionId).then((view) => {
      if (alive) useSessionWatch.getState().setShare(sessionId, view)
    }, () => undefined)
    return () => {
      alive = false
    }
  }, [sessionId])

  const start = async (): Promise<void> => {
    setBusy(true)
    setError('')
    setRemoteOff(false)
    try {
      const result = await window.yan.sessionShare.start(sessionId, title)
      if (result.ok) useSessionWatch.getState().setShare(sessionId, result.share)
      else {
        setError(result.error)
        setRemoteOff(result.reason === 'remote-off')
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.yan.sessionShare.stop(sessionId)
      useSessionWatch.getState().setShare(sessionId, null)
    } finally {
      setBusy(false)
    }
  }

  const copy = (): void => {
    if (!share) return
    void navigator.clipboard.writeText(share.invite).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }, () => setError(text.copy))
  }

  const remove = async (deviceId: string): Promise<void> => {
    const next = await window.yan.sessionShare.removeViewer(sessionId, deviceId).catch(() => null)
    useSessionWatch.getState().setShare(sessionId, next)
  }

  return (
    <div className="watch-dialog" data-testid="watch-share-dialog">
      <p className="watch-dialog-lead">{text.shareLead}</p>
      {share ? (
        <>
          <TextArea
            className="watch-dialog-invite"
            label={text.shareInviteLabel}
            value={share.invite}
            isReadOnly
            rows={4}
            description={text.shareInviteHint}
            data-testid="watch-share-invite"
          />
          <p className="watch-dialog-section">{text.viewers}</p>
          {share.viewers.length ? (
            <ul className="watch-dialog-viewers" data-testid="watch-share-viewers">
              {share.viewers.map((viewer) => (
                <li key={viewer.id} className="watch-dialog-viewer">
                  <span title={viewer.name}>{viewer.name}</span>
                  <IconButton size="sm" variant="ghost" aria-label={text.removeViewer(viewer.name)} tooltip={text.removeViewer(viewer.name)} onPress={() => void remove(viewer.id)}>
                    <X size={14} aria-hidden />
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : (
            <p className="watch-dialog-hint">{text.viewersEmpty}</p>
          )}
        </>
      ) : null}
      {error ? (
        <Notice tone="fail" compact data-testid="watch-share-error">
          {error}
        </Notice>
      ) : null}
      <DialogFooter align="between">
        {share ? (
          <Button variant="danger" isPending={busy} onPress={() => void stop()} data-testid="watch-share-stop">
            {text.shareStop}
          </Button>
        ) : remoteOff ? (
          <Button variant="secondary" onPress={() => { onClose(); openSettingsDialog('devices') }}>
            {text.openDeviceSettings}
          </Button>
        ) : (
          <span />
        )}
        {share ? (
          <Button variant="primary" icon={copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} onPress={copy} data-testid="watch-share-copy">
            {copied ? text.copied : text.copy}
          </Button>
        ) : (
          <Button variant="primary" isPending={busy} onPress={() => void start()} data-testid="watch-share-start">
            {text.shareStart}
          </Button>
        )}
      </DialogFooter>
    </div>
  )
}

function JoinBody({ onClose }: { onClose: () => void }): JSX.Element {
  const { lang } = useI18n()
  const text = watchText(lang)
  const [invite, setInvite] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const join = async (): Promise<void> => {
    if (!invite.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await window.yan.watch.join(invite.trim())
      if (!result.ok) {
        setError(result.error)
        return
      }
      useSessionWatch.getState().adopt(result.watch)
      const panel = useRightPanel.getState()
      panel.open(watchSurface(result.watch.id, result.watch.title || text.readOnly))
      panel.setOpen(true)
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="watch-dialog"
      data-testid="watch-join-dialog"
      onSubmit={(event) => {
        event.preventDefault()
        void join()
      }}
    >
      <p className="watch-dialog-lead">{text.joinLead}</p>
      <TextArea
        className="watch-dialog-invite"
        label={text.joinLabel}
        placeholder={text.joinPlaceholder}
        value={invite}
        onChange={(value) => {
          setInvite(value)
          setError('')
        }}
        rows={4}
        autoFocus
        data-testid="watch-join-input"
      />
      {error ? (
        <Notice tone="fail" compact data-testid="watch-join-error">
          {error}
        </Notice>
      ) : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onClose}>
          {text.cancel}
        </Button>
        <Button variant="primary" type="submit" isDisabled={!invite.trim()} isPending={busy} data-testid="watch-join-submit">
          {text.join}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function SessionWatchDialogs(): JSX.Element | null {
  const { lang } = useI18n()
  const text = watchText(lang)
  const dialog = useSessionWatch((s) => s.dialog)
  const acquireOverlayBlocker = useStore((s) => s.acquireOverlayBlocker)
  useEffect(() => listenSessionWatch(), [])
  useEffect(() => (dialog ? acquireOverlayBlocker('session-watch') : undefined), [dialog, acquireOverlayBlocker])
  if (!dialog) return null
  const close = (): void => useSessionWatch.getState().closeDialog()
  return (
    <ModalOverlay isDismissable isOpen onOpenChange={(open) => { if (!open) close() }}>
      <Modal>
        <Dialog title={dialog.kind === 'share' ? `${text.shareTitle} · ${dialog.title}` : text.joinTitle} closeLabel={text.close}>
          {dialog.kind === 'share' ? <ShareBody sessionId={dialog.sessionId} title={dialog.title} onClose={close} /> : <JoinBody onClose={close} />}
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
