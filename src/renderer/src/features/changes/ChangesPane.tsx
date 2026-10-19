import { uiText } from '../../i18n/ui-text'
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { ArrowLeft, ChevronDown, GitCompare, RefreshCw } from 'lucide-react'
import type { GitChangePatch, GitStatusEntry } from '../../../../shared/git'
import { Badge, Button, IconButton, ListBox, ListBoxItem, Menu, MenuItem, MenuTrigger, Popover, TextField, cx } from '../../ui'
import { useI18n } from '../../i18n'
import { fileStatusLabel, porcelainFileStatus } from '../../lib/file-status'
import { DiffView } from '../diff'
import { changesText } from './text'
import { PaneTools, usePaneChrome } from '../workbench/pane-chrome'
import {
  WORKING_SCOPE,
  commitScope,
  compareLabel,
  isValidSha,
  resolvePatchSource,
  scopeToRequest,
  type ChangesScopeKind,
  type ChangesScopeState
} from './changes-scope'
import { ImageCompare } from './ImageCompare'
import type {
  ChangeItem,
  ChangesGitSource,
  ChangesImagePair,
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

function bridge(): YanGitBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.yan?.git
}

function defaultGitSource(): ChangesGitSource {
  const source: ChangesGitSource = {
    async state(cwd: string): Promise<GitStateView> {
      const git = bridge()
      if (!git) return { repo: null, error: uiText('state.error.gitUnavailable') }
      const res = await git.state(cwd)
      return { repo: res.repo, error: res.error }
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
      added: entry.added,
      removed: entry.removed
    })
  }
  for (const path of untracked) {
    if (!map.has(path)) map.set(path, { path, status: '??', untracked: true })
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path))
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
}

const EMPTY_META: ListMeta = { baseRef: null, baseSha: null, targetSha: null, added: null, removed: null }

type ListOutcome =
  | { ok: true; items: ChangeItem[]; head: string | null; meta: ListMeta; patches: Record<string, GitChangePatch> }
  | { ok: false; error: string }

type PatchMode = 'text' | 'binary' | 'too-large' | 'image'

const SCOPE_KINDS: readonly ChangesScopeKind[] = ['working', 'branch', 'commit']

export function ChangesPane({ owner, gitSource, loadPatch, lang, className }: ChangesPaneProps): ReactElement {
  const uiLang = useI18n().lang
  const text = useMemo(() => changesText(lang ?? uiLang), [lang, uiLang])
  const source = useMemo(() => gitSource ?? defaultGitSource(), [gitSource])
  const loader = useMemo(() => loadPatch ?? defaultLoadPatch(), [loadPatch])
  const chrome = usePaneChrome()
  const ownerKey = owner.key
  const cwd = owner.cwd
  const generation = owner.generation ?? 0
  const ownerId = `${ownerKey}\n${cwd}`

  const [tick, setTick] = useState(0)
  const [loading, setLoading] = useState(false)
  const [repo, setRepo] = useState<GitStateView['repo']>(null)
  const [error, setError] = useState('')
  const [listError, setListError] = useState('')
  const [items, setItems] = useState<ChangeItem[]>([])
  const [meta, setMeta] = useState<ListMeta>(EMPTY_META)
  const [headSha, setHeadSha] = useState<string | null>(null)
  const [scopeState, setScopeState] = useState<{ ownerId: string; scope: ChangesScopeState }>({
    ownerId,
    scope: WORKING_SCOPE
  })
  const [shaDraft, setShaDraft] = useState('')
  const [shaInvalid, setShaInvalid] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [patch, setPatch] = useState('')
  const [patchMode, setPatchMode] = useState<PatchMode>('text')
  const [patchImage, setPatchImage] = useState<ChangesImagePair | null>(null)
  const [patchTruncated, setPatchTruncated] = useState(false)
  const [patchLoading, setPatchLoading] = useState(false)
  const [patchError, setPatchError] = useState('')

  const seqRef = useRef(0)
  const patchSeqRef = useRef(0)
  const patchesRef = useRef<Record<string, GitChangePatch>>({})
  const lastOwnerRef = useRef(ownerId)

  const scope = scopeState.ownerId === ownerId ? scopeState.scope : WORKING_SCOPE
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
    setRepo(null)
    setItems([])
    setMeta(EMPTY_META)
    patchesRef.current = {}
    setSelected(null)
    setPatch('')
    setPatchTruncated(false)
    setPatchError('')
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
              removed: snapshot.removed
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
        setError(stateRes.error ?? '')
        if (listRes.ok) {
          setListError('')
          setItems(listRes.items)
          setMeta(listRes.meta)
          patchesRef.current = listRes.patches
          if (listRes.head) setHeadSha(listRes.head)
        } else {
          setListError(listRes.error)
          setItems([])
        }
      })
      .finally(() => {
        if (alive && seq === seqRef.current) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [ownerKey, cwd, generation, tick, source, request])

  useEffect(() => {
    setPatchImage(null)
    setPatchMode('text')
    if (!selected) {
      setPatch('')
      setPatchTruncated(false)
      setPatchLoading(false)
      setPatchError('')
      return
    }
    const seq = ++patchSeqRef.current
    const origin = resolvePatchSource(selected, patchesRef.current[selected])
    setPatchError('')
    setPatchTruncated(false)
    if (origin.kind === 'inline') {
      setPatch(origin.patch)
      setPatchLoading(false)
      return
    }
    setPatch('')
    if (origin.kind === 'binary' || origin.kind === 'too-large') {
      setPatchMode(origin.kind)
      setPatchLoading(false)
      return
    }
    if (!loader || !request) {
      setPatchLoading(false)
      return
    }
    let alive = true
    setPatchLoading(true)
    loader(cwd, selected, { scope: request, images: origin.kind === 'image' })
      .then((value) => {
        if (!alive || seq !== patchSeqRef.current) return
        if (origin.kind === 'image' && value.image) {
          setPatchMode('image')
          setPatchImage(value.image)
          return
        }
        if (value.binary && !value.patch) {
          setPatchMode('binary')
          return
        }
        setPatch(value.patch)
        setPatchTruncated(value.truncated === true)
      })
      .catch((e: unknown) => {
        if (alive && seq === patchSeqRef.current) setPatchError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive && seq === patchSeqRef.current) setPatchLoading(false)
      })
    return () => {
      alive = false
    }
  }, [selected, loader, cwd, tick, request])

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

  const canDiff = loader !== undefined
  const hasEntries = Boolean(source.changes || source.entries)
  const hasTracked = (repo?.stagedCount ?? 0) + (repo?.unstagedCount ?? 0) > 0
  const showingDetail = Boolean(selected) && canDiff
  const scopeLabels: Record<ChangesScopeKind, string> = {
    working: text.scopeWorking,
    branch: text.scopeBranch,
    commit: text.scopeCommit
  }

  const scopeMenu = source.changes ? (
    <MenuTrigger>
      <Button size="sm" variant="ghost" aria-label={text.scopeLabel} title={text.scopeLabel} icon={<GitCompare size={14} aria-hidden="true" />}>
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
            <MenuItem key={kind} id={kind} textValue={scopeLabels[kind]}>
              {scopeLabels[kind]}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  ) : null

  const refreshButton = (
    <IconButton
      size="sm"
      aria-label={text.refresh}
      title={text.refresh}
      isDisabled={loading}
      onPress={() => setTick((n) => n + 1)}
    >
      <RefreshCw size={14} aria-hidden="true" />
    </IconButton>
  )

  const head = chrome ? (
    <PaneTools>
      {scopeMenu}
      {refreshButton}
    </PaneTools>
  ) : (
    <header className="changes-pane__head">
      <h2 className="changes-pane__title">{text.title}</h2>
      <div className="changes-pane__actions">
        <Badge tone="neutral">{text.readOnly}</Badge>
        {scopeMenu}
        {refreshButton}
      </div>
    </header>
  )

  if (showingDetail && selected) {
    return (
      <section className={cx('changes-pane', className)} aria-label={text.title}>
        {head}
        {!owner.active ? <p className="changes-pane__hint">{text.inactiveHint}</p> : null}
        <div className="changes-pane__detail">
          <div className="changes-pane__detail-head">
            <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} aria-hidden="true" />} onPress={() => setSelected(null)}>
              {text.back}
            </Button>
            <span className="changes-pane__detail-path" title={selected}>
              {selected}
            </span>
          </div>
          <div className="changes-pane__detail-body">
            {patchLoading ? (
              <p className="changes-pane__hint">{text.patchLoading}</p>
            ) : patchError ? (
              <p className="changes-pane__hint changes-pane__hint--error" role="alert">{text.patchError(patchError)}</p>
            ) : patchMode === 'binary' ? (
              <p className="changes-pane__hint">{text.patchBinary}</p>
            ) : patchMode === 'too-large' ? (
              <p className="changes-pane__hint">{text.patchTooLarge}</p>
            ) : patchMode === 'image' && patchImage ? (
              <ImageCompare before={patchImage.before} after={patchImage.after} text={text} />
            ) : (
              <>
                {patchTruncated ? <p className="changes-pane__hint">{text.patchTruncated}</p> : null}
                <DiffView patch={patch} lang={lang} showFileHeader={false} />
              </>
            )}
          </div>
        </div>
      </section>
    )
  }

  const problem = repo ? '' : error ? classifyProblem(error, text) : text.notRepo
  const compareWith = compareLabel(scope, meta)
  const needsSha = scope.kind === 'commit' && !request

  return (
    <section className={cx('changes-pane', className)} aria-label={text.title}>
      {head}
      {!owner.active ? <p className="changes-pane__hint">{text.inactiveHint}</p> : null}
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
                <span className="changes-pane__delta">{text.totalLines(meta.added, meta.removed)}</span>
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
      {loading && !repo ? <p className="changes-pane__hint">{text.loading}</p> : null}
      {!loading && problem ? <p className={error ? 'changes-pane__hint changes-pane__hint--error' : 'changes-pane__hint'} role={error ? 'alert' : undefined}>{problem}</p> : null}
      {repo ? (
        <>
          {!hasEntries && hasTracked ? <p className="changes-pane__hint">{text.entriesLimited}</p> : null}
          {listError ? <p className="changes-pane__hint changes-pane__hint--error" role="alert">{text.entriesFailed(listError)}</p> : null}
          {!canDiff ? <p className="changes-pane__hint">{text.noDiffChannel}</p> : null}
          {needsSha ? <p className="changes-pane__hint">{text.shaNeeded}</p> : null}
          {items.length === 0 ? (
            scope.kind === 'working' ? (
              !hasTracked ? <p className="changes-pane__hint">{text.clean}</p> : null
            ) : !loading && !listError && !needsSha ? (
              <p className="changes-pane__hint">{text.scopeEmpty}</p>
            ) : null
          ) : (
            <ListBox
              aria-label={text.title}
              className="changes-pane__list"
              selectionMode={canDiff ? 'single' : 'none'}
              selectedKeys={selected ? [selected] : []}
              onSelectionChange={(keys) => {
                const first = [...keys][0]
                setSelected(first === undefined ? null : String(first))
              }}
            >
              {items.map((item) => (
                <ListBoxItem key={item.path} id={item.path} textValue={item.path} className="changes-pane__item">
                  <span className="changes-pane__status" data-status={porcelainFileStatus(item.status)} title={item.status}>{fileStatusLabel(porcelainFileStatus(item.status), lang ?? uiLang)}</span>
                  <span className="changes-pane__path" title={item.path}>
                    {item.path}
                  </span>
                  {item.added !== undefined || item.removed !== undefined ? (
                    <span className="changes-pane__delta">
                      <span className="changes-pane__delta-add">+{item.added ?? 0}</span>
                      <span className="changes-pane__delta-del">−{item.removed ?? 0}</span>
                    </span>
                  ) : null}
                </ListBoxItem>
              ))}
            </ListBox>
          )}
          {canDiff && items.length > 0 ? <p className="changes-pane__hint">{text.selectFile}</p> : null}
        </>
      ) : null}
    </section>
  )
}
