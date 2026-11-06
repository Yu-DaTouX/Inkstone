import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { flushSync } from 'react-dom'
import { useI18n, useT } from '../../i18n'
import { pendingSendsForView, useStore } from '../../state/store'
import { ComposerFrame } from '../../t3/components/chat/ComposerFrame'
import {
  ComposerAttachmentFileList,
  ComposerAttachButton,
  ComposerAttachmentMediaRow
} from '../../t3/components/chat/ComposerAttachmentStrip'
import { ComposerControlsBar } from '../../t3/components/chat/ComposerControlsBar'
import { ComposerNotice } from '../../t3/components/chat/ComposerPromptLengthValidation'
import { ComposerPrimaryActions } from '../../t3/components/chat/ComposerPrimaryActions'
import {
  ContextWindowMeter,
  ContextWindowMeterPlaceholder
} from '../../t3/components/chat/ContextWindowMeter'
import { ComposerStashMenuV3, composerStashFrameProps } from '../../t3/components/chat/ComposerStashMenuV3'
import { ProviderModelPicker } from '../../t3/components/chat/ProviderModelPicker'
import { QueuedRunsControl } from '../../t3/components/chat/QueuedRunsControl'
import { PlanCard } from './PlanCard'
import { Kbd, KbdGroup } from '../../ui'
import { AskDock } from '../session/AskDock'
import { useComposerQuestionTitle } from '../session/question-composer'
import { usePastedTextAttach } from './use-pasted-text'
import { PROMPT_SUGGESTION_STATUS_KEY, suggestionKeyAction, visibleSuggestion } from './prompt-suggestion'
import { ComposerVoiceButton } from '../../t3/components/chat/ComposerVoiceButton'
import { setComposerEditorHandle, useComposerMenuProps } from '../../t3/components/chat/composerEventScope'
import { useAttachmentAdapter, useComposerDropTarget } from '../../t3/adapters/composer-attachments'
import { useComposerSubmitAdapter } from '../../t3/adapters/composer-submit'
import { useContextCompactAdapter, useContextWindowSnapshot } from '../../t3/adapters/context'
import { useComposerModelAdapter } from '../../t3/adapters/composer-model'
import { usePromptStashAdapter } from '../../t3/adapters/composer-stash'
import { useComposerNotice } from '../../t3/adapters/notice'
import { ComposerEditor, type ComposerEditorChange, type ComposerEditorHandle } from './ComposerEditor'
import {
  ComposerCommandMenu,
  composerSuggestionOptionId,
  type ComposerCommandItem
} from '../../t3/components/chat/ComposerCommandMenu'
import { ComposerCommandMenuLayer } from '../../t3/components/chat/ComposerCommandMenuLayer'
import { useComposerControlsLayout } from './composer-controls-layout'
import {
  ESC_ARM_WINDOW_MS,
  STRAY_ENTER_MS,
  isComposingKey,
  planComposerKey,
  roundRunningOf,
  viewRunnerRunning,
  swallowStrayEnter,
  type ComposerKeyEvent,
  type ComposerPasteEvent
} from './composer-keys'
import { composerMode, composerPlaceholderKey } from './composer-layout'
import { appendBlock, hasComposerText, prependBlock, type ComposerAtomSpec, type TextSelection } from './composer-text'
import {
  INITIAL_PROMPT_HISTORY,
  humanPrompts,
  promptHistoryStep,
  queueRecallTarget,
  type PromptHistoryNav
} from './prompt-history'
import { useCompletion, firstClause } from './useCompletion'
import { useSessionQuoteDrop } from './use-session-quote'
import { imageRefLabel, imageRefPrefix, renumberImageRefsAfterRemoval } from './image-refs'
import { ImageViewer } from './image-viewer'
import { ComposerHeightHandle } from './ComposerHeightHandle'
import { PendingModelChange } from './PendingModelChange'
import { ComposerWidthHandles } from './ComposerWidthHandles'
import { loadDraft, restoreDraft, saveDraft } from './draft-store'
import './composer.css'

let consumedComposerFocus = 0
let attachmentsConversation: string | null = null

function sourceLabelOf(t: ReturnType<typeof useT>, source: string): string {
  const key = ({
    yan: 'composer.src.yan',
    pi: 'composer.src.pi',
    extension: 'composer.src.extension',
    skill: 'composer.src.skill',
    prompt: 'composer.src.prompt',
    compatibility: 'composer.src.compatibility'
  } as const)[source as 'yan']
  return key ? t(key) : source
}

function baseName(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const at = trimmed.lastIndexOf('/')
  return at < 0 ? path : path.slice(at + 1)
}

function dirName(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const at = trimmed.lastIndexOf('/')
  return at < 0 ? '' : trimmed.slice(0, at)
}

const ComposerModelControls = memo(function ComposerModelControls(): JSX.Element {
  const t = useT()
  const model = useComposerModelAdapter()
  const menuProps = useComposerMenuProps()
  const layout = useComposerControlsLayout()
  return (
    <>
      <span ref={layout.attachHost} hidden aria-hidden />
      <ComposerControlsBar
        modelPicker={(menu) => (
          <ProviderModelPicker
            activeInstanceId={model.activeInstanceId}
            model={model.model}
            instanceEntries={model.instanceEntries}
            modelOptionsByInstance={model.modelOptionsByInstance}
            favoriteKeys={model.favoriteKeys}
            onInstanceModelChange={model.select}
            onToggleFavorite={model.toggleFavorite}
            onOpenProviderSetup={model.openProviderSetup}
            isComposerOwned
            floatingLayerProps={menuProps}
            open={menu.open}
            onOpenChange={menu.onOpenChange}
            aside={menu.aside}
            triggerBadge={menu.badge}
            footer={menu.footer}
          />
        )}
        collapsed={false}
        hidden={!layout.visible}
        measuredHiddenBlockCount={layout.hiddenBlockCount}
        iconOnlyBlockCount={layout.iconOnlyBlockCount}
        showProviderUnavailable={model.instanceEntries.length === 0}
        providerSetupLabel={t('composer.t3.picker.openProviderSetup')}
        onOpenProviderSetup={model.openProviderSetup}
      />
    </>
  )
})

const ComposerContextMeter = memo(function ComposerContextMeter(): JSX.Element {
  const usage = useContextWindowSnapshot()
  const compact = useContextCompactAdapter()
  return usage ? (
    <ContextWindowMeter
      usage={usage}
      modelDisplayName={compact.modelDisplayName}
      onCompact={compact.onCompact}
      compactDisabled={compact.compactDisabled}
      compactDisabledReason={compact.compactDisabledReason}
    />
  ) : <ContextWindowMeterPlaceholder />
})

export function ComposerV3(): JSX.Element {
  const t = useT()
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState<number | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const editorRef = useRef<ComposerEditorHandle>(null)
  const attachments = useAttachmentAdapter()
  const drop = useComposerDropTarget()
  const notice = useComposerNotice(value)
  const rootRef = useRef<HTMLDivElement>(null)
  useSessionQuoteDrop(rootRef)
  const attachPastedText = usePastedTextAttach(rootRef)
  const stash = usePromptStashAdapter({
    value,
    rootRef,
    onStashed: () => {
      setValue('')
      useStore.getState().clearAttachments()
    }
  })
  const stashFrame = composerStashFrameProps(stash, t)
  const submitAdapter = useComposerSubmitAdapter({
    value,
    clearText: () => setValue(''),
    restoreText: (text) => setValue(text),
    focusComposer: () => editorRef.current?.focus({ preventScroll: true })
  })
  const { lang } = useI18n()
  const sessionId = useStore((s) => s.session?.sessionId)

  useEffect(() => {
    setComposerEditorHandle({
      current: {
        focusAtEnd: () => {
          const editor = editorRef.current
          if (!editor) return
          editor.focus()
          editor.setSelection(editor.getText().length)
        }
      }
    })
    return () => setComposerEditorHandle(null)
  }, [])

  const prefix = imageRefPrefix(lang)
  const labelFor = useCallback((index: number) => imageRefLabel(prefix, index + 1), [prefix])

  const preview = previewId ? attachments.images.find((item) => item.id === previewId) : undefined

  const removeImage = useCallback(
    (id: string) => {
      const index = attachments.images.findIndex((item) => item.id === id)
      setValue((draft) => (index < 0 ? draft : renumberImageRefsAfterRemoval(draft, index + 1)))
      attachments.remove(id)
    },
    [attachments]
  )

  const [composing, setComposing] = useState(false)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [historyNav, setHistoryNav] = useState<PromptHistoryNav | null>(null)
  const historyRef = useRef(INITIAL_PROMPT_HISTORY)
  const strayEnterUntil = useRef(-Infinity)
  const lastEsc = useRef(0)
  const [escArmed, setEscArmed] = useState(false)
  const escArmedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (escArmedTimer.current) clearTimeout(escArmedTimer.current)
  }, [])
  const armEscAbort = useCallback((armed: boolean, ms = 0): void => {
    if (escArmedTimer.current) clearTimeout(escArmedTimer.current)
    escArmedTimer.current = armed ? setTimeout(() => setEscArmed(false), ms) : null
    setEscArmed(armed)
  }, [])
  const commands = useStore((s) => s.commands)
  const composerFocus = useStore((s) => s.composerFocus)
  const composerInsert = useStore((s) => s.composerInsert)
  const editorInject = useStore((s) => s.editorInject)
  const queueRestore = useStore((s) => s.queueRestore)
  const abort = useStore((s) => s.abort)
  const sendKey = useStore((s) => s.settings?.sendKey ?? 'auto')
  const historyKey = useStore(
    (s) => s.peekedSessionId ?? s.session?.conversationId ?? s.session?.sessionId ?? ''
  )
  const roundRunning = useStore((s) =>
    roundRunningOf({
      runnerRunning: viewRunnerRunning(s),
      isStreaming: s.session?.isStreaming,
      isCompacting: s.session?.isCompacting
    })
  )
  const compacting = useStore((s) => !!s.session?.isCompacting)

  const armStrayEnter = useCallback((): void => {
    strayEnterUntil.current = Date.now() + STRAY_ENTER_MS
  }, [])

  useEffect(() => {
    armStrayEnter()
  }, [armStrayEnter])

  useLayoutEffect(() => {
    setMenuAnchor(
      rootRef.current?.querySelector<HTMLElement>('[data-chat-composer-main-surface="true"]') ?? null
    )
  }, [])

  useEffect(() => {
    historyRef.current = { ...INITIAL_PROMPT_HISTORY, resetKey: historyKey }
    setHistoryNav(null)
  }, [historyKey])

  useEffect(() => {
    if (composerFocus.tick === consumedComposerFocus) return
    if (composerFocus.sessionId && composerFocus.sessionId !== sessionId) return
    consumedComposerFocus = composerFocus.tick
    armStrayEnter()
    requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }))
  }, [composerFocus, sessionId, armStrayEnter])

  const draftKey = useStore((s) => {
    if (s.peekedSessionId) return s.peekedSessionId
    const runner = s.runners.find((item) => (item.runId ?? item.id) === s.activeRunnerId)
    const sid = s.session?.sessionId ?? runner?.sessionId
    return sid || (s.activeRunnerId ? `run:${s.activeRunnerId}` : '')
  })
  const conversationKey = useStore((s) => s.peekedSessionId ?? s.session?.conversationId) ?? draftKey
  const storeAttachments = useStore((s) => s.attachments)
  const setSessionDraft = useStore((s) => s.setSessionDraft)
  const [hydratedDraftKey, setHydratedDraftKey] = useState<string | null>(null)
  const hydratedConversation = useRef<string | null>(null)
  const skipSessionDraft = useRef(false)
  useEffect(() => {
    const leavingConversation = !!attachmentsConversation && attachmentsConversation !== (conversationKey || null)
    attachmentsConversation = conversationKey || null
    hydratedConversation.current = conversationKey || null
    skipSessionDraft.current = true
    const state = useStore.getState()
    const restored = restoreDraft(draftKey ? state.sessionRuntimes[draftKey] : undefined, draftKey ? loadDraft(draftKey) : undefined)
    setValue(restored.text)
    setHydratedDraftKey(draftKey)
    setCursor(draftKey ? restored.text.length : null)
    if ((leavingConversation || restored.attachments.length) && restored.attachments !== state.attachments && (restored.attachments.length || state.attachments.length)) {
      useStore.setState({ attachments: restored.attachments })
    }
  }, [conversationKey, draftKey])
  const draftReady = !!draftKey && hydratedDraftKey === draftKey && hydratedConversation.current === conversationKey
  const pendingDraft = useRef<{ key: string; text: string; attachments: typeof storeAttachments } | null>(null)
  const flushDraft = useCallback((): void => {
    const pending = pendingDraft.current
    pendingDraft.current = null
    if (pending) saveDraft(pending.key, { text: pending.text, attachments: pending.attachments })
  }, [])
  useEffect(() => {
    if (!draftReady) return undefined
    pendingDraft.current = { key: draftKey, text: value, attachments: storeAttachments }
    const timer = setTimeout(flushDraft, 250)
    return () => clearTimeout(timer)
  }, [draftReady, draftKey, value, storeAttachments, flushDraft])
  useEffect(() => {
    window.addEventListener('pagehide', flushDraft)
    return () => {
      window.removeEventListener('pagehide', flushDraft)
      flushDraft()
    }
  }, [draftKey, flushDraft])
  useEffect(() => {
    if (skipSessionDraft.current) {
      skipSessionDraft.current = false
      return
    }
    if (draftReady) setSessionDraft(value, draftKey)
  }, [draftReady, draftKey, setSessionDraft, value])

  useEffect(() => {
    const pending = useStore.getState().composerInsert
    if (pending === null) return
    useStore.getState().clearComposerInsert()
    setValue((draft) => appendBlock(draft, pending))
    armStrayEnter()
    requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }))
  }, [composerInsert, armStrayEnter])

  useEffect(() => {
    if (editorInject === null) return
    useStore.getState().consumeEditorInject()
    setValue((draft) => (editorInject.mode === 'append' ? appendBlock(draft, editorInject.text) : editorInject.text))
    armStrayEnter()
    requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }))
  }, [editorInject, armStrayEnter])

  useEffect(() => {
    if (queueRestore === null) return
    useStore.getState().consumeQueueRestore()
    setValue((draft) => prependBlock(draft, queueRestore))
    armStrayEnter()
    requestAnimationFrame(() => editorRef.current?.focus({ preventScroll: true }))
  }, [queueRestore, armStrayEnter])

  const placeCursor = useCallback((position: number): void => {
    setCursor(position)
    requestAnimationFrame(() => {
      const editor = editorRef.current
      if (!editor) return
      editor.focus()
      editor.setSelection(position)
    })
  }, [])

  const insertAtom = useCallback(
    (range: TextSelection, spec: ComposerAtomSpec, trailing?: string) =>
      editorRef.current?.insertAtom(range, spec, trailing) ?? false,
    []
  )
  const caretInCode = useCallback(() => editorRef.current?.caretInCode() ?? false, [])
  const caretAfterMention = useCallback(() => editorRef.current?.caretAfterMention() ?? false, [])
  const editorComposing = useCallback(() => editorRef.current?.isComposing() ?? false, [])

  const completion = useCompletion({
    value,
    cursor,
    setValue,
    placeCursor,
    insertAtom,
    caretInCode,
    caretAfterMention,
    isComposing: editorComposing,
    composing
  })

  const chipContext = useMemo(
    () => ({
      commands: commands.map((command) => command.name),
      mentions: attachments.files.map((item) => item.path).filter((path): path is string => !!path),
      imagePrefix: prefix,
      imageCount: attachments.images.length
    }),
    [attachments.files, attachments.images.length, commands, prefix]
  )

  const mode = composerMode(value)
  const answering = useComposerQuestionTitle()
  const suggestionStatus = useStore((s) => s.statuses[PROMPT_SUGGESTION_STATUS_KEY])
  const suggestionsEnabled = useStore((s) => s.settings?.promptSuggestions !== false)
  const [dismissedSuggestion, setDismissedSuggestion] = useState<string | null>(null)
  useEffect(() => {
    if (!suggestionStatus) setDismissedSuggestion(null)
  }, [suggestionStatus])
  const suggestion = visibleSuggestion({
    suggestion: suggestionStatus,
    dismissed: dismissedSuggestion,
    enabled: suggestionsEnabled,
    running: roundRunning || submitAdapter.isSendBusy,
    answering: answering !== null,
    value,
    attachmentCount: attachments.count,
    composing
  })
  const placeholder = escArmed && roundRunning ? t('composer.phEscArmed') : suggestion ?? (mode === 'bash' ? t('composer.phBash') : answering !== null ? t('composer.phAnswerPlain') : roundRunning || submitAdapter.isSendBusy ? t('composer.phRunning') : t(composerPlaceholderKey({ bash: false, session: !!sessionId, firstRun: false })))
  const slashMode =
    completion.slashQuery !== null &&
    (completion.slashMatches.length > 0 || (completion.atQuery === null && completion.slashStatus !== 'idle'))
  const menuItems: ComposerCommandItem[] = !completion.open
    ? []
    : slashMode
      ? completion.slashMatches.map((command) => ({
          id: `slash:${command.name}`,
          type: 'slash-command' as const,
          command,
          label: `/${command.name}`,
          description: firstClause(command.description),
          sourceLabel: sourceLabelOf(t, command.source)
        }))
      : [
          ...completion.atImages.map((option) => ({
            id: `image:${option.n}`,
            type: 'image' as const,
            label: option.label,
            name: option.attachment.name,
            preview: option.attachment.preview.startsWith('data:')
              ? option.attachment.preview
              : `data:${option.attachment.mimeType};base64,${option.attachment.preview}`
          })),
          ...completion.atMatches.map((path) => ({
            id: `path:${path}`,
            type: 'path' as const,
            path,
            label: baseName(path),
            description: dirName(path)
          }))
        ]

  const selectMenuItem = (item: ComposerCommandItem): void => {
    if (item.type === 'slash-command') completion.completeSlash(item.command)
    else if (item.type === 'image') {
      const option = completion.atImages.find((entry) => entry.n === Number(item.id.slice('image:'.length)))
      if (option) completion.completeImage(option)
    } else completion.completeAt(item.path)
  }

  const submitMessage = (dispatch: 'steer' | 'followUp'): Promise<void> =>
    submitAdapter.submit(dispatch)

  const recallHistory = (event: ComposerKeyEvent): boolean => {
    const arrow = event.key === 'ArrowUp' || event.key === 'ArrowDown'
    if (!arrow && historyRef.current.index === null) return false
    if (arrow && (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)) return false
    if (isComposingKey(event)) return false
    const empty = editorRef.current?.isEmpty() ?? value === ''
    if (arrow && event.key === 'ArrowUp' && empty && !completion.open && historyRef.current.index === null) {
      const state = useStore.getState()
      const target = queueRecallTarget({ followUp: state.queue.followUp, pending: pendingSendsForView(state) })
      if (target) {
        if (target.kind === 'pending') state.restoreSend(target.id)
        else void state.removeQueued(target.id)
        event.preventDefault()
        return true
      }
    }
    const selection = editorRef.current?.getSelection()
    const step = promptHistoryStep(historyRef.current, {
      resetKey: historyKey,
      key: event.key,
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
      event.preventDefault()
      return true
    }
    if (!arrow) return false
    if (step.action === 'recall' || step.action === 'restore') {
      event.preventDefault()
      const text = step.text ?? ''
      if (text === value) placeCursor(text.length)
      else setValue(text)
      return true
    }
    return false
  }

  const onKeyDown = (event: ComposerKeyEvent): void => {
    if (event.defaultPrevented || isComposingKey(event)) return
    if (
      swallowStrayEnter({
        event,
        until: strayEnterUntil.current,
        now: Date.now(),
        plainEnterSends: sendKey !== 'ctrlEnter'
      })
    ) {
      event.preventDefault()
      return
    }
    const suggestionAction = suggestion ? suggestionKeyAction(event, sendKey) : null
    if (suggestion && suggestionAction) {
      event.preventDefault()
      if (suggestionAction === 'dismiss') setDismissedSuggestion(suggestion)
      else if (suggestionAction === 'fill') setValue(suggestion)
      else {
        flushSync(() => setValue(suggestion))
        void submitMessage('steer')
      }
      return
    }
    const completionHandled = completion.handleKey(event)
    if (!completionHandled && recallHistory(event)) return
    const plan = planComposerKey({
      event,
      completionHandled,
      running: roundRunning,
      compacting,
      sendKey,
      hasText: hasComposerText(value),
      hasAttachments: attachments.count > 0,
      lastEsc: lastEsc.current,
      now: Date.now()
    })
    if (plan.preventDefault) event.preventDefault()
    lastEsc.current = plan.lastEsc
    if (plan.action === 'armAbort') armEscAbort(true, ESC_ARM_WINDOW_MS)
    else if (escArmed) armEscAbort(false)
    if (plan.action === 'steer') void submitMessage('steer')
    else if (plan.action === 'followUp') void submitMessage('followUp')
    else if (plan.action === 'abort') void abort()
  }

  const appendVoiceText = (text: string): void => {
    const spoken = text.trim()
    if (!spoken) return
    setValue((draft) => (/[A-Za-z0-9]$/.test(draft) && /^[A-Za-z0-9]/.test(spoken) ? `${draft} ${spoken}` : `${draft}${spoken}`))
  }

  const onPaste = (event: ComposerPasteEvent): void => {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file)
    if (files.length === 0) {
      if (attachPastedText(event.clipboardData.getData('text/plain'))) event.preventDefault()
      return
    }
    event.preventDefault()
    attachments.addFiles(files)
  }

  const historyStatus = historyNav
    ? `${t('composer.historyStatus', { n: historyNav.index, total: historyNav.total })}${
        historyNav.hasDraft ? ` · ${t('composer.historyDraftHint')}` : ''
      }`
    : ''

  const menuLayer =
    completion.open && menuAnchor ? (
      <ComposerCommandMenuLayer anchor={menuAnchor}>
        <ComposerCommandMenu
          listId="composer-command-menu"
          items={menuItems}
          isLoading={slashMode ? completion.slashStatus === 'loading' : completion.atLoading}
          triggerKind={slashMode ? 'slash-command' : 'path'}
          activeItemId={menuItems[completion.index]?.id ?? null}
          total={menuItems.length}
          error={
            slashMode
              ? completion.slashStatus === 'error'
                ? 'slash'
                : null
              : completion.atError
                ? completion.atStatus === 'permission'
                  ? 'permission'
                  : 'path'
                : null
          }
          onRetry={slashMode ? completion.retrySlash : undefined}
          onHighlightedItemChange={(itemId) => {
            const index = menuItems.findIndex((item) => item.id === itemId)
            if (index >= 0) completion.setIndex(index)
          }}
          onSelect={selectMenuItem}
        />
      </ComposerCommandMenuLayer>
    ) : null

  const editor = (
    <div className="flex min-w-0 items-start gap-2" data-composer-editor-row="true">
      {mode ? (
        <span
          className="mt-0.5 inline-flex shrink-0 items-center gap-[0.2em] rounded-sm border border-border/60 bg-accent px-1 py-0.5 font-medium text-2xs text-foreground"
          data-mode={mode}
          data-testid="composer-mode"
          title={mode === 'bash' ? t('composer.bashModeTip') : undefined}
        >
          {mode === 'bash' ? t('composer.bashMode') : t('composer.cmdMode')}
        </span>
      ) : null}
      <div className="relative min-w-0 flex-1">
        {historyNav ? (
          <div
            className="mb-1 text-3xs text-muted-foreground tabular-nums"
            role="status"
            aria-live="polite"
            data-testid="composer-history-status"
          >
            {historyStatus}
          </div>
        ) : null}
        <ComposerEditor
          ref={editorRef}
          value={value}
          cursor={cursor}
          placeholder={placeholder}
          suggestion={!!suggestion}
          ariaLabel={t('composer.inputLabel')}
          expanded={completion.open}
          chipContext={chipContext}
          activeOptionId={
            completion.open && menuItems[completion.index]
              ? composerSuggestionOptionId('composer-command-menu', menuItems[completion.index].id)
              : undefined
          }
          data-testid="composer-input"
          onChange={(change: ComposerEditorChange) => {
            setValue(change.text)
            setCursor(change.cursor)
          }}
          onCursorChange={setCursor}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onCompositionChange={setComposing}
        />
        {suggestion && value === '' ? (
          <div className="composer-suggestion" aria-hidden="true" data-testid="composer-suggestion">
            {suggestion}
            <span className="composer-suggestion__keys">
              <Kbd>Tab</Kbd>
              <KbdGroup keys={sendKey === 'ctrlEnter' ? ['Ctrl', 'Enter'] : ['Enter']} />
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )

  const mediaRow = (
    <ComposerAttachmentMediaRow
      images={attachments.images}
      refLabel={labelFor}
      onExpandImage={setPreviewId}
      onRemoveImage={removeImage}
    />
  )
  const fileList = (
    <ComposerAttachmentFileList
      files={attachments.files}
      onPreviewFile={(id) => {
        const file = attachments.files.find((item) => item.id === id)
        if (file?.path) void useStore.getState().previewFile(file.path)
      }}
      onRemoveFile={attachments.remove}
    />
  )

  return (
    <div className="composer-v3" ref={rootRef} data-testid="composer-v3" data-session-quote-drop data-quote-label={t('composer.quoteDrop')}>
      <QueuedRunsControl />
      <PendingModelChange />
      <ComposerFrame
        editor={editor}
        menuLayer={menuLayer}
        banners={
          <>
            <AskDock />
            <PlanCard />
            {stash.isOpen ? (
              <ComposerStashMenuV3
                entries={stash.entries}
                onRestore={stash.restore}
                onDelete={stash.remove}
                onClose={stash.close}
                scopeRef={rootRef}
              />
            ) : null}
          </>
        }
        attachments={
          <>
            {mediaRow}
            {fileList}
          </>
        }
        notice={notice ? <ComposerNotice message={notice.message} tone={notice.tone} slot="image-ref" /> : null}
        footerLeading={
          <>
            <ComposerAttachButton onFiles={attachments.addFiles} />
            <ComposerVoiceButton onText={appendVoiceText} scope={sessionId ?? undefined} />
          </>
        }
        controls={<ComposerModelControls />}
        primaryActions={
          <>
            <ComposerContextMeter />
            <ComposerPrimaryActions
              isRunning={submitAdapter.isRunning}
              canInterrupt={submitAdapter.canInterrupt}
              isSendBusy={submitAdapter.isSendBusy}
              sendDisabledReason={submitAdapter.sendDisabledReason}
              hasSendableContent={submitAdapter.hasSendableContent}
              preserveComposerFocusOnPointerDown
              onSubmitMessage={(mode) => void submitMessage(mode)}
              onInterrupt={submitAdapter.interrupt}
            />
          </>
        }
        edgeHandles={
          <>
            <ComposerWidthHandles />
            <ComposerHeightHandle />
          </>
        }
        stash={stashFrame}
        dropActive={drop.active}
        dropProps={drop.handlers}
      />
      <ImageViewer
        isOpen={!!preview}
        src={preview ? preview.previewUrl : null}
        alt={preview?.name}
        caption={preview ? preview.name : undefined}
        onOpenChange={(open) => {
          if (!open) setPreviewId(null)
        }}
      />
    </div>
  )
}
