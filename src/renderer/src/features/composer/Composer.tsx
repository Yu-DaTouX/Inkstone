import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { Button } from '../../ui'
import type { Attachment } from '../../../../shared/ipc'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { submitComposerInput } from '../../lib/composer-submit'
import { attachmentsAfterSubmit, runLocalCommandGuarded } from '../../lib/v3-submit-ownership'
import { readFiles } from './attachment-files'
import { ModelThinkingPicker } from '../../patterns/ModelThinkingPicker'
import { ContextRing } from '../../patterns/ContextRing'
import { AttachmentStrip, ImageRefWarning } from './AttachmentStrip'
import { imageRefPrefix, renumberImageRefsAfterRemoval, withImageLegend } from './image-refs'
import { ComposerBorder } from './ComposerBorder'
import { CompletionMenu } from './CompletionMenu'
import { ComposerUsage } from './ComposerUsage'
import { PermissionToggle } from './PermissionToggle'
import { PlusMenu } from './PlusMenu'
import { ProjectPicker } from './ProjectPicker'
import { QueueEditor } from './QueueEditor'
import { QuotaResumeBar } from './QuotaResumeBar'
import { VoiceButton } from './VoiceButton'
import { useCompletion } from './useCompletion'
import {
  composerMode,
  composerPrompt,
  composerSendKeyHint,
  composerSubmitAction
} from './composer-layout'
import './composer.css'

let consumedComposerFocus = 0

const MIN_H = 56
const MAX_H = 200

export function Composer({ className }: { className?: string } = {}) {
  const t = useT()
  const { lang } = useI18n()
  const [value, setValue] = useState('')
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const cursorRef = useRef<number | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  const lastEsc = useRef(0)
  const submittingRef = useRef(false)

  const send = useStore((s) => s.send)
  const abort = useStore((s) => s.abort)
  const runBash = useStore((s) => s.runBash)
  const notify = useStore((s) => s.notify)
  const commands = useStore((s) => s.commands)
  const models = useStore((s) => s.models)
  const thinkingLevels = useStore((s) => s.thinkingLevels)
  const session = useStore((s) => s.session)
  const sendKey = useStore((s) => s.settings?.sendKey ?? 'auto')
  const sessionId = session?.sessionId

  const roundRunning = useStore(
    (s) => !!s.runners.find((r) => (r.runId ?? r.id) === s.activeRunnerId)?.running || !!s.session?.isCompacting
  )
  const compacting = useStore((s) => !!s.session?.isCompacting)

  const runtimeKey = useStore((s) => {
    if (s.peekedSessionId) return s.peekedSessionId
    const runner = s.runners.find((item) => (item.runId ?? item.id) === s.activeRunnerId)
    const sid = s.session?.sessionId ?? runner?.sessionId
    return sid || (s.activeRunnerId ? `run:${s.activeRunnerId}` : '')
  })
  const freshSession = useStore((s) => s.messages.length === 0 && !s.peekedSessionId)
  const conversationKey = useStore((s) => s.peekedSessionId ?? s.session?.conversationId) ?? runtimeKey
  const cachedDraft = useStore((s) => (runtimeKey ? s.sessionRuntimes[runtimeKey]?.draft ?? '' : ''))
  const setSessionDraft = useStore((s) => s.setSessionDraft)

  const editorInject = useStore((s) => s.editorInject)
  const consumeEditorInject = useStore((s) => s.consumeEditorInject)
  const composerInsert = useStore((s) => s.composerInsert)
  const clearComposerInsert = useStore((s) => s.clearComposerInsert)
  const queueRestore = useStore((s) => s.queueRestore)
  const consumeQueueRestore = useStore((s) => s.consumeQueueRestore)

  const attachmentCount = useStore((s) => s.attachments.length)
  const clearAttachments = useStore((s) => s.clearAttachments)
  const addAttachments = useStore((s) => s.addAttachments)
  const addFileRefs = useStore((s) => s.addFileRefs)
  const addFileRefPaths = useStore((s) => s.addFileRefPaths)
  const composerFocus = useStore((s) => s.composerFocus)

  useEffect(() => {
    if (editorInject === null) return
    const { text, mode } = editorInject
    setValue((v) => (mode === 'append' && v ? `${v}\n${text}` : text))
    consumeEditorInject()
    ref.current?.focus()
  }, [editorInject, consumeEditorInject])

  useEffect(() => {
    if (composerInsert === null) return
    setValue((v) => (v ? `${v}\n${composerInsert}` : composerInsert))
    clearComposerInsert()
    ref.current?.focus()
  }, [composerInsert, clearComposerInsert])

  useEffect(() => {
    if (queueRestore === null) return
    setValue((v) => (v ? `${queueRestore}\n${v}` : queueRestore))
    consumeQueueRestore()
    ref.current?.focus()
  }, [queueRestore, consumeQueueRestore])

  useEffect(() => {
    if (composerFocus.tick === consumedComposerFocus) return
    if (composerFocus.sessionId && composerFocus.sessionId !== sessionId) return
    consumedComposerFocus = composerFocus.tick
    requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }))
  }, [composerFocus, sessionId])

  const hydratedKey = useRef<string | null>(null)
  const skipPersist = useRef(false)
  useEffect(() => {
    hydratedKey.current = conversationKey || null
    skipPersist.current = true
    setValue(runtimeKey ? cachedDraft : '')
    cursorRef.current = runtimeKey ? cachedDraft.length : null
    setCursor(cursorRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationKey])
  useEffect(() => {
    if (skipPersist.current) {
      skipPersist.current = false
      return
    }
    if (!runtimeKey || hydratedKey.current !== conversationKey) return
    setSessionDraft(value, runtimeKey)
  }, [runtimeKey, conversationKey, setSessionDraft, value])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, MIN_H), MAX_H)}px`
  }, [value])

  const insertAtCursor = useCallback((text: string): void => {
    const el = ref.current
    setValue((current) => {
      const pos = el && document.activeElement === el ? el.selectionStart : cursorRef.current ?? current.length
      cursorRef.current = pos + text.length
      setCursor(pos + text.length)
      requestAnimationFrame(() => {
        el?.focus()
        el?.setSelectionRange(pos + text.length, pos + text.length)
      })
      return `${current.slice(0, pos)}${text}${current.slice(pos)}`
    })
  }, [])

  const placeCursor = useCallback((pos: number): void => {
    cursorRef.current = pos
    setCursor(pos)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(pos, pos)
    })
  }, [])

  const completion = useCompletion({ value, cursor, setValue, placeCursor })

  const clearAll = useCallback((): void => {
    setValue('')
    clearAttachments()
  }, [clearAttachments])

  const restoreAttachments = useCallback((saved: Attachment[]): void => {
    useStore.setState((state) => ({
      attachments: [...saved, ...state.attachments.filter((item) => !saved.some((kept) => kept.id === item.id))]
    }))
  }, [])

  const isLocalCommand = (raw: string): boolean => {
    if (value.startsWith('!')) return true
    if (raw === '/login' || raw.startsWith('/login ')) return true
    const name = /^\/([^\s]+)/.exec(raw)?.[1]?.toLowerCase()
    if (!name) return false
    return commands.some((c) => (c.source === 'yan' || c.source === 'compatibility') && c.name.toLowerCase() === name)
  }

  const runCommandPath = useCallback(async (): Promise<void> => {
    await submitComposerInput({
      text: value,
      attachments: useStore.getState().attachments,
      commands,
      models,
      t,
      session,
      thinkingLevels,
      roundRunning,
      isCompacting: compacting,
      actions: {
        runBash,
        openSettings: (tab) => useStore.getState().openSettings(tab),
        newSession: () => useStore.getState().newSession({ scope: 'global' }),
        compact: (custom) => useStore.getState().compact(custom),
        openBrowser: (url) => useStore.getState().openBrowser(url),
        setModel: (provider, id) => useStore.getState().setModel(provider, id),
        exportHtml: (path) => useStore.getState().exportHtml(path),
        copyLastReply: () => useStore.getState().copyLastReply(),
        clone: () => useStore.getState().clone(),
        setManualTitle: (id, title) => useStore.getState().setManualTitle(id, title),
        setThinking: (level) => useStore.getState().setThinking(level),
        nativeSession: (action, args) => useStore.getState().nativeSession(action, args),
        notify
      },
      clearText: () => setValue(''),
      clearAll,
      restoreText: (raw) => setValue((draft) => (draft ? `${raw}\n${draft}` : raw)),
      restoreAttachments,
      readAttachments: () => useStore.getState().attachments,
      send,
      holdSend: useStore.getState().holdSend,
      focusComposer: () => ref.current?.focus()
    })
  }, [value, commands, models, t, session, thinkingLevels, roundRunning, compacting, runBash, notify, clearAll, restoreAttachments, send])

  const submitMessage = useCallback(
    async (mode: 'steer' | 'followUp'): Promise<void> => {
      const raw = value.trim()
      const attachments = useStore.getState().attachments
      if (!raw && attachments.length === 0) return
      if (submittingRef.current) return
      submittingRef.current = true
      try {
      if (isLocalCommand(raw)) {
        await runLocalCommandGuarded({
          raw: value,
          ensureActivated: () => useStore.getState().ensureActivated(),
          run: runCommandPath,
          notifyBlocked: () =>
            notify('error', t('composer.localCommandBlocked'))
        })
        return
      }
      const sentIds = attachments.map((a) => a.id)
      const images = attachments
        .filter((a) => a.kind !== 'file')
        .map((a) => ({ data: a.data, mimeType: a.mimeType }))
      const fileRefs = attachments.filter((a) => a.kind === 'file' && a.path)
      const body = withImageLegend(raw, images.length, imageRefPrefix(lang))
      const outgoing = fileRefs.length
        ? `${body ? `${body}\n\n` : ''}${t('composer.fileRefs', { list: fileRefs.map((a) => `- ${a.path}`).join('\n') })}`
        : body
      const ok = roundRunning ? await send(outgoing, images.length ? images : undefined, mode) : await send(outgoing, images.length ? images : undefined)
      if (ok) {
        setValue((draft) => (draft === value ? '' : draft))
        useStore.setState((state) => ({ attachments: attachmentsAfterSubmit(state.attachments, sentIds) }))
      }
      } finally {
        submittingRef.current = false
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [value, roundRunning, runCommandPath, notify, send, t, lang]
  )

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = [...e.clipboardData.items]
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f)
      if (files.length === 0) return
      e.preventDefault()
      void readFiles(files, addAttachments, (names) => notify('error', t('attachment.skipped', { names: names.join(', ') })))
    },
    [addAttachments, notify, t]
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const internalPaths = e.dataTransfer.getData('application/x-yan-file-paths').trim()
      const internalPath = e.dataTransfer.getData('application/x-yan-file-path').trim()
      if (internalPaths || internalPath) {
        e.preventDefault()
        setDragging(false)
        let paths = [internalPath]
        if (internalPaths) {
          try {
            const parsed: unknown = JSON.parse(internalPaths)
            paths = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [internalPath]
          } catch {
            paths = [internalPath]
          }
        }
        paths = paths.filter((value) => value.trim().length > 0)
        if (paths.length) void addFileRefPaths(paths)
        return
      }
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      setDragging(false)
      const files = [...e.dataTransfer.files]
      if (files.length === 0) return
      const images = files.filter((f) => f.type.startsWith('image/'))
      const others = files.filter((f) => !f.type.startsWith('image/'))
      if (images.length) void readFiles(images, addAttachments, (names) => notify('error', t('attachment.skipped', { names: names.join(', ') })))
      if (others.length) void addFileRefs(others)
    },
    [addAttachments, addFileRefs, addFileRefPaths, notify, t]
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.defaultPrevented) return
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return

    if (completion.handleKey(e)) return

    if (e.key === 'Enter') {
      const mod = e.ctrlKey || e.metaKey
      if (e.shiftKey) {
        return
      }
      if (roundRunning) {
        e.preventDefault()
        void submitMessage(compacting || e.altKey ? 'followUp' : 'steer')
        return
      }
      const wantsSend = mod ? true : sendKey === 'enter' ? true : sendKey === 'ctrlEnter' ? false : true
      if (wantsSend) {
        e.preventDefault()
        void submitMessage('steer')
      }
      return
    }

    if (e.key === 'Escape' && roundRunning) {
      if (value.trim() || attachmentCount > 0) return
      e.preventDefault()
      const now = Date.now()
      if (now - lastEsc.current < 500) {
        lastEsc.current = 0
        void abort()
      } else {
        lastEsc.current = now
      }
    }
  }

  const rememberCursor = (e: React.SyntheticEvent<HTMLTextAreaElement>): void => {
    cursorRef.current = e.currentTarget.selectionStart
    setCursor(e.currentTarget.selectionStart)
  }

  const canSend = value.trim().length > 0 || attachmentCount > 0
  const placeholder = roundRunning
    ? `Enter ${t('queue.steerNow')} · Alt+Enter ${t('queue.queueIt')}`
    : t('composer.ph')
  const mode = composerMode(value)
  const prompt = composerPrompt(value)
  const submitAction = composerSubmitAction({
    running: roundRunning,
    hasText: value.trim().length > 0,
    hasAttachments: attachmentCount > 0
  })
  const sendKeyHint = composerSendKeyHint(sendKey, false)

  return (
    <div
      className={`composer-wrap ${dragging ? 'is-dropping' : ''} ${className ?? ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-yan-file-path')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDragging(true)
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <QuotaResumeBar />
      <QueueEditor />
      <div className="composer">
        <ComposerBorder />
        <AttachmentStrip onRemoveImage={(n) => setValue((draft) => renumberImageRefsAfterRemoval(draft, n))} />
        <ImageRefWarning text={value} />
        <div className="composer-input">
          <CompletionMenu completion={completion} />
          <div className="composer-line">
            <span className="composer-prompt" aria-hidden>
              {prompt}
            </span>
            <textarea
              ref={ref}
              className="composer-text"
              value={value}
              placeholder={placeholder}
              rows={1}
              data-testid="composer-input"
              aria-label={t('composer.inputLabel')}
              spellCheck={false}
              role="combobox"
              aria-expanded={completion.open}
              aria-autocomplete="list"
              aria-activedescendant={completion.open ? (completion.slashMatches.length > 0 ? `composer-slash-option-${completion.index}` : completion.atImages.length + completion.atMatches.length > 0 ? `composer-at-option-${completion.index}` : undefined) : undefined}
              onChange={(e) => {
                setValue(e.target.value)
                cursorRef.current = e.target.selectionStart
                setCursor(e.target.selectionStart)
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onSelect={rememberCursor}
              onClick={rememberCursor}
            />
          </div>
          <div className="composer-bar">
            <div className="composer-tools">
              {mode ? (
                <span className="composer-mode" data-mode={mode} data-testid="composer-mode">
                  {mode === 'bash' ? t('composer.bashMode') : t('composer.cmdMode')}
                </span>
              ) : null}
              <PermissionToggle />
              {freshSession ? <ProjectPicker /> : null}
              <PlusMenu onInsert={insertAtCursor} />
              {sendKeyHint ? (
                <span className="composer-keyhint" data-testid="composer-keyhint">
                  {sendKeyHint === 'enter' ? t('composer.keyEnterSend') : t('composer.keyCtrlSend')}
                </span>
              ) : null}
            </div>
            <VoiceButton onText={insertAtCursor} />
            <ContextRing />
            <ModelThinkingPicker />
            {submitAction === 'stop' ? (
              <Button
                variant="secondary"
                size="sm"
                aria-label={t('composer.stop')}
                title={t('composer.stop')}
                className="composer-send composer-stop"
                data-testid="composer-stop"
                onPress={() => void abort()}
              >
                <Square size={14} aria-hidden />
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                aria-label={t('composer.go')}
                className="composer-send"
                data-testid="composer-send"
                isDisabled={!canSend}
                onPress={() => void submitMessage('steer')}
              >
                <ArrowUp size={16} aria-hidden />
              </Button>
            )}
          </div>
        </div>
      </div>
      <ComposerUsage />
    </div>
  )
}
