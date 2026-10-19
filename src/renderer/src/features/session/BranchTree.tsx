import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from 'react'
import {
  Activity,
  Archive,
  CornerDownRight,
  File,
  GitBranch,
  Layers,
  Package,
  Shield,
  Sparkles,
  Tag,
  Terminal,
  User,
  type LucideIcon
} from 'lucide-react'
import type { Lang } from '../../i18n'
import { useI18n } from '../../i18n'
import {
  buildTreeView,
  initialCollapsedForLeaf,
  parseTreePayload,
  type NativeEntryKind,
  type NativeActionResult,
  type NativeTreeNode,
  type NativeTreeRow
} from '../../../../shared/native-session'
import type { NativeSessionHostRequest, NativeSessionHostResult } from '../../../../shared/native-session-host'
import { Badge, Button, Dialog, DialogTrigger, IconButton, Popover, Spinner, TextField } from '../../ui'
import { Tree, TreeChevron, TreeItem, TreeItemContent, TreeItemLabel } from '../../ui/Tree'
import type { WorkspaceOwner } from '../workbench/types'
import './branch-tree.css'

export interface BranchText {
  title: string
  treeLabel: string
  hint: string
  hintSummarize: string
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
  expand: string
  collapse: string
  guard: (stats: { cycles: number; depth: number; rows: number; scan: boolean }) => string
  kind: Record<NativeEntryKind, string>
}

const ZH: BranchText = {
  title: '分支',
  treeLabel: '会话树',
  hint: '切换只把当前叶子移到所选条目：不改写会话文件，也不会自动摘要。',
  hintSummarize: '切换时让模型总结离开的分支，摘要作为新条目写进会话，可能需要几十秒。',
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
  emptyHint: '开始会话后，分叉点会在这里以树的形式列出。',
  navigate: '切换到此条目',
  navigated: '已切换；当前叶子已更新。',
  actionFailed: '分支切换失败。',
  atLeaf: '当前叶子已在此条目。',
  busyHint: '会话运行中不能切换分支，请等这一轮结束。',
  leaf: '当前',
  expand: '展开',
  collapse: '收起',
  guard: ({ cycles, depth, rows, scan }) =>
    `树已保护性折叠：环 ${cycles} 处 · 过深 ${depth} 处 · 超出 ${rows} 行${scan ? ' · 扫描上限' : ''}。`,
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
  treeLabel: 'Session tree',
  hint: 'Switching only moves the current leaf to the chosen entry: it does not rewrite the session file and never summarizes.',
  hintSummarize: 'Switching asks the model to summarize the branch you leave; the summary is added to the session and may take a while.',
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
  emptyHint: 'Once the conversation forks, fork points appear here as a tree.',
  navigate: 'Switch to this entry',
  navigated: 'Switched; the current leaf is updated.',
  actionFailed: 'Branch switch failed.',
  atLeaf: 'The current leaf is already this entry.',
  busyHint: 'The session is running; wait for this turn before switching branches.',
  leaf: 'Current',
  expand: 'Expand',
  collapse: 'Collapse',
  guard: ({ cycles, depth, rows, scan }) =>
    `Tree was folded for safety: ${cycles} cycle(s) · ${depth} over-deep · ${rows} row(s) over limit${scan ? ' · scan cap' : ''}.`,
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

const EMPTY_ROWS: NativeTreeRow[] = []

const KIND_ICON: Record<NativeEntryKind, LucideIcon> = {
  user: User,
  assistant: Sparkles,
  tool: Terminal,
  system: Shield,
  summary: Archive,
  branch: GitBranch,
  label: Tag,
  meta: Layers,
  custom: Package,
  usage: Activity,
  unknown: File
}

export interface BranchTransport {
  request: (request: NativeSessionHostRequest) => Promise<NativeSessionHostResult>
}

export type BranchTreeLoad =
  | { ok: true; tree: NativeTreeNode[]; leafId: string | null }
  | { ok: false; error: string }

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
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
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

export async function labelBranch(
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

export interface BranchNode {
  row: NativeTreeRow
  children: BranchNode[]
}

export function nestBranchRows(rows: readonly NativeTreeRow[]): BranchNode[] {
  const roots: BranchNode[] = []
  const stack: BranchNode[] = []
  for (const row of rows) {
    const node: BranchNode = { row, children: [] }
    while (stack.length && stack[stack.length - 1].row.depth >= row.depth) stack.pop()
    if (stack.length) stack[stack.length - 1].children.push(node)
    else roots.push(node)
    stack.push(node)
  }
  return roots
}

export interface BranchNodeContext {
  text: BranchText
  pending: string | null
  blocked: boolean
  onNavigate: (entryId: string) => void
  onLabel: (entryId: string, label: string) => Promise<boolean>
}

function BranchBookmark({ row, ctx }: { row: NativeTreeRow; ctx: BranchNodeContext }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(row.label ?? '')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (open) setValue(row.label ?? '')
  }, [open, row.label])
  const save = async (label: string): Promise<void> => {
    setSaving(true)
    const saved = await ctx.onLabel(row.entryId, label)
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
        aria-label={`${ctx.text.bookmarkEdit} · ${row.text || ctx.text.kind[row.kind]}`}
        title={ctx.text.bookmarkEdit}
        isDisabled={ctx.blocked}
        data-testid="branch-bookmark"
      >
        <Tag size={12} aria-hidden="true" />
      </IconButton>
      <Popover className="branch-bookmark-pop" placement="bottom end" offset={4}>
        <Dialog showClose={false} aria-label={ctx.text.bookmarkEdit} className="branch-bookmark-dialog">
          <form className="branch-bookmark-form" onSubmit={submit}>
            <TextField
              autoFocus
              label={ctx.text.bookmark}
              value={value}
              onChange={setValue}
              maxLength={200}
              placeholder={ctx.text.bookmarkPlaceholder}
              data-testid="branch-bookmark-input"
            />
            <div className="branch-bookmark-actions">
              {row.label ? (
                <Button size="sm" variant="ghost" isDisabled={saving} onPress={() => void save('')} data-testid="branch-bookmark-clear">
                  {ctx.text.bookmarkClear}
                </Button>
              ) : null}
              <Button size="sm" variant="primary" type="submit" isDisabled={saving || !value.trim()} data-testid="branch-bookmark-save">
                {ctx.text.bookmarkSave}
              </Button>
            </div>
          </form>
        </Dialog>
      </Popover>
    </DialogTrigger>
  )
}

export function renderBranchNodes(nodes: readonly BranchNode[], ctx: BranchNodeContext): JSX.Element[] {
  return nodes.map((node) => {
    const { row } = node
    const KindIcon = KIND_ICON[row.kind]
    const label = row.text || ctx.text.kind[row.kind]
    const classes = ['branch-node', `branch-node--${row.kind}`]
    if (row.leaf) classes.push('branch-node--leaf')
    if (row.onActiveBranch) classes.push('branch-node--active')
    return (
      <TreeItem
        key={row.entryId}
        id={row.entryId}
        textValue={label}
        className={classes.join(' ')}
        onAction={() => ctx.onNavigate(row.entryId)}
      >
        <TreeItemContent>
          <TreeChevron />
          <KindIcon size={13} className="branch-kind" aria-hidden="true" />
          <TreeItemLabel title={`${ctx.text.kind[row.kind]} · ${row.entryType}`}>{label}</TreeItemLabel>
          {row.label ? (
            <Badge className="branch-label" title={row.label}>
              {row.label}
            </Badge>
          ) : null}
          {row.folded && row.hiddenCount > 0 ? <Badge className="branch-meta">+{row.hiddenCount}</Badge> : null}
          {row.leaf ? (
            <Badge tone="run" className="branch-leaf">
              {ctx.text.leaf}
            </Badge>
          ) : null}
          {ctx.pending === row.entryId ? <Spinner className="branch-spin" label={ctx.text.navigated} size={12} /> : null}
          {row.kind === 'label' ? null : <BranchBookmark row={row} ctx={ctx} />}
        </TreeItemContent>
        {renderBranchNodes(node.children, ctx)}
      </TreeItem>
    )
  })
}

export interface BranchTreeProps {
  owner: WorkspaceOwner
  transport: BranchTransport
  busy?: boolean
  summarize?: boolean
  reloadToken?: number
  onNavigated?: () => void
  className?: string
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; error: string }
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

  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [retryToken, setRetryToken] = useState(0)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())
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
    setState({ phase: 'loading' })
    setActionError('')
    setNotice('')
    setPending(null)
    if (!expectedSessionId) {
      setState({ phase: 'error', error: text.inactive })
      return
    }
    void loadBranchTree(transportRef.current, expectedSessionId, text.loadFailed).then((result) => {
      if (cancelled || !aliveRef.current || run !== runRef.current) return
      if (!result.ok) {
        setState({ phase: 'error', error: result.error })
        return
      }
      setState({ phase: 'ready', tree: result.tree, leafId: result.leafId })
      setCollapsed(initialCollapsedForLeaf(result.tree, result.leafId))
      setOverrideId(result.leafId)
    })
    return () => {
      cancelled = true
    }
  }, [expectedSessionId, reloadToken, retryToken, text.inactive, text.loadFailed])

  const view = useMemo(
    () => (state.phase === 'ready' ? buildTreeView(state.tree, state.leafId, collapsed) : null),
    [state, collapsed]
  )
  const rows = view?.rows ?? EMPTY_ROWS
  const stats = view?.stats ?? null
  const nested = useMemo(() => nestBranchRows(rows), [rows])

  const expandedKeys = useMemo(() => {
    const keys = new Set<string>()
    const visit = (nodes: readonly BranchNode[]): void => {
      for (const node of nodes) {
        if (node.children.length) keys.add(node.row.entryId)
        visit(node.children)
      }
    }
    visit(nested)
    return keys
  }, [nested])

  const selected = useMemo(() => {
    if (overrideId && rows.some((row) => row.entryId === overrideId)) return overrideId
    if (state.phase === 'ready' && state.leafId && rows.some((row) => row.entryId === state.leafId)) return state.leafId
    return rows[0]?.entryId ?? null
  }, [overrideId, rows, state])

  const selectedRow = rows.find((row) => row.entryId === selected) ?? null

  const refreshInPlace = useCallback(async (keepSelected?: string): Promise<void> => {
    if (!expectedSessionId) return
    const run = ++runRef.current
    const result = await loadBranchTree(transportRef.current, expectedSessionId, text.loadFailed)
    if (!aliveRef.current || run !== runRef.current) return
    if (!result.ok) {
      setActionError(result.error)
      return
    }
    setState({ phase: 'ready', tree: result.tree, leafId: result.leafId })
    setCollapsed(initialCollapsedForLeaf(result.tree, result.leafId))
    setOverrideId(keepSelected ?? result.leafId)
  }, [expectedSessionId, text.loadFailed])

  const navigate = useCallback(
    async (entryId: string | null): Promise<void> => {
      if (!entryId || !expectedSessionId || pending || busy) return
      const row = rows.find((item) => item.entryId === entryId)
      if (row?.leaf) {
        setActionError('')
        setNotice(text.atLeaf)
        return
      }
      setPending(entryId)
      setActionError('')
      setNotice('')
      const run = runRef.current
      const result = await navigateBranch(transportRef.current, expectedSessionId, entryId, text.actionFailed, summarize)
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
    [expectedSessionId, pending, busy, summarize, rows, text.atLeaf, text.actionFailed, text.navigated, onNavigated, refreshInPlace]
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

  const ctx = useMemo<BranchNodeContext>(
    () => ({
      text,
      pending,
      blocked: busy || pending !== null,
      onNavigate: (entryId: string) => {
        void navigate(entryId)
      },
      onLabel: setLabel
    }),
    [text, pending, busy, navigate, setLabel]
  )

  const guard = stats ? stats.cycles + stats.depthTruncated + stats.rowTruncated : 0
  const guarded = !!stats && (guard > 0 || stats.scanTruncated)
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
          <p className="branch-status__title">{text.loadFailed}</p>
          <p className="branch-status__detail">{state.error}</p>
          <Button size="sm" onPress={() => setRetryToken((value) => value + 1)} data-testid="branch-retry">
            {text.retry}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={`branch-tree${className ? ` ${className}` : ''}`} data-testid="branch-tree">
      {rows.length ? (
        <Tree
          className="branch-tree__list"
          aria-label={text.treeLabel}
          selectionMode="single"
          selectionBehavior="replace"
          selectedKeys={selected ? [selected] : []}
          onSelectionChange={(keys) => {
            const key = keys === 'all' ? selected : Array.from(keys)[0]
            if (typeof key === 'string' && key) {
              setOverrideId(key)
              setActionError('')
            }
          }}
          expandedKeys={expandedKeys}
          onExpandedChange={(keys) => {
            setCollapsed((prev) => {
              const next = new Set(prev)
              for (const row of rows) {
                if (!row.hasChildren || row.truncated) continue
                const wasExpanded = expandedKeys.has(row.entryId)
                const nowExpanded = keys.has(row.entryId)
                if (wasExpanded === nowExpanded) continue
                if (nowExpanded) next.delete(row.entryId)
                else next.add(row.entryId)
              }
              return next
            })
          }}
        >
          {renderBranchNodes(nested, ctx)}
        </Tree>
      ) : (
        <div className="branch-status" data-testid="branch-tree-empty">
          <p className="branch-status__title">{text.empty}</p>
          <p className="branch-status__detail">{text.emptyHint}</p>
        </div>
      )}

      {guarded && stats ? (
        <p className="branch-note" data-testid="branch-tree-guard">
          {text.guard({ cycles: stats.cycles, depth: stats.depthTruncated, rows: stats.rowTruncated, scan: stats.scanTruncated })}
        </p>
      ) : null}

      <div className="branch-foot">
        <span className="branch-foot__hint">{pending && summarize ? text.summarizing : blocked ? text.busyHint : summarize ? text.hintSummarize : text.hint}</span>
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
        <Button
          size="sm"
          variant="primary"
          icon={<CornerDownRight size={13} aria-hidden="true" />}
          isDisabled={!selected || blocked || !!selectedRow?.leaf}
          title={selectedRow?.leaf ? text.atLeaf : blocked ? text.busyHint : undefined}
          data-testid="branch-navigate"
          onPress={() => void navigate(selected)}
        >
          {text.navigate}
        </Button>
      </div>
    </div>
  )
}
