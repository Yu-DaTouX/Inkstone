import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type JSX } from 'react'
import { CornerDownRight, Tag } from 'lucide-react'
import type { Lang } from '../../i18n'
import { useI18n } from '../../i18n'
import {
  parseTreePayload,
  type NativeEntryKind,
  type NativeActionResult,
  type NativeTreeNode
} from '../../../../shared/native-session'
import { buildBranchLanes, type BranchLaneRow, type BranchLanes } from '../../../../shared/branch-lanes'
import type { NativeSessionHostRequest, NativeSessionHostResult } from '../../../../shared/native-session-host'
import { Badge, Button, Dialog, DialogFooter, DialogTrigger, IconButton, ListBox, ListBoxItem, Popover, Spinner, TextField } from '../../ui'
import type { WorkspaceOwner } from '../workbench/types'
import './branch-tree.css'

interface BranchText {
  title: string
  treeLabel: string
  hint: string
  hintSummarize: string
  footHint: string
  footHintSummarize: string
  summarize: string
  summarizing: string
  bookmark: string
  bookmarkEdit: string
  bookmarkPlaceholder: string
  bookmarkSave: string
  bookmarkClear: string
  bookmarkSaved: string
  bookmarkFailed: string
  loading: string
  loadFailed: string
  bridgeMissing: string
  inactive: string
  retry: string
  refresh: string
  empty: string
  emptyHint: string
  navigate: string
  navigated: string
  actionFailed: string
  atLeaf: string
  busyHint: string
  leaf: string
  steps: (count: number) => string
  kind: Record<NativeEntryKind, string>
}

const ZH: BranchText = {
  title: '分支',
  treeLabel: '分支图',
  hint: '切换只把当前叶子移到所选条目：不改写会话文件，也不会自动摘要。',
  hintSummarize: '切换时让模型总结离开的分支，摘要作为新条目写进会话，可能需要几十秒。',
  footHint: '只移动当前叶子，不改写会话',
  footHintSummarize: '切换时总结离开的分支',
  summarize: '离开时生成分支摘要',
  summarizing: '正在总结离开的分支…',
  bookmark: '书签',
  bookmarkEdit: '编辑书签',
  bookmarkPlaceholder: '给这个条目起个名字',
  bookmarkSave: '保存',
  bookmarkClear: '清除',
  bookmarkSaved: '书签已更新。',
  bookmarkFailed: '书签保存失败。',
  loading: '正在读取会话树…',
  loadFailed: '会话树读取失败。',
  bridgeMissing: '宿主尚未提供原生会话桥；此页签暂时无法读取会话树。',
  inactive: '当前会话尚未在 pi 侧激活，无法读取或切换分支。',
  retry: '重试',
  refresh: '重新读取会话树',
  empty: '这条会话还没有可显示的分支。',
  emptyHint: '对话分叉后，每条分支在这里占一列。',
  navigate: '切换到此条目',
  navigated: '已切换；当前叶子已更新。',
  actionFailed: '分支切换失败。',
  atLeaf: '当前叶子已在此条目。',
  busyHint: '会话运行中不能切换分支，请等这一轮结束。',
  leaf: '当前',
  steps: (count) => `${count} 步`,
  kind: {
    user: '用户',
    assistant: '助手',
    tool: '工具',
    system: '系统',
    summary: '压缩摘要',
    branch: '分支摘要',
    label: '书签',
    meta: '元信息',
    custom: '自定义',
    usage: '用量',
    unknown: '其它'
  }
}

const EN: BranchText = {
  title: 'Branches',
  treeLabel: 'Branch graph',
  hint: 'Switching only moves the current leaf to the chosen entry: it does not rewrite the session file and never summarizes.',
  hintSummarize: 'Switching asks the model to summarize the branch you leave; the summary is added to the session and may take a while.',
  footHint: 'Moves the current leaf only',
  footHintSummarize: 'Summarizes the branch you leave',
  summarize: 'Summarize the branch I leave',
  summarizing: 'Summarizing the branch you left…',
  bookmark: 'Bookmark',
  bookmarkEdit: 'Edit bookmark',
  bookmarkPlaceholder: 'Name this entry',
  bookmarkSave: 'Save',
  bookmarkClear: 'Clear',
  bookmarkSaved: 'Bookmark updated.',
  bookmarkFailed: 'Could not save the bookmark.',
  loading: 'Loading session tree…',
  loadFailed: 'Could not load the session tree.',
  bridgeMissing: 'The host has not exposed the native session bridge yet; this tab cannot read the tree.',
  inactive: 'This session is not active in pi yet, so branches cannot be read or switched.',
  retry: 'Retry',
  refresh: 'Reload session tree',
  empty: 'This session has no branches to show yet.',
  emptyHint: 'Once the conversation forks, each branch gets its own lane here.',
  navigate: 'Switch to this entry',
  navigated: 'Switched; the current leaf is updated.',
  actionFailed: 'Branch switch failed.',
  atLeaf: 'The current leaf is already this entry.',
  busyHint: 'The session is running; wait for this turn before switching branches.',
  leaf: 'Current',
  steps: (count) => `${count} ${count === 1 ? 'step' : 'steps'}`,
  kind: {
    user: 'User',
    assistant: 'Assistant',
    tool: 'Tool',
    system: 'System',
    summary: 'Compaction',
    branch: 'Branch summary',
    label: 'Bookmark',
    meta: 'Meta',
    custom: 'Custom',
    usage: 'Usage',
    unknown: 'Other'
  }
}

export function branchText(lang: Lang): BranchText {
  return lang === 'en-US' ? EN : ZH
}

const EMPTY_LANES: BranchLanes = { rows: [], edges: [], lanes: 1 }
const LOAD_RETRY_MS = [300, 800, 2000]
const ROW_PX = 30
const LANE_PX = 14
const EDGE_PX = 11

export interface BranchTransport {
  request: (request: NativeSessionHostRequest) => Promise<NativeSessionHostResult>
}

type BranchTreeLoad =
  | { ok: true; tree: NativeTreeNode[]; leafId: string | null }
  | { ok: false; error: string; raw?: boolean }

export async function loadBranchTree(
  transport: BranchTransport,
  expectedSessionId: string,
  fallbackError: string
): Promise<BranchTreeLoad> {
  try {
    const result = await transport.request({ action: 'tree', expectedSessionId })
    if (!result.ok) return { ok: false, error: result.error || fallbackError }
    const parsed = parseTreePayload(result)
    return { ok: true, tree: parsed.tree, leafId: parsed.leafId }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), raw: true }
  }
}

export async function navigateBranch(
  transport: BranchTransport,
  expectedSessionId: string,
  entryId: string,
  fallbackError: string,
  summarize = false
): Promise<NativeActionResult> {
  try {
    const result = await transport.request(
      summarize ? { action: 'navigate', expectedSessionId, entryId, summarize } : { action: 'navigate', expectedSessionId, entryId }
    )
    if (!result.ok) return { ok: false, error: result.error || fallbackError }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function labelBranch(
  transport: BranchTransport,
  expectedSessionId: string,
  entryId: string,
  label: string,
  fallbackError: string
): Promise<NativeActionResult> {
  try {
    const result = await transport.request({ action: 'set-label', expectedSessionId, entryId, label: label.trim() })
    if (!result.ok) return { ok: false, error: result.error || fallbackError }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function rowTitle(row: BranchLaneRow, text: BranchText): string {
  if (row.kind === 'user') return row.text || text.kind.user
  return row.text ? `${text.kind[row.kind]} · ${row.text}` : text.kind[row.kind]
}

function BranchBookmark({ row, text, blocked, onLabel }: { row: BranchLaneRow; text: BranchText; blocked: boolean; onLabel: (entryId: string, label: string) => Promise<boolean> }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(row.label ?? '')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (open) setValue(row.label ?? '')
  }, [open, row.label])
  const save = async (label: string): Promise<void> => {
    setSaving(true)
    const saved = await onLabel(row.entryId, label)
    setSaving(false)
    if (saved) setOpen(false)
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void save(value)
  }
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <IconButton
        size="sm"
        className="branch-bookmark"
        aria-label={`${text.bookmarkEdit} · ${rowTitle(row, text)}`}
        tooltip={text.bookmarkEdit}
        isDisabled={blocked}
        data-testid="branch-bookmark"
      >
        <Tag size={13} aria-hidden="true" />
      </IconButton>
      <Popover className="branch-bookmark-pop" placement="top end" offset={4}>
        <Dialog showClose={false} aria-label={text.bookmarkEdit} className="branch-bookmark-dialog">
          <form className="branch-bookmark-form" onSubmit={submit}>
            <TextField
              autoFocus
              label={text.bookmark}
              value={value}
              onChange={setValue}
              maxLength={200}
              placeholder={text.bookmarkPlaceholder}
              data-testid="branch-bookmark-input"
            />
            <DialogFooter>
              {row.label ? (
                <Button size="sm" variant="ghost" isDisabled={saving} onPress={() => void save('')} data-testid="branch-bookmark-clear">
                  {text.bookmarkClear}
                </Button>
              ) : null}
              <Button size="sm" variant="primary" type="submit" isDisabled={saving || !value.trim()} data-testid="branch-bookmark-save">
                {text.bookmarkSave}
              </Button>
            </DialogFooter>
          </form>
        </Dialog>
      </Popover>
    </DialogTrigger>
  )
}

const laneX = (lane: number): number => EDGE_PX + lane * LANE_PX
const rowY = (index: number): number => index * ROW_PX + ROW_PX / 2

function edgePath(fromLane: number, from: number, toLane: number, to: number): string {
  const x1 = laneX(fromLane)
  const x2 = laneX(toLane)
  const y1 = rowY(from)
  const y2 = rowY(to)
  if (x1 === x2) return `M${x1} ${y1}L${x2} ${y2}`
  const bend = y1 + ROW_PX
  return `M${x1} ${y1}C${x1} ${y1 + ROW_PX * 0.6} ${x2} ${bend - ROW_PX * 0.6} ${x2} ${bend}L${x2} ${y2}`
}

export function BranchGraph({
  lanes,
  text,
  selected,
  pending,
  onSelect,
  onAction
}: {
  lanes: BranchLanes
  text: BranchText
  selected: string | null
  pending: string | null
  onSelect: (entryId: string) => void
  onAction: (entryId: string) => void
}): JSX.Element {
  const width = EDGE_PX * 2 + (lanes.lanes - 1) * LANE_PX
  const style = { '--branch-row': `${ROW_PX}px`, '--branch-graph-w': `${width}px` } as CSSProperties
  return (
    <div className="branch-graph" style={style}>
      <svg className="branch-graph__lines" width={width} height={lanes.rows.length * ROW_PX} aria-hidden="true">
        {lanes.edges.map((edge) => (
          <path
            key={`${edge.from}:${edge.to}`}
            className="branch-graph__edge"
            data-active={edge.active ? '1' : undefined}
            d={edgePath(edge.fromLane, edge.from, edge.toLane, edge.to)}
          />
        ))}
        {lanes.rows.map((row, index) => (
          <circle
            key={row.entryId}
            className="branch-graph__dot"
            data-kind={row.kind === 'user' ? 'user' : row.kind === 'branch' || row.kind === 'summary' ? 'summary' : 'step'}
            data-active={row.active ? '1' : undefined}
            data-leaf={row.leaf ? '1' : undefined}
            cx={laneX(row.lane)}
            cy={rowY(index)}
            r={row.leaf ? 5 : row.kind === 'user' ? 4 : 3}
          />
        ))}
      </svg>
      <ListBox
        className="branch-graph__rows"
        aria-label={text.treeLabel}
        selectionMode="single"
        selectionBehavior="replace"
        disallowEmptySelection
        selectedKeys={selected ? [selected] : []}
        onSelectionChange={(keys) => {
          const key = keys === 'all' ? selected : Array.from(keys)[0]
          if (typeof key === 'string' && key) onSelect(key)
        }}
        onAction={(key) => onAction(String(key))}
      >
        {lanes.rows.map((row) => {
          const title = rowTitle(row, text)
          return (
            <ListBoxItem
              key={row.entryId}
              id={row.entryId}
              textValue={title}
              className="branch-graph__row"
              data-entry-id={row.entryId}
              data-kind={row.kind}
              data-active={row.active ? '1' : undefined}
            >
              <span className="branch-graph__text" title={title}>{title}</span>
              {row.label ? <Badge className="branch-label" title={row.label}>{row.label}</Badge> : null}
              {row.steps ? <span className="branch-graph__steps">{text.steps(row.steps)}</span> : null}
              {row.leaf ? <Badge tone="run" className="branch-leaf">{text.leaf}</Badge> : null}
              {pending === row.entryId ? <Spinner className="branch-spin" label={text.navigated} size={12} /> : null}
            </ListBoxItem>
          )
        })}
      </ListBox>
    </div>
  )
}

interface BranchTreeProps {
  owner: WorkspaceOwner
  transport: BranchTransport
  busy?: boolean
  summarize?: boolean
  reloadToken?: number
  onNavigated?: () => void
  className?: string
}

const TREE_MEMORY_MAX = 8
const treeMemory = new Map<string, { tree: NativeTreeNode[]; leafId: string | null }>()

function rememberTree(sessionId: string, tree: NativeTreeNode[], leafId: string | null): void {
  treeMemory.delete(sessionId)
  treeMemory.set(sessionId, { tree, leafId })
  while (treeMemory.size > TREE_MEMORY_MAX) {
    const oldest = treeMemory.keys().next().value
    if (oldest === undefined) break
    treeMemory.delete(oldest)
  }
}

function rememberedLoadState(sessionId: string | null | undefined): LoadState {
  const known = sessionId ? treeMemory.get(sessionId) : undefined
  return known ? { phase: 'ready', tree: known.tree, leafId: known.leafId } : { phase: 'loading' }
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; error: string; raw?: boolean }
  | { phase: 'ready'; tree: NativeTreeNode[]; leafId: string | null }

export function BranchTree({
  owner,
  transport,
  busy = false,
  summarize = false,
  reloadToken = 0,
  onNavigated,
  className
}: BranchTreeProps): JSX.Element {
  const { lang } = useI18n()
  const text = useMemo(() => branchText(lang), [lang])

  const [state, setState] = useState<LoadState>(() => rememberedLoadState(owner.sessionId))
  const [retryToken, setRetryToken] = useState(0)
  const [overrideId, setOverrideId] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')

  const runRef = useRef(0)
  const aliveRef = useRef(true)
  const transportRef = useRef(transport)
  transportRef.current = transport

  const expectedSessionId = owner.sessionId

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      runRef.current += 1
    }
  }, [])

  useEffect(() => {
    const run = ++runRef.current
    let cancelled = false
    setState(rememberedLoadState(expectedSessionId))
    setActionError('')
    setNotice('')
    setPending(null)
    if (!expectedSessionId) {
      setState({ phase: 'error', error: text.inactive })
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const attempt = (tries: number): void => {
      void loadBranchTree(transportRef.current, expectedSessionId, text.loadFailed).then((result) => {
        if (cancelled || !aliveRef.current || run !== runRef.current) return
        if (!result.ok) {
          if (!result.raw && tries < LOAD_RETRY_MS.length) {
            timer = setTimeout(() => attempt(tries + 1), LOAD_RETRY_MS[tries])
            return
          }
          setState({ phase: 'error', error: result.error, raw: result.raw })
          return
        }
        rememberTree(expectedSessionId, result.tree, result.leafId)
        setState({ phase: 'ready', tree: result.tree, leafId: result.leafId })
        setOverrideId(null)
      })
    }
    attempt(0)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [expectedSessionId, reloadToken, retryToken, text.inactive, text.loadFailed])

  const lanes = useMemo(
    () => (state.phase === 'ready' ? buildBranchLanes(state.tree, state.leafId) : EMPTY_LANES),
    [state]
  )
  const rows = lanes.rows
  const leafRowId = rows.find((row) => row.leaf)?.entryId ?? null
  const leafId = state.phase === 'ready' ? state.leafId : null

  const selected = useMemo(() => {
    if (overrideId && rows.some((row) => row.entryId === overrideId)) return overrideId
    return leafRowId ?? rows[rows.length - 1]?.entryId ?? null
  }, [overrideId, rows, leafRowId])

  const selectedRow = rows.find((row) => row.entryId === selected) ?? null
  const selectedIsLeaf = !!selectedRow && selectedRow.targetId === leafId

  const listRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!leafRowId || typeof requestAnimationFrame !== 'function') return
    const frame = requestAnimationFrame(() => {
      const rowsInList = listRef.current?.querySelectorAll<HTMLElement>('[data-entry-id]') ?? []
      const row = Array.from(rowsInList).find((item) => item.dataset.entryId === leafRowId)
      const scroller = row?.closest<HTMLElement>('.branch-graph')
      if (!row || !scroller) return
      const top = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      if (top < scroller.scrollTop) scroller.scrollTop = top
      else if (top + row.offsetHeight > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + row.offsetHeight - scroller.clientHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [leafRowId, state])

  const refreshInPlace = useCallback(async (keepSelected?: string): Promise<void> => {
    if (!expectedSessionId) return
    const run = ++runRef.current
    const result = await loadBranchTree(transportRef.current, expectedSessionId, text.loadFailed)
    if (!aliveRef.current || run !== runRef.current) return
    if (!result.ok) {
      setActionError(result.error)
      return
    }
    rememberTree(expectedSessionId, result.tree, result.leafId)
    setState({ phase: 'ready', tree: result.tree, leafId: result.leafId })
    setOverrideId(keepSelected ?? null)
  }, [expectedSessionId, text.loadFailed])

  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy && state.phase === 'ready') void refreshInPlace()
    wasBusy.current = busy
  }, [busy, state.phase, refreshInPlace])

  const navigate = useCallback(
    async (entryId: string | null): Promise<void> => {
      if (!entryId || !expectedSessionId || pending || busy) return
      const row = rows.find((item) => item.entryId === entryId)
      if (!row) return
      if (row.targetId === leafId) {
        setActionError('')
        setNotice(text.atLeaf)
        return
      }
      setPending(entryId)
      setActionError('')
      setNotice('')
      const run = runRef.current
      const result = await navigateBranch(transportRef.current, expectedSessionId, row.targetId, text.actionFailed, summarize)
      if (!aliveRef.current || run !== runRef.current) return
      setPending(null)
      if (!result.ok) {
        setActionError(result.error || text.actionFailed)
        return
      }
      setNotice(result.message || text.navigated)
      onNavigated?.()
      await refreshInPlace()
    },
    [expectedSessionId, pending, busy, summarize, rows, leafId, text.atLeaf, text.actionFailed, text.navigated, onNavigated, refreshInPlace]
  )

  const setLabel = useCallback(
    async (entryId: string, label: string): Promise<boolean> => {
      if (!expectedSessionId || pending || busy) return false
      setActionError('')
      setNotice('')
      const run = runRef.current
      const result = await labelBranch(transportRef.current, expectedSessionId, entryId, label, text.bookmarkFailed)
      if (!aliveRef.current || run !== runRef.current) return false
      if (!result.ok) {
        setActionError(result.error || text.bookmarkFailed)
        return false
      }
      setNotice(text.bookmarkSaved)
      await refreshInPlace(entryId)
      return true
    },
    [expectedSessionId, pending, busy, text.bookmarkFailed, text.bookmarkSaved, refreshInPlace]
  )

  const blocked = busy || pending !== null

  if (state.phase === 'loading') {
    return (
      <div className={`branch-tree${className ? ` ${className}` : ''}`} data-testid="branch-tree-loading">
        <div className="branch-status">
          <Spinner label={text.loading} />
          <span>{text.loading}</span>
        </div>
      </div>
    )
  }

  if (state.phase === 'error') {
    return (
      <div className={`branch-tree${className ? ` ${className}` : ''}`} data-testid="branch-tree-error">
        <div className="branch-status">
          <p className="branch-status__title" title={state.raw ? state.error : undefined}>{text.loadFailed}</p>
          {state.raw ? null : <p className="branch-status__detail">{state.error}</p>}
          <Button size="sm" onPress={() => setRetryToken((value) => value + 1)} data-testid="branch-retry">
            {text.retry}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div ref={listRef} className={`branch-tree${className ? ` ${className}` : ''}`} data-testid="branch-tree">
      {rows.length ? (
        <BranchGraph
          lanes={lanes}
          text={text}
          selected={selected}
          pending={pending}
          onSelect={(entryId) => {
            setOverrideId(entryId)
            setActionError('')
            setNotice('')
          }}
          onAction={(entryId) => void navigate(entryId)}
        />
      ) : (
        <div className="branch-status" data-testid="branch-tree-empty">
          <p className="branch-status__title">{text.empty}</p>
          <p className="branch-status__detail">{text.emptyHint}</p>
        </div>
      )}

      <div className="branch-foot">
        <span className="branch-foot__hint" title={summarize ? text.hintSummarize : text.hint}>{pending && summarize ? text.summarizing : blocked ? text.busyHint : summarize ? text.footHintSummarize : text.footHint}</span>
        <span className="branch-foot__spacer" />
        {actionError ? (
          <span className="branch-note branch-note--err" data-testid="branch-error" role="alert">
            {actionError}
          </span>
        ) : notice ? (
          <span className="branch-note branch-note--ok" data-testid="branch-notice" role="status">
            {notice}
          </span>
        ) : null}
        {selectedRow && selectedRow.kind !== 'label' ? <BranchBookmark row={selectedRow} text={text} blocked={blocked} onLabel={setLabel} /> : null}
        <Button
          size="sm"
          variant="primary"
          icon={<CornerDownRight size={13} aria-hidden="true" />}
          isDisabled={!selected || blocked || selectedIsLeaf}
          title={selectedIsLeaf ? text.atLeaf : blocked ? text.busyHint : undefined}
          data-testid="branch-navigate"
          onPress={() => void navigate(selected)}
        >
          {text.navigate}
        </Button>
      </div>
    </div>
  )
}
