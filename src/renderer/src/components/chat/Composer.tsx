import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT, type TFunc } from '../../i18n'
import { useStore } from '../../state/store'
import { composerDraftKey, composerSubmitIdentity } from '../../state/composer-recovery'
import { displayedSessionOf, sameSplitSession } from '../../state/split-view'
import { ComposerBorder } from './ComposerBorder'
import { QuestionPanel } from './QuestionPanel'
import { ExtensionWidgets } from './ExtensionWidgets'
import { ModelThinkingPicker } from '../Pickers'
import { ComposerUsage } from './ComposerUsage'
import { ContextRing } from '../toolbar/NativeContextSection'
import { VoiceInputButton } from './VoiceInputButton'
import { findAtQuery, replaceAtQuery } from './at-query'
import { findSlashQuery, replaceSlashQuery } from './slash-query'
import type { FileListingStatus, FileRequestContext, SlashCommand } from '../../../../shared/ipc'
import { PlusMenu } from './PlusMenu'
import { readFiles, fmtSize } from './attachment-files'
import { QueueStack, PermissionPicker } from './ComposerPickers'
import { ApprovalCard } from './ApprovalCard'
import { ActiveSubagents } from './ActiveSubagents'
import { runPhaseText, useRunProgress } from './run-status'
import { formatDuration } from '../../../../shared/duration'
import { submitComposerInput } from '../../lib/composer-submit'
import { Tip } from '../ui'

const REST_H = 64
const REST_H_SHORT = 40
const SHORT_WINDOW_H = 640

export const composerRestHeight = (): number => (window.innerHeight <= SHORT_WINDOW_H ? REST_H_SHORT : REST_H)

export function fitComposerHeight(el: HTMLTextAreaElement): void {
  el.style.height = 'auto'
  el.style.height = `${Math.min(Math.max(el.scrollHeight, composerRestHeight()), 240)}px`
}

let consumedComposerFocus = 0
const FOCUS_REQUEST_TTL = 4000

export function Composer() {
  const t = useT()
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const send = useStore((s) => s.send)
  const holdSend = useStore((s) => s.holdSend)
  const abort = useStore((s) => s.abort)
  const runBash = useStore((s) => s.runBash)
  const running = useStore((s) => !!s.session?.isAgentRunning || !!s.session?.isStreaming)
  const roundRunning = useStore(
    (s) => !!s.runners.find((r) => (r.runId ?? r.id) === s.activeRunnerId)?.running || !!s.session?.isCompacting
  )
  const pendingSends = useStore((s) => s.pendingSends)
  const conn = useStore((s) => s.conn)
  const commands = useStore((s) => s.commands)
  const commandUse = useStore((s) => s.commandUse)
  const markCommandUsed = useStore((s) => s.markCommandUsed)
  const sendKey = useStore((s) => s.settings?.sendKey ?? 'auto')
  const reloadCommands = useStore((s) => s.reloadCommands)
  const openSettings = useStore((s) => s.openSettings)
  const notify = useStore((s) => s.notify)
  const commandsAt = useStore((s) => s.commandsAt)
  const attachments = useStore((s) => s.attachments)
  const activeSessionId = useStore((s) => s.session?.sessionId ?? '')
  const activeCwd = useStore((s) => s.session?.cwd ?? s.settings?.cwd ?? '')
  const activeRunnerId = useStore((s) => s.activeRunnerId ?? '')
  const activeGeneration = useStore((s) =>
    s.runners.find((runner) => (runner.runId ?? runner.id) === s.activeRunnerId)?.generation ?? 0
  )
  const draftKey = useStore((s) => composerDraftKey(s))
  const conversationKey = useStore((s) => s.session?.conversationId) ?? draftKey
  const cachedDraft = useStore((s) =>
    draftKey ? s.sessionRuntimes[draftKey]?.draft ?? '' : ''
  )
  const setSessionDraft = useStore((s) => s.setSessionDraft)
  const hydrateComposerDraft = useStore((s) => s.hydrateComposerDraft)
  const activeProjectId = useStore((s) => {
    const runner = s.runners.find((item) => (item.runId ?? item.id) === s.activeRunnerId)
    if (runner?.projectId) return runner.projectId
    const summary = s.sessions.find((item) => item.id === s.session?.sessionId || item.path === s.session?.sessionFile)
    if (summary?.scope === 'global') return undefined
    const cwd = s.session?.cwd ?? s.settings?.cwd ?? ''
    return summary?.projectId ?? s.settings?.projects.find((project) => {
      const a = project.cwd.replace(/[\\/]+$/, '').toLowerCase()
      const b = cwd.replace(/[\\/]+$/, '').toLowerCase()
      return a === b
    })?.id
  })
  const addAttachments = useStore((s) => s.addAttachments)
  const addFileRefs = useStore((s) => s.addFileRefs)
  const addFileRefPaths = useStore((s) => s.addFileRefPaths)
  const removeAttachment = useStore((s) => s.removeAttachment)
  const clearAttachments = useStore((s) => s.clearAttachments)
  const newSession = useStore((s) => s.newSession)
  const compact = useStore((s) => s.compact)
  const setModel = useStore((s) => s.setModel)
  const models = useStore((s) => s.models)
  const session = useStore((s) => s.session)
  const thinkingLevels = useStore((s) => s.thinkingLevels)
  const openBrowser = useStore((s) => s.openBrowser)
  const editorInject = useStore((s) => s.editorInject)
  const composerInsert = useStore((s) => s.composerInsert)
  const clearComposerInsert = useStore((s) => s.clearComposerInsert)
  const consumeEditorInject = useStore((s) => s.consumeEditorInject)
  const queueRestore = useStore((s) => s.queueRestore)
  const consumeQueueRestore = useStore((s) => s.consumeQueueRestore)

  const [dragging, setDragging] = useState(false)
  const [menu, setMenu] = useState<{ open: boolean; index: number }>({ open: false, index: 0 })
  const [cursor, setCursor] = useState<number | null>(null)
  const hydratedDraftKey = useRef<string | null>(null)
  const skipDraftPersist = useRef(false)

  const lastArrowUp = useRef(0)

  const [expanded, setExpanded] = useState(false)
  const sendRule: 'enter' | 'ctrl' =
    sendKey === 'enter' ? 'enter' : sendKey === 'ctrlEnter' ? 'ctrl' : expanded ? 'ctrl' : 'enter'
  const [tall, setTall] = useState(0)
  const resizeMoved = useRef(false)
  const collapsedValue = useRef<string | null>(null)

  const resetComposerHeight = useCallback((): void => {
    if (!ref.current) return
    ref.current.style.height = `${restHeight()}px`
    ref.current.style.maxHeight = ''
  }, [])

  const restHeight = composerRestHeight
  const TALL_H = 180

  const [heightAnimating, setHeightAnimating] = useState(false)
  const heightAnimTimer = useRef<number | null>(null)
  const animateHeight = useCallback((): void => {
    setHeightAnimating(true)
    if (heightAnimTimer.current !== null) window.clearTimeout(heightAnimTimer.current)
    heightAnimTimer.current = window.setTimeout(() => {
      heightAnimTimer.current = null
      setHeightAnimating(false)
    }, 240)
  }, [])
  useEffect(
    () => () => {
      if (heightAnimTimer.current !== null) window.clearTimeout(heightAnimTimer.current)
    },
    []
  )

  const toggleExpanded = useCallback((): void => {
    animateHeight()
    setExpanded((v) => {
      if (v) {
        collapsedValue.current = value
        resetComposerHeight()
        setTall(0)
        return false
      }
      collapsedValue.current = null
      setTall(TALL_H)
      return true
    })
  }, [value, resetComposerHeight, animateHeight])

  const resizeCleanup = useRef<(() => void) | null>(null)
  const resizing = useRef(false)
  useEffect(() => () => resizeCleanup.current?.(), [])

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      resizeCleanup.current?.()
      const pointerId = e.pointerId
      const startY = e.clientY
      const capAtStart = Math.max(96, Math.round(window.innerHeight * 0.35))
      const startT = Math.min(tall || (ref.current?.offsetHeight ?? TALL_H), capAtStart)
      const handle = e.currentTarget as HTMLElement
      let moved = 0
      let lastHeight = startT
      resizeMoved.current = false
      resizing.current = true
      try {
        handle.setPointerCapture(e.pointerId)
      } catch {
      }
      handle.classList.add('active')
      document.body.classList.add('resizing-composer')

      const onMove = (ev: PointerEvent): void => {
        const dy = startY - ev.clientY
        moved = Math.max(moved, Math.abs(dy))
        if (moved < 4) return
        const capNow = Math.max(96, Math.round(window.innerHeight * 0.35))
        const next = Math.max(40, Math.min(capNow, startT + dy))
        lastHeight = next
        setTall(next)
        if (next > 48) setExpanded(true)
        else setExpanded(false)
      }

      let finished = false
      const onUp = (): void => {
        if (finished) return
        finished = true
        handle.classList.remove('active')
        document.body.classList.remove('resizing-composer')
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
        document.removeEventListener('pointercancel', onUp)
        if (resizeCleanup.current === onUp) resizeCleanup.current = null
        resizing.current = false
        try { if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId) } catch { }

        resizeMoved.current = moved >= 4
        if (moved < 4) return
        if (lastHeight <= 48) {
          collapsedValue.current = value
          resetComposerHeight()
          setExpanded(false)
          setTall(0)
        }
      }

      resizeCleanup.current = onUp
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
      document.addEventListener('pointercancel', onUp)
    },
    [tall, toggleExpanded, value, resetComposerHeight]
  )

  const finishResizeClick = useCallback((): void => {
    if (!resizeMoved.current) toggleExpanded()
    resizeMoved.current = false
  }, [toggleExpanded])

  useEffect(() => {
    if (editorInject === null) return
    setValue((v) => (v ? `${v}\n${editorInject}` : editorInject))
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

  const focusRequest = useStore((s) => s.composerFocus)
  const shownId = useStore((s) => displayedSessionOf(s)?.sessionId)
  const shownPath = useStore((s) => displayedSessionOf(s)?.path)
  useEffect(() => {
    if (focusRequest.tick === consumedComposerFocus || Date.now() - focusRequest.at > FOCUS_REQUEST_TTL) return
    if (!sameSplitSession(focusRequest, { sessionId: shownId, path: shownPath })) return
    consumedComposerFocus = focusRequest.tick
    requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }))
  }, [focusRequest, shownId, shownPath])

  useEffect(() => {
    hydratedDraftKey.current = conversationKey || null
    skipDraftPersist.current = true
    setValue(draftKey ? cachedDraft : '')
    setCursor(draftKey ? cachedDraft.length : null)
    hydrateComposerDraft(draftKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationKey, draftKey])

  useEffect(() => {
    if (skipDraftPersist.current) {
      skipDraftPersist.current = false
      return
    }
    if (!draftKey || hydratedDraftKey.current !== conversationKey) return
    setSessionDraft(value)
  }, [draftKey, conversationKey, setSessionDraft, value])

  const [viewH, setViewH] = useState(() => window.innerHeight)
  useEffect(() => {
    const onResize = (): void => setViewH(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const need = Math.min(Math.max(el.scrollHeight, restHeight()), 240)
    const cap = Math.max(96, Math.round(viewH * 0.35))
    const h = Math.min(tall > 0 ? Math.max(tall, need) : need, cap)
    el.style.height = `${h}px`
    el.style.maxHeight = tall > 0 ? `${Math.min(Math.max(tall, 240), cap)}px` : ''

    if (expanded) return
    if (collapsedValue.current === value) {
      resetComposerHeight()
      return
    }
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 20
    const pad = 16
    if (!resizing.current && el.scrollHeight > lh * 3 + pad) {
      animateHeight()
      setExpanded(true)
      setTall(TALL_H)
    }
  }, [value, tall, expanded, viewH])

  const disabled = conn !== 'ready'
  const localCommandName = /^\/([^\s]+)/.exec(value.trim())?.[1]?.toLowerCase()
  const canRunLocalCommand = !!localCommandName && commands.some(
    (command) => command.source === 'yan' && command.executable && command.name.toLowerCase() === localCommandName
  )

  const bashMode = value.startsWith('!')
  const slashRange = useMemo(
    () => findSlashQuery(value, cursor ?? value.length),
    [cursor, value]
  )
  const slashQuery = slashRange?.query ?? null

  const slashMatches = useMemo(() => {
    if (slashQuery === null) return []
    const q = slashQuery.toLowerCase()
    const hit = commands
      .filter((c) => !c.hiddenInMenu)
      .filter((c) => c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q))
    return hit.sort((a, b) => {
      const sa = commandSourceRank(a)
      const sb = commandSourceRank(b)
      if (sa !== sb) return sa - sb
      const ua = commandUse[a.name] ?? 0
      const ub = commandUse[b.name] ?? 0
      if (ua !== ub) return ub - ua
      return a.name.localeCompare(b.name)
    })
  }, [commands, slashQuery, commandUse])

  const atQuery = useMemo(
    () => findAtQuery(value, cursor ?? value.length),
    [cursor, value]
  )

  const [paths, setPaths] = useState<string[]>([])
  const [pathsLoading, setPathsLoading] = useState(false)
  const [pathsError, setPathsError] = useState(false)
  const [pathsStatus, setPathsStatus] = useState<FileListingStatus>('empty')
  const [pathsTruncated, setPathsTruncated] = useState(false)
  const [atMenuDismissed, setAtMenuDismissed] = useState(false)
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false)

  useEffect(() => {
    if (atQuery === null) {
      setPaths([])
      setPathsLoading(false)
      setPathsError(false)
      setPathsStatus('empty')
      setPathsTruncated(false)
      setAtMenuDismissed(false)
      return
    }
    setPaths([])
    setPathsLoading(true)
    setPathsError(false)
    setPathsStatus('empty')
    setPathsTruncated(false)
    let alive = true
    const context: FileRequestContext = {
      cwd: activeCwd,
      generation: activeGeneration,
      ...(activeProjectId ? { projectId: activeProjectId } : {})
    }
    const requestKey = `${activeRunnerId}\0${activeSessionId}\0${activeCwd}\0${activeProjectId ?? ''}\0${activeGeneration}\0${atQuery.query}`
    const id = setTimeout(() => {
      void window.yan
        .completePath(atQuery.query, activeCwd, context)
        .then((result) => {
          const current = useStore.getState()
          const currentRunner = current.runners.find((runner) => (runner.runId ?? runner.id) === current.activeRunnerId)
          const currentSummary = current.sessions.find(
            (item) => item.id === current.session?.sessionId || item.path === current.session?.sessionFile
          )
          const currentCwd = current.session?.cwd ?? current.settings?.cwd ?? ''
          const currentProject = currentRunner?.projectId ?? (
            currentSummary?.scope === 'global'
              ? undefined
              : currentSummary?.projectId ?? current.settings?.projects.find((project) => {
                return sameFileCwd(project.cwd, currentCwd)
              })?.id
          ) ?? ''
          const currentKey = `${current.activeRunnerId ?? ''}\0${current.session?.sessionId ?? ''}\0${current.session?.cwd ?? current.settings?.cwd ?? ''}\0${currentProject}\0${currentRunner?.generation ?? 0}\0${atQuery.query}`
          const response = result.request
          const responseMatches = !response || (
            sameFileCwd(response.cwd, context.cwd) &&
            response.projectId === context.projectId &&
            response.generation === context.generation
          )
          if (alive && currentKey === requestKey && responseMatches) {
            setPaths(result.paths)
            setPathsLoading(false)
            setPathsStatus(result.status)
            setPathsTruncated(result.truncated)
            setPathsError(result.status !== 'ok' && result.status !== 'empty')
          }
        })
        .catch(() => {
          if (alive) {
            setPaths([])
            setPathsLoading(false)
            setPathsError(true)
          }
        })
    }, 120)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [activeCwd, activeGeneration, activeProjectId, activeRunnerId, activeSessionId, atQuery])

  const atMatches = useMemo(() => {
    if (atQuery === null || paths.length === 0) return []
    return paths
  }, [atQuery, paths])

  useEffect(() => {
    if (slashQuery !== null && slashMatches.length > 0 && !slashMenuDismissed) {
      setMenu({ open: true, index: 0 })
    } else if (atQuery !== null && !atMenuDismissed && (atMatches.length > 0 || pathsLoading || pathsError)) {
      setMenu({ open: true, index: 0 })
    } else {
      setMenu((m) => (m.open ? { open: false, index: 0 } : m))
    }
  }, [
    atMatches.length,
    atMenuDismissed,
    atQuery,
    pathsError,
    pathsLoading,
    slashMatches.length,
    slashMenuDismissed,
    slashQuery
  ])

  useEffect(() => {
    setSlashMenuDismissed(false)
  }, [slashQuery])

  const completeSlash = useCallback(
    (command: SlashCommand) => {
      if (!command.executable) return
      const range = findSlashQuery(value, cursor ?? value.length)
      if (!range) return
      const next = replaceSlashQuery(value, range, command.name)
      setValue(next.value)
      setCursor(next.cursor)
      setMenu({ open: false, index: 0 })
      markCommandUsed(command.name)
      ref.current?.focus()
    },
    [cursor, markCommandUsed, value]
  )

  useEffect(() => {
    if (slashQuery === null) return
    if (Date.now() - commandsAt < 30_000) return
    void reloadCommands()
  }, [slashQuery, commandsAt, reloadCommands])

  const completeAt = useCallback(
    (p: string) => {
      const range = findAtQuery(value, cursor ?? value.length)
      if (!range) return
      const next = replaceAtQuery(value, range, p)
      setValue(next.value)
      setCursor(next.cursor)
      if (!p.endsWith('/')) {
        setAtMenuDismissed(true)
        setMenu({ open: false, index: 0 })
      } else {
        setAtMenuDismissed(false)
      }
      ref.current?.focus()
    },
    [cursor, value]
  )

  const submit = () => {
    const view = useStore.getState()
    const identity = composerSubmitIdentity(view)
    const attachmentsAtSubmit = view.attachments
    const recover = (text: string, saved: typeof attachmentsAtSubmit): void => {
      useStore.getState().recoverComposerInput({ identity, text, attachments: saved })
    }
    return submitComposerInput({
      text: value,
      attachments,
      commands,
      models,
      t,
      session,
      thinkingLevels,
      roundRunning,
      isCompacting: !!useStore.getState().session?.isCompacting,
      actions: {
        runBash,
        openSettings,
        newSession: () => newSession({ scope: 'global' }),
        compact,
        openBrowser,
        setModel,
        exportHtml: (outputPath) => useStore.getState().exportHtml(outputPath),
        nativeSession: (action, args) => useStore.getState().nativeSession(action, args),
        copyLastReply: () => useStore.getState().copyLastReply(),
        clone: () => useStore.getState().clone(),
        setManualTitle: (id, title) => useStore.getState().setManualTitle(id, title),
        setThinking: (level) => useStore.getState().setThinking(level),
        notify
      },
      clearText: () => setValue(''),
      clearAll: () => {
        setValue('')
        clearAttachments()
      },
      restoreText: (raw) => recover(raw, []),
      restoreAttachments: (saved) => recover('', saved),
      readAttachments: () => attachmentsAtSubmit,
      send,
      holdSend,
      focusComposer: () => ref.current?.focus()
    })
  }

  useEffect(() => {
    if (roundRunning || pendingSends.length === 0) return
    void useStore.getState().releaseSend(pendingSends[0].id, 'followUp')
  }, [roundRunning, pendingSends])

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
      const internalPath = e.dataTransfer.getData('application/x-yan-file-path').trim()
      if (internalPath) {
        e.preventDefault()
        setDragging(false)
        void addFileRefPaths([internalPath])
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
    [addAttachments, addFileRefPaths, addFileRefs, notify, t]
  )

  const rememberCursor = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    setCursor(el.selectionStart)
  }, [])

  const insertAtCursor = (text: string): void => {
    const el = ref.current
    const at = el && document.activeElement === el ? el.selectionStart : (cursor ?? value.length)
    const next = `${value.slice(0, at)}${text}${value.slice(at)}`
    setValue(next)
    const pos = at + text.length
    setCursor(pos)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(pos, pos)
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.defaultPrevented) return

    const items = slashMatches.length > 0 ? slashMatches.map((c) => c.name) : atMatches
    if (menu.open && items.length > 0) {
      if (e.nativeEvent.isComposing) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMenu((m) => ({ ...m, index: (m.index + 1) % items.length }))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMenu((m) => ({ ...m, index: (m.index - 1 + items.length) % items.length }))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        if (slashMatches.length > 0) completeSlash(slashMatches[menu.index])
        else completeAt(items[menu.index])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAtMenuDismissed(true)
        if (slashMatches.length > 0) setSlashMenuDismissed(true)
        setMenu({ open: false, index: 0 })
        return
      }
    }

    if (e.key === 'ArrowUp' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (value.length === 0) {
        const now = Date.now()
        if (now - lastArrowUp.current < 400) {
          e.preventDefault()
          lastArrowUp.current = 0
          toggleExpanded()
          return
        }
        lastArrowUp.current = now
      }
    }

    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      const wantsSend =
        e.ctrlKey || e.metaKey
          ? true
          : sendKey === 'enter'
            ? !e.shiftKey
            : sendKey === 'ctrlEnter'
              ? false
              : !e.shiftKey && !expanded
      if (wantsSend) {
        e.preventDefault()
        void submit()
        return
      }
    }

    if (e.key === 'Escape' && expanded && !running) {
      e.preventDefault()
      toggleExpanded()
      return
    }

    if (e.key === 'Escape' && running) {
      e.preventDefault()
      void abort()
    }

  }

  return (
    <div
      className={`composer-wrap ${dragging ? 'dropping' : ''}`}
      data-autonomous="0"
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
      <QueueStack />
      <ApprovalCard />
      <ActiveSubagents />
      <div className="composer-stack">
      <div className="composer-orbit" data-testid="composer-orbit">
      <div className={`composer ${expanded ? 'tall' : ''} ${heightAnimating ? 'animating' : ''}`}>
        <ComposerBorder />
        <QuestionPanel />
        {attachments.length > 0 ? (
          <div className="attach-strip">
            {attachments.map((a) => (
              <div className="attach" key={a.id} title={`${a.name} · ${fmtSize(a.size)}`} data-kind={a.kind ?? 'image'}>
                {a.kind === 'file' ? (
                  <span className="attach-file-ico" aria-hidden>
                    <Icon name="file" size={12} />
                  </span>
                ) : (
                  <img src={`data:${a.mimeType};base64,${a.preview}`} alt={a.name} />
                )}
                <span className="attach-name">{a.name}</span>
                {a.kind === 'file' ? <span className="attach-size">{fmtSize(a.size)}</span> : null}
                <button
                  className="attach-del"
                  onClick={() => removeAttachment(a.id)}
                  title={t('composer.removeImage')}
                  aria-label={t('composer.removeImage')}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {menu.open && slashMatches.length > 0 ? (
          <div className="slash-menu" role="listbox" data-testid="slash-menu">
            <div className="slash-query" aria-hidden>
              <span className="slash-query-prompt">›</span>/{slashQuery}
            </div>
            {slashMatches.map((c, i) => (
              <Fragment key={`${c.source}:${c.name}:${c.module ?? ''}`}>
                {i === 0 || slashMatches[i - 1].source !== c.source ? (
                  <div className="slash-group" data-source={c.source}>{commandSourceLabel(t, c.source)}</div>
                ) : null}
                <button
                  className={`slash-item ${i === menu.index ? 'sel' : ''} ${c.executable ? '' : 'compat'}`}
                  onMouseEnter={() => setMenu((m) => ({ ...m, index: i }))}
                  onClick={() => completeSlash(c)}
                  disabled={!c.executable}
                  title={c.availability}
                  id={`composer-slash-option-${i}`}
                  role="option"
                  aria-disabled={!c.executable}
                  aria-selected={i === menu.index}
                >
                  <span className="slash-name">/{c.name}</span>
                  <span className="slash-desc" title={c.description}>{firstClause(c.description)}</span>
                  {c.module ? <span className="slash-src">{c.module}</span> : null}
                </button>
              </Fragment>
            ))}
            <div className="slash-hint" data-testid="slash-hint">
              <span>
                <kbd className="ui-kbd">↑↓</kbd> {t('composer.slashSelect')}
              </span>
              <span>
                <kbd className="ui-kbd">Enter</kbd> / <kbd className="ui-kbd">Tab</kbd> {t('composer.slashFill')}
              </span>
              <span>
                <kbd className="ui-kbd">Esc</kbd> {t('composer.slashClose')}
              </span>
              <span className="slash-count">{t('composer.slashCount', { n: slashMatches.length })}</span>
            </div>
          </div>
        ) : null}

        {menu.open && slashMatches.length === 0 && atQuery !== null ? (
          <div className="slash-menu" role="listbox" data-testid="at-menu">
            {pathsLoading ? <div className="slash-empty" data-testid="at-loading">{t('composer.pathLoading')}</div> : null}
            {!pathsLoading && pathsError ? (
              <div className="slash-empty" data-testid="at-error">
                {pathsStatus === 'permission' ? t('composer.pathPermission') : t('composer.pathError')}
              </div>
            ) : null}
            {!pathsLoading && !pathsError && atMatches.length === 0 ? (
              <div className="slash-empty" data-testid="at-empty">{t('composer.pathNoMatch')}</div>
            ) : null}
            {!pathsLoading && !pathsError ? atMatches.map((p, i) => (
              <button
                key={p}
                className={`slash-item ${i === menu.index ? 'sel' : ''}`}
                onMouseEnter={() => setMenu((m) => ({ ...m, index: i }))}
                onClick={() => completeAt(p)}
                id={`composer-at-option-${i}`}
                role="option"
                aria-selected={i === menu.index}
                title={toAbsoluteFilePath(activeCwd, p)}
              >
                <span className="slash-name">
                  <Icon name={p.endsWith('/') ? 'folder' : 'file'} size={12} />
                  {p}
                </span>
                <span className="slash-src">{p.endsWith('/') ? t('composer.dir') : t('composer.file')}</span>
              </button>
            )) : null}
            {!pathsLoading && !pathsError && pathsTruncated ? (
              <div className="slash-hint" data-testid="at-truncated">{t('composer.pathTruncated')}</div>
            ) : null}
          </div>
        ) : null}

        <div
          className="composer-resize"
          onPointerDown={startResize}
          onClick={finishResizeClick}
          title={expanded ? t('composer.resizeExpanded') : t('composer.resizeHint')}
          data-testid="composer-resize"
          role="separator"
          aria-orientation="horizontal"
          tabIndex={0}
          aria-label={t('composer.resizeHint')}
          aria-valuemin={40}
          aria-valuemax={Math.max(96, Math.round(window.innerHeight * 0.35))}
          aria-valuenow={Math.round(tall || (ref.current?.offsetHeight ?? restHeight()))}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault()
              const step = event.shiftKey ? 48 : 16
              const cap = Math.max(96, Math.round(window.innerHeight * 0.35))
              const current = tall || (ref.current?.offsetHeight ?? restHeight())
              const next = Math.max(40, Math.min(cap, current + (event.key === 'ArrowUp' ? step : -step)))
              setTall(next)
              setExpanded(next > 48)
            } else if (event.key === 'Home') {
              event.preventDefault()
              setTall(0)
              setExpanded(false)
            } else if (event.key === 'End') {
              event.preventDefault()
              setTall(Math.max(96, Math.round(window.innerHeight * 0.35)))
              setExpanded(true)
            }
          }}
        />

        <ExtensionWidgets placement="aboveEditor" />
        <div className="composer-line">
          <span className="composer-prompt" aria-hidden>
            {bashMode ? '$' : '›'}
          </span>
          <textarea
            ref={ref}
            rows={1}
            data-testid="composer"
            value={value}
            disabled={disabled}
            placeholder={
              disabled
                ? t('conn.starting')
                : running
                  ? t('composer.busy')
                  : expanded
                    ? t('composer.phTall')
                    : t('composer.ph')
            }
            onChange={(e) => {
              setValue(e.target.value)
              setCursor(e.target.selectionStart)
              setAtMenuDismissed(false)
            }}
            onSelect={rememberCursor}
            onClick={rememberCursor}
            onKeyUp={rememberCursor}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            aria-activedescendant={menu.open && slashMatches.length ? `composer-slash-option-${menu.index}` : menu.open && atQuery !== null && atMatches.length ? `composer-at-option-${menu.index}` : undefined}
          />
        </div>

        <ExtensionWidgets placement="belowEditor" />

        <div className="composer-bar">
          <div className="composer-tools">
            {bashMode ? (
              <span className="mode-badge bash">{t('composer.bashMode')}</span>
            ) : value.startsWith('/') ? (
              <span className="mode-badge cmd">{t('composer.cmdMode')}</span>
            ) : null}

            <PermissionPicker />
            <PlusMenu onInsert={insertAtCursor} />


            {expanded || sendKey !== 'auto' ? (
              <span className="ctool-hint" data-testid="composer-keyhint">
                {sendRule === 'enter' ? t('composer.keyEnterSend') : t('composer.keyCtrlSend')}
              </span>
            ) : null}
          </div>

          <VoiceInputButton onText={insertAtCursor} disabled={disabled} />
          <ContextRing />
          <ModelThinkingPicker />
          <RunSlot />
          {running && !value.trim() && attachments.length === 0 ? (
            <Tip label={t('composer.stop')}>
              <button
                className="send stop"
                data-testid="composer-stop"
                aria-label={t('composer.stop')}
                onClick={() => void abort()}
              >
                <span className="composer-stop-sq" aria-hidden />
              </button>
            </Tip>
          ) : (
            <button
              className="send"
              data-testid="send"
              onClick={() => void submit()}
              disabled={!value.trim() && attachments.length === 0 ? true : disabled && !canRunLocalCommand}
              title={
                sendRule === 'ctrl'
                  ? t('composer.keyCtrlSend')
                  : expanded
                    ? t('composer.sendTipTall')
                    : undefined
              }
            >
              <Icon name={bashMode ? 'terminal' : 'send'} size={12} />
              <span>{bashMode ? t('composer.run') : t('composer.go')}</span>
            </button>
          )}
        </div>
      </div>
      </div>
      <ComposerUsage />

      </div>

    </div>
  )
}

function RunSlot() {
  const t = useT()
  const progress = useRunProgress()
  const compaction = useStore((s) => s.session?.compaction)
  if (!progress) return null
  const elapsed = formatDuration(progress.elapsedMs)
  const text = runPhaseText(t, progress, compaction)
  const shown = progress.phase === 'tool' ? t('chat.working') : text
  return <span className="composer-run" role="status" aria-live="polite" data-testid="composer-run" title={text}>{shown} <span className="composer-run-time">{elapsed}</span></span>
}

function sameFileCwd(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
}

function toAbsoluteFilePath(cwd: string, rel: string): string {
  const root = cwd.replace(/[\\/]+$/, '')
  return rel ? `${root}\\${rel.replace(/\//g, '\\')}` : root
}

function firstClause(text?: string): string {
  if (!text) return ''
  const cut = text.search(/[。；;（(]|\.\s/)
  const head = (cut > 0 ? text.slice(0, cut) : text).trim()
  return head.length > 24 ? `${head.slice(0, 23)}…` : head
}

function commandSourceRank(command: SlashCommand): number {
  return {
    yan: 0,
    pi: 1,
    extension: 2,
    skill: 3,
    prompt: 4,
    compatibility: 5
  }[command.source]
}

function commandSourceLabel(t: TFunc, source: SlashCommand['source']): string {
  return t(({
    yan: 'composer.src.yan',
    pi: 'composer.src.pi',
    extension: 'composer.src.extension',
    skill: 'composer.src.skill',
    prompt: 'composer.src.prompt',
    compatibility: 'composer.src.compatibility'
  } as const)[source])
}
