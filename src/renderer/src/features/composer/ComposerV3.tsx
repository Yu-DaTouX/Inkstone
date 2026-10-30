import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
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
  STRAY_ENTER_MS,
  isComposingKey,
  planComposerKey,
  roundRunningOf,
  swallowStrayEnter,
  type ComposerKeyEvent,
  type ComposerPasteEvent
} from './composer-keys'
import { composerMode, composerPlaceholderKey } from './composer-layout'
import { hasComposerText, type ComposerAtomSpec, type TextSelection } from './composer-text'
import {
  INITIAL_PROMPT_HISTORY,
  humanPrompts,
  promptHistoryStep,
  queueRecallTarget,
  type PromptHistoryNav
} from './prompt-history'
import { useCompletion, firstClause } from './useCompletion'
import { imageRefLabel, imageRefPrefix, renumberImageRefsAfterRemoval } from './image-refs'
import { ImageViewer } from './image-viewer'
import './composer.css'

let consumedComposerFocus = 0

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
  const model = useComposerModelAdapter()
  const menuProps = useComposerMenuProps()
  const controlsLayout = useComposerControlsLayout()
  const stash = usePromptStashAdapter({ value, rootRef, onStashed: () => setValue('') })
  const stashFrame = composerStashFrameProps(stash, t)
  const contextUsage = useContextWindowSnapshot()
  const contextCompact = useContextCompactAdapter()
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

  const placeholder = t(composerPlaceholderKey({ bash: false, session: !!sessionId, firstRun: false }))

  const [composing, setComposing] = useState(false)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [historyNav, setHistoryNav] = useState<PromptHistoryNav | null>(null)
  const historyRef = useRef(INITIAL_PROMPT_HISTORY)
  const strayEnterUntil = useRef(-Infinity)
  const lastEsc = useRef(0)
  const commands = useStore((s) => s.commands)
  const composerFocus = useStore((s) => s.composerFocus)
  const abort = useStore((s) => s.abort)
  const sendKey = useStore((s) => s.settings?.sendKey ?? 'auto')
  const historyKey = useStore(
    (s) => s.peekedSessionId ?? s.session?.conversationId ?? s.session?.sessionId ?? ''
  )
  const roundRunning = useStore((s) =>
    roundRunningOf({
      runnerRunning: !!s.runners.find((runner) => (runner.runId ?? runner.id) === s.activeRunnerId)?.running,
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
    if (plan.action === 'steer') void submitMessage('steer')
    else if (plan.action === 'followUp') void submitMessage('followUp')
    else if (plan.action === 'abort') void abort()
  }

  const onPaste = (event: ComposerPasteEvent): void => {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file)
    if (files.length === 0) return
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
        >
          {mode === 'bash' ? t('composer.bashMode') : t('composer.cmdMode')}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
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
    <div className="composer-v3" ref={rootRef} data-testid="composer-v3">
      <QueuedRunsControl />
      <ComposerFrame
        editor={editor}
        menuLayer={menuLayer}
        banners={
          stash.isOpen ? (
            <ComposerStashMenuV3
              entries={stash.entries}
              onRestore={stash.restore}
              onDelete={stash.remove}
              onClose={stash.close}
              scopeRef={rootRef}
            />
          ) : null
        }
        attachments={
          <>
            {mediaRow}
            {fileList}
          </>
        }
        notice={notice ? <ComposerNotice message={notice.message} tone={notice.tone} slot="image-ref" /> : null}
        footerLeading={<ComposerAttachButton onFiles={attachments.addFiles} />}
        controls={
          <>
            <span ref={controlsLayout.attachHost} hidden aria-hidden />
            <ComposerControlsBar
              modelPicker={
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
                />
              }
              collapsed={false}
              hidden={!controlsLayout.visible}
              measuredHiddenBlockCount={controlsLayout.hiddenBlockCount}
              iconOnlyBlockCount={controlsLayout.iconOnlyBlockCount}
              showProviderUnavailable={model.instanceEntries.length === 0}
              providerSetupLabel={t('composer.t3.picker.openProviderSetup')}
              onOpenProviderSetup={model.openProviderSetup}
            />
          </>
        }
        primaryActions={
          <>
            {contextUsage ? (
              <ContextWindowMeter
                usage={contextUsage}
                modelDisplayName={contextCompact.modelDisplayName}
                onCompact={contextCompact.onCompact}
                compactDisabled={contextCompact.compactDisabled}
                compactDisabledReason={contextCompact.compactDisabledReason}
              />
            ) : (
              <ContextWindowMeterPlaceholder />
            )}
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
