import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MessageKey, TVars } from '../../i18n'
import { useT } from '../../i18n'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'
import { useStore } from '../../state/store'
import { Icon, type IconName } from '../../icons/Icon'
import { Badge, Button, EmptyState, IconButton, ListRow, Spinner } from '../ui'
import {
  buildTreeView,
  initialCollapsedForLeaf,
  moveTreeSelection,
  nativeModelKey,
  type NativeEntryKind,
  type NativeActionResult,
  type NativeScopedModel,
  type NativeScopedModelsLoad,
  type NativeSessionAction,
  type NativeSessionLoadResult,
  type NativeSessionMode,
  type NativeTreeLoad,
  type NativeTreeRow,
  type NativeTrustLoad
} from '../../../../shared/native-session'

export interface NativeSessionPanelProps {
  mode: NativeSessionMode
  onClose: () => void
  load: () => Promise<NativeSessionLoadResult>
  onAction: NativeSessionAction
  resetKey?: string
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; error: string }
  | { phase: 'ready'; data: NativeTreeLoad | NativeScopedModelsLoad | NativeTrustLoad }

const MODE_TITLE: Record<NativeSessionMode, string> = {
  tree: 'native.tree.title',
  'scoped-models': 'native.scope.title',
  trust: 'native.trust.title'
}

const KIND_ICON: Record<NativeEntryKind, IconName> = {
  user: 'message-dots',
  assistant: 'agent',
  tool: 'terminal',
  system: 'settings',
  summary: 'compact',
  branch: 'branch',
  label: 'tag',
  meta: 'layers',
  custom: 'package',
  usage: 'activity',
  unknown: 'file'
}

const KIND_LABEL: Record<NativeEntryKind, string> = {
  user: 'native.entry.user',
  assistant: 'native.entry.assistant',
  tool: 'native.entry.tool',
  system: 'native.entry.system',
  summary: 'native.entry.summary',
  branch: 'native.entry.branch',
  label: 'native.entry.label',
  meta: 'native.entry.meta',
  custom: 'native.entry.custom',
  usage: 'native.entry.usage',
  unknown: 'native.entry.unknown'
}

export function NativeSessionPanel({ mode, onClose, load, onAction, resetKey }: NativeSessionPanelProps) {
  const t = useT()
  const tx = useCallback((key: string, vars?: TVars): string => t(key as MessageKey, vars), [t])

  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const { isTop } = useModalLayer(true, onClose)
  useFocusTrap(panel, true, isTop)
  useEffect(() => useStore.getState().acquireOverlayBlocker('native-session'), [])

  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const runRef = useRef(0)
  const aliveRef = useRef(true)
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      runRef.current += 1
    }
  }, [])

  const read = useCallback(async (): Promise<NativeSessionLoadResult> => {
    try {
      return await loadRef.current()
    } catch (error) {
      return { ok: false, mode, error: error instanceof Error ? error.message : String(error) }
    }
  }, [mode])

  const reload = useCallback(async (): Promise<void> => {
    const run = ++runRef.current
    setState({ phase: 'loading' })
    const result = await read()
    if (!aliveRef.current || run !== runRef.current) return
    if (!result.ok) {
      setState({ phase: 'error', error: result.error })
      return
    }
    if (result.mode !== mode) {
      setState({ phase: 'error', error: tx('native.modeMismatch') })
      return
    }
    setState({ phase: 'ready', data: result })
  }, [mode, read, tx])

  const refreshTree = useCallback(async (): Promise<NativeTreeLoad | null> => {
    const run = ++runRef.current
    const result = await read()
    if (!aliveRef.current || run !== runRef.current) return null
    if (!result.ok || result.mode !== 'tree') {
      if (!result.ok) setState({ phase: 'error', error: result.error })
      return null
    }
    setState({ phase: 'ready', data: result })
    return result
  }, [read])

  useEffect(() => {
    void reload()
  }, [reload, resetKey])

  return createPortal(
    <div
      className="modal-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && isTop) onClose()
      }}
    >
      <div
        className="modal native-session"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-mode={mode}
        data-testid="native-session-panel"
        ref={panel}
      >
        <div className="modal-head">
          <span className="modal-title" id={titleId}>
            {tx(MODE_TITLE[mode])}
          </span>
          <span className="spacer" />
          <IconButton size="sm" icon="close" label={tx('native.close')} onClick={onClose} data-testid="native-session-close" />
        </div>
        {state.phase === 'loading' ? (
          <div className="native-session-status" data-testid="native-session-loading">
            <Spinner label={tx('native.loading')} />
            <span>{tx('native.loading')}</span>
          </div>
        ) : state.phase === 'error' ? (
          <EmptyState
            icon="alert-circle"
            title={tx('native.loadFailed')}
            center
            className="native-session-status"
            testId="native-session-error"
            action={
              <Button size="sm" onClick={() => void reload()}>
                {tx('native.retry')}
              </Button>
            }
          >
            <span className="native-session-error-detail">{state.error}</span>
          </EmptyState>
        ) : state.data.mode === 'tree' ? (
          <TreeMode data={state.data} onAction={onAction} onRefresh={refreshTree} tx={tx} />
        ) : state.data.mode === 'scoped-models' ? (
          <ScopeMode data={state.data} onAction={onAction} tx={tx} />
        ) : (
          <TrustMode data={state.data} onAction={onAction} tx={tx} />
        )}
      </div>
    </div>,
    document.body
  )
}

type Tx = (key: string, vars?: TVars) => string

function TreeMode({
  data,
  onAction,
  onRefresh,
  tx
}: {
  data: NativeTreeLoad
  onAction: NativeSessionAction
  onRefresh: () => Promise<NativeTreeLoad | null>
  tx: Tx
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => initialCollapsedForLeaf(data.tree, data.leafId))
  const [overrideId, setOverrideId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const wantFocus = useRef(true)

  const view = useMemo(() => buildTreeView(data.tree, data.leafId, collapsed), [data, collapsed])
  const rows = view.rows
  const selected = useMemo(() => {
    if (overrideId && rows.some((row) => row.entryId === overrideId)) return overrideId
    if (data.leafId && rows.some((row) => row.entryId === data.leafId)) return data.leafId
    return rows[0]?.entryId ?? null
  }, [overrideId, rows, data.leafId])
  const selectedRow = rows.find((row) => row.entryId === selected) ?? null

  const signature = rows.map((row) => row.entryId).join('|')
  useEffect(() => {
    if (!wantFocus.current) return
    wantFocus.current = false
    if (selected) rowRefs.current.get(selected)?.focus()
  }, [selected, signature])

  const move = (delta: number): void => {
    const next = moveTreeSelection(rows, selected, delta)
    if (!next || next === selected) return
    wantFocus.current = true
    setOverrideId(next)
  }

  const toggleFold = (entryId: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(entryId)) next.delete(entryId)
      else next.add(entryId)
      return next
    })
  }

  const navigate = async (entryId: string | null): Promise<void> => {
    if (!entryId || busy) return
    setBusy(entryId)
    setError('')
    setNotice('')
    const result: NativeActionResult = await onAction('navigate', { entryId })
    setBusy(null)
    if (!result.ok) {
      setError(result.error || tx('native.actionFailed'))
      return
    }
    setNotice(result.message || tx('native.tree.navigated'))
    const next = await onRefresh()
    if (next) {
      setCollapsed(initialCollapsedForLeaf(next.tree, next.leafId))
      setOverrideId(next.leafId)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!selectedRow) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        move(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        move(-1)
        break
      case 'ArrowRight':
        event.preventDefault()
        if (selectedRow.hasChildren && selectedRow.folded) toggleFold(selectedRow.entryId)
        else move(1)
        break
      case 'ArrowLeft':
        event.preventDefault()
        if (selectedRow.hasChildren && !selectedRow.folded) toggleFold(selectedRow.entryId)
        else move(-1)
        break
      case 'Home':
        event.preventDefault()
        if (rows[0]) {
          wantFocus.current = true
          setOverrideId(rows[0].entryId)
        }
        break
      case 'End':
        event.preventDefault()
        if (rows.length) {
          wantFocus.current = true
          setOverrideId(rows[rows.length - 1].entryId)
        }
        break
      case 'Enter':
        event.preventDefault()
        void navigate(selectedRow.entryId)
        break
      default:
        break
    }
  }

  const guard = view.stats.cycles + view.stats.depthTruncated + view.stats.rowTruncated
  const guarded = guard > 0 || view.stats.scanTruncated

  return (
    <>
      {rows.length ? (
        <div
          className="native-session-tree"
          role="tree"
          aria-label={tx('native.tree.title')}
          data-testid="native-tree"
          onKeyDown={onKeyDown}
        >
          {rows.map((row) => (
            <TreeRow
              key={row.entryId}
              row={row}
              selected={row.entryId === selected}
              busy={busy === row.entryId}
              register={(element) => {
                if (element) rowRefs.current.set(row.entryId, element)
                else rowRefs.current.delete(row.entryId)
              }}
              onSelect={() => setOverrideId(row.entryId)}
              onNavigate={() => void navigate(row.entryId)}
              onToggle={() => toggleFold(row.entryId)}
              tx={tx}
            />
          ))}
        </div>
      ) : (
        <EmptyState icon="branch" title={tx('native.tree.empty')} center className="native-session-status" />
      )}
      {guarded ? (
        <p className="native-session-note" data-testid="native-tree-guard">
          {tx('native.tree.guard', {
            cycles: view.stats.cycles,
            depth: view.stats.depthTruncated,
            rows: view.stats.rowTruncated
          })}
        </p>
      ) : null}
      <div className="modal-foot">
        <span className="native-session-hint">{tx('native.tree.hint')}</span>
        <span className="spacer" />
        {error ? (
          <span className="native-session-note" data-tone="err" data-testid="native-tree-error">
            {error}
          </span>
        ) : notice ? (
          <span className="native-session-note" data-tone="ok" data-testid="native-tree-notice">
            {notice}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="primary"
          disabled={!selected || !!busy}
          onClick={() => void navigate(selected)}
          data-testid="native-tree-navigate"
        >
          {tx('native.tree.navigate')}
        </Button>
      </div>
    </>
  )
}

function TreeRow({
  row,
  selected,
  busy,
  register,
  onSelect,
  onNavigate,
  onToggle,
  tx
}: {
  row: NativeTreeRow
  selected: boolean
  busy: boolean
  register: (element: HTMLDivElement | null) => void
  onSelect: () => void
  onNavigate: () => void
  onToggle: () => void
  tx: Tx
}) {
  const className = [
    'ui-list-row native-session-row',
    selected && 'sel',
    row.leaf && 'leaf',
    row.onActiveBranch && 'active',
    row.kind !== 'unknown' && `k-${row.kind}`
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div
      ref={register}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      aria-expanded={row.hasChildren && !row.truncated ? !row.folded : undefined}
      tabIndex={selected ? 0 : -1}
      className={className}
      style={{ paddingLeft: `calc(var(--sp-2) + ${row.depth} * var(--sp-3))` }}
      data-entry-id={row.entryId}
      data-kind={row.kind}
      data-leaf={row.leaf ? '1' : undefined}
      data-active={row.onActiveBranch ? '1' : undefined}
      data-testid={`native-tree-row-${row.entryId}`}
      onClick={onSelect}
      onDoubleClick={onNavigate}
    >
      {row.hasChildren && !row.truncated ? (
        <IconButton
          size="sm"
          icon="chevron-right"
          iconClassName={row.folded ? '' : 'open'}
          tabIndex={-1}
          className="native-session-fold"
          label={tx(row.folded ? 'native.tree.expand' : 'native.tree.collapse')}
          onClick={(event) => {
            event.stopPropagation()
            onToggle()
          }}
        />
      ) : (
        <span className="native-session-fold spacer" aria-hidden="true" />
      )}
      <Icon name={KIND_ICON[row.kind]} size={12} className="native-session-kind" />
      <span className="native-session-text" title={row.entryType}>
        {row.text || tx(KIND_LABEL[row.kind])}
      </span>
      {row.label ? <Badge tone="accent">{row.label}</Badge> : null}
      {row.folded && row.hiddenCount > 0 ? <span className="native-session-meta">+{row.hiddenCount}</span> : null}
      {row.leaf ? <Badge tone="ok">{tx('native.tree.leaf')}</Badge> : null}
      {busy ? <Spinner label={tx('native.tree.navigating')} /> : null}
    </div>
  )
}

function ScopeMode({
  data,
  onAction,
  tx
}: {
  data: NativeScopedModelsLoad
  onAction: NativeSessionAction
  tx: Tx
}) {
  const initial = useMemo(() => new Set(data.models.filter((model) => model.inScope).map(nativeModelKey)), [data])
  const [draft, setDraft] = useState<Set<string>>(() => new Set(initial))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const dirty = draft.size !== initial.size || [...draft].some((key) => !initial.has(key))

  const toggle = (model: NativeScopedModel): void => {
    const key = nativeModelKey(model)
    setDraft((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    setNotice('')
  }

  const save = async (): Promise<void> => {
    if (busy || !dirty) return
    setBusy(true)
    setError('')
    setNotice('')
    const result = await onAction('set-scoped-models', { modelIds: [...draft] })
    setBusy(false)
    if (!result.ok) {
      setError(result.error || tx('native.actionFailed'))
      return
    }
    setNotice(result.message || tx('native.scope.saved'))
  }

  return (
    <>
      <div className="native-session-scope-head">
        <p className="native-session-desc">{tx('native.scope.desc')}</p>
        <span className="native-session-meta" data-testid="native-scope-count">
          {tx('native.scope.count', { n: draft.size })}
        </span>
      </div>
      {data.scopeIsAll ? <p className="native-session-note">{tx('native.scope.all')}</p> : null}
      {data.models.length ? (
        <div className="native-session-list" data-testid="native-scope-list">
          {data.models.map((model) => {
            const key = nativeModelKey(model)
            const picked = draft.has(key)
            return (
              <ListRow
                key={key}
                current={model.current}
                aria-pressed={picked}
                className="native-session-model-row"
                data-testid={`native-scope-row-${key}`}
                lead={<Icon name={picked ? 'check-circle' : 'minus'} size={12} />}
                meta={
                  <span className="native-session-model-meta">
                    {model.current ? <Badge tone="accent">{tx('native.scope.current')}</Badge> : null}
                    <span>{model.provider}</span>
                  </span>
                }
                onClick={() => toggle(model)}
              >
                {model.name}
              </ListRow>
            )
          })}
        </div>
      ) : (
        <EmptyState icon="agent" title={tx('native.scope.empty')} center className="native-session-status" />
      )}
      <div className="modal-foot">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setDraft(new Set(data.models.map(nativeModelKey)))}
          data-testid="native-scope-select-all"
        >
          {tx('native.scope.selectAll')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDraft(new Set())} data-testid="native-scope-clear">
          {tx('native.scope.clear')}
        </Button>
        <span className="spacer" />
        {error ? (
          <span className="native-session-note" data-tone="err" data-testid="native-scope-error">
            {error}
          </span>
        ) : notice ? (
          <span className="native-session-note" data-tone="ok" data-testid="native-scope-notice">
            {notice}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !dirty}
          onClick={() => void save()}
          data-testid="native-scope-save"
        >
          {busy ? tx('native.scope.saving') : tx('native.scope.save')}
        </Button>
      </div>
    </>
  )
}

function TrustMode({ data, onAction, tx }: { data: NativeTrustLoad; onAction: NativeSessionAction; tx: Tx }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const save = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    const result = await onAction('set-trust', { trusted: !data.trusted })
    setBusy(false)
    if (!result.ok) {
      setError(result.error || tx('native.actionFailed'))
      return
    }
    setNotice(result.message || tx(data.trusted ? 'native.trust.revoked' : 'native.trust.saved'))
  }

  return (
    <>
      <div className="native-session-trust">
        <div className="native-session-field">
          <span className="native-session-field-name">{tx('native.trust.cwd')}</span>
          <code className="native-session-path" title={data.cwd}>
            {data.cwd}
          </code>
        </div>
        <div className="native-session-field">
          <span className="native-session-field-name">{tx('native.trust.state')}</span>
          <Badge tone={data.trusted ? 'ok' : 'warn'} testId="native-trust-state">
            {tx(data.trusted ? 'native.trust.trusted' : 'native.trust.untrusted')}
          </Badge>
        </div>
        {data.entry ? (
          <div className="native-session-field">
            <span className="native-session-field-name">{tx('native.trust.entry')}</span>
            <code className="native-session-path" title={data.entry}>
              {data.entry}
            </code>
          </div>
        ) : null}
        {!data.requiresTrust ? <p className="native-session-note">{tx('native.trust.notRequired')}</p> : null}
        <p className="native-session-risk" data-testid="native-trust-risk">
          {tx('native.trust.risk')}
        </p>
      </div>
      <div className="modal-foot">
        <span className="spacer" />
        {error ? (
          <span className="native-session-note" data-tone="err" data-testid="native-trust-error">
            {error}
          </span>
        ) : notice ? (
          <span className="native-session-note" data-tone="ok" data-testid="native-trust-notice">
            {notice}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => void save()}
          data-testid="native-trust-save"
        >
          {data.trusted ? tx('native.trust.revoke') : tx('native.trust.save')}
        </Button>
      </div>
    </>
  )
}
