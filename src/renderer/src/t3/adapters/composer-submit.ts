import { useCallback, useRef, useState } from 'react'
import type { Attachment } from '../../../../shared/ipc'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { currentThinkingLevels } from '../../state/store'
import { composerSubmitIdentity } from '../../state/composer-recovery'
import { composerStoreActions } from '../../lib/composer-store-send'
import { submitComposerInput } from '../../lib/composer-submit'
import { attachmentsAfterSubmit, runLocalCommandGuarded } from '../../lib/v3-submit-ownership'
import { roundRunningOf } from '../../features/composer/composer-keys'
import { composerLocalCommand } from '../../features/composer/composer-layout'
import { hasComposerText } from '../../features/composer/composer-text'
import { fileReferencePath } from '../../features/composer/file-refs'
import { imageRefPrefix, withImageLegend } from '../../features/composer/image-refs'
import { loadDraft, saveDraft } from '../../features/composer/draft-store'

export type ComposerSubmitMode = 'steer' | 'followUp'

export interface ComposerSubmitPorts {
  readonly value: string
  readonly clearText: () => void
  readonly restoreText: (text: string) => void
  readonly focusComposer: () => void
}

export interface ComposerSubmitAdapter {
  readonly isRunning: boolean
  readonly canInterrupt: boolean
  readonly isSendBusy: boolean
  readonly hasSendableContent: boolean
  readonly sendDisabledReason: string | null
  submit: (mode: ComposerSubmitMode) => Promise<void>
  interrupt: () => void
}

function runtimeKeyOf(s: {
  peekedSessionId: string | null
  session: { sessionId?: string } | null
  runners: { runId?: string; id: string; sessionId?: string }[]
  activeRunnerId: string | null
}): string {
  if (s.peekedSessionId) return s.peekedSessionId
  const runner = s.runners.find((item) => (item.runId ?? item.id) === s.activeRunnerId)
  const sid = s.session?.sessionId ?? runner?.sessionId
  return sid || (s.activeRunnerId ? `run:${s.activeRunnerId}` : '')
}

export function useComposerSubmitAdapter(ports: ComposerSubmitPorts): ComposerSubmitAdapter {
  const t = useT()
  const { lang } = useI18n()
  const portsRef = useRef(ports)
  portsRef.current = ports
  const submittingRef = useRef(false)
  const [busy, setBusy] = useState(false)

  const roundRunning = useStore((s) =>
    roundRunningOf({
      runnerRunning: !!s.runners.find((r) => (r.runId ?? r.id) === s.activeRunnerId)?.running,
      isStreaming: s.session?.isStreaming,
      isCompacting: s.session?.isCompacting
    })
  )
  const compacting = useStore((s) => !!s.session?.isCompacting)
  const attachmentCount = useStore((s) => s.attachments.length)
  const send = useStore((s) => s.send)

  const restoreAttachments = useCallback((saved: Attachment[]): void => {
    useStore.setState((state) => ({
      attachments: [
        ...saved,
        ...state.attachments.filter((item) => !saved.some((kept) => kept.id === item.id))
      ]
    }))
  }, [])

  const runCommandPath = useCallback(async (): Promise<void> => {
    const state = useStore.getState()
    await submitComposerInput({
      text: portsRef.current.value,
      attachments: state.attachments,
      commands: state.commands,
      models: state.models,
      t,
      session: state.session,
      thinkingLevels: currentThinkingLevels(state),
      roundRunning,
      isCompacting: compacting,
      actions: composerStoreActions(),
      clearText: () => portsRef.current.clearText(),
      clearAll: () => {
        portsRef.current.clearText()
        useStore.getState().clearAttachments()
      },
      restoreText: (raw) => portsRef.current.restoreText(raw),
      restoreAttachments,
      readAttachments: () => useStore.getState().attachments,
      send,
      holdSend: (outgoing, images) => useStore.getState().holdSend(outgoing, images),
      focusComposer: () => portsRef.current.focusComposer()
    })
  }, [t, roundRunning, compacting, restoreAttachments, send])

  const submit = useCallback(
    async (mode: ComposerSubmitMode): Promise<void> => {
      const value = portsRef.current.value
      const raw = value.trim()
      const attachments = useStore.getState().attachments
      if (!raw && attachments.length === 0) return
      if (submittingRef.current) return
      submittingRef.current = true
      setBusy(true)
      const identity = composerSubmitIdentity(useStore.getState())
      let cleared = false
      try {
        if (composerLocalCommand(value, useStore.getState().commands)) {
          await runLocalCommandGuarded({
            raw: value,
            ensureActivated: () => useStore.getState().ensureActivated(),
            run: runCommandPath,
            notifyBlocked: () => useStore.getState().notify('error', t('composer.localCommandBlocked'))
          })
          return
        }
        const sentIds = attachments.map((a) => a.id)
        const sentFrom = runtimeKeyOf(useStore.getState())
        const images = attachments
          .filter((a) => a.kind !== 'file')
          .map((a) => ({ data: a.data, mimeType: a.mimeType }))
        const fileRefs = attachments.filter((a) => a.kind === 'file' && a.path)
        const body = withImageLegend(raw, images.length, imageRefPrefix(lang))
        const outgoing = fileRefs.length
          ? `${body ? `${body}\n\n` : ''}${t('composer.fileRefs', {
              list: fileRefs.map((a) => `- ${fileReferencePath(a)}`).join('\n')
            })}`
          : body
        const sending = roundRunning
          ? send(outgoing, images.length ? images : undefined, mode)
          : send(outgoing, images.length ? images : undefined)
        portsRef.current.clearText()
        useStore.getState().dropSentAttachments(sentIds, sentFrom ? [sentFrom] : [])
        cleared = true
        const ok = await sending
        if (ok) {
          const saved = sentFrom ? loadDraft(sentFrom) : undefined
          if (saved) {
            saveDraft(sentFrom, {
              text: saved.text,
              attachments: attachmentsAfterSubmit(saved.attachments, sentIds)
            })
          }
        } else {
          useStore.getState().recoverComposerInput({ identity, text: value, attachments })
        }
      } catch (error) {
        if (cleared) useStore.getState().recoverComposerInput({ identity, text: value, attachments })
        useStore
          .getState()
          .notify(
            'error',
            error instanceof Error && error.message ? error.message : t('state.error.sendFailed')
          )
      } finally {
        submittingRef.current = false
        setBusy(false)
      }
    },
    [t, lang, roundRunning, runCommandPath, send]
  )

  const interrupt = useCallback((): void => {
    void useStore.getState().abort()
  }, [])

  return {
    isRunning: roundRunning,
    canInterrupt: roundRunning,
    isSendBusy: busy,
    hasSendableContent: hasComposerText(ports.value) || attachmentCount > 0,
    sendDisabledReason: null,
    submit,
    interrupt
  }
}
