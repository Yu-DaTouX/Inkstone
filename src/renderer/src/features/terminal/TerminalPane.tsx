import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent } from 'react'
import { Plus, RefreshCw, SquareTerminal } from 'lucide-react'
import { Badge, Button, ConfirmDialog, EmptyState, KbdGroup, Menu, MenuItem, MenuSeparator, Notice, PaneHeader, Popover, type BadgeTone } from '../../ui'
import { PaneTitle, PaneTools, usePaneChrome } from '../workbench/pane-chrome'
import { useI18n, useT } from '../../i18n'
import { resourceOwner } from '../../state/resource-owners'
import { useStore } from '../../state/store'
import { showPreview } from '../workbench/preview-bindings'
import { isMacPlatform, resolveTerminalPath, terminalSelectionBlock, type TerminalFileLink, type TerminalLinkMatch } from './terminal-links'
import { terminalText } from './terminal-text'
import { selectOwnedTerminals } from './terminal-session'
import type { TerminalAdopt, TerminalViewState } from './terminal-session'
import {
  canAddTerminalTab,
  othersThan,
  pickActiveAfterClose,
  terminalTabLabel
} from './terminal-tabs'
import { terminalViewStore, type TerminalViewSettings } from './terminal-view'
import { TerminalTabView, type TerminalTabHandle } from './TerminalTabView'
import { TerminalTabStrip, type TerminalTabItem } from './TerminalTabStrip'
import { TerminalFindBar } from './TerminalFindBar'
import { TerminalViewMenu } from './TerminalViewMenu'
import type { TerminalFindDirection } from './terminal-find'
import { onActivateTerminal } from './terminal-activate'
import { onTerminalTabRequest } from './terminal-requests'
import type { TerminalPaneProps } from '../workbench/types'
import type { TerminalAvailability, TerminalProcessEntry, TerminalProcessList, TerminalProgramStatus, TerminalSnapshot } from '../../../../shared/ipc'
import './terminal.css'

function statusOf(state: TerminalViewState | undefined): { key: 'term.running' | 'term.waitPermission' | 'term.waitAnswer' | 'term.waitAuth' | 'term.wait' | 'term.ok' | 'term.error' | 'term.idle'; tone: BadgeTone; progress?: number } | null {
  const status: TerminalProgramStatus | undefined = state?.status
  if (!status || status.state === 'clear') return null
  if (state?.phase === 'exited' && status.state !== 'done' && status.state !== 'error') return null
  switch (status.state) {
    case 'working':
      return {
        key: 'term.running',
        tone: 'accent',
        ...(typeof status.progress === 'number' && Number.isFinite(status.progress) && status.progress >= 0 && status.progress <= 100
          ? { progress: Math.round(status.progress) }
          : {})
      }
    case 'blocked':
      return {
        key: status.kind === 'permission' ? 'term.waitPermission' : status.kind === 'question' ? 'term.waitAnswer' : status.kind === 'auth' ? 'term.waitAuth' : 'term.wait',
        tone: 'ask'
      }
    case 'done':
      return { key: 'term.ok', tone: 'ok' }
    case 'error':
      return { key: 'term.error', tone: 'fail' }
    case 'idle':
      return { key: 'term.idle', tone: 'neutral' }
    default:
      return null
  }
}

interface TabSeed {
  key: string
  adopt: TerminalAdopt
}

type PanePhase = 'idle' | 'loading' | 'inactive' | 'unavailable' | 'error' | 'ready'

interface CloseRequest {
  keys: string[]
  keep: string | null
  processes: TerminalProcessEntry[]
  more: number
}

const BELL_FLASH_MS = 1200
const FIND_DELAY = 120
const LINK_CACHE_MS = 15000
const LINK_CACHE_MAX = 200
const NO_PROCESSES: TerminalProcessList = { ok: false, processes: [] }

function commandRunning(state: TerminalViewState | undefined): boolean {
  return state?.status?.state === 'working' || state?.status?.state === 'blocked'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '')
}

export function TerminalPane({ owner, visible = true }: TerminalPaneProps): JSX.Element {
  const t = useT()
  const { lang } = useI18n()
  const text = useMemo(() => terminalText(lang), [lang])

  const bodyRef = useRef<HTMLDivElement | null>(null)
  const menuAnchor = useRef<HTMLSpanElement | null>(null)
  const handles = useRef(new Map<string, TerminalTabHandle>())
  const ownerRef = useRef(owner)
  ownerRef.current = owner
  const loadedFor = useRef<string | null>(null)
  const loadSeq = useRef(0)
  const localSeq = useRef(0)
  const bellTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const focusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const focusFrame = useRef(0)
  const focusSeq = useRef(0)
  const findTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const [view, setView] = useState<TerminalViewSettings>(() => terminalViewStore().get())
  const [tabs, setTabs] = useState<TabSeed[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [states, setStates] = useState<Record<string, TerminalViewState>>({})
  const [phase, setPhase] = useState<PanePhase>('idle')
  const [paneError, setPaneError] = useState('')
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findNone, setFindNone] = useState(false)
  const [bell, setBell] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; selection: string } | null>(null)
  const [closing, setClosing] = useState<CloseRequest | null>(null)
  const statesRef = useRef(states)
  statesRef.current = states
  const closeSeq = useRef(0)
  const linkCache = useRef(new Map<string, { at: number; abs: Promise<string | null> }>())
  const labelsRef = useRef(new Map<string, string>())
  const mac = useMemo(() => isMacPlatform(), [])

  useEffect(() => terminalViewStore().subscribe(() => setView(terminalViewStore().get())), [])

  useEffect(() => () => clearTimeout(bellTimer.current), [])

  useEffect(
    () => () => {
      focusSeq.current += 1
      cancelAnimationFrame(focusFrame.current)
      clearTimeout(focusTimer.current)
      clearTimeout(findTimer.current)
    },
    []
  )

  const load = useCallback(async (): Promise<void> => {
    const my = ++loadSeq.current
    const current = ownerRef.current
    if (!current.active) {
      setPhase('inactive')
      return
    }
    setPhase('loading')
    let check: TerminalAvailability
    try {
      check = await window.yan.terminal.available()
    } catch (error) {
      check = { available: false, error: messageOf(error) }
    }
    if (my !== loadSeq.current) return
    if (!check.available) {
      setPaneError(check.error ?? '')
      setPhase('unavailable')
      return
    }
    let list: TerminalSnapshot[]
    try {
      list = await window.yan.terminal.list()
    } catch {
      if (my !== loadSeq.current) return
      setPaneError(text.listFailed)
      setPhase('error')
      return
    }
    if (my !== loadSeq.current) return
    const owned = selectOwnedTerminals(list, current.key, resourceOwner)
    const seeds: TabSeed[] = owned.map((snapshot) => ({ key: snapshot.id, adopt: { id: snapshot.id } }))
    if (seeds.length === 0) {
      localSeq.current += 1
      seeds.push({ key: `local-${localSeq.current}`, adopt: 'none' })
    }
    setTabs(seeds)
    setActive((previous) => (previous && seeds.some((seed) => seed.key === previous) ? previous : seeds[seeds.length - 1]?.key ?? null))
    setPhase('ready')
  }, [text.listFailed])

  useEffect(() => {
    loadedFor.current = null
    loadSeq.current += 1
    setTabs([])
    setActive(null)
    setStates({})
    setPhase('idle')
    setFindOpen(false)
    setMenu(null)
    setClosing(null)
    closeSeq.current += 1
    linkCache.current.clear()
  }, [owner.key])

  useEffect(() => {
    if (!owner.active) {
      setPhase('inactive')
      return
    }
    if (!visible) return
    if (loadedFor.current === owner.key) return
    loadedFor.current = owner.key
    void load()
  }, [owner.key, owner.active, visible, load])

  const retry = useCallback((): void => {
    loadedFor.current = null
    if (visible && owner.active) {
      loadedFor.current = owner.key
      void load()
    }
  }, [load, owner.active, owner.key, visible])

  const handleState = useCallback((key: string, state: TerminalViewState): void => {
    setStates((previous) => ({ ...previous, [key]: state }))
  }, [])

  const handleBell = useCallback((key: string): void => {
    setBell(key)
    clearTimeout(bellTimer.current)
    bellTimer.current = setTimeout(() => setBell((current) => (current === key ? null : current)), BELL_FLASH_MS)
  }, [])

  const activeState = active ? states[active] : undefined

  const focusTerminal = useCallback((key: string): void => {
    const hostId = `terminal-host-${key}`
    const seq = (focusSeq.current += 1)
    cancelAnimationFrame(focusFrame.current)
    clearTimeout(focusTimer.current)
    let attempts = 0
    const tryFocus = (): void => {
      if (focusSeq.current !== seq) return
      const handle = handles.current.get(key)
      handle?.focus()
      const focused = document.activeElement?.closest?.('[data-testid^="terminal-host-"]') ?? null
      if (focused?.getAttribute('data-testid') === hostId) return
      attempts += 1
      if (attempts < 10) focusTimer.current = setTimeout(() => {
        focusFrame.current = requestAnimationFrame(tryFocus)
      }, 40)
    }
    focusFrame.current = requestAnimationFrame(tryFocus)
  }, [])

  const selectTab = useCallback(
    (key: string): void => {
      setActive(key)
      focusTerminal(key)
    },
    [focusTerminal]
  )

  useEffect(
    () =>
      onActivateTerminal((key, id) => {
        if (key !== ownerRef.current.key) return
        if (!tabs.some((tab) => tab.key === id)) return
        setActive(id)
        focusTerminal(id)
      }),
    [tabs, focusTerminal]
  )

  useEffect(
    () =>
      onTerminalTabRequest((request) => {
        if (request.ownerKey !== ownerRef.current.key) return
        if (loadedFor.current !== ownerRef.current.key) {
          loadedFor.current = ownerRef.current.key
          void load()
        }
        if (!tabs.some((tab) => tab.key === request.terminalId)) {
          if (!canAddTerminalTab(tabs.length)) return
          setTabs((previous) => [...previous, { key: request.terminalId, adopt: { id: request.terminalId } }])
        }
        setActive(request.terminalId)
      }),
    [tabs, load]
  )

  const newTab = useCallback((): void => {
    if (!canAddTerminalTab(tabs.length)) return
    localSeq.current += 1
    const seed: TabSeed = { key: `local-${localSeq.current}`, adopt: 'none' }
    setTabs((previous) => [...previous, seed])
    setActive(seed.key)
    focusTerminal(seed.key)
  }, [focusTerminal, tabs.length])

  const closeTabNow = useCallback(
    (key: string): void => {
      void handles.current.get(key)?.session()?.kill()
      setTabs((previous) => othersThan(previous, key))
      setStates((previous) => {
        if (!(key in previous)) return previous
        const next = { ...previous }
        delete next[key]
        return next
      })
      setActive(pickActiveAfterClose(tabs.map((tab) => tab.key), key, active))
    },
    [active, tabs]
  )

  const closeOthersNow = useCallback(
    (key: string): void => {
      for (const tab of tabs) {
        if (tab.key === key) continue
        void handles.current.get(tab.key)?.session()?.kill()
      }
      setTabs((previous) => previous.filter((tab) => tab.key === key))
      setStates((previous) => (previous[key] ? { [key]: previous[key] } : {}))
      setActive(key)
    },
    [tabs]
  )

  const closeNow = useRef({ closeTabNow, closeOthersNow })
  closeNow.current = { closeTabNow, closeOthersNow }

  const commitClose = useCallback((request: Pick<CloseRequest, 'keys' | 'keep'>): void => {
    if (request.keep) closeNow.current.closeOthersNow(request.keep)
    else if (request.keys[0]) closeNow.current.closeTabNow(request.keys[0])
  }, [])

  const requestClose = useCallback(
    async (keys: string[], keep: string | null): Promise<void> => {
      const seq = ++closeSeq.current
      const targets = keys
        .map((key) => statesRef.current[key])
        .filter((state): state is TerminalViewState => !!state?.terminalId && state.phase !== 'exited' && state.phase !== 'error')
      if (targets.length === 0) {
        commitClose({ keys, keep })
        return
      }
      const lists = await Promise.all(
        targets.map((state) => window.yan.terminal.processes(state.terminalId as string).catch(() => NO_PROCESSES))
      )
      if (seq !== closeSeq.current) return
      const processes = lists.flatMap((list) => list.processes)
      const more = lists.reduce((sum, list) => sum + (list.more ?? 0), 0)
      const unknown = lists.some((list, index) => !list.ok && commandRunning(targets[index]))
      if (processes.length === 0 && more === 0 && !unknown) {
        commitClose({ keys, keep })
        return
      }
      setClosing({ keys, keep, processes, more })
    },
    [commitClose]
  )

  const closeTab = useCallback((key: string): void => void requestClose([key], null), [requestClose])

  const closeOthers = useCallback(
    (key: string): void => void requestClose(tabs.filter((tab) => tab.key !== key).map((tab) => tab.key), key),
    [requestClose, tabs]
  )

  const terminalCwd = useCallback((key: string): string => statesRef.current[key]?.cwd || ownerRef.current.cwd, [])

  const resolveFileLink = useCallback(
    (key: string, link: TerminalFileLink): Promise<string | null> => {
      const abs = resolveTerminalPath(terminalCwd(key), link.path)
      if (!abs) return Promise.resolve(null)
      const root = ownerRef.current.cwd || undefined
      const cacheKey = `${root ?? ''}\u0000${abs}`
      const cache = linkCache.current
      const now = Date.now()
      const hit = cache.get(cacheKey)
      if (hit && now - hit.at < LINK_CACHE_MS) return hit.abs
      const pending = window.yan
        .statPreview(abs, root)
        .then((result) => (result.ok && result.abs ? result.abs : null))
        .catch(() => null)
      if (cache.size >= LINK_CACHE_MAX) cache.clear()
      cache.set(cacheKey, { at: now, abs: pending })
      return pending
    },
    [terminalCwd]
  )

  const checkFile = useCallback(
    async (key: string, link: TerminalFileLink): Promise<boolean> => !!(await resolveFileLink(key, link)),
    [resolveFileLink]
  )

  const openLink = useCallback(
    (key: string, link: TerminalLinkMatch): void => {
      if (link.kind === 'url') {
        void useStore.getState().openLink(link.url)
        return
      }
      const ownerKey = ownerRef.current.key
      void resolveFileLink(key, link).then((abs) => {
        if (!abs || ownerRef.current.key !== ownerKey) return
        showPreview(ownerKey, abs, link.line ? { preview: true, line: link.line } : { preview: true })
      })
    },
    [resolveFileLink]
  )

  const addSelection = useCallback(
    (key: string): void => {
      const selection = handles.current.get(key)?.selection() ?? ''
      const label = labelsRef.current.get(key) || text.tabTitle
      const cwd = terminalCwd(key)
      const same = cwd.replace(/[\\/]+$/, '').toLowerCase() === ownerRef.current.cwd.replace(/[\\/]+$/, '').toLowerCase()
      const block = terminalSelectionBlock(selection, text.selectionSource(label, same ? '' : cwd))
      if (block) useStore.getState().insertIntoComposer(block)
    },
    [terminalCwd, text]
  )

  const openFind = useCallback((key: string | null): void => {
    setFindQuery('')
    setFindNone(false)
    setFindOpen(true)
    if (key) handles.current.get(key)?.resetFind()
  }, [])

  useEffect(() => {
    if (!active) return
    const handle = handles.current.get(active)
    const previous = findQuery
    clearTimeout(findTimer.current)
    setFindOpen(false)
    setFindQuery('')
    setFindNone(false)
    if (previous) handle?.resetFind()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  useEffect(() => {
    const state = active ? states[active] : undefined
    if (state?.phase === 'exited' || state?.phase === 'error') setFindOpen(false)
  }, [active, states])

  const runFind = useCallback(
    (query: string, direction: TerminalFindDirection, reset: boolean): void => {
      clearTimeout(findTimer.current)
      const handle = active ? handles.current.get(active) : undefined
      if (!query) {
        handle?.resetFind()
        setFindNone(false)
        return
      }
      setFindNone(!(handle?.find(query, direction, reset) ?? false))
    },
    [active]
  )

  const runFindLater = useCallback(
    (query: string): void => {
      clearTimeout(findTimer.current)
      findTimer.current = setTimeout(() => runFind(query, 'previous', true), FIND_DELAY)
    },
    [runFind]
  )

  const closeFind = useCallback((): void => {
    clearTimeout(findTimer.current)
    setFindOpen(false)
    if (active) handles.current.get(active)?.focus()
    setFindNone(false)
  }, [active])

  const openBodyMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>): void => {
      event.preventDefault()
      if (!active) return
      const box = bodyRef.current?.getBoundingClientRect()
      const selection = handles.current.get(active)?.selection() ?? ''
      setMenu({ x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0), selection })
    },
    [active]
  )

  const runMenu = useCallback(
    (key: string): void => {
      const handle = active ? handles.current.get(active) : undefined
      if (!handle) return
      if (key === 'copy') handle.copySelection()
      else if (key === 'paste') {
        void navigator.clipboard
          .readText()
          .then((value) => {
            if (value) handle.paste(value)
          })
          .catch(() => undefined)
      } else if (key === 'add-to-chat') {
        if (active) addSelection(active)
        return
      } else if (key === 'select-all') handle.selectAll()
      else if (key === 'clear') handle.clear()
      handle.focus()
    },
    [active, addSelection]
  )

  const inactive = !owner.active || phase === 'inactive'
  const unavailable = phase === 'unavailable'
  const loadFailed = phase === 'error'
  const starting = phase === 'loading' && tabs.length === 0
  const failed = activeState?.phase === 'error'
  const busy = activeState?.phase === 'starting' || activeState?.phase === 'connecting'
  const exited = activeState?.phase === 'exited'

  const title = activeState?.title || ''
  const cwd = activeState?.cwd || owner.cwd
  const badge = statusOf(activeState)
  const chrome = usePaneChrome()
  const barTitle = <span className="term-pane-title" title={cwd || title}>{title || cwd || text.tabTitle}</span>
  const barActions = <TerminalViewMenu view={view} text={text} onChange={(patch) => terminalViewStore().update(patch)} />
  const barStatus = (
    <>
      {badge ? (
        <Badge tone={badge.tone} className="term-pane-badge">
          {t(badge.key)}
          {badge.progress === undefined ? '' : ` ${badge.progress}%`}
        </Badge>
      ) : null}
      {exited ? (
        <span className="term-pane-exited" data-testid="terminal-exited">
          {t('term.exited', { code: activeState?.exitCode === null || activeState?.exitCode === undefined ? '—' : String(activeState.exitCode) })}
        </span>
      ) : null}
    </>
  )

  const items: TerminalTabItem[] = tabs.map((tab, index) => {
    const state = states[tab.key]
    const info = terminalTabLabel(tabs.length > 1 ? '' : state?.title ?? '', index, tabs.length)
    return {
      key: tab.key,
      label: info.kind === 'title' ? info.text : info.kind === 'numbered' ? text.tabNumber(info.number) : text.tabTitle,
      detail: state?.title || state?.cwd || '',
      busy: state?.status?.state === 'working' && state.phase !== 'exited',
      exited: state?.phase === 'exited'
    }
  })
  labelsRef.current = new Map(items.map((item) => [item.key, item.label]))

  const strip =
    tabs.length > 0 ? (
      <TerminalTabStrip
        tabs={items}
        active={active}
        bell={bell}
        canAdd={canAddTerminalTab(tabs.length) && !inactive && !unavailable && !loadFailed}
        inline={!!chrome}
        text={text}
        onSelect={selectTab}
        onClose={closeTab}
        onCloseOthers={closeOthers}
        onNew={newTab}
      />
    ) : null

  return (
    <div className="term-pane" data-phase={activeState?.phase ?? (inactive ? 'inactive' : 'idle')} data-visible={visible ? '1' : '0'} data-testid="terminal-pane">
      {chrome ? (
        <>
          {strip || badge || exited ? (
            <PaneTitle>
              <span className="term-pane-chrome-title min-w-0 [&_.ui-ptabs]:gap-1 [&_.ui-ptab]:rounded-[var(--control-radius)] [&_.ui-ptab]:text-xs [&_.ui-ptab_.ui-ptab__close]:size-4">
                {strip}
                {barStatus}
              </span>
            </PaneTitle>
          ) : null}
          <PaneTools>{barActions}</PaneTools>
        </>
      ) : (
        <PaneHeader
          size="sm"
          className="term-pane-bar"
          icon={<SquareTerminal size={14} aria-hidden />}
          title={barTitle}
          actions={barActions}
        >
          {barStatus}
        </PaneHeader>
      )}

      {chrome ? null : strip}

      <div className="term-pane-body" ref={bodyRef}>
        <div className="term-pane-hosts">
          {tabs.map((tab) => (
            <TerminalTabView
              key={tab.key}
              ref={(handle) => {
                if (handle) handles.current.set(tab.key, handle)
                else handles.current.delete(tab.key)
              }}
              tabKey={tab.key}
              adopt={tab.adopt}
              owner={owner}
              visible={visible && !inactive && !unavailable && !loadFailed}
              active={tab.key === active}
              view={view}
              text={{
                startFailed: text.startFailed,
                attachFailed: text.attachFailed,
                bufferOverflow: text.bufferOverflow
              }}
              onState={handleState}
              onBell={handleBell}
              onFindRequest={openFind}
              onContextMenu={openBodyMenu}
              linkHint={text.linkHint(mac)}
              onLink={openLink}
              checkFile={checkFile}
              onAddSelection={addSelection}
            />
          ))}
        </div>

        {starting ? (
          <div className="term-pane-cover" data-testid="terminal-busy">
            <Notice compact loading>{text.connecting}</Notice>
          </div>
        ) : null}

        {inactive ? (
          <div className="term-pane-cover">
            <EmptyState size="sm" title={text.activateFirst} data-testid="terminal-inactive" />
          </div>
        ) : null}

        {unavailable ? (
          <div className="term-pane-cover" data-testid="terminal-unavailable">
            <EmptyState
              size="sm"
              title={t('term.unavailable')}
              action={
                <Button size="sm" icon={<RefreshCw size={14} strokeWidth={1.75} />} onPress={retry} data-testid="terminal-retry">
                  {t('term.retry')}
                </Button>
              }
            />
            {paneError ? <Notice tone="fail" compact className="term-pane-error" data-testid="terminal-error">{paneError}</Notice> : null}
          </div>
        ) : null}

        {loadFailed ? (
          <div className="term-pane-cover">
            <EmptyState
              size="sm"
              title={paneError || text.listFailed}
              data-testid="terminal-failed"
              action={
                <Button size="sm" icon={<RefreshCw size={14} strokeWidth={1.75} />} onPress={retry} data-testid="terminal-retry">
                  {text.reload}
                </Button>
              }
            />
          </div>
        ) : null}

        {!inactive && failed ? (
          <div className="term-pane-cover">
            <EmptyState
              size="sm"
              title={activeState?.notice || text.startFailed}
              data-testid="terminal-failed"
              action={
                <Button
                  size="sm"
                  icon={<RefreshCw size={14} strokeWidth={1.75} />}
                  onPress={() => {
                    if (active) void handles.current.get(active)?.session()?.retry()
                  }}
                  data-testid="terminal-retry"
                >
                  {t('term.retry')}
                </Button>
              }
            />
          </div>
        ) : null}

        {!inactive && !unavailable && !loadFailed && !failed && busy ? (
          <div className="term-pane-cover" data-testid="terminal-busy">
            <Notice compact loading>{activeState?.phase === 'starting' ? text.starting : text.connecting}</Notice>
          </div>
        ) : null}

        {!inactive && !unavailable && !loadFailed && !failed && tabs.length === 0 ? (
          <div className="term-pane-cover">
            <EmptyState
              size="sm"
              title={t('term.none')}
              data-testid="terminal-empty"
              action={
                <Button size="sm" icon={<Plus size={14} strokeWidth={1.75} />} onPress={newTab} data-testid="terminal-new-empty">
                  {t('term.new')}
                </Button>
              }
            />
          </div>
        ) : null}

        {!inactive && !failed && activeState?.notice ? (
          <Notice tone="fail" compact className="term-pane-note" data-testid="terminal-notice">
            {activeState.notice}
          </Notice>
        ) : null}

        {!inactive && exited ? (
          <Notice compact className="term-pane-note" data-testid="terminal-exited">
            {t('term.exited', { code: activeState?.exitCode === null || activeState?.exitCode === undefined ? '—' : String(activeState.exitCode) })}
          </Notice>
        ) : null}

        {findOpen && !inactive ? (
          <TerminalFindBar
            query={findQuery}
            noResults={findNone}
            text={text}
            onQuery={(query) => {
              setFindQuery(query)
              runFindLater(query)
            }}
            onStep={(direction) => runFind(findQuery, direction, false)}
            onClose={closeFind}
          />
        ) : null}

        {menu ? (
          <>
            <span className="term-menu-anchor" ref={menuAnchor} style={{ left: menu.x, top: menu.y }} aria-hidden />
            <Popover
              triggerRef={menuAnchor}
              isOpen
              onOpenChange={(open) => {
                if (!open) setMenu(null)
              }}
              placement="bottom start"
              offset={0}
            >
              <Menu
                aria-label={text.terminalMenu}
                autoFocus="first"
                onAction={(key) => {
                  setMenu(null)
                  runMenu(String(key))
                }}
                data-testid="terminal-menu"
              >
                <MenuItem id="copy" textValue={text.copy} isDisabled={!menu.selection}>
                  {text.copy}
                </MenuItem>
                <MenuItem id="paste" textValue={text.paste}>
                  {text.paste}
                </MenuItem>
                <MenuItem
                  id="add-to-chat"
                  textValue={text.addToChat}
                  isDisabled={!menu.selection}
                  shortcut={<KbdGroup keys={mac ? ['Cmd', 'Shift', 'L'] : ['Ctrl', 'Shift', 'L']} />}
                  data-testid="terminal-menu-add-to-chat"
                >
                  {text.addToChat}
                </MenuItem>
                <MenuSeparator />
                <MenuItem id="select-all" textValue={text.selectAll}>
                  {text.selectAll}
                </MenuItem>
                <MenuSeparator />
                <MenuItem id="clear" textValue={text.clear}>
                  {text.clear}
                </MenuItem>
              </Menu>
            </Popover>
          </>
        ) : null}
      </div>

      <ConfirmDialog
        isOpen={!!closing}
        onOpenChange={(open) => {
          if (!open) setClosing(null)
        }}
        title={text.closeConfirmTitle}
        description={closing && (closing.processes.length > 0 || closing.more > 0) ? text.closeConfirmList : text.closeConfirmUnknown}
        tone="danger"
        confirmLabel={text.closeConfirmAction}
        cancelLabel={text.cancel}
        onConfirm={() => {
          if (closing) commitClose(closing)
          setClosing(null)
        }}
        confirmTestId="terminal-close-confirm"
        data-testid="terminal-close-dialog"
      >
        {closing && closing.processes.length > 0 ? (
          <ul className="term-close-list" data-testid="terminal-close-processes">
            {closing.processes.map((process) => (
              <li key={process.pid} className="term-close-item">
                <span className="ui-num">{process.name}</span>
                <span className="ui-meta-num">{process.pid}</span>
              </li>
            ))}
            {closing.more > 0 ? <li className="term-close-item ui-meta-num">{text.closeConfirmMore(closing.more)}</li> : null}
          </ul>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}
