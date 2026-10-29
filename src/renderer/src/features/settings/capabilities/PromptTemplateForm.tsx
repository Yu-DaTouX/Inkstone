import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { useStore } from '../../../state/store'
import { useT } from '../../../i18n'
import { Button, Dialog, Modal, ModalOverlay, TextArea, TextField } from '../../../ui'
import { Meta, Note, Warn } from './parts'
import { useCapsText } from './text'

export function PromptTemplateForm({
  runnerId,
  sessionId,
  onClose,
  onCreated
}: {
  runnerId: string | null
  sessionId?: string
  onClose(): void
  onCreated(): void
}): ReactElement {
  const text = useCapsText()
  const t = useT()
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [savedPath, setSavedPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const active = useRef(true)
  const inFlight = useRef(false)

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  const isCurrent = (): boolean => {
    const state = useStore.getState()
    return active.current && state.activeRunnerId === runnerId && state.session?.sessionId === sessionId
  }

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (inFlight.current || !isCurrent()) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    let path = savedPath
    const templateName = name.trim()
    try {
      if (!path) {
        const result = await window.yan.capabilities.createPromptTemplate({ name: templateName, content: content.trim() })
        if (!isCurrent()) return
        if (!result.ok || !result.path) {
          setError(result.error ?? text('promptSaveFailed'))
          return
        }
        path = result.path
        setSavedPath(path)
      }
      if (!sessionId) {
        useStore.getState().notify('info', text('promptSavedNoSession'))
        onCreated()
        return
      }
      const result = await window.yan.nativeSession({ action: 'reload', expectedSessionId: sessionId })
      if (!isCurrent()) return
      if (!result.ok) {
        setError(text('promptSavedReloadFailed', { error: result.error ?? text('loadFailed') }))
        return
      }
      await useStore.getState().reloadCommands()
      if (!isCurrent()) return
      if (!useStore.getState().commands.some(command => command.source === 'prompt' && command.name === templateName)) {
        setError(text('promptSavedReloadFailed', { error: text('promptNotLoaded', { name: templateName }) }))
        return
      }
      useStore.getState().notify('info', text('promptCreated', { name: templateName }))
      onCreated()
    } catch (cause) {
      if (!isCurrent()) return
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(path ? text('promptSavedReloadFailed', { error: message }) : message)
    } finally {
      inFlight.current = false
      if (isCurrent()) setBusy(false)
    }
  }

  return (
    <ModalOverlay
      className="settings-confirm-overlay"
      isOpen
      isDismissable={false}
      isKeyboardDismissDisabled={busy}
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <Modal data-dialog-size="md">
        <Dialog title={text('promptCreate')} closeLabel={t('set.close')} showClose={!busy}>
          <form className="caps-stack" onSubmit={save} data-testid="caps-prompt-create-form">
            <TextField
              autoFocus
              label={text('promptName')}
              description={text('promptNameHint')}
              placeholder="translate"
              name="templateName"
              isRequired
              maxLength={64}
              value={name}
              onChange={setName}
              isDisabled={busy || !!savedPath}
              data-testid="caps-prompt-create-name"
            />
            <TextArea
              label={text('promptContent')}
              placeholder={text('promptContentPlaceholder')}
              name="templateContent"
              isRequired
              rows={6}
              maxLength={64_000}
              value={content}
              onChange={setContent}
              isDisabled={busy || !!savedPath}
              data-testid="caps-prompt-create-content"
            />
            <Note>{text('promptCreateHint')}</Note>
            {savedPath ? <Meta title={savedPath}>{text('promptSavedLocation', { path: savedPath })}</Meta> : null}
            {error ? <Warn>{error}</Warn> : null}
            <div className="caps-confirm-actions">
              <Button variant="ghost" isDisabled={busy} onPress={onClose}>
                {t(savedPath ? 'set.close' : 'ui.cancel')}
              </Button>
              <Button
                variant="primary"
                type="submit"
                isPending={busy}
                isDisabled={busy || !name.trim() || !content.trim()}
                data-testid="caps-prompt-create-save"
              >
                {text(savedPath ? 'promptRetryReload' : 'promptSave')}
              </Button>
            </div>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
