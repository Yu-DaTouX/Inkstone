import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent } from 'react'
import { Plus, RefreshCw, Terminal as TerminalIcon } from 'lucide-react'
import { Badge, Button, EmptyState, Menu, MenuItem, Notice, PaneHeader, Popover, Separator, type BadgeTone } from '../../ui'
import { PaneTitle, PaneTools, usePaneChrome } from '../workbench/pane-chrome'
import { useI18n, useT } from '../../i18n'
import { resourceOwner } from '../../state/resource-owners'
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
import type { TerminalPaneProps } from '../workbench/types'
import type { TerminalAvailability, TerminalProgramStatus, TerminalSnapshot } from '../../../../shared/ipc'
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

const BELL_FLASH_MS = 1200
const FIND_DELAY = 120

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

  const newTab = useCallback((): void => {
    if (!canAddTerminalTab(tabs.length)) return
    localSeq.current += 1
    const seed: TabSeed = { key: `local-${localSeq.current}`, adopt: 'none' }
    setTabs((previous) => [...previous, seed])
    setActive(seed.key)
    focusTerminal(seed.key)
  }, [focusTerminal, tabs.length])

  const closeTab = useCallback(
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

  const closeOthers = useCallback(
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
      } else if (key === 'select-all') handle.selectAll()
      else if (key === 'clear') handle.clear()
      handle.focus()
    },
    [active]
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
              <span className="term-pane-chrome-title">
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
          icon={<TerminalIcon size={14} strokeWidth={1.75} />}
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
            />
          ))}
        </div>

        {starting ? (
          <div className="term-pane-cover" data-testid="terminal-busy">
            <Notice compact>{text.connecting}</Notice>
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
            <Notice compact>{activeState?.phase === 'starting' ? text.starting : text.connecting}</Notice>
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
          <span className="term-pane-exited term-pane-note" data-testid="terminal-exited">
            {t('term.exited', { code: activeState?.exitCode === null || activeState?.exitCode === undefined ? '—' : String(activeState.exitCode) })}
          </span>
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
                <Separator />
                <MenuItem id="select-all" textValue={text.selectAll}>
                  {text.selectAll}
                </MenuItem>
                <Separator />
                <MenuItem id="clear" textValue={text.clear}>
                  {text.clear}
                </MenuItem>
              </Menu>
            </Popover>
          </>
        ) : null}
      </div>
    </div>
  )
}
