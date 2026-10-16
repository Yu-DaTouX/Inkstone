/**
 * 会话分支树（v3 · WP-26 / WP-30 分支页）。
 *
 * 只投影并切换 pi 的**原生会话树**：数据来自主进程原生会话桥（`yan:nativeSession`），
 * 纯投影函数来自 `src/shared/native-session.ts`。这里不读、不写会话文件，也不做摘要：
 *   · 取树 = `{ action: 'tree', expectedSessionId }`；
 *   · 切换 = `{ action: 'navigate', expectedSessionId, entryId }`，只发稳定 `entryId`；
 *   · 主进程与 pi 扩展固定 `summarize:false`，因此本组件**不发**任何摘要参数，
 *     也不画「导航并摘要」按钮。
 *
 * 呈现与交互交给正式原语 `ui/Tree`（React Aria）：真实父子嵌套由 `TreeItem` 承载，
 * `aria-level` / 展开 / 选中 / 键盘漫游 / 禁用全部按 RAC 的 treegrid 语义，本文件不
 * 自己维护树状态机、不手写 `aria-level`。`buildTreeView` 的扁平行（含环 / 深 / 超量
 * 保护）在这里只做一次受限还原：按 `depth` 把可见行折回嵌套结构，保护统计仍如实显示。
 *
 * 可靠性（与 v2 面板同一口径，实现另写、不复制 v2 样式）：
 *   · 请求绑定 `owner.sessionId`；owner 变化即作废在途响应（序号闸门 + 卸载清理），
 *     旧会话的树不会覆盖新会话；
 *   · 会话忙（运行 / 流式 / 压缩中）或已有切换在途时禁用导航；错误可重试；
 *   · 深树 / 环 / 超量由共享纯函数限量，界面只如实显示保护统计。
 *
 * 文案：v3 未定稿，暂用本文件内的 zh/en 小字典（与相邻模块一致）；共享 i18n 的
 * `native.*` 由热点整合者统一并入，见交付补丁。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
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
import { Badge, Button, Spinner } from '../../ui'
import { Tree, TreeChevron, TreeItem, TreeItemContent, TreeItemLabel } from '../../ui/Tree'
import type { WorkspaceOwner } from '../workbench/types'
import './branch-tree.css'

/* ------------------------------------------------------------------ 文案 */

export interface BranchText {
  title: string
  treeLabel: string
  hint: string
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
  loading: '正在读取会话树…',
  loadFailed: '会话树读取失败。',
  bridgeMissing: '宿主尚未提供原生会话桥；此页签暂时无法读取会话树。',
  inactive: '当前会话尚未在 pi 侧激活，无法读取或切换分支。',
  retry: '重试',
  refresh: '重新读取会话树',
  empty: '这条会话还没有可显示的分支。',
  emptyHint: '开始对话后，分叉点会在这里以树的形式列出。',
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

/* ------------------------------------------------------------------ 传输与请求 */

/** 原生会话桥的最小接口面，与 `shared/native-session-host.ts` 的请求 / 结果一一对应。 */
export interface BranchTransport {
  request: (request: NativeSessionHostRequest) => Promise<NativeSessionHostResult>
}

export type BranchTreeLoad =
  | { ok: true; tree: NativeTreeNode[]; leafId: string | null }
  | { ok: false; error: string }

/** 取树：只发 `tree` 动作，绑定 `expectedSessionId`。 */
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

/** 切换：只发 `navigate` 与稳定 `entryId`；不发摘要参数（原生固定 `summarize:false`）。 */
export async function navigateBranch(
  transport: BranchTransport,
  expectedSessionId: string,
  entryId: string,
  fallbackError: string
): Promise<NativeActionResult> {
  try {
    const result = await transport.request({ action: 'navigate', expectedSessionId, entryId })
    if (!result.ok) return { ok: false, error: result.error || fallbackError }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/* ------------------------------------------------------------------ 扁平行 → 受限嵌套 */

/** 分支树的一个节点：稳定 `entryId` 的行 + 其可见子节点。 */
export interface BranchNode {
  row: NativeTreeRow
  children: BranchNode[]
}

/**
 * 把 `buildTreeView` 的可见行折回嵌套结构。
 *
 * 输入已经是 DFS 前序、只含可见行的扁平数组（折叠 / 环 / 深 / 超量保护在
 * `buildTreeView` 里收口），因此这里只用 `depth` 入栈出栈，深度不会超过原保护的
 * `maxDepth`、节点数不会超过 `maxRows`，不再引入第二套树状态。
 */
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
  onNavigate: (entryId: string) => void
}

/**
 * 把受限嵌套结构渲染成 RAC 的 `TreeItem`。
 *
 * 嵌套 `TreeItem` 是 `TreeItemContent` 的兄弟节点，`aria-level` / 展开 / 选中由
 * RAC 依真实父子关系计算；这里只放行内容与语义标识（条目类型、书签、折叠隐藏数、
 * 当前叶子）。激活（Enter / 双击）仍走宿主显式导航，不做自动跳转。
 */
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
        </TreeItemContent>
        {renderBranchNodes(node.children, ctx)}
      </TreeItem>
    )
  })
}

/* ------------------------------------------------------------------ 组件 */

export interface BranchTreeProps {
  /** 归属：请求与切换都绑定 `owner.sessionId`。 */
  owner: WorkspaceOwner
  /** 原生会话桥；缺省时由宿主注入。 */
  transport: BranchTransport
  /** 会话正忙（运行 / 流式 / 压缩中）：禁用切换。 */
  busy?: boolean
  /** 外部刷新信号（例如面板上的刷新按钮）。 */
  reloadToken?: number
  /** 切换成功后由宿主同步会话（`refreshSessions`）。 */
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
      /* 卸载即作废在途响应，关面板后旧数据不得回写。 */
      aliveRef.current = false
      runRef.current += 1
    }
  }, [])

  /* 整树加载：owner / 刷新信号变化时重来，并丢弃此前在途响应。 */
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

  /** RAC 的展开集合 = 当前渲染了子节点的行；折叠仍由 `collapsed` 收口到 `buildTreeView`。 */
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

  /* 切换后**就地**重取树（不闪 loading、不丢折叠），成功后由宿主刷新会话列表。 */
  const refreshInPlace = useCallback(async (): Promise<void> => {
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
    setOverrideId(result.leafId)
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
      const result = await navigateBranch(transportRef.current, expectedSessionId, entryId, text.actionFailed)
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
    [expectedSessionId, pending, busy, rows, text.atLeaf, text.actionFailed, text.navigated, onNavigated, refreshInPlace]
  )

  const ctx = useMemo<BranchNodeContext>(
    () => ({
      text,
      pending,
      onNavigate: (entryId: string) => {
        void navigate(entryId)
      }
    }),
    [text, pending, navigate]
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
        <span className="branch-foot__hint">{blocked ? text.busyHint : text.hint}</span>
        <span className="branch-foot__spacer" />
        {actionError ? (
          <span className="branch-note branch-note--err" data-testid="branch-error">
            {actionError}
          </span>
        ) : notice ? (
          <span className="branch-note branch-note--ok" data-testid="branch-notice">
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
