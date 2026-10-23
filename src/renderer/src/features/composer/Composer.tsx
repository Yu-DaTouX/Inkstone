import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { Button } from '../../ui'
import type { Attachment } from '../../../../shared/ipc'
import { useI18n, useT } from '../../i18n'
import { useStore, pendingSendsForView } from '../../state/store'
import { submitComposerInput } from '../../lib/composer-submit'
import { composerStoreActions } from '../../lib/composer-store-send'
import { attachmentsAfterSubmit, runLocalCommandGuarded } from '../../lib/v3-submit-ownership'
import { readFiles } from './attachment-files'
import { loadDraft, saveDraft } from './draft-store'
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
import { ProjectPicker } from './ProjectPicker'
import { QueueEditor } from './QueueEditor'
import { QuotaResumeBar } from './QuotaResumeBar'
import { IsolationMergeBar } from './IsolationMergeBar'
import { VoiceButton } from './VoiceButton'
import { useCompletion } from './useCompletion'
import {
  composerLocalCommand,
  composerMode,
  composerPlaceholderKey,
  composerPrompt,
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
  const [dragging, setDragging] = useState(false)
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
  const thinkingLevels = useStore((s) => s.thinkingLevels)
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
  const cachedDraft = useStore((s) => (runtimeKey ? s.sessionRuntimes[runtimeKey]?.draft ?? '' : ''))
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
  const addFileRefs = useStore((s) => s.addFileRefs)
  const addFileRefPaths = useStore((s) => s.addFileRefPaths)
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

  const hydratedKey = useRef<string | null>(null)
  const skipPersist = useRef(false)
  useEffect(() => {
    const leavingConversation = !!attachmentsConversation && attachmentsConversation !== (conversationKey || null)
    attachmentsConversation = conversationKey || null
    hydratedKey.current = conversationKey || null
    skipPersist.current = true
    const persisted = runtimeKey ? loadDraft(runtimeKey) : undefined
    const restored = runtimeKey ? cachedDraft || persisted?.text || '' : ''
    setValue(restored)
    setCursor(runtimeKey ? restored.length : null)
    const state = useStore.getState()
    const cachedAttachments = runtimeKey ? state.sessionRuntimes[runtimeKey]?.draftAttachments ?? [] : []
    const ownAttachments = cachedAttachments.length ? cachedAttachments : persisted?.attachments ?? []
    if (leavingConversation || ownAttachments.length) {
      if (ownAttachments !== state.attachments && (ownAttachments.length || state.attachments.length)) useStore.setState({ attachments: ownAttachments })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationKey])
  useEffect(() => {
    if (!runtimeKey || hydratedKey.current !== conversationKey) return undefined
    const timer = setTimeout(() => saveDraft(runtimeKey, { text: value, attachments }), 250)
    return () => clearTimeout(timer)
  }, [runtimeKey, conversationKey, value, attachments])
  const latestDraft = useRef({ key: '', text: '', attachments })
  latestDraft.current = { key: runtimeKey ?? '', text: value, attachments }
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
    if (!runtimeKey || hydratedKey.current !== conversationKey) return
    setSessionDraft(value, runtimeKey)
  }, [runtimeKey, conversationKey, setSessionDraft, value])

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
  const menuAnchor = useCallback(() => editorRef.current?.caretRect() ?? null, [])
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
          ? `${body ? `${body}\n\n` : ''}${t('composer.fileRefs', { list: fileRefs.map((a) => `- ${a.path}`).join('\n') })}`
          : body
        const ok = roundRunning
          ? await send(outgoing, images.length ? images : undefined, mode)
          : await send(outgoing, images.length ? images : undefined)
        if (ok) {
          setValue((draft) => (draft === value ? '' : draft))
          useStore.getState().dropSentAttachments(sentIds, sentFrom ? [sentFrom] : [])
          const saved = sentFrom ? loadDraft(sentFrom) : undefined
          if (saved) saveDraft(sentFrom, { text: saved.text, attachments: attachmentsAfterSubmit(saved.attachments, sentIds) })
        }
      } catch (error) {
        notify('error', error instanceof Error && error.message ? error.message : t('state.error.sendFailed'))
      } finally {
        submittingRef.current = false
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [value, roundRunning, runCommandPath, notify, send, t, lang, runtimeKey]
  )

  const onPaste = useCallback(
    (e: ComposerPasteEvent) => {
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
    ? `Enter ${t('queue.steerNow')} · Ctrl+Q / Alt+Enter ${t('queue.queueIt')}`
    : t(composerPlaceholderKey({ bash: mode === 'bash', session: !!sessionId && !freshSession, firstRun }))
  const prompt = composerPrompt(value)
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
      <IsolationMergeBar />
      <QueueEditor />
      <div className="composer">
        <ComposerBorder />
        <AttachmentStrip onRemoveImage={(n) => setValue((draft) => renumberImageRefsAfterRemoval(draft, n))} />
        <ImageRefWarning text={value} />
        <div className="composer-input">
          <ComposerMenu completion={completion} anchor={menuAnchor} />
          <div className="composer-line">
            <span className="composer-prompt" aria-hidden>
              {prompt}
            </span>
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
              {mode ? (
                <span className="composer-mode" data-mode={mode} data-testid="composer-mode">
                  {mode === 'bash' ? t('composer.bashMode') : t('composer.cmdMode')}
                </span>
              ) : null}
              <PermissionToggle />
              {freshSession ? <ProjectPicker /> : null}
              <PlusMenu onInsert={insertAtCursor} />
            </div>
            <div className="composer-aux">
              <VoiceButton onText={insertAtCursor} />
              <ContextRing />
            </div>
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
                <Square size={10} fill="currentColor" aria-hidden />
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
                <ArrowUp size={14} aria-hidden />
              </Button>
            )}
          </div>
        </div>
        <span className="sr-only" role="status" aria-live="polite" data-testid="composer-history-status">
          {historyStatus}
        </span>
      </div>
    </div>
  )
}
