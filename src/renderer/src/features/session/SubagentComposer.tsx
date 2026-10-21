import { useState, type JSX, type KeyboardEvent } from 'react'
import { ArrowUp } from 'lucide-react'
import { useT } from '../../i18n'
import { IconButton, Notice, TextArea } from '../../ui'
import type { SubagentRun } from '../../../../shared/ipc'
import { subagentComposerMode } from './subagent-composer'

const MAX_CHARS = 12_000

export function SubagentComposer({ run }: { run: SubagentRun }): JSX.Element | null {
  const t = useT()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const mode = subagentComposerMode(run)
  if (mode === 'hidden') return null
  const blocked = mode === 'busy' || sending
  const value = text.trim()

  const send = async (): Promise<void> => {
    if (!value || blocked) return
    setSending(true)
    setError('')
    try {
      const result = await window.yan.subagents.send(run.id, value)
      if (result.ok) setText('')
      else setError(result.error ?? t('sa.composer.failed'))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void send()
  }

  const placeholder = mode === 'resume' ? t('sa.composer.resume') : t('sa.composer.steer')
  return (
    <div className="sa-composer" data-mode={mode} data-testid="v3-subagent-composer">
      <div className="sa-composer-box" onKeyDown={onKeyDown}>
        <TextArea
          aria-label={placeholder}
          placeholder={placeholder}
          rows={1}
          value={text}
          maxLength={MAX_CHARS}
          isDisabled={sending}
          onChange={setText}
          className="sa-composer-field"
          data-testid="v3-subagent-composer-input"
        />
        <IconButton
          size="sm"
          variant="secondary"
          aria-label={t('sa.composer.send')}
          isDisabled={!value || blocked}
          onPress={() => void send()}
          data-testid="v3-subagent-composer-send"
        >
          <ArrowUp size={14} aria-hidden />
        </IconButton>
      </div>
      {mode === 'busy' ? <p className="sa-composer-hint">{t('sa.composer.busy')}</p> : null}
      {error ? <Notice tone="fail" compact data-testid="v3-subagent-composer-error">{error}</Notice> : null}
    </div>
  )
}
