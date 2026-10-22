import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, FileListingStatus, FileRequestContext, SlashCommand } from '../../../../shared/ipc'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { findAtQuery, replaceAtQuery } from './at-query'
import { swallowsPendingCompletionKey, type ComposerKeyEvent } from './composer-keys'
import { replaceTextRange, type ComposerAtomSpec, type TextSelection } from './composer-text'
import { imageRefLabel, imageRefMatches, imageRefPrefix } from './image-refs'

export interface ImageRefOption {
  n: number
  label: string
  attachment: Attachment
}
import { findSlashQuery, replaceSlashQuery } from './slash-query'

export type SlashLoadStatus = 'idle' | 'loading' | 'error'

export interface CompletionState {
  slashQuery: string | null
  slashMatches: SlashCommand[]
  slashStatus: SlashLoadStatus
  retrySlash: () => void
  atQuery: string | null
  atImages: ImageRefOption[]
  atMatches: string[]
  atLoading: boolean
  atError: boolean
  atStatus: FileListingStatus
  atTruncated: boolean
  cwd: string
  open: boolean
  index: number
  setIndex: (index: number) => void
  completeSlash: (command: SlashCommand) => void
  completeAt: (path: string) => void
  completeImage: (option: ImageRefOption) => void
  handleKey: (event: ComposerKeyEvent) => boolean
}

interface Options {
  value: string
  cursor: number | null
  setValue: (value: string) => void
  placeCursor: (cursor: number) => void
  insertAtom?: (range: TextSelection, spec: ComposerAtomSpec, trailing?: string) => boolean
  caretInCode?: () => boolean
  caretAfterMention?: () => boolean
  isComposing?: () => boolean
  composing?: boolean
}

function commandSourceRank(command: SlashCommand): number {
  return { yan: 0, pi: 1, extension: 2, skill: 3, prompt: 4, compatibility: 5 }[command.source]
}

function foldCase(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return /^[a-zA-Z]:/.test(trimmed) || trimmed.includes('\\') ? trimmed.toLowerCase() : trimmed
}

function sameFileCwd(a: string, b: string): boolean {
  return foldCase(a) === foldCase(b)
}

export function toAbsoluteFilePath(cwd: string, rel: string): string {
  const root = cwd.replace(/[\\/]+$/, '')
  const sep = root.includes('\\') ? '\\' : '/'
  return rel ? `${root}${sep}${rel.replace(/[\\/]/g, sep)}` : root
}

export function firstClause(text?: string): string {
  if (!text) return ''
  const cut = text.search(/[。；;（(]|\.\s/)
  const head = (cut > 0 ? text.slice(0, cut) : text).trim()
  return head.length > 24 ? `${head.slice(0, 23)}…` : head
}

export function useCompletion({
  value,
  cursor,
  setValue,
  placeCursor,
  insertAtom,
  caretInCode,
  caretAfterMention,
  isComposing,
  composing = false
}: Options): CompletionState {
  const typedComposing = composing || (isComposing?.() ?? false)
  const commands = useStore((s) => s.commands)
  const commandUse = useStore((s) => s.commandUse)
  const commandsAt = useStore((s) => s.commandsAt)
  const markCommandUsed = useStore((s) => s.markCommandUsed)
  const reloadCommands = useStore((s) => s.reloadCommands)

  const activeSessionId = useStore((s) => s.session?.sessionId ?? '')
  const activeCwd = useStore((s) => s.session?.cwd ?? s.settings?.cwd ?? '')
  const attachments = useStore((s) => s.attachments)
  const { lang } = useI18n()
  const activeRunnerId = useStore((s) => s.activeRunnerId ?? '')
  const activeGeneration = useStore((s) =>
    s.runners.find((runner) => (runner.runId ?? runner.id) === s.activeRunnerId)?.generation ?? 0
  )
  const activeProjectId = useStore((s) => {
    const runner = s.runners.find((item) => (item.runId ?? item.id) === s.activeRunnerId)
    if (runner?.projectId) return runner.projectId
    const summary = s.sessions.find((item) => item.id === s.session?.sessionId || item.path === s.session?.sessionFile)
    if (summary?.scope === 'global') return undefined
    if (summary?.projectId) return summary.projectId
    const cwd = s.session?.cwd ?? s.settings?.cwd ?? ''
    return s.settings?.projects.find((project) => sameFileCwd(project.cwd, cwd))?.id
  })

  const [menu, setMenu] = useState<{ open: boolean; index: number }>({ open: false, index: 0 })
  const [paths, setPaths] = useState<string[]>([])
  const [atLoading, setAtLoading] = useState(false)
  const [atError, setAtError] = useState(false)
  const [atStatus, setAtStatus] = useState<FileListingStatus>('empty')
  const [atTruncated, setAtTruncated] = useState(false)
  const [atDismissed, setAtDismissed] = useState(false)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [slashStatus, setSlashStatus] = useState<SlashLoadStatus>('idle')

  const inCode = caretInCode?.() ?? false
  const afterMention = caretAfterMention?.() ?? false
  const slashRange = useMemo(
    () => findSlashQuery(value, cursor ?? value.length, { inCode }),
    [cursor, inCode, value]
  )
  const atRange = useMemo(() => findAtQuery(value, cursor ?? value.length, { inCode, afterMention }), [afterMention, cursor, inCode, value])
  const frozen = useRef<{ slash: string | null; at: string | null }>({ slash: null, at: null })
  if (!typedComposing) frozen.current = { slash: slashRange?.query ?? null, at: atRange?.query ?? null }
  const slashQuery = typedComposing ? frozen.current.slash : slashRange?.query ?? null
  const atQuery = typedComposing ? frozen.current.at : atRange?.query ?? null

  const atImages = useMemo<ImageRefOption[]>(() => {
    if (atQuery === null || atRange?.quoted) return []
    const prefix = imageRefPrefix(lang)
    const images = attachments.filter((a) => a.kind !== 'file')
    return imageRefMatches(prefix, images.length, atQuery).map((n) => ({
      n,
      label: imageRefLabel(prefix, n),
      attachment: images[n - 1]
    }))
  }, [atQuery, atRange?.quoted, attachments, lang])

  const slashMatches = useMemo(() => {
    if (slashQuery === null) return []
    const q = slashQuery.toLowerCase()
    return commands
      .filter((c) => !c.hiddenInMenu)
      .filter((c) => c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q))
      .sort((a, b) => {
        const sa = commandSourceRank(a)
        const sb = commandSourceRank(b)
        if (sa !== sb) return sa - sb
        const ua = commandUse[a.name] ?? 0
        const ub = commandUse[b.name] ?? 0
        if (ua !== ub) return ub - ua
        return a.name.localeCompare(b.name)
      })
  }, [commands, slashQuery, commandUse])

  const loadCommands = useCallback(() => {
    setSlashStatus('loading')
    const before = useStore.getState().commandsAt
    return reloadCommands().then(
      () => {
        const current = useStore.getState()
        setSlashStatus(current.commandsAt > before || current.commands.length > 0 ? 'idle' : 'error')
      },
      () => setSlashStatus('error')
    )
  }, [reloadCommands])

  useEffect(() => {
    if (slashQuery === null) return
    setSlashStatus('idle')
    if (Date.now() - commandsAt < 30_000) return
    void loadCommands()
  }, [slashQuery, commandsAt, loadCommands])

  const retrySlash = useCallback(() => {
    void loadCommands()
  }, [loadCommands])

  useEffect(() => {
    if (atQuery === null) {
      setPaths([])
      setAtLoading(false)
      setAtError(false)
      setAtStatus('empty')
      setAtTruncated(false)
      setAtDismissed(false)
      return
    }
    if (atDismissed) {
      setPaths([])
      setAtLoading(false)
      setAtError(false)
      setAtStatus('empty')
      setAtTruncated(false)
      return
    }
    setPaths([])
    setAtLoading(true)
    setAtError(false)
    setAtStatus('empty')
    setAtTruncated(false)
    let alive = true
    const context: FileRequestContext = {
      cwd: activeCwd,
      generation: activeGeneration,
      ...(activeProjectId ? { projectId: activeProjectId } : {})
    }
    const requestKey = `${activeRunnerId}\0${activeSessionId}\0${activeCwd}\0${activeProjectId ?? ''}\0${activeGeneration}\0${atQuery}`
    const id = setTimeout(() => {
      void window.yan
        .completePath(atQuery, activeCwd, context)
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
              : currentSummary?.projectId ?? current.settings?.projects.find((project) => sameFileCwd(project.cwd, currentCwd))?.id
          ) ?? ''
          const currentKey = `${current.activeRunnerId ?? ''}\0${current.session?.sessionId ?? ''}\0${currentCwd}\0${currentProject}\0${currentRunner?.generation ?? 0}\0${atQuery}`
          const response = result.request
          const responseMatches = !response || (
            sameFileCwd(response.cwd, context.cwd) &&
            response.projectId === context.projectId &&
            response.generation === context.generation
          )
          if (alive && currentKey === requestKey && responseMatches) {
            setPaths(result.paths)
            setAtLoading(false)
            setAtStatus(result.status)
            setAtTruncated(result.truncated)
            setAtError(result.status !== 'ok' && result.status !== 'empty')
          }
        })
        .catch(() => {
          if (alive) {
            setPaths([])
            setAtLoading(false)
            setAtError(true)
          }
        })
    }, 120)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [atDismissed, activeCwd, activeGeneration, activeProjectId, activeRunnerId, activeSessionId, atQuery])

  const slashReady = slashMatches.length > 0 || slashStatus === 'loading' || slashStatus === 'error'
  useEffect(() => {
    if (typedComposing) return
    if (slashQuery !== null && slashReady && !slashDismissed) {
      setMenu((m) => (m.open ? m : { open: true, index: 0 }))
    } else if (atQuery !== null && slashMatches.length === 0 && !atDismissed && (atImages.length > 0 || paths.length > 0 || atLoading || atError)) {
      setMenu((m) => (m.open ? m : { open: true, index: 0 }))
    } else {
      setMenu((m) => (m.open ? { open: false, index: 0 } : m))
    }
  }, [atDismissed, atError, atImages.length, atLoading, atQuery, paths.length, slashDismissed, slashMatches.length, slashQuery, slashReady, typedComposing])

  useEffect(() => {
    if (typedComposing) return
    setMenu((m) => (m.open ? { ...m, index: 0 } : m))
  }, [slashQuery, typedComposing])

  useEffect(() => {
    setSlashDismissed(false)
  }, [slashQuery])

  const atStart = atRange?.start ?? null
  useEffect(() => {
    setAtDismissed(false)
  }, [atStart])

  const completeSlash = useCallback(
    (command: SlashCommand) => {
      if (!command.executable) return
      const range = findSlashQuery(value, cursor ?? value.length)
      if (!range) return
      const next = replaceSlashQuery(value, range, command.name)
      const atomRange = { start: range.start - 1, end: range.end }
      const spec: ComposerAtomSpec = {
        kind: 'command',
        raw: `/${command.name}`,
        path: command.name,
        label: command.name
      }
      const trailing = next.cursor > atomRange.start + spec.raw.length ? ' ' : ''
      if (!insertAtom?.(atomRange, spec, trailing)) {
        setValue(next.value)
        placeCursor(next.cursor)
      }
      setMenu({ open: false, index: 0 })
      markCommandUsed(command.name)
    },
    [cursor, insertAtom, markCommandUsed, placeCursor, setValue, value]
  )

  const completeAt = useCallback(
    (path: string) => {
      const range = findAtQuery(value, cursor ?? value.length)
      if (!range) return
      const next = replaceAtQuery(value, range, path)
      const raw = `@${next.value.slice(range.start, next.cursor)}`
      const spec: ComposerAtomSpec = { kind: 'mention', raw, path }
      const trailing = path.endsWith('/') || /^\s/.test(value.slice(range.end)) ? '' : ' '
      if (!insertAtom?.({ start: range.start - 1, end: range.end }, spec, trailing)) {
        setValue(next.value)
        placeCursor(next.cursor)
      }
      if (!path.endsWith('/')) {
        setAtDismissed(true)
        setMenu({ open: false, index: 0 })
      } else {
        setAtDismissed(false)
      }
    },
    [cursor, insertAtom, placeCursor, setValue, value]
  )

  const completeImage = useCallback(
    (option: ImageRefOption) => {
      const range = findAtQuery(value, cursor ?? value.length)
      if (!range) return
      const after = value.slice(range.end)
      const insert = after.startsWith(' ') ? option.label : `${option.label} `
      const next = replaceTextRange(value, { start: range.start, end: range.end }, insert)
      const spec: ComposerAtomSpec = {
        kind: 'image',
        raw: `@${option.label}`,
        path: option.label,
        label: option.label
      }
      const trailing = insert.startsWith(option.label) ? insert.slice(option.label.length) : ''
      if (!insertAtom?.({ start: range.start - 1, end: range.end }, spec, trailing)) {
        setValue(next.text)
        placeCursor(next.cursor)
      }
      setAtDismissed(true)
      setMenu({ open: false, index: 0 })
    },
    [cursor, insertAtom, placeCursor, setValue, value]
  )

  const setIndex = useCallback((index: number) => setMenu((m) => ({ ...m, index })), [])

  const handleKey = (event: ComposerKeyEvent): boolean => {
    const count = slashMatches.length > 0 ? slashMatches.length : atImages.length + paths.length
    if (!menu.open) return false
    if (event.key === 'Escape') {
      event.preventDefault()
      if (slashMatches.length > 0 || slashQuery !== null) setSlashDismissed(true)
      else setAtDismissed(true)
      setMenu({ open: false, index: 0 })
      return true
    }
    if (count === 0) {
      if (swallowsPendingCompletionKey(event.key)) {
        event.preventDefault()
        return true
      }
      return false
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setMenu((m) => ({ ...m, index: (m.index + 1) % count }))
      return true
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setMenu((m) => ({ ...m, index: (m.index - 1 + count) % count }))
      return true
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setMenu((m) => ({ ...m, index: event.key === 'Home' ? 0 : count - 1 }))
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      if (slashMatches.length > 0) completeSlash(slashMatches[menu.index] ?? slashMatches[0])
      else if (menu.index < atImages.length) completeImage(atImages[menu.index])
      else {
        const path = paths[menu.index - atImages.length] ?? paths[0]
        if (path) completeAt(path)
      }
      return true
    }
    return false
  }

  return {
    slashQuery,
    slashMatches,
    slashStatus,
    retrySlash,
    atQuery,
    atImages,
    atMatches: paths,
    atLoading,
    atError,
    atStatus,
    atTruncated,
    cwd: activeCwd,
    open: menu.open,
    index: menu.index,
    setIndex,
    completeSlash,
    completeAt,
    completeImage,
    handleKey
  }
}
