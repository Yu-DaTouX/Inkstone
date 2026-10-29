import { uiText } from '../../i18n/ui-text'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import { ChevronDown, FlaskConical, GitCompare, List, RefreshCw } from 'lucide-react'
import type { GitActionExpected } from '../../../../shared/git-actions'
import type { GitChangePatch, GitStatusEntry } from '../../../../shared/git'
import {
  Button,
  Checkbox,
  DiffStat,
  EmptyState,
  IconButton,
  Menu,
  MenuItem,
  MenuTrigger,
  Notice,
  Popover,
  Spinner,
  TextField,
  Toggle,
  TreeRow,
  cx
} from '../../ui'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import type { DiffViewMode } from '../diff'
import { serializeLineComment, type CommentLang } from '../preview/code-line-comment'
import { changesText } from './text'
import { PaneTools, usePaneMenu, type PaneMenuItem } from '../workbench/pane-chrome'
import {
  WORKING_SCOPE,
  commitScope,
  compareLabel,
  isValidSha,
  scopeKey,
  scopeToRequest,
  type ChangesScopeKind,
  type ChangesScopeState
} from './changes-scope'
import { ChangesFileDiff } from './ChangesFileDiff'
import { buildFileTree, createLimitedQueue, flattenFileTree, isLargeDiff, sortChangeItems } from './file-list'
import { useChangesFileList } from './use-file-list'
import { isTestFilePath, readHideTestFiles, writeHideTestFiles } from './test-files'
import {
  patchHash,
  readViewedFiles,
  reconcileViewedFiles,
  viewedPathsOf,
  withFileViewed,
  writeViewedFiles
} from './viewed-files'
import type {
  ChangeItem,
  ChangesAnnotate,
  ChangesGitSource,
  ChangesOwner,
  ChangesPatch,
  ChangesSnapshot,
  GitStateView,
  PatchLoader
} from './types'
import './changes-pane.css'

export interface ChangesPaneProps {
  owner: ChangesOwner
  gitSource?: ChangesGitSource
  loadPatch?: PatchLoader
  lang?: string
  className?: string
}

type YanGitBridge = NonNullable<Window['yan']['git']>

const LAYOUT_KEY = 'inkstone.changes.layout'

function bridge(): YanGitBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.yan?.git
}

function readLayout(): DiffViewMode {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'split' ? 'split' : 'unified'
  } catch {
    return 'unified'
  }
}

function writeLayout(mode: DiffViewMode): void {
  try {
    localStorage.setItem(LAYOUT_KEY, mode)
  } catch {
    return
  }
}

function defaultGitSource(): ChangesGitSource {
  const source: ChangesGitSource = {
    async state(cwd: string): Promise<GitStateView> {
      const git = bridge()
      if (!git) return { repo: null, error: uiText('state.error.gitUnavailable') }
      const res = await git.state(cwd)
      return { repo: res.repo, expected: res.expected, error: res.error }
    },
    async untracked(cwd: string): Promise<string[]> {
      const git = bridge()
      if (!git) return []
      return git.untracked(cwd)
    }
  }
  if (bridge()?.changes) {
    source.changes = async (cwd, query): Promise<ChangesSnapshot> => {
      const git = bridge()
      if (!git?.changes) throw new Error(uiText('state.error.gitUnavailable'))
      const res = await git.changes(cwd, { scope: query.scope, patches: query.patches })
      if (!res.ok) throw new Error(res.error ?? uiText('state.error.changesReadFailed'))
      return {
        files: res.files,
        head: res.head,
        scopeKind: res.scopeKind ?? query.scope.kind,
        baseRef: res.baseRef ?? null,
        baseSha: res.baseSha ?? null,
        targetSha: res.targetSha ?? null,
        added: res.added ?? null,
        removed: res.removed ?? null,
        pathScope: res.scope ?? null,
        patches: res.patches ?? {}
      }
    }
  }
  return source
}

function defaultLoadPatch(): PatchLoader | undefined {
  if (!bridge()?.diff) return undefined
  return async (cwd, path, request): Promise<ChangesPatch> => {
    const git = bridge()
    if (!git?.diff) throw new Error(uiText('state.error.gitUnavailable'))
    const res = await git.diff({ cwd, path, scope: request?.scope, images: request?.images })
    if (!res.ok) throw new Error(res.error ?? uiText('state.error.diffReadFailed'))
    return { patch: res.patch, truncated: res.truncated, binary: res.binary, image: res.image }
  }
}

type ChangeEntry = GitStatusEntry & { added?: number; removed?: number }

function mergeItems(entries: ChangeEntry[], untracked: string[]): ChangeItem[] {
  const map = new Map<string, ChangeItem>()
  for (const entry of entries) {
    if (entry.ignored) continue
    map.set(entry.path, {
      path: entry.path,
      status: `${entry.x}${entry.y}`,
      untracked: entry.untracked,
      origPath: entry.origPath,
      added: entry.added,
      removed: entry.removed
    })
  }
  for (const path of untracked) {
    if (!map.has(path)) map.set(path, { path, status: '??', untracked: true })
  }
  return sortChangeItems([...map.values()])
}

function classifyProblem(error: string, text: ReturnType<typeof changesText>): string {
  if (!error) return text.notRepo
  if (/ENOENT|not found|找不到|未安装|spawn git|command not found|is not recognized|git 不可用/i.test(error)) return text.gitMissing
  return text.gitError(error)
}

interface ListMeta {
  baseRef: string | null
  baseSha: string | null
  targetSha: string | null
  added: number | null
  removed: number | null
  pathScope: string | null
}

const EMPTY_META: ListMeta = { baseRef: null, baseSha: null, targetSha: null, added: null, removed: null, pathScope: null }

type ListOutcome =
  | { ok: true; items: ChangeItem[]; head: string | null; meta: ListMeta; patches: Record<string, GitChangePatch> }
  | { ok: false; error: string }

const SCOPE_KINDS: readonly ChangesScopeKind[] = ['working', 'branch', 'commit']

export function ChangesPane({ owner, gitSource, loadPatch, lang, className }: ChangesPaneProps): ReactElement {
  const { lang: uiLang, t } = useI18n()
  const resolvedLang = lang ?? uiLang
  const text = useMemo(() => changesText(resolvedLang), [resolvedLang])
  const source = useMemo(() => gitSource ?? defaultGitSource(), [gitSource])
  const loader = useMemo(() => loadPatch ?? defaultLoadPatch(), [loadPatch])
  const ownerKey = owner.key
  const cwd = owner.cwd
  const generation = owner.generation ?? 0
  const ownerId = `${ownerKey}\n${cwd}`
  const fileList = useChangesFileList()
  const schedule = useMemo(() => createLimitedQueue(4), [])

  const [tick, setTick] = useState(0)
  const [loading, setLoading] = useState(false)
  const [repo, setRepo] = useState<GitStateView['repo']>(null)
  const [expected, setExpected] = useState<GitActionExpected | undefined>(undefined)
  const [error, setError] = useState('')
  const [listError, setListError] = useState('')
  const [items, setItems] = useState<ChangeItem[]>([])
  const [patches, setPatches] = useState<Record<string, GitChangePatch>>({})
  const [meta, setMeta] = useState<ListMeta>(EMPTY_META)
  const [headSha, setHeadSha] = useState<string | null>(null)
  const [scopeState, setScopeState] = useState<{ ownerId: string; scope: ChangesScopeState }>({
    ownerId,
    scope: WORKING_SCOPE
  })
  const [shaDraft, setShaDraft] = useState('')
  const [shaInvalid, setShaInvalid] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set())
  const [activePath, setActivePath] = useState<string | null>(null)
  const [reveal, setReveal] = useState<{ path: string; seq: number } | null>(null)
  const [layout, setLayout] = useState<DiffViewMode>(readLayout)
  const [message, setMessage] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [actionNotice, setActionNotice] = useState('')
  const [hideTests, setHideTests] = useState(readHideTestFiles)
  const [viewed, setViewed] = useState(readViewedFiles)

  const seqRef = useRef(0)
  const initRef = useRef('')
  const lastOwnerRef = useRef(ownerId)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const revealAtRef = useRef(0)

  const scope = scopeState.ownerId === ownerId ? scopeState.scope : WORKING_SCOPE
  const initKey = `${ownerId}|${scopeKey(scope)}|${generation}`
  const scopeKind = scope.kind
  const scopeSha = scope.sha
  const request = useMemo(() => scopeToRequest({ kind: scopeKind, sha: scopeSha }), [scopeKind, scopeSha])

  useEffect(() => {
    setShaDraft(scopeSha)
    setShaInvalid(false)
  }, [ownerId, scopeKind, scopeSha])

  useEffect(() => {
    if (lastOwnerRef.current === ownerId) return
    lastOwnerRef.current = ownerId
    setHeadSha(null)
  }, [ownerId])

  useEffect(() => {
    const seq = ++seqRef.current
    let alive = true
    setLoading(true)
    setError('')
    setListError('')
    const listPromise: Promise<ListOutcome> = (async (): Promise<ListOutcome> => {
      try {
        if (source.changes) {
          if (!request) return { ok: true, items: [], head: null, meta: EMPTY_META, patches: {} }
          const snapshot = await source.changes(cwd, { scope: request, patches: true })
          return {
            ok: true,
            items: mergeItems(snapshot.files, []),
            head: snapshot.head,
            meta: {
              baseRef: snapshot.baseRef,
              baseSha: snapshot.baseSha,
              targetSha: snapshot.targetSha,
              added: snapshot.added,
              removed: snapshot.removed,
              pathScope: snapshot.pathScope ?? null
            },
            patches: snapshot.patches
          }
        }
        if (source.entries) {
          const entries = await source.entries(cwd)
          return { ok: true, items: mergeItems(entries, []), head: null, meta: EMPTY_META, patches: {} }
        }
        const untracked = await source.untracked(cwd).catch(() => [] as string[])
        return { ok: true, items: mergeItems([], untracked), head: null, meta: EMPTY_META, patches: {} }
      } catch (e: unknown) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    })()
    void Promise.all([
      source.state(cwd).catch((e: unknown): GitStateView => ({ repo: null, error: e instanceof Error ? e.message : String(e) })),
      listPromise
    ])
      .then(([stateRes, listRes]) => {
        if (!alive || seq !== seqRef.current) return
        setRepo(stateRes.repo)
        setExpected(stateRes.expected)
        setError(stateRes.error ?? '')
        if (listRes.ok) {
          setListError('')
          setItems(listRes.items)
          setPatches(listRes.patches)
          setMeta(listRes.meta)
          if (initRef.current !== initKey) {
            initRef.current = initKey
            setExpanded(isLargeDiff(listRes.items) ? new Set() : new Set(listRes.items.map((item) => item.path)))
            setCollapsedDirs(new Set())
            setActivePath(null)
          } else {
            setExpanded((prev) => new Set(listRes.items.filter((item) => prev.has(item.path)).map((item) => item.path)))
          }
          if (listRes.head) setHeadSha(listRes.head)
        } else {
          setListError(listRes.error)
          setItems([])
          setPatches({})
        }
      })
      .finally(() => {
        if (alive && seq === seqRef.current) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [ownerKey, cwd, generation, tick, source, request])

  const viewedRoot = repo?.root ?? ''
  const patchHashes = useMemo(() => {
    const map = new Map<string, string>()
    for (const [path, entry] of Object.entries(patches)) {
      if (entry?.patch) map.set(path, patchHash(entry.patch))
    }
    return map
  }, [patches])
  const testPaths = useMemo(
    () => new Set(items.filter((item) => isTestFilePath(item.path)).map((item) => item.path)),
    [items]
  )
  const hiddenTestCount = hideTests ? testPaths.size : 0
  const shownItems = useMemo(
    () => (hideTests ? items.filter((item) => !testPaths.has(item.path)) : items),
    [hideTests, items, testPaths]
  )
  const viewedCandidates = useMemo(
    () => shownItems.map((item) => ({ path: item.path, hash: patchHashes.get(item.path) ?? null })),
    [shownItems, patchHashes]
  )
  const viewedPaths = useMemo(
    () => viewedPathsOf(viewed, viewedRoot, viewedCandidates),
    [viewed, viewedRoot, viewedCandidates]
  )

  const large = useMemo(() => isLargeDiff(shownItems), [shownItems])
  const narrow = fileList.paneWidth > 0 && fileList.paneWidth < 560
  const mode: DiffViewMode = layout === 'split' && narrow ? 'unified' : layout

  const treeRows = useMemo(() => flattenFileTree(buildFileTree(shownItems), collapsedDirs), [shownItems, collapsedDirs])
  const tabbableRowPath = useMemo(() => {
    const paths = treeRows.map((row) => row.path)
    if (activePath && paths.includes(activePath)) return activePath
    return paths[0] ?? null
  }, [treeRows, activePath])
  const itemByPath = useMemo(() => new Map(items.map((item) => [item.path, item])), [items])
  const selectFile = useCallback((path: string): void => {
    setActivePath(path)
    setExpanded((prev) => {
      if (prev.has(path)) return prev
      const next = new Set(prev)
      next.add(path)
      return next
    })
    setReveal((prev) => ({ path, seq: (prev?.seq ?? 0) + 1 }))
  }, [])

  const toggleFile = useCallback((path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const toggleDir = useCallback((path: string): void => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const toggleHideTests = useCallback((): void => {
    const next = !hideTests
    setHideTests(next)
    writeHideTestFiles(next)
  }, [hideTests])

  const toggleViewed = useCallback(
    (path: string, next: boolean): void => {
      setViewed((prev) => withFileViewed(prev, viewedRoot, path, patchHashes.get(path) ?? null, next))
    },
    [patchHashes, viewedRoot]
  )

  useEffect(() => {
    writeViewedFiles(viewed)
  }, [viewed])

  useEffect(() => {
    if (!viewedRoot || patchHashes.size === 0) return
    setViewed((prev) =>
      reconcileViewedFiles(
        prev,
        viewedRoot,
        [...patchHashes].map(([path, hash]) => ({ path, hash }))
      )
    )
  }, [patchHashes, viewedRoot])

  useEffect(() => {
    if (!reveal) return
    const scroller = scrollerRef.current
    const node = scroller?.querySelector<HTMLElement>(`[data-path="${CSS.escape(reveal.path)}"]`)
    if (!scroller || !node) return
    revealAtRef.current = Date.now()
    scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  }, [reveal])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return undefined
    let frame = 0
    const onScroll = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (Date.now() - revealAtRef.current < 250) return
        const top = scroller.getBoundingClientRect().top + 32
        for (const section of scroller.querySelectorAll<HTMLElement>('[data-path]')) {
          if (section.getBoundingClientRect().bottom > top) {
            const path = section.dataset.path ?? null
            setActivePath((prev) => (prev === path ? prev : path))
            return
          }
        }
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [items.length])

  const chooseScope = (kind: ChangesScopeKind): void => {
    if (kind === scope.kind) return
    const next: ChangesScopeState = kind === 'commit' ? commitScope(headSha) : kind === 'branch' ? { kind, sha: '' } : WORKING_SCOPE
    setScopeState({ ownerId, scope: next })
  }

  const applySha = (event: FormEvent): void => {
    event.preventDefault()
    if (!isValidSha(shaDraft)) {
      setShaInvalid(true)
      return
    }
    setShaInvalid(false)
    setScopeState({ ownerId, scope: commitScope(shaDraft) })
  }

  const refresh = useCallback((): void => {
    setActionError('')
    setActionNotice('')
    setTick((n) => n + 1)
  }, [])

  const runAction = useCallback(
    async (kind: 'stage-all' | 'commit'): Promise<void> => {
      const git = bridge()
      if (!git || !expected || actionBusy) return
      setActionBusy(true)
      setActionError('')
      setActionNotice('')
      try {
        const requestId = `changes-${kind}-${Date.now()}`
        const res =
          kind === 'commit'
            ? await git.action({ requestId, cwd, expected, kind: 'commit', message: message.trim() })
            : await git.action({ requestId, cwd, expected, kind: 'stage-all' })
        if (!res.ok) {
          setActionError(text.commitFailed(res.failure?.message ?? ''))
          if (res.failure?.code === 'stale') setTick((n) => n + 1)
          return
        }
        if (kind === 'commit') {
          setActionNotice(text.commitDone(res.summary ?? ''))
          setMessage('')
        }
        setTick((n) => n + 1)
      } catch (e: unknown) {
        setActionError(text.commitFailed(e instanceof Error ? e.message : String(e)))
      } finally {
        setActionBusy(false)
      }
    },
    [actionBusy, cwd, expected, message, text]
  )

  const canDiff = loader !== undefined
  const hasEntries = Boolean(source.changes || source.entries)
  const hasTracked = (repo?.stagedCount ?? 0) + (repo?.unstagedCount ?? 0) > 0
  const hasWork = (repo?.changedCount ?? 0) > 0
  const canAct = Boolean(bridge()?.action) && Boolean(expected) && hasWork && owner.active && !actionBusy
  const scopeLabels: Record<ChangesScopeKind, string> = {
    working: text.scopeWorking,
    branch: text.scopeBranch,
    commit: text.scopeCommit
  }

  const scopeMenu = source.changes ? (
    <MenuTrigger>
      <Button size="sm" variant="ghost" aria-label={text.scopeLabel} icon={<GitCompare size={14} aria-hidden="true" />}>
        {scopeLabels[scope.kind]}
        <ChevronDown size={12} aria-hidden="true" />
      </Button>
      <Popover placement="bottom end">
        <Menu
          aria-label={text.scopeLabel}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[scope.kind]}
          onAction={(key) => chooseScope(String(key) as ChangesScopeKind)}
        >
          {SCOPE_KINDS.map((kind) => (
            <MenuItem key={kind} id={kind} textValue={scopeLabels[kind]} checked="selection">
              {scopeLabels[kind]}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  ) : null

  const refreshButton = (
    <IconButton size="sm" aria-label={text.refresh} tooltip={text.refresh} isDisabled={loading} onPress={refresh}>
      <RefreshCw size={14} aria-hidden="true" />
    </IconButton>
  )

  const listToggle = fileList.canFit ? (
    <Toggle
      icon
      aria-label={fileList.shown ? text.hideFileList : text.showFileList}
      tooltip={fileList.shown ? text.hideFileList : text.showFileList}
      isSelected={fileList.shown}
      onChange={fileList.toggle}
    >
      <List size={14} aria-hidden="true" />
    </Toggle>
  ) : null

  const displayMenu: PaneMenuItem[] = [
    ...(fileList.canFit
      ? [{ id: 'changes:files', label: fileList.shown ? text.hideFileList : text.showFileList, checked: fileList.shown, onAction: fileList.toggle }]
      : []),
    {
      id: 'changes:tests',
      label: hideTests ? t('changes.showTests') : t('changes.hideTests'),
      checked: hideTests,
      disabled: testPaths.size === 0,
      onAction: toggleHideTests
    },
    { id: 'changes:collapse', label: text.collapseAll, onAction: () => setExpanded(new Set()) },
    {
      id: 'changes:expand',
      label: text.expandAll,
      disabled: large,
      onAction: () => setExpanded(new Set(items.map((item) => item.path)))
    },
    {
      id: 'changes:split',
      label: layout === 'split' && narrow ? `${text.layoutSplit} · ${text.splitNeedsWidth}` : text.layoutSplit,
      checked: layout === 'split',
      onAction: () => {
        const next: DiffViewMode = layout === 'split' ? 'unified' : 'split'
        setLayout(next)
        writeLayout(next)
      }
    },
    { id: 'changes:refresh', label: text.refresh, onAction: refresh }
  ]
  usePaneMenu('changes', displayMenu)

  const onTreeKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-row-path]')
    if (!row) return
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-row-path]')]
    const index = rows.indexOf(row)
    const path = row.dataset.rowPath ?? ''
    const isDir = row.dataset.rowKind === 'dir'
    const focus = (at: number): void => rows[Math.max(0, Math.min(rows.length - 1, at))]?.focus()
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focus(index + 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      focus(index - 1)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      focus(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      focus(rows.length - 1)
      return
    }
    if (!isDir) return
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      if (collapsedDirs.has(path)) toggleDir(path)
      else focus(index + 1)
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (!collapsedDirs.has(path)) toggleDir(path)
      else focus(index - 1)
    }
  }

  const annotate = useMemo<ChangesAnnotate>(() => {
    const commentLang: CommentLang = resolvedLang.toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN'
    return {
      labels: {
        add: t('changes.annotateAdd'),
        line: (line) => t('changes.annotateLine', { line }),
        lines: (start, end) => t('changes.annotateLines', { start, end }),
        placeholder: t('changes.annotatePlaceholder'),
        submit: t('changes.annotateSubmit'),
        cancel: t('changes.annotateCancel'),
        hint: t('changes.annotateHint')
      },
      onComment: (path, annotation) => {
        const serialized = serializeLineComment({
          path,
          start: annotation.start,
          end: annotation.end,
          code: annotation.code,
          text: annotation.text,
          lang: commentLang
        })
        if (serialized) useStore.getState().insertIntoComposer(serialized)
      }
    }
  }, [resolvedLang, t])

  const head = (
    <PaneTools>
      {scopeMenu}
      {listToggle}
      {refreshButton}
    </PaneTools>
  )

  const problem = repo ? '' : error ? classifyProblem(error, text) : text.notRepo
  const compareWith = compareLabel(scope, meta)
  const needsSha = scope.kind === 'commit' && !request
  const showEmpty = items.length === 0
  const subdir = scope.kind === 'working' && meta.pathScope && meta.pathScope !== '.' ? meta.pathScope : null
  const elsewhere = repo?.changedCount ?? 0

  return (
    <section className={cx('changes-pane', className)} aria-label={text.title}>
      {head}
      {!owner.active ? hint(text.inactiveHint) : null}
      {repo ? (
        <div className="changes-pane__summary">
          <div className="changes-pane__repo">
            <span className="changes-pane__repo-name" title={repo.root}>
              {repo.name}
            </span>
            <span className="changes-pane__branch">
              {repo.detached ? text.detached : repo.branch ?? text.noBranch}
              {repo.unborn ? ` · ${text.unborn}` : ''}
            </span>
          </div>
          {scope.kind === 'working' ? (
            <dl className="changes-pane__stats">
              <div>
                <dt>{text.changed}</dt>
                <dd>{repo.changedCount}</dd>
              </div>
              <div>
                <dt>{text.staged}</dt>
                <dd>{repo.stagedCount}</dd>
              </div>
              <div>
                <dt>{text.unstaged}</dt>
                <dd>{repo.unstagedCount}</dd>
              </div>
              <div>
                <dt>{text.untracked}</dt>
                <dd>{repo.untrackedCount}</dd>
              </div>
            </dl>
          ) : (
            <div className="changes-pane__compare">
              {compareWith ? <span className="changes-pane__compare-label" title={compareWith}>{text.compareWith(compareWith)}</span> : null}
              {meta.added !== null && meta.removed !== null ? (
                <DiffStat added={meta.added} removed={meta.removed} aria-label={text.totalLines(meta.added, meta.removed)} />
              ) : null}
            </div>
          )}
          {scope.kind === 'commit' ? (
            <form className="changes-pane__sha" onSubmit={applySha}>
              <TextField
                aria-label={text.shaLabel}
                className="changes-pane__sha-field"
                value={shaDraft}
                onChange={(value) => {
                  setShaDraft(value)
                  setShaInvalid(false)
                }}
                isInvalid={shaInvalid}
                errorMessage={text.shaInvalid}
                placeholder={text.shaPlaceholder}
              />
              <Button size="sm" type="submit">
                {text.shaApply}
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
      {loading && !repo ? (
        <Notice variant="hint" icon={<Spinner size="xs" />} className="changes-pane__hint">
          {text.loading}
        </Notice>
      ) : null}
      {!loading && problem ? (
        error ? (
          <Notice tone="fail" compact className="changes-pane__hint">
            {problem}
          </Notice>
        ) : (
          <EmptyState size="sm" title={problem} className="changes-pane__empty" />
        )
      ) : null}
      {repo ? (
        <>
          {!hasEntries && hasTracked ? hint(text.entriesLimited) : null}
          {listError ? (
            <Notice
              tone="fail"
              compact
              className="changes-pane__hint"
              action={
                <Button size="xs" onPress={refresh}>
                  {text.retry}
                </Button>
              }
            >
              {text.entriesFailed(listError)}
            </Notice>
          ) : null}
          {!canDiff ? hint(text.noDiffChannel) : null}
          {needsSha ? hint(text.shaNeeded) : null}
          {subdir && !listError && !loading
            ? hint(showEmpty && elsewhere > 0 ? text.subdirClean(subdir, elsewhere) : text.subdirScope(subdir), 'changes-subdir-hint')
            : null}
          {hiddenTestCount > 0 ? hint(t('changes.testsHidden', { count: hiddenTestCount }), 'changes-tests-hidden') : null}
          {showEmpty ? (
            scope.kind === 'working' ? (
              !hasTracked && !listError && !subdir ? <EmptyState size="sm" title={text.clean} className="changes-pane__empty" /> : null
            ) : !loading && !listError && !needsSha ? (
              <EmptyState size="sm" title={text.scopeEmpty} className="changes-pane__empty" />
            ) : null
          ) : (
            <div className="changes-pane__layout" ref={fileList.hostRef} data-dragging={fileList.dragging || undefined}>
              {fileList.shown ? (
                <div className="changes-pane__files" style={{ width: fileList.width }}>
                  <div className="changes-pane__files-head">
                    <span className="changes-pane__files-stat">
                      {t('changes.viewedOf', { viewed: viewedPaths.size, total: shownItems.length })}
                    </span>
                    {testPaths.size > 0 ? (
                      <Toggle
                        icon
                        size="xs"
                        aria-label={hideTests ? t('changes.showTests') : t('changes.hideTests')}
                        tooltip={hideTests ? t('changes.showTests') : t('changes.hideTests')}
                        isSelected={hideTests}
                        data-testid="changes-hide-tests"
                        onChange={toggleHideTests}
                      >
                        <FlaskConical size={12} aria-hidden="true" />
                      </Toggle>
                    ) : null}
                  </div>
                  <div className="changes-pane__tree" role="tree" aria-label={text.filesTitle} onKeyDown={onTreeKeyDown}>
                    {treeRows.map((row) => {
                      if (row.kind === 'dir') {
                        return (
                          <TreeRow
                            key={`dir:${row.path}`}
                            role="treeitem"
                            depth={row.depth}
                            expanded={!collapsedDirs.has(row.path)}
                            aria-level={row.depth + 1}
                            data-row-path={row.path}
                            data-row-kind="dir"
                            tabIndex={row.path === tabbableRowPath ? 0 : -1}
                            className="changes-pane__row"
                            onClick={() => toggleDir(row.path)}
                          >
                            {row.name}
                          </TreeRow>
                        )
                      }
                      const entry = itemByPath.get(row.path)
                      const seen = viewedPaths.has(row.path)
                      const selected = activePath === row.path
                      return (
                        <div key={`file:${row.path}`} className="changes-pane__item" role="none" data-viewed={seen ? '' : undefined}>
                          <TreeRow
                            role="treeitem"
                            depth={row.depth}
                            aria-level={row.depth + 1}
                            aria-selected={selected}
                            data-selected={selected ? '' : undefined}
                            data-row-path={row.path}
                            data-row-kind="file"
                            tabIndex={row.path === tabbableRowPath ? 0 : -1}
                            className="changes-pane__row"
                            muted={seen}
                            icon={<FileTypeIcon name={row.path} size={12} />}
                            trailing={
                              entry?.added !== undefined || entry?.removed !== undefined ? (
                                <DiffStat added={entry?.added ?? 0} removed={entry?.removed ?? 0} />
                              ) : undefined
                            }
                            onClick={() => selectFile(row.path)}
                          >
                            {row.name}
                          </TreeRow>
                          <Checkbox
                            className="changes-pane__viewed"
                            aria-label={seen ? t('changes.markUnviewed', { path: row.path }) : t('changes.markViewed', { path: row.path })}
                            isSelected={seen}
                            onChange={(next) => toggleViewed(row.path, next)}
                          />
                        </div>
                      )
                    })}
                  </div>
                  <div
                    className="changes-pane__divider"
                    role="separator"
                    tabIndex={0}
                    aria-label={text.resizeFileList}
                    aria-orientation="vertical"
                    aria-valuemin={160}
                    aria-valuemax={Math.round(fileList.limit)}
                    aria-valuenow={Math.round(fileList.width)}
                    onPointerDown={fileList.onDividerPointerDown}
                    onKeyDown={fileList.onDividerKeyDown}
                    onDoubleClick={fileList.resetWidth}
                  />
                </div>
              ) : fileList.canFit ? (
                <div
                  className="changes-pane__edge"
                  role="separator"
                  tabIndex={0}
                  aria-label={text.showFileList}
                  aria-orientation="vertical"
                  aria-valuemin={0}
                  aria-valuemax={640}
                  aria-valuenow={0}
                  onClick={fileList.show}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'ArrowLeft') return
                    event.preventDefault()
                    fileList.show()
                  }}
                />
              ) : null}
              <div className="changes-pane__main" ref={scrollerRef} tabIndex={-1}>
                {large ? hint(text.largeDiffBanner, undefined, 'changes-pane__banner') : null}
                {shownItems.map((item) => (
                  <ChangesFileDiff
                    key={item.path}
                    item={item}
                    entry={patches[item.path]}
                    cwd={cwd}
                    request={request ?? { kind: 'working' }}
                    loader={loader}
                    schedule={schedule}
                    tick={tick}
                    lang={resolvedLang}
                    text={text}
                    mode={mode}
                    expanded={expanded.has(item.path)}
                    onToggle={toggleFile}
                    onRetry={refresh}
                    annotate={annotate}
                  />
                ))}
              </div>
            </div>
          )}
          {scope.kind === 'working' ? (
            <div className="changes-pane__commit">
              <TextField
                aria-label={text.commitMessage}
                className="changes-pane__commit-field"
                placeholder={text.commitPlaceholder}
                value={message}
                onChange={setMessage}
              />
              <Button size="sm" isDisabled={!canAct} onPress={() => void runAction('stage-all')}>
                {text.stageAll}
              </Button>
              <Button size="sm" variant="primary" isDisabled={!canAct || !message.trim()} onPress={() => void runAction('commit')}>
                {text.commitAction}
              </Button>
            </div>
          ) : null}
          {actionBusy ? (
            <Notice variant="hint" icon={<Spinner size="xs" />} className="changes-pane__hint">
              {text.commitBusy}
            </Notice>
          ) : null}
          {actionError ? (
            <Notice tone="fail" compact className="changes-pane__hint">
              {actionError}
            </Notice>
          ) : null}
          {actionNotice ? (
            <Notice variant="hint" tone="ok" className="changes-pane__hint">
              {actionNotice}
            </Notice>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

function hint(message: string, testId?: string, className = 'changes-pane__hint'): ReactElement {
  return (
    <Notice variant="hint" className={className} data-testid={testId}>
      {message}
    </Notice>
  )
}
