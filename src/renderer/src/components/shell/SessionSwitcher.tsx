import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { SessionSearchHit, SessionSummary } from '../../../../shared/ipc'
import { useT, type MessageKey, type TFunc } from '../../i18n'
import { Icon } from '../../icons/Icon'
import { useStore } from '../../state/store'
import { shortProject } from '../rail/rail-utils'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'
import { Button } from '../ui'
import {
  QUICK_ACTION_IDS,
  filterHostActions,
  groupHostActions,
  hostActionById,
  hostActionDisabledReason,
  hostSectionKey,
  isHostActionDisabled,
  matchesTokens,
  resolveShortcut,
  runHostAction,
  tokensOf,
  KEY_BINDINGS,
  type HostActionDef
} from '../../lib/host-actions'
import { submitComposerInput } from '../../lib/composer-submit'
import { useHostActionRuntime } from '../../lib/use-host-actions'

interface SessionRow {
  kind: 'session'
  session: SessionSummary
  title: string
  project: string
  snippet?: string
}

interface ActionRow {
  kind: 'action'
  action: HostActionDef
  disabled: boolean
  reason?: string
}

interface CommandRow {
  kind: 'command'
  name: string
  description?: string
  disabled: boolean
  reason?: string
}

type Row = SessionRow | ActionRow | CommandRow

const RECENT_LIMIT = 12
const RESULT_LIMIT = 30
const COMMAND_LIMIT = 40

function ago(t: TFunc, at: number | undefined): string {
  if (!at || !Number.isFinite(at)) return ''
  const s = Math.max(0, (Date.now() - at) / 1000)
  if (s < 60) return t('time.justNow')
  if (s < 3600) return t('time.minutesAgo', { n: Math.floor(s / 60) })
  if (s < 86400) return t('time.hoursAgo', { n: Math.floor(s / 3600) })
  if (s < 86400 * 30) return t('time.daysAgo', { n: Math.floor(s / 86400) })
  const d = new Date(at)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

const COMMAND_RANK: Record<string, number> = { yan: 0, pi: 1, extension: 2, skill: 3, prompt: 4, compatibility: 5 }

export function SessionSwitcher({
  onClose,
  onOpenShortcutSheet
}: {
  onClose: () => void
  onOpenShortcutSheet: () => void
}) {
  const t = useT()
  const sessions = useStore((s) => s.sessions)
  const titles = useStore((s) => s.titles)
  const manualTitles = useStore((s) => s.manualTitles)
  const settings = useStore((s) => s.settings)
  const commands = useStore((s) => s.commands)
  const currentFile = useStore((s) => s.session?.conversationFile ?? s.session?.sessionFile)
  const switchSession = useStore((s) => s.switchSession)
  const acquireOverlayBlocker = useStore((s) => s.acquireOverlayBlocker)
  const { runtime, availability } = useHostActionRuntime(onOpenShortcutSheet)
  const targetRef = useRef({
    runnerId: useStore.getState().activeRunnerId ?? '',
    sessionId: useStore.getState().session?.sessionId,
    file: useStore.getState().session?.conversationFile ?? useStore.getState().session?.sessionFile
  })
  const [query, setQuery] = useState('')
  const [bodyResult, setBodyResult] = useState<{ query: string; hits: SessionSearchHit[] }>({ query: '', hits: [] })
  const hits = bodyResult.query === query ? bodyResult.hits : []
  const [busy, setBusy] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const { isTop } = useModalLayer(true, onClose)
  useFocusTrap(panelRef, true, isTop)
  const projectNames = settings?.projectNames ?? {}
  const projects = settings?.projects ?? []

  const actionMode = query.startsWith('>')
  const actionQuery = actionMode ? query.slice(1) : ''

  useEffect(() => {
    const release = acquireOverlayBlocker('session-switcher')
    return release
  }, [acquireOverlayBlocker])

  useEffect(() => {
    const timer = window.setTimeout(() => input.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    const tokens = tokensOf(query)
    setSearchError(false)
    if (actionMode || !tokens.length) {
      setBodyResult({ query, hits: [] })
      setBusy(false)
      return undefined
    }
    let alive = true
    setBusy(true)
    const timer = window.setTimeout(() => {
      void window.yan.searchSessions(query, RESULT_LIMIT)
        .then((result) => { if (alive) setBodyResult({ query, hits: result.hits }) })
        .catch(() => { if (alive) { setBodyResult({ query, hits: [] }); setSearchError(true) } })
        .finally(() => { if (alive) setBusy(false) })
    }, 140)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [query, retry, actionMode])

  const projectOf = (s: SessionSummary): string => {
    const record = projects.find((p) => p.cwd === s.cwd)
    return record?.name || projectNames[s.cwd] || shortProject(s.cwd)
  }
  const titleOf = (s: SessionSummary): string => manualTitles[s.id] || titles[s.id] || s.title

  const sessionRows = useMemo<SessionRow[]>(() => {
    const activityOf = (s: SessionSummary): number => s.lastActivityAt ?? s.updatedAt
    const decorated = sessions.map((session) => ({ session, title: titleOf(session), project: projectOf(session) }))
    const tokens = tokensOf(query)
    if (!tokens.length) {
      return decorated
        .filter((r) => r.session.path !== currentFile)
        .sort((a, b) => activityOf(b.session) - activityOf(a.session))
        .slice(0, RECENT_LIMIT)
        .map((r) => ({ kind: 'session', ...r }))
    }
    const titleMatches = decorated
      .filter((r) => {
        const hay = `${r.title} ${r.project} ${r.session.cwd}`.toLowerCase()
        return tokens.every((token) => hay.includes(token))
      })
      .sort((a, b) => activityOf(b.session) - activityOf(a.session))
    const seen = new Set(titleMatches.map((r) => r.session.path))
    const byPath = new Map(decorated.map((r) => [r.session.path, r]))
    const bodyMatches: SessionRow[] = []
    for (const hit of hits) {
      const base = byPath.get(hit.path)
      if (!base || seen.has(hit.path)) continue
      bodyMatches.push({ kind: 'session', ...base, snippet: hit.snippet })
    }
    return [...titleMatches, ...bodyMatches].slice(0, RESULT_LIMIT).map((r) => ({ kind: 'session' as const, ...r }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, titles, manualTitles, projects, projectNames, query, hits, currentFile])

  const quickActions = useMemo(
    () => QUICK_ACTION_IDS.map((id) => hostActionById(id)).filter((a): a is HostActionDef => !!a),
    []
  )

  const quickRows = useMemo<ActionRow[]>(
    () => quickActions.map((action) => ({
      kind: 'action' as const,
      action,
      disabled: isHostActionDisabled(action, availability),
      reason: hostActionDisabledReason(action, availability)
    })),
    [quickActions, availability]
  )

  const actionRows = useMemo<ActionRow[]>(() => {
    const labelOf = (action: HostActionDef): string => t(action.labelKey as MessageKey)
    const filtered = filterHostActions(actionQuery, labelOf)
    return filtered.map((action) => ({
      kind: 'action',
      action,
      disabled: isHostActionDisabled(action, availability),
      reason: hostActionDisabledReason(action, availability)
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionQuery, availability, t])

  const commandRows = useMemo<CommandRow[]>(() => {
    if (!actionMode) return []
    const tokens = tokensOf(actionQuery)
    const list = commands
      .filter((c) => !c.hiddenInMenu)
      .filter((c) => {
        if (!tokens.length) return true
        return matchesTokens(`${c.name} ${c.description ?? ''}`, tokens)
      })
      .sort((a, b) => {
        const rank = (COMMAND_RANK[a.source] ?? 9) - (COMMAND_RANK[b.source] ?? 9)
        return rank !== 0 ? rank : a.name.localeCompare(b.name)
      })
      .slice(0, COMMAND_LIMIT)
    return list.map((c) => ({
      kind: 'command',
      name: c.name,
      description: c.description,
      disabled: !c.executable || c.source === 'compatibility',
      reason: c.availability ?? c.description
    }))
  }, [actionMode, actionQuery, commands])

  const rows = useMemo<Row[]>(() => {
    if (actionMode) return [...actionRows, ...commandRows]
    return [...sessionRows, ...quickRows]
  }, [actionMode, actionRows, commandRows, sessionRows, quickRows])

  useEffect(() => { setActive(0) }, [query])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, rows.length])

  const sameTarget = (): boolean => {
    const s = useStore.getState()
    return (s.activeRunnerId ?? '') === targetRef.current.runnerId &&
      (targetRef.current.sessionId
        ? s.session?.sessionId === targetRef.current.sessionId
        : (s.session?.conversationFile ?? s.session?.sessionFile) === targetRef.current.file)
  }

  const runCommand = (row: CommandRow): void => {
    if (row.disabled) return
    onClose()
    const sessionBound = !['new', 'login', 'settings'].includes(row.name)
    if (sessionBound && !sameTarget()) {
      useStore.getState().notify('info', t('switcher.targetChanged'))
      return
    }
    const s = useStore.getState()
    void submitComposerInput({
      text: `/${row.name}`,
      attachments: [],
      commands: s.commands,
      models: s.models,
      t,
      session: s.session,
      thinkingLevels: s.thinkingLevels,
      roundRunning: !!s.runners.find((r) => (r.runId ?? r.id) === s.activeRunnerId)?.running,
      isCompacting: !!s.session?.isCompacting,
      actions: {
        runBash: s.runBash,
        openSettings: s.openSettings,
        newSession: () => s.newSession({ scope: 'global' }),
        compact: s.compact,
        openBrowser: s.openBrowser,
        setModel: s.setModel,
        exportHtml: s.exportHtml,
        nativeSession: s.nativeSession,
        copyLastReply: s.copyLastReply,
        clone: s.clone,
        setManualTitle: s.setManualTitle,
        setThinking: s.setThinking,
        notify: s.notify
      },
      clearText: () => {},
      clearAll: () => {},
      restoreText: () => {},
      restoreAttachments: () => {},
      readAttachments: () => [],
      send: s.send,
      holdSend: s.holdSend,
      focusComposer: () => {}
    })
  }

  const runAction = (row: ActionRow): void => {
    if (row.disabled) return
    const sessionBound = ['newSessionProject', 'copyLastReply', 'stopRun'].includes(row.action.id)
    if (sessionBound && !sameTarget()) {
      useStore.getState().notify('info', t('switcher.targetChanged'))
      return
    }
    onClose()
    void runHostAction(row.action.id, runtime).then(result => {
      if (!result.ok && result.error) useStore.getState().notify('error', result.error)
    })
  }

  const choose = (row: Row | undefined): void => {
    if (!row) return
    if (row.kind === 'session') {
      onClose()
      void switchSession(row.session.path)
      return
    }
    if (row.kind === 'action') runAction(row)
    else runCommand(row)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.target !== input.current) return
    if (e.nativeEvent.isComposing) return
    const shortcut = resolveShortcut({
      key: e.key,
      ctrl: e.ctrlKey,
      meta: e.metaKey,
      alt: e.altKey,
      shift: e.shiftKey,
      composing: e.nativeEvent.isComposing,
      repeat: e.repeat,
      altGraph: e.getModifierState?.('AltGraph') ?? false,
      inTerminal: false,
      modalOpen: false
    })
    if (shortcut === 'shortcutSheet') {
      e.preventDefault()
      onOpenShortcutSheet()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (rows.length ? (i + 1) % rows.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(rows[active])
    }
  }

  const hasQuery = tokensOf(query).length > 0
  const kbdOf = (action: HostActionDef): string[] | undefined =>
    action.binding ? KEY_BINDINGS[action.binding].keys : undefined

  const renderRow = (row: Row): ReactElement => {
    const index = rows.indexOf(row)
    const on = index === active
    const disabled = row.kind !== 'session' && row.disabled
    const testid = row.kind === 'session' ? 'switcher-row' : row.kind === 'action' ? 'switcher-action' : 'switcher-command'
    return (
      <button
        key={row.kind === 'session' ? row.session.path : row.kind === 'action' ? `action-${row.action.id}` : `cmd-${row.name}`}
        id={`switcher-result-${index}`}
        type="button"
        role="option"
        aria-selected={on}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        data-active={on}
        className={`switcher-row${on ? ' on' : ''}${disabled ? ' off' : ''}`}
        onMouseMove={() => { if (index !== active && index >= 0) setActive(index) }}
        onClick={() => choose(row)}
        data-testid={testid}
      >
        {row.kind === 'session' ? (
          <>
            <span className="switcher-title">{row.title}</span>
            <span className="switcher-meta">{row.project} · {ago(t, row.session.lastActivityAt ?? row.session.updatedAt)}</span>
            {row.snippet ? <span className="switcher-snippet">{row.snippet}</span> : null}
          </>
        ) : row.kind === 'action' ? (
          <>
            <span className="switcher-title">{t(row.action.labelKey as MessageKey)}</span>
            {kbdOf(row.action) ? (
              <span className="switcher-key">{kbdOf(row.action)!.map((k) => <kbd className="ui-kbd" key={k}>{k}</kbd>)}</span>
            ) : null}
            {row.reason ? <span className="switcher-snippet">{t(row.reason as MessageKey)}</span> : null}
          </>
        ) : (
          <>
            <span className="switcher-title">/{row.name}</span>
            {row.disabled ? <span className="switcher-meta">{t('switcher.compat')}</span> : null}
            {row.reason ? <span className="switcher-snippet">{row.reason}</span> : null}
          </>
        )}
      </button>
    )
  }

  return (
    <div className="modal-scrim switcher-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }} role="dialog" aria-modal="true" aria-label={t('switcher.title')} data-testid="session-switcher">
      <div className="switcher" ref={panelRef} onKeyDown={onKeyDown}>
        <div className="switcher-input">
          <Icon name={actionMode ? 'terminal' : 'search'} size={14} />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={actionMode ? t('switcher.actionPlaceholder') : t('switcher.placeholder')}
            spellCheck={false}
            aria-label={t('switcher.title')}
            data-testid="switcher-input"
            role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="switcher-results"
            aria-activedescendant={rows[active] ? `switcher-result-${active}` : undefined}
          />
          {busy && !actionMode ? <span className="switcher-busy" aria-hidden>…</span> : null}
        </div>
        <div className="switcher-list" id="switcher-results" ref={listRef} role="listbox">
          {actionMode ? (
            <>
              {groupHostActions(actionRows.map((r) => r.action)).map((group) => (
                <div key={group.section}>
                  <div className="switcher-label">{t(hostSectionKey(group.section) as MessageKey)}</div>
                  {actionRows.filter((r) => r.action.section === group.section).map((row) => renderRow(row))}
                </div>
              ))}
              {commandRows.length ? (
                <div>
                  <div className="switcher-label">{t('switcher.commands')}</div>
                  {commandRows.map((row) => renderRow(row))}
                </div>
              ) : null}
            </>
          ) : (
            <>
              {!hasQuery ? <div className="switcher-label">{t('switcher.recent')}</div> : null}
              {sessionRows.map((row) => renderRow(row))}
              {!hasQuery && quickRows.length ? (
                <div>
                  <div className="switcher-label">{t('switcher.common')}</div>
                  {quickRows.map((row) => renderRow(row))}
                </div>
              ) : null}
            </>
          )}
          {actionMode
            ? rows.length === 0 ? <div className="switcher-empty">{t('switcher.noActions')}</div> : null
            : searchError ? <div className="switcher-empty" role="alert" data-testid="switcher-error">{t('switcher.failed')}
              <Button size="sm" variant="ghost" data-testid="switcher-retry" onClick={() => setRetry(n => n + 1)}>{t('switcher.retry')}</Button>
            </div> : sessionRows.length === 0 ? <div className="switcher-empty">{busy ? t('switcher.searching') : hasQuery ? t('switcher.none') : t('switcher.noSessions')}</div> : null}
        </div>
        <div className="switcher-foot">{t('switcher.hint')}</div>
      </div>
    </div>
  )
}
