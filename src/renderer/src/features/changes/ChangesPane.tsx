import { uiText } from '../../i18n/ui-text'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import type { GitStatusEntry } from '../../../../shared/git'
import { Badge, Button, IconButton, ListBox, ListBoxItem, cx } from '../../ui'
import { useI18n } from '../../i18n'
import { fileStatusLabel, porcelainFileStatus } from '../../lib/file-status'
import { DiffView } from '../diff'
import { changesText } from './text'
import { PaneTools, usePaneChrome } from '../workbench/pane-chrome'
import type { ChangeItem, ChangesGitSource, ChangesOwner, ChangesPatch, GitStateView, PatchLoader } from './types'
import './changes-pane.css'

export interface ChangesPaneProps {
  owner: ChangesOwner
  gitSource?: ChangesGitSource
  loadPatch?: PatchLoader
  lang?: string
  className?: string
}

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
    source.entries = async (cwd: string): Promise<GitStatusEntry[]> => {
      const git = bridge()
      if (!git?.changes) throw new Error(uiText('state.error.gitUnavailable'))
      const res = await git.changes(cwd)
      if (!res.ok) throw new Error(res.error ?? uiText('state.error.changesReadFailed'))
      return res.files
    }
  }
  return source
}

function defaultLoadPatch(): PatchLoader | undefined {
  if (!bridge()?.diff) return undefined
  return async (cwd: string, path: string): Promise<ChangesPatch> => {
    const git = bridge()
    if (!git?.diff) throw new Error(uiText('state.error.gitUnavailable'))
    const res = await git.diff({ cwd, path })
    if (!res.ok) throw new Error(res.error ?? uiText('state.error.diffReadFailed'))
    return { patch: res.patch, truncated: res.truncated, binary: res.binary }
  }
}

type YanGitBridge = NonNullable<Window['yan']['git']>

function mergeItems(entries: GitStatusEntry[], untracked: string[]): ChangeItem[] {
  const map = new Map<string, ChangeItem>()
  for (const entry of entries) {
    if (entry.ignored) continue
    map.set(entry.path, { path: entry.path, status: `${entry.x}${entry.y}`, untracked: entry.untracked })
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

export function ChangesPane({ owner, gitSource, loadPatch, lang, className }: ChangesPaneProps): ReactElement {
  const uiLang = useI18n().lang
  const text = useMemo(() => changesText(lang ?? uiLang), [lang, uiLang])
  const source = useMemo(() => gitSource ?? defaultGitSource(), [gitSource])
  const loader = useMemo(() => loadPatch ?? defaultLoadPatch(), [loadPatch])
  const chrome = usePaneChrome()
  const [tick, setTick] = useState(0)
  const [loading, setLoading] = useState(false)
  const [repo, setRepo] = useState<GitStateView['repo']>(null)
  const [error, setError] = useState('')
  const [listError, setListError] = useState('')
  const [items, setItems] = useState<ChangeItem[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [patch, setPatch] = useState('')
  const [patchTruncated, setPatchTruncated] = useState(false)
  const [patchLoading, setPatchLoading] = useState(false)
  const [patchError, setPatchError] = useState('')

  const seqRef = useRef(0)
  const patchSeqRef = useRef(0)
  const ownerKey = owner.key
  const cwd = owner.cwd
  const generation = owner.generation ?? 0

  useEffect(() => {
    const seq = ++seqRef.current
    let alive = true
    setLoading(true)
    setError('')
    setListError('')
    setRepo(null)
    setItems([])
    setSelected(null)
    setPatch('')
    setPatchTruncated(false)
    setPatchError('')
    const entriesPromise: Promise<{ ok: true; entries: GitStatusEntry[] } | { ok: false; error: string }> = source.entries
      ? source
          .entries(cwd)
          .then((entries) => ({ ok: true as const, entries }))
          .catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
      : Promise.resolve({ ok: true as const, entries: [] as GitStatusEntry[] })
    const untrackedPromise: Promise<string[]> = source.entries
      ? Promise.resolve([] as string[])
      : source.untracked(cwd).catch(() => [] as string[])
    void Promise.all([
      source.state(cwd).catch((e: unknown): GitStateView => ({ repo: null, error: e instanceof Error ? e.message : String(e) })),
      untrackedPromise,
      entriesPromise
    ])
      .then(([stateRes, untrackedRes, entriesRes]) => {
        if (!alive || seq !== seqRef.current) return
        setRepo(stateRes.repo)
        setError(stateRes.error ?? '')
        setListError(entriesRes.ok ? '' : entriesRes.error)
        setItems(mergeItems(entriesRes.ok ? entriesRes.entries : [], untrackedRes))
      })
      .finally(() => {
        if (alive && seq === seqRef.current) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [ownerKey, cwd, generation, tick, source])

  useEffect(() => {
    if (!selected || !loader) {
      setPatch('')
      setPatchTruncated(false)
      return
    }
    const seq = ++patchSeqRef.current
    let alive = true
    setPatchLoading(true)
    setPatchError('')
    setPatch('')
    setPatchTruncated(false)
    loader(cwd, selected)
      .then((value) => {
        if (!alive || seq !== patchSeqRef.current) return
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
  }, [selected, loader, cwd, tick])

  const canDiff = loader !== undefined
  const hasTracked = (repo?.stagedCount ?? 0) + (repo?.unstagedCount ?? 0) > 0
  const showingDetail = Boolean(selected) && canDiff

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
    <PaneTools>{refreshButton}</PaneTools>
  ) : (
    <header className="changes-pane__head">
      <h2 className="changes-pane__title">{text.title}</h2>
      <div className="changes-pane__actions">
        <Badge tone="neutral">{text.readOnly}</Badge>
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
        </div>
      ) : null}
      {loading && !repo ? <p className="changes-pane__hint">{text.loading}</p> : null}
      {!loading && problem ? <p className={error ? 'changes-pane__hint changes-pane__hint--error' : 'changes-pane__hint'} role={error ? 'alert' : undefined}>{problem}</p> : null}
      {repo ? (
        <>
          {!source.entries && hasTracked ? <p className="changes-pane__hint">{text.entriesLimited}</p> : null}
          {listError ? <p className="changes-pane__hint changes-pane__hint--error" role="alert">{text.entriesFailed(listError)}</p> : null}
          {!canDiff ? <p className="changes-pane__hint">{text.noDiffChannel}</p> : null}
          {items.length === 0 ? (
            !hasTracked ? <p className="changes-pane__hint">{text.clean}</p> : null
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
