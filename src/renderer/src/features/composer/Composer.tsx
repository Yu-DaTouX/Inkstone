import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { Button, IconButton, Separator } from '../../ui'
import type { Attachment } from '../../../../shared/ipc'
import { useI18n, useT } from '../../i18n'
import { currentThinkingLevels, useStore, pendingSendsForView } from '../../state/store'
import { submitComposerInput } from '../../lib/composer-submit'
import { composerStoreActions } from '../../lib/composer-store-send'
import { attachmentsAfterSubmit, runLocalCommandGuarded } from '../../lib/v3-submit-ownership'
import { readFiles } from './attachment-files'
import { fileReferencePath } from './file-refs'
import { composerSubmitIdentity } from '../../state/composer-recovery'
import { loadDraft, restoreDraft, saveDraft } from './draft-store'
import { ModelThinkingPicker } from '../../patterns/ModelThinkingPicker'
import { ContextRing } from '../../patterns/ContextRing'
import { AttachmentStrip, ImageRefWarning } from './AttachmentStrip'
import { imageRefPrefix, renumberImageRefsAfterRemoval, withImageLegend } from './image-refs'
import { ComposerBorder } from './ComposerBorder'
import { ComposerEditor, type ComposerEditorChange, type ComposerEditorHandle } from './ComposerEditor'
import {
  STRAY_ENTER_MS,
  isComposingKey,
  planComposerKey,
  roundRunningOf,
  swallowStrayEnter,
  type ComposerKeyEvent,
  type ComposerPasteEvent
} from './composer-keys'
import { appendBlock, hasComposerText, prependBlock, type ComposerAtomSpec, type TextSelection } from './composer-text'
import { CANVAS_SEND_TO_CHAT_EVENT, type CanvasSendToChatDetail } from '../preview/canvas-share'
import { ComposerMenu } from './ComposerMenu'
import { PermissionToggle } from './PermissionToggle'
import { PlusMenu } from './PlusMenu'
import { PromptStash } from './PromptStash'
import { ProjectPicker } from './ProjectPicker'
import { QueueEditor } from './QueueEditor'
import { IsolationMergeBar } from './IsolationMergeBar'
import { PlanCard } from './PlanCard'
import { FileDropOverlay, useFileDropZone } from './FileDropZone'
import { attachDroppedFiles, captureDroppedFiles } from './drop-attach'
import { usePastedTextAttach } from './use-pasted-text'
import { VoiceButton } from './VoiceButton'
import { useSessionQuoteDrop } from './use-session-quote'
import { useCompletion } from './useCompletion'
import {
  composerLocalCommand,
  composerMode,
  composerPlaceholderKey,
  composerSubmitAction
} from './composer-layout'
import {
  INITIAL_PROMPT_HISTORY,
  humanPrompts,
  promptHistoryStep,
  queueRecallTarget,
  type PromptHistoryNav
} from './prompt-history'
import './composer.css'

let consumedComposerFocus = 0
let attachmentsConversation: string | null = null

export function Composer({ className }: { className?: string } = {}) {
  const t = useT()
  const { lang } = useI18n()
  const [value, setValue] = useState('')
  const valueRef = useRef(value)
  valueRef.current = value
  const wrapRef = useRef<HTMLDivElement>(null)
  useSessionQuoteDrop(wrapRef)
  const editorRef = useRef<ComposerEditorHandle>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  const [composing, setComposing] = useState(false)
  const lastEsc = useRef(0)
  const submittingRef = useRef(false)
  const historyRef = useRef(INITIAL_PROMPT_HISTORY)
  const [historyNav, setHistoryNav] = useState<PromptHistoryNav | null>(null)
  const strayEnterUntil = useRef(-Infinity)
  const armStrayEnter = useCallback((): void => {
    strayEnterUntil.current = Date.now() + STRAY_ENTER_MS
  }, [])

  const send = useStore((s) => s.send)
  const abort = useStore((s) => s.abort)
  const notify = useStore((s) => s.notify)
  const commands = useStore((s) => s.commands)
  const models = useStore((s) => s.models)
  const thinkingLevels = useStore(currentThinkingLevels)
  const session = useStore((s) => s.session)
  const sendKey = useStore((s) => s.settings?.sendKey ?? 'auto')
  const sessionId = session?.sessionId

  const roundRunning = useStore((s) =>
    roundRunningOf({
      runnerRunning: !!s.runners.find((r) => (r.runId ?? r.id) === s.activeRunnerId)?.running,
      isStreaming: s.session?.isStreaming,
      isCompacting: s.session?.isCompacting
    })
  )
  const compacting = useStore((s) => !!s.session?.isCompacting)

  const runtimeKey = useStore((s) => {
    if (s.peekedSessionId) return s.peekedSessionId
    const runner = s.runners.find((item) => (item.runId ?? item.id) === s.activeRunnerId)
    const sid = s.session?.sessionId ?? runner?.sessionId
    return sid || (s.activeRunnerId ? `run:${s.activeRunnerId}` : '')
  })
  const freshSession = useStore((s) => s.messages.length === 0 && !s.peekedSessionId)
  const firstRun = useStore((s) => s.sessions.every((item) => (item.messageCount ?? 0) === 0))
  const conversationKey = useStore((s) => s.peekedSessionId ?? s.session?.conversationId) ?? runtimeKey
  const historyKey = runtimeKey || conversationKey
  const setSessionDraft = useStore((s) => s.setSessionDraft)

  const editorInject = useStore((s) => s.editorInject)
  const consumeEditorInject = useStore((s) => s.consumeEditorInject)
  const composerInsert = useStore((s) => s.composerInsert)
  const clearComposerInsert = useStore((s) => s.clearComposerInsert)
  const queueRestore = useStore((s) => s.queueRestore)
  const consumeQueueRestore = useStore((s) => s.consumeQueueRestore)

  const attachmentCount = useStore((s) => s.attachments.length)
  const attachments = useStore((s) => s.attachments)
  const clearAttachments = useStore((s) => s.clearAttachments)
  const addAttachments = useStore((s) => s.addAttachments)
  const composerFocus = useStore((s) => s.composerFocus)

  useEffect(() => {
    armStrayEnter()
  }, [armStrayEnter])

  useEffect(() => {
    historyRef.current = { ...INITIAL_PROMPT_HISTORY, resetKey: historyKey }
    setHistoryNav(null)
  }, [historyKey])

  useEffect(() => {
    if (editorInject === null) return
    const { text, mode } = editorInject
    setValue((v) => (mode === 'append' ? appendBlock(v, text) : text))
    consumeEditorInject()
    editorRef.current?.focus()
    armStrayEnter()
  }, [editorInject, consumeEditorInject, armStrayEnter])

  useEffect(() => {
    if (composerInsert === null) return
    setValue((v) => appendBlock(v, composerInsert))
    clearComposerInsert()
    editorRef.current?.focus()
    armStrayEnter()
  }, [composerInsert, clearComposerInsert, armStrayEnter])

  useEffect(() => {
    if (queueRestore === null) return
    setValue((v) => prependBlock(v, queueRestore))
    consumeQueueRestore()
    editorRef.current?.focus()
    armStrayEnter()
  }, [queueRestore, consumeQueueRestore, armStrayEnter])

  useEffect(() => {
    if (composerFocus.tick === consumedComposerFocus) return
    if (composerFocus.sessionId && composerFocus.sessionId !== sessionId) return
    consumedComposerFocus = composerFocus.tick
    armStrayEnter()
    requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }))
  }, [composerFocus, sessionId, armStrayEnter])

  const [hydratedDraftKey, setHydratedDraftKey] = useState<string | null>(null)
  const hydratedKey = useRef<string | null>(null)
  const skipPersist = useRef(false)
  useEffect(() => {
    const leavingConversation = !!attachmentsConversation && attachmentsConversation !== (conversationKey || null)
    attachmentsConversation = conversationKey || null
    hydratedKey.current = conversationKey || null
    skipPersist.current = true
    const persisted = runtimeKey ? loadDraft(runtimeKey) : undefined
    const state = useStore.getState()
    const restored = restoreDraft(runtimeKey ? state.sessionRuntimes[runtimeKey] : undefined, persisted)
    setValue(restored.text)
    setHydratedDraftKey(runtimeKey)
    setCursor(runtimeKey ? restored.text.length : null)
    const ownAttachments = restored.attachments
    if (leavingConversation || ownAttachments.length) {
      if (ownAttachments !== state.attachments && (ownAttachments.length || state.attachments.length)) useStore.setState({ attachments: ownAttachments })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationKey, runtimeKey])
  useEffect(() => {
    if (!runtimeKey || hydratedDraftKey !== runtimeKey || hydratedKey.current !== conversationKey) return undefined
    const draft = { text: value, attachments }
    const timer = setTimeout(() => saveDraft(runtimeKey, draft), 250)
    return () => {
      clearTimeout(timer)
      saveDraft(runtimeKey, draft)
    }
  }, [runtimeKey, hydratedDraftKey, conversationKey, value, attachments])
  const latestDraft = useRef({ key: '', text: '', attachments })
  if (hydratedDraftKey === runtimeKey) latestDraft.current = { key: runtimeKey ?? '', text: value, attachments }
  useEffect(
    () => () => {
      const { key, text, attachments: saved } = latestDraft.current
      if (key) saveDraft(key, { text, attachments: saved })
    },
    []
  )
  useEffect(() => {
    if (skipPersist.current) {
      skipPersist.current = false
      return
    }
    if (!runtimeKey || hydratedDraftKey !== runtimeKey || hydratedKey.current !== conversationKey) return
    setSessionDraft(value, runtimeKey)
  }, [runtimeKey, hydratedDraftKey, conversationKey, setSessionDraft, value])

  const insertAtCursor = useCallback((text: string): void => {
    editorRef.current?.insertText(text)
  }, [])

  useEffect(() => {
    const onSendToChat = (event: Event): void => {
      const detail = (event as CustomEvent<CanvasSendToChatDetail>).detail
      const editor = editorRef.current
      const node = document.querySelector('[data-testid="composer-input"]')
      if (!detail || !editor || !node || node.getClientRects().length === 0) return
      if (detail.text) insertAtCursor(valueRef.current.trim() ? `\n\n${detail.text}` : detail.text)
      editor.focus({ preventScroll: true })
      detail.handled = true
    }
    window.addEventListener(CANVAS_SEND_TO_CHAT_EVENT, onSendToChat)
    return () => window.removeEventListener(CANVAS_SEND_TO_CHAT_EVENT, onSendToChat)
  }, [insertAtCursor])

  const placeCursor = useCallback((pos: number): void => {
    setCursor(pos)
    requestAnimationFrame(() => {
      editorRef.current?.focus()
      editorRef.current?.setSelection(pos)
    })
  }, [])

  const chipContext = useMemo(
    () => ({
      commands: commands.map((command) => command.name),
      mentions: attachments.filter((item) => item.kind === 'file' && item.path).map((item) => item.path as string),
      imagePrefix: imageRefPrefix(lang),
      imageCount: attachments.filter((item) => item.kind !== 'file').length
    }),
    [attachments, commands, lang]
  )

  const insertAtom = useCallback(
    (range: TextSelection, spec: ComposerAtomSpec, trailing?: string) =>
      editorRef.current?.insertAtom(range, spec, trailing) ?? false,
    []
  )

  const caretInCode = useCallback(() => editorRef.current?.caretInCode() ?? false, [])
  const caretAfterMention = useCallback(() => editorRef.current?.caretAfterMention() ?? false, [])
  const isComposing = useCallback(() => editorRef.current?.isComposing() ?? false, [])
  const menuAnchor = useCallback(() => wrapRef.current?.querySelector('.composer')?.getBoundingClientRect() ?? null, [])
  const completion = useCompletion({
    value,
    cursor,
    setValue,
    placeCursor,
    insertAtom,
    caretInCode,
    caretAfterMention,
    isComposing,
    composing
  })

  const clearAll = useCallback((): void => {
    setValue('')
    clearAttachments()
  }, [clearAttachments])

  const restoreAttachments = useCallback((saved: Attachment[]): void => {
    useStore.setState((state) => ({
      attachments: [...saved, ...state.attachments.filter((item) => !saved.some((kept) => kept.id === item.id))]
    }))
  }, [])

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
      actions: composerStoreActions(),
      clearText: () => setValue(''),
      clearAll,
      restoreText: (raw) => setValue((draft) => (draft ? `${raw}\n${draft}` : raw)),
      restoreAttachments,
      readAttachments: () => useStore.getState().attachments,
      send,
      holdSend: useStore.getState().holdSend,
      focusComposer: () => editorRef.current?.focus()
    })
  }, [value, commands, models, t, session, thinkingLevels, roundRunning, compacting, clearAll, restoreAttachments, send])

  const submitMessage = useCallback(
    async (mode: 'steer' | 'followUp'): Promise<void> => {
      const raw = value.trim()
      const attachments = useStore.getState().attachments
      if (!raw && attachments.length === 0) return
      if (submittingRef.current) return
      submittingRef.current = true
      const identity = composerSubmitIdentity(useStore.getState())
      let cleared = false
      try {
        if (composerLocalCommand(value, commands)) {
          await runLocalCommandGuarded({
            raw: value,
            ensureActivated: () => useStore.getState().ensureActivated(),
            run: runCommandPath,
            notifyBlocked: () => notify('error', t('composer.localCommandBlocked'))
          })
          return
        }
        const sentIds = attachments.map((a) => a.id)
        const sentFrom = runtimeKey
        const images = attachments
          .filter((a) => a.kind !== 'file')
          .map((a) => ({ data: a.data, mimeType: a.mimeType }))
        const fileRefs = attachments.filter((a) => a.kind === 'file' && a.path)
        const body = withImageLegend(raw, images.length, imageRefPrefix(lang))
        const outgoing = fileRefs.length
          ? `${body ? `${body}\n\n` : ''}${t('composer.fileRefs', { list: fileRefs.map((a) => `- ${fileReferencePath(a)}`).join('\n') })}`
          : body
        const sending = roundRunning ? send(outgoing, images.length ? images : undefined, mode) : send(outgoing, images.length ? images : undefined)
        setValue('')
        useStore.getState().dropSentAttachments(sentIds, sentFrom ? [sentFrom] : [])
        cleared = true
        const ok = await sending
        if (ok) {
          const saved = sentFrom ? loadDraft(sentFrom) : undefined
          if (saved) saveDraft(sentFrom, { text: saved.text, attachments: attachmentsAfterSubmit(saved.attachments, sentIds) })
        } else {
          useStore.getState().recoverComposerInput({ identity, text: value, attachments })
        }
      } catch (error) {
        if (cleared) useStore.getState().recoverComposerInput({ identity, text: value, attachments })
        notify('error', error instanceof Error && error.message ? error.message : t('state.error.sendFailed'))
      } finally {
        submittingRef.current = false
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [value, roundRunning, runCommandPath, notify, send, t, lang, runtimeKey]
  )

  const attachPastedText = usePastedTextAttach(wrapRef)
  const onPaste = useCallback(
    (e: ComposerPasteEvent) => {
      const files = [...e.clipboardData.items]
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f)
      if (files.length === 0) {
        if (attachPastedText(e.clipboardData.getData('text/plain'))) e.preventDefault()
        return
      }
      e.preventDefault()
      const identity = composerSubmitIdentity(useStore.getState())
      void readFiles(files, (items) => addAttachments(items, identity), (names) => notify('error', t('attachment.skipped', { names: names.join(', ') })))
    },
    [addAttachments, attachPastedText, notify, t]
  )

  const onDrop = useCallback(
    (data: DataTransfer) => {
      const dropped = captureDroppedFiles(data)
      if (!dropped) return
      attachDroppedFiles(dropped, composerSubmitIdentity(useStore.getState()), (names) => notify('error', t('attachment.skipped', { names: names.join(', ') })))
    },
    [notify, t]
  )
  const fileDrop = useFileDropZone(wrapRef, onDrop)

  const recallHistory = (e: ComposerKeyEvent): boolean => {
    const arrow = e.key === 'ArrowUp' || e.key === 'ArrowDown'
    if (!arrow && historyRef.current.index === null) return false
    if (arrow && (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey)) return false
    if (isComposingKey(e)) return false
    const empty = editorRef.current?.isEmpty() ?? value === ''
    if (arrow && e.key === 'ArrowUp' && empty && !completion.open && historyRef.current.index === null) {
      const state = useStore.getState()
      const target = queueRecallTarget({ followUp: state.queue.followUp, pending: pendingSendsForView(state) })
      if (target) {
        if (target.kind === 'pending') state.restoreSend(target.id)
        else void state.removeQueued(target.id)
        e.preventDefault()
        return true
      }
    }
    const selection = editorRef.current?.getSelection()
    const step = promptHistoryStep(historyRef.current, {
      resetKey: historyKey,
      key: e.key,
      composing: false,
      empty,
      caretAtStart: !selection || selection.start === 0,
      caretAtEnd: !selection || selection.end === value.length,
      text: value,
      prompts: humanPrompts(useStore.getState().messages)
    })
    const previousNav = historyRef.current.nav
    historyRef.current = step.state
    if (step.state.nav !== previousNav) setHistoryNav(step.state.nav)
    if (step.action === 'swallow') {
      e.preventDefault()
      return true
    }
    if (!arrow) return false
    if (step.action === 'recall' || step.action === 'restore') {
      e.preventDefault()
      const text = step.text ?? ''
      if (text === value) placeCursor(text.length)
      else setValue(text)
      return true
    }
    return false
  }

  const onKeyDown = (e: ComposerKeyEvent): void => {
    if (e.defaultPrevented || isComposingKey(e)) return
    if (
      swallowStrayEnter({
        event: e,
        until: strayEnterUntil.current,
        now: Date.now(),
        plainEnterSends: sendKey !== 'ctrlEnter'
      })
    ) {
      e.preventDefault()
      return
    }
    const completionHandled = completion.handleKey(e)
    if (!completionHandled && recallHistory(e)) return
    const plan = planComposerKey({
      event: e,
      completionHandled,
      running: roundRunning,
      compacting,
      sendKey,
      hasText: hasComposerText(value),
      hasAttachments: attachmentCount > 0,
      lastEsc: lastEsc.current,
      now: Date.now()
    })
    if (plan.preventDefault) e.preventDefault()
    lastEsc.current = plan.lastEsc
    if (plan.action === 'steer') void submitMessage('steer')
    else if (plan.action === 'followUp') void submitMessage('followUp')
    else if (plan.action === 'abort') void abort()
  }

  const handleEditorChange = useCallback((change: ComposerEditorChange): void => {
    setValue(change.text)
    setCursor(change.cursor)
  }, [])

  const rememberCursor = useCallback((position: number): void => {
    setCursor(position)
  }, [])

  const canSend = hasComposerText(value) || attachmentCount > 0
  const mode = composerMode(value)
  const placeholder = roundRunning
    ? t('composer.phRunning')
    : t(composerPlaceholderKey({ bash: mode === 'bash', session: !!sessionId && !freshSession, firstRun }))
  const historyStatus = historyNav
    ? `${t('composer.historyStatus', { n: historyNav.index, total: historyNav.total })}${
        historyNav.hasDraft ? ` · ${t('composer.historyDraftHint')}` : ''
      }`
    : ''
  const submitAction = composerSubmitAction({
    running: roundRunning,
    hasText: hasComposerText(value),
    hasAttachments: attachmentCount > 0
  })
  return (
    <div
      ref={wrapRef}
      className={`composer-wrap ${fileDrop && !fileDrop.dropped ? 'is-dropping' : ''} ${className ?? ''}`}
      data-session-quote-drop
    >
      <FileDropOverlay state={fileDrop} />
      <PromptStash value={value} onClear={clearAll} rootRef={wrapRef} />
      <IsolationMergeBar />
      <div className="composer" data-quote-label={t('composer.quoteDrop')}>
        <ComposerBorder />
        <PlanCard />
        <QueueEditor />
        <AttachmentStrip onRemoveImage={(n) => setValue((draft) => renumberImageRefsAfterRemoval(draft, n))} />
        <ImageRefWarning text={value} />
        <div className="composer-input">
          <ComposerMenu completion={completion} anchor={menuAnchor} />
          {historyNav ? (
            <div className="composer-history" role="status" aria-live="polite" data-testid="composer-history-status">
              {historyStatus}
            </div>
          ) : null}
          <div className="composer-line">
            {mode ? (
              <span className="composer-mode" data-mode={mode} data-testid="composer-mode">
                {mode === 'bash' ? t('composer.bashMode') : t('composer.cmdMode')}
              </span>
            ) : null}
            <ComposerEditor
              ref={editorRef}
              value={value}
              cursor={cursor}
              placeholder={placeholder}
              ariaLabel={t('composer.inputLabel')}
              expanded={completion.open}
              chipContext={chipContext}
              activeOptionId={completion.open ? (completion.slashMatches.length > 0 ? `composer-slash-option-${completion.index}` : completion.atImages.length + completion.atMatches.length > 0 ? `composer-at-option-${completion.index}` : undefined) : undefined}
              data-testid="composer-input"
              onChange={handleEditorChange}
              onCursorChange={rememberCursor}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onCompositionChange={setComposing}
            />
          </div>
          <div className="composer-bar">
            <div className="composer-tools">
              <ModelThinkingPicker />
              <PermissionToggle />
              {freshSession ? <ProjectPicker /> : null}
            </div>
            <div className="composer-line-end">
              <ContextRing />
              <Separator orientation="vertical" className="composer-group-sep composer-status-sep" />
              <PlusMenu onInsert={insertAtCursor} />
              <VoiceButton onText={insertAtCursor} scope={sessionId} />
              {submitAction === 'stop' ? (
                <IconButton
                  variant="secondary"
                  round
                  aria-label={t('composer.stop')}
                  tooltip={t('composer.stop')}
                  className="composer-send composer-stop"
                  data-testid="composer-stop"
                  onPress={() => void abort()}
                >
                  <Square size={10} fill="currentColor" aria-hidden />
                </IconButton>
              ) : (
                <Button
                  variant="primary"
                  round
                  aria-label={t('composer.go')}
                  className="composer-send"
                  data-testid="composer-send"
                  isDisabled={!canSend}
                  onPress={() => void submitMessage('steer')}
                >
                  <ArrowUp size={14} aria-hidden />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
