import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Attachment, FileListingStatus, FileRequestContext, SlashCommand } from '../../../../shared/ipc'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { findAtQuery, replaceAtQuery } from './at-query'
import { imageRefLabel, imageRefMatches, imageRefPrefix } from './image-refs'

export interface ImageRefOption {
  n: number
  label: string
  attachment: Attachment
}
import { findSlashQuery, replaceSlashQuery } from './slash-query'

export interface CompletionState {
  slashQuery: string | null
  slashMatches: SlashCommand[]
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
  handleKey: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
}

interface Options {
  value: string
  cursor: number | null
  setValue: (value: string) => void
  placeCursor: (cursor: number) => void
}

export function commandSourceRank(command: SlashCommand): number {
  return { yan: 0, pi: 1, extension: 2, skill: 3, prompt: 4, compatibility: 5 }[command.source]
}

function sameFileCwd(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
}

export function toAbsoluteFilePath(cwd: string, rel: string): string {
  const root = cwd.replace(/[\\/]+$/, '')
  return rel ? `${root}\\${rel.replace(/\//g, '\\')}` : root
}

export function firstClause(text?: string): string {
  if (!text) return ''
  const cut = text.search(/[。；;（(]|\.\s/)
  const head = (cut > 0 ? text.slice(0, cut) : text).trim()
  return head.length > 24 ? `${head.slice(0, 23)}…` : head
}

export function useCompletion({ value, cursor, setValue, placeCursor }: Options): CompletionState {
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

  const slashRange = useMemo(() => findSlashQuery(value, cursor ?? value.length), [cursor, value])
  const slashQuery = slashRange?.query ?? null
  const atRange = useMemo(() => findAtQuery(value, cursor ?? value.length), [cursor, value])
  const atQuery = atRange?.query ?? null

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

  useEffect(() => {
    if (slashQuery === null) return
    if (Date.now() - commandsAt < 30_000) return
    void reloadCommands()
  }, [slashQuery, commandsAt, reloadCommands])

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
  }, [activeCwd, activeGeneration, activeProjectId, activeRunnerId, activeSessionId, atQuery])

  useEffect(() => {
    if (slashQuery !== null && slashMatches.length > 0 && !slashDismissed) {
      setMenu({ open: true, index: 0 })
    } else if (atQuery !== null && slashMatches.length === 0 && !atDismissed && (atImages.length > 0 || paths.length > 0 || atLoading || atError)) {
      setMenu({ open: true, index: 0 })
    } else {
      setMenu((m) => (m.open ? { open: false, index: 0 } : m))
    }
  }, [atDismissed, atError, atImages.length, atLoading, atQuery, paths.length, slashDismissed, slashMatches.length, slashQuery])

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
      setValue(next.value)
      placeCursor(next.cursor)
      setMenu({ open: false, index: 0 })
      markCommandUsed(command.name)
    },
    [cursor, markCommandUsed, placeCursor, setValue, value]
  )

  const completeAt = useCallback(
    (path: string) => {
      const range = findAtQuery(value, cursor ?? value.length)
      if (!range) return
      const next = replaceAtQuery(value, range, path)
      setValue(next.value)
      placeCursor(next.cursor)
      if (!path.endsWith('/')) {
        setAtDismissed(true)
        setMenu({ open: false, index: 0 })
      } else {
        setAtDismissed(false)
      }
    },
    [cursor, placeCursor, setValue, value]
  )

  const completeImage = useCallback(
    (option: ImageRefOption) => {
      const range = findAtQuery(value, cursor ?? value.length)
      if (!range) return
      const after = value.slice(range.end)
      const insert = after.startsWith(' ') ? option.label : `${option.label} `
      setValue(`${value.slice(0, range.start)}${insert}${after}`)
      placeCursor(range.start + option.label.length + 1)
      setAtDismissed(true)
      setMenu({ open: false, index: 0 })
    },
    [cursor, placeCursor, setValue, value]
  )

  const setIndex = useCallback((index: number) => setMenu((m) => ({ ...m, index })), [])

  const handleKey = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const count = slashMatches.length > 0 ? slashMatches.length : atImages.length + paths.length
    if (!menu.open || count === 0) return false
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
    if (event.key === 'Escape') {
      event.preventDefault()
      if (slashMatches.length > 0) setSlashDismissed(true)
      else setAtDismissed(true)
      setMenu({ open: false, index: 0 })
      return true
    }
    return false
  }

  return {
    slashQuery,
    slashMatches,
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
