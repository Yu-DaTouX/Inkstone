import { useEffect, useRef, useState } from 'react'
import type {
  ForkRefsReportView,
  GitActionResult,
  GitRefOption,
  WorktreeBlocker,
  WorktreeInfo,
  WorktreeLinkView
} from '../../../../shared/ipc'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useConfirm } from '../ui/confirm'
import { useStore } from '../../state/store'
import { compareWebUrl } from '../../../../shared/git'
import { shortProject } from '../rail/rail-utils'
import { SourceMenu } from './SourceMenu'
import { WriteFailure } from './CommitBar'
import { useGitWrite, useRepoState } from './useGitReview'

export function EnvironmentMenu() {
  const t = useT()
  const confirm = useConfirm()
  const session = useStore((s) => s.session)
  const settings = useStore((s) => s.settings)
  const project = session?.cwd ?? settings?.cwd
  const patchSettings = useStore((s) => s.patchSettings)
  const newSession = useStore((s) => s.newSession)
  const changeCwd = useStore((s) => s.changeCwd)
  const repoView = useRepoState(project)

  const prText = (): string => {
    if (pr === null) return t('pr.querying')
    if (!pr.ok) {
      if (pr.error === 'auth') return t('pr.err.auth')
      if (pr.error === 'rate-limit') return t('pr.err.rate-limit')
      if (pr.error === 'network') return t('pr.err.network')
      if (pr.error === 'not-found') return t('pr.err.not-found')
      if (pr.error === 'unsupported') return t('pr.err.unsupported')
      return t('pr.err.unknown')
    }
    if (pr.state === 'none') return t('pr.none')
    const head =
      pr.state === 'merged' ? t('pr.merged') : pr.state === 'closed' ? t('pr.closed') : pr.state === 'draft' ? t('pr.draft') : t('pr.open')
    const checks =
      pr.checks === 'pending'
        ? ' · ' + t('pr.checks.pending')
        : pr.checks === 'success'
          ? ' · ' + t('pr.checks.success')
          : pr.checks === 'failure'
            ? ' · ' + t('pr.checks.failure')
            : ''
    return head + checks + (pr.localAhead ? ' · ' + t('pr.localAhead') : '')
  }
  const repo = repoView.repo
  const write = useGitWrite(project, (res: GitActionResult) => {
    if (!res.ok) return
    if (res.state) repoView.apply(res.state)
    repoView.refresh()
  })

  const [open, setOpen] = useState(false)
  const [showBranches, setShowBranches] = useState(false)
  const [refs, setRefs] = useState<GitRefOption[]>([])
  const [busyBranches, setBusyBranches] = useState<string[]>([])
  const [newBranch, setNewBranch] = useState('')
  const [showWorktrees, setShowWorktrees] = useState(false)
  const [trees, setTrees] = useState<WorktreeInfo[]>([])
  const [trustMap, setTrustMap] = useState<Record<string, { trusted: boolean; entry: string | null }>>({})
  const [forkRefs, setForkRefs] = useState<Record<string, ForkRefsReportView>>({})
  const [origins, setOrigins] = useState<WorktreeLinkView[]>([])
  const myOrigin = session?.sessionId ? origins.find((x) => x.sessionId === session.sessionId) : undefined
  const [wtBranch, setWtBranch] = useState('')
  const [wtPath, setWtPath] = useState('')
  const [wtDeleteBranch, setWtDeleteBranch] = useState(false)
  const [actionError, setActionError] = useState('')
  const [wtBlockers, setWtBlockers] = useState<WorktreeBlocker[]>([])
  const [webRepo, setWebRepo] = useState<string | null>(null)
  const [pr, setPr] = useState<{
    ok: boolean
    state: string
    checks: string
    title?: string
    number?: number
    url?: string
    localAhead?: boolean
    error?: string
    message?: string
  } | null>(null)
  const [carryStaged, setCarryStaged] = useState(false)
  const [carryUnstaged, setCarryUnstaged] = useState(false)
  const [pickOpen, setPickOpen] = useState(false)
  const [untracked, setUntracked] = useState<{ path: string; size: number }[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const wrapRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  useEffect(() => {
    if (!open || !showBranches || !project) return
    let alive = true
    void window.yan.git
      .refs(project)
      .then((res) => {
        if (!alive) return
        setRefs(res.refs.filter((r) => r.kind === 'local' || r.kind === 'head'))
        setBusyBranches(res.busyBranches)
      })
      .catch(() => {
      })
    return () => {
      alive = false
    }
  }, [open, showBranches, project])

  useEffect(() => {
    if (!open) return
    let alive = true
    void window.yan.git
      .worktreeLinks()
      .then((res) => {
        if (alive) setOrigins(Array.isArray(res) ? res : [])
      })
      .catch(() => {
      })
    return () => {
      alive = false
    }
  }, [open])

  useEffect(() => {
    if (!open || !showWorktrees || !project) return
    let alive = true
    void window.yan.git
      .worktrees(project)
      .then((res) => {
        if (alive) setTrees(res.worktrees ?? [])
      })
      .catch(() => {
      })
    return () => {
      alive = false
    }
  }, [open, showWorktrees, project, repoView.repo?.worktreeId])

  useEffect(() => {
    if (!pickOpen || !project) return
    let alive = true
    void window.yan.git
      .untracked(project)
      .then((paths) => {
        if (!alive) return
        setUntracked(paths.map((path) => ({ path, size: 0 })))
      })
      .catch((e: unknown) => {
        if (alive) {
          setUntracked([])
          setWtBlockers([{ kind: 'missing', message: e instanceof Error ? e.message : String(e) }])
        }
      })
  }, [pickOpen, project])

  useEffect(() => {
    if (!open || !project) return
    let alive = true
    setPr(null)
    void window.yan.git
      .prStatus(project)
      .then((res) => {
        if (alive) setPr(res)
      })
      .catch((e: unknown) => {
        if (alive) setPr({ ok: false, state: 'none', checks: 'none', error: 'unknown', message: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      alive = false
    }
  }, [open, project, repoView.repo?.head])

  useEffect(() => {
    if (!open || !project) return
    let alive = true
    void window.yan.git
      .remoteWeb(project)
      .then((res) => {
        if (alive) setWebRepo(res.ok ? (res.web ?? null) : null)
      })
      .catch(() => {
        if (alive) setWebRepo(null)
      })
    return () => {
      alive = false
    }
  }, [open, project, repoView.repo?.head])

  useEffect(() => {
    if (!open || !showWorktrees) return
    const targets = trees.filter((w) => !w.main).map((w) => w.path)
    if (!targets.length) return
    let alive = true
    void Promise.all(
      targets.map((p) =>
        window.yan.trust
          .status(p)
          .then((st) => [p, { trusted: st.trusted, entry: st.entry }] as const)
          .catch(() => null)
      )
    ).then((rows) => {
      if (!alive) return
      const next: Record<string, { trusted: boolean; entry: string | null }> = {}
      for (const row of rows) if (row) next[row[0]] = row[1]
      setTrustMap(next)
    })
    return () => {
      alive = false
    }
  }, [open, showWorktrees, trees])

  useEffect(() => {
    if (!open || !showWorktrees) return
    const targets = trees.filter((w) => !w.main).map((w) => w.path)
    if (!targets.length) return
    let alive = true
    void Promise.all(
      targets.map((p) =>
        window.yan.git
          .forkFileRefs({ worktree: p, sourceFile: session?.sessionFile, sourceCwd: session?.cwd })
          .then((report) => [p, report] as const)
          .catch(() => null)
      )
    ).then((rows) => {
      if (!alive) return
      const next: Record<string, ForkRefsReportView> = {}
      for (const row of rows) if (row) next[row[0]] = row[1]
      setForkRefs(next)
    })
    return () => {
      alive = false
    }
  }, [open, showWorktrees, trees, session?.sessionId, session?.sessionFile, session?.cwd])

  useEffect(() => {
    if (open) firstRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) {
      setShowBranches(false)
      setNewBranch('')
      setShowWorktrees(false)
      setWtDeleteBranch(false)
      setActionError('')
      setWtBlockers([])
      setPickOpen(false)
      setPicked([])
    }
  }, [open])

  const changed = repo?.changedCount ?? 0

  const forkRefsTip = (report: ForkRefsReportView): string => {
    const problems = report.summary.problems
    if (!problems.length) return t('env.forkRefsAllOk')
    return problems
      .map(
        (item) =>
          `${item.state === 'outside' ? t('env.forkRefsOutside') : item.state === 'missing' ? t('env.forkRefsMissing') : t('env.forkRefsMismatch')} · ${item.ref}`
      )
      .join('\n')
  }
  const branchLabel = repo?.detached
    ? t('env.detached')
    : repo?.unborn
      ? t('env.noCommit')
      : (repo?.branch ?? t('env.detached'))

  return (
    <div className={`env-wrap ${open ? 'open' : ''}`} ref={wrapRef} data-testid="env-wrap">
      <button
        type="button"
        className={`shead-proj env-trigger ${project ? '' : 'none'}`}
        title={project ?? t('header.noProject')}
        data-testid="session-project"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={project ? 'folder' : 'folder-open'} size={12} className="shead-proj-ico" />
        <span className="shead-proj-name">{project ? shortProject(project) : t('header.noProject')}</span>
        <Icon name="chevron-right" size={12} className="chev env-caret" />
      </button>

      {open ? (
        <div className="env-menu" role="menu" data-testid="env-menu" aria-label={t('env.title')}>
          <div className="env-project" data-testid="env-local" title={project ?? ''}>
            <span className="env-project-ico" aria-hidden="true">
              <Icon name="folder" size={16} />
            </span>
            <span className="env-project-meta">
              <span className="env-project-name">{project ? shortProject(project) : t('header.noProject')}</span>
              {project ? <span className="env-project-path">{project}</span> : null}
            </span>
            {project ? (
              <span className="env-project-actions">
                <button
                  type="button"
                  ref={firstRef}
                  className="env-mini"
                  data-testid="env-open-folder"
                  title={t('env.openFolder')}
                  onClick={() => {
                    void window.yan.openPath(project).then((result) => { if (!result.ok) setActionError(result.error || t('env.openFolder')) }).catch((cause) => setActionError(cause instanceof Error ? cause.message : String(cause)))
                  }}
                >
                  {t('env.open')}
                </button>
                <button
                  type="button"
                  className="env-mini"
                  data-testid="env-copy-path"
                  title={t('env.copyPath')}
                  onClick={() => {
                    void navigator.clipboard?.writeText(project).catch((cause) => setActionError(cause instanceof Error ? cause.message : String(cause)))
                  }}
                >
                  {t('env.copy')}
                </button>
              </span>
            ) : null}
          </div>

          {repo ? (
            <>
              <div className="env-group">
              <div className="env-item env-static" data-testid="env-changes">
                <Icon name="history" size={14} />
                <span className="env-label">{t('env.changes')}</span>
                <span className="env-count" data-testid="env-changes-count">
                  {changed === 0 ? (
                    <span className="env-none">{t('env.noChanges')}</span>
                  ) : (
                    <>
                      <span className="env-dots" aria-hidden="true">
                        {Array.from({ length: 10 }, (_, i) => (
                          <i key={i} className={i < changed ? 'on' : i < changed + repo.untrackedCount ? 'new' : ''} />
                        ))}
                      </span>
                      <span className="env-num">{changed}</span>
                      {repo.untrackedCount > 0 ? (
                        <span className="env-num env-untracked" title={t('env.untracked')}>
                          +{repo.untrackedCount}
                        </span>
                      ) : null}
                    </>
                  )}
                </span>
              </div>

              <button
                type="button"
                role="menuitem"
                className="env-item"
                data-testid="env-branch"
                aria-expanded={showBranches}
                onClick={() => setShowBranches((v) => !v)}
              >
                <Icon name="branch" size={14} />
                <span className="env-label env-mono">{branchLabel}</span>
                {repo.ahead > 0 || repo.behind > 0 ? (
                  <span className="env-sub env-ab">
                    {repo.ahead > 0 ? `↑${repo.ahead}` : ''}
                    {repo.behind > 0 ? `↓${repo.behind}` : ''}
                  </span>
                ) : null}
                <Icon name="chevron-right" size={12} className={`env-caret ${showBranches ? 'open' : ''}`} />
              </button>

              {showBranches ? (
                <div className="env-branches" data-testid="env-branches">
                  {refs.map((r) => {
                    const inUse = busyBranches.includes(r.ref)
                    const isCurrent = r.ref === repo.branch
                    return (
                      <button
                        key={r.ref}
                        type="button"
                        className={`env-branch ${isCurrent ? 'current' : ''}`}
                        data-testid="env-branch-item"
                        disabled={!!write.busy || isCurrent || inUse}
                        title={inUse ? t('env.branchInUse') : r.ref}
                        onClick={() => {
                          if (!repoView.expected) return
                          void write.run({ kind: 'switch-branch', branch: r.ref }, repoView.expected)
                        }}
                      >
                        <span className="env-branch-name">{r.ref}</span>
                        {isCurrent ? <span className="env-branch-tag">{t('env.branchCurrent')}</span> : null}
                        {inUse ? <span className="env-branch-tag warn">{t('env.branchInUse')}</span> : null}
                      </button>
                    )
                  })}

                  <div className="env-newbranch">
                    <input
                      className="env-branch-input"
                      data-testid="env-new-branch-name"
                      placeholder={t('env.branchName')}
                      value={newBranch}
                      spellCheck={false}
                      onChange={(e) => setNewBranch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' || !newBranch.trim() || !repoView.expected) return
                        void write.run(
                          { kind: 'create-branch', branch: newBranch.trim(), startPoint: null, checkout: true },
                          repoView.expected
                        )
                      }}
                    />
                    <button
                      type="button"
                      className="env-mini"
                      data-testid="env-create-branch"
                      disabled={!!write.busy || !newBranch.trim() || !repoView.expected}
                      title={t('env.createAndSwitch')}
                      onClick={() => {
                        if (!repoView.expected) return
                        void write.run(
                          { kind: 'create-branch', branch: newBranch.trim(), startPoint: null, checkout: true },
                          repoView.expected
                        )
                      }}
                    >
                      {t('env.createAndSwitch')}
                    </button>
                  </div>

                  {write.busy === 'switch-branch' || write.busy === 'create-branch' ? (
                    <div className="env-sub">{t('env.checking')}</div>
                  ) : null}
                </div>
              ) : null}
              </div>

              <div className="env-group env-sync">
              <button
                type="button"
                role="menuitem"
                className="env-item"
                data-testid="env-fetch"
                disabled={!!write.busy || !repoView.expected}
                title={repo.upstream ? `${t('env.fetch')} ${repo.upstream.split('/')[0]}` : t('env.fetch')}
                onClick={() => {
                  if (!repoView.expected) return
                  void write.run({ kind: 'fetch', remote: null }, repoView.expected)
                }}
              >
                <Icon name="refresh" size={14} />
                <span className="env-label">{t('env.fetch')}</span>
                <span className="env-sub">{repo.upstream ? repo.upstream.split('/')[0] : ''}</span>
              </button>

              <button
                type="button"
                role="menuitem"
                className="env-item"
                data-testid="env-push"
                disabled={!!write.busy || !repoView.expected}
                title={[repo.upstream || t('commit.noUpstream'), repo.unpushedCount ? t('env.pushN', { n: repo.unpushedCount }) : ''].filter(Boolean).join(' · ')}
                onClick={async () => {
                  if (!repoView.expected) return
                  if (!repo.upstream && !(await confirm({ title: t('commit.setUpstream'), body: t('commit.setUpstreamHint'), detail: `origin/${repo.branch ?? t('env.detached')}`, confirmLabel: t('commit.setUpstream') }))) return
                  void write.run(
                    {
                      kind: 'push',
                      remote: null,
                      branch: repo.branch,
                      setUpstream: !repo.upstream
                    },
                    repoView.expected
                  )
                }}
              >
                <Icon name="send" size={14} />
                <span className="env-label">{t('env.push')}</span>
                <span className="env-sub env-ab">
                  {repo.unpushedCount === null
                    ? t('commit.setUpstream')
                    : repo.unpushedCount > 0
                      ? `↑${repo.unpushedCount}`
                      : ''}
                </span>
              </button>
              </div>

              <div className="env-group">
              <button
                type="button"
                role="menuitem"
                className="env-item"
                data-testid="env-worktrees"
                aria-expanded={showWorktrees}
                onClick={() => setShowWorktrees((v) => !v)}
              >
                <Icon name="folder-open" size={14} />
                <span className="env-label">{t('env.worktrees')}</span>
                <span className="env-sub">{trees.length > 1 ? String(trees.length) : ''}</span>
                <Icon name="chevron-right" size={12} className={`env-caret ${showWorktrees ? 'open' : ''}`} />
              </button>

              {showWorktrees ? (
                <div className="env-branches env-worktrees" data-testid="env-worktree-list">
                  {myOrigin ? (
                    <div className="env-carry-hint" data-testid="env-worktree-origin">
                      {t('env.worktreeOrigin', {
                        name: myOrigin.branch || t('env.detached'),
                        dir: myOrigin.worktree
                      })}
                    </div>
                  ) : null}
                  {trees.map((w) => (
                    <div className="env-worktree" key={w.path}>
                      <span className="env-branch-name" title={w.path}>
                        {w.branch ?? t('env.detached')}
                      </span>
                      {w.main ? <span className="env-branch-tag">{t('env.worktreeMain')}</span> : null}
                      {!w.main && w.ours ? <span className="env-branch-tag">{t('env.worktreeOurs')}</span> : null}
                      {!w.main ? (
                        trustMap[w.path]?.trusted ? (
                          <>
                            <span className="env-branch-tag" data-testid="env-worktree-trusted">{t('env.trusted')}</span>
                            <button type="button" className="env-mini" title={t('env.trustRevokeNote')} onClick={async () => {
                              if (!(await confirm({ title: t('env.trustRevoke'), body: t('env.trustRevokeNote'), detail: w.path, confirmLabel: t('env.trustRevoke'), tone: 'danger' }))) return
                              void window.yan.trust.revoke(w.path).then((result) => {
                                if (result.ok) {
                                  setTrustMap((map) => ({ ...map, [w.path]: { trusted: false, entry: result.entry } }))
                                  setActionError(t('env.trustRevokeNote'))
                                } else setActionError(result.error || t('env.trustRevoke'))
                              }).catch((error) => setActionError(error instanceof Error ? error.message : String(error)))
                            }}>{t('env.trustRevoke')}</button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="env-mini"
                            data-testid="env-worktree-trust"
                            title={t('env.trustAllowNote')}
                            onClick={async () => {
                              if (!(await confirm({ title: t('env.trustAllow'), body: t('env.trustAllowNote'), detail: w.path, confirmLabel: t('env.trustAllow') }))) return
                              setActionError('')
                              void window.yan.trust.allow(w.path).then((res) => {
                                if (res?.ok) setTrustMap((m) => ({ ...m, [w.path]: { trusted: true, entry: res.entry } }))
                                else setActionError(res?.error || t('env.trustAllowNote'))
                              }).catch((cause) => setActionError(cause instanceof Error ? cause.message : String(cause)))
                            }}
                          >
                            {t('env.trustAllow')}
                          </button>
                        )
                      ) : null}
                      {!w.main ? (
                        <>
                        <button
                          type="button"
                          className="env-mini"
                          data-testid="env-worktree-open"
                          title={t('env.worktreeOpenNote')}
                          onClick={() => {
                            void (async () => {
                              setActionError('')
                              let succeeded = false
                              try {
                              const before = useStore.getState().session
                              await changeCwd(w.path)
                              const made = await newSession({ cwd: w.path })
                              if (!made.ok || !made.sessionId) throw new Error(made.error || t('env.worktreeOpenNote'))
                              if (made.sessionId) {
                                await window.yan.git
                                  .worktreeLink({
                                    sessionId: made.sessionId,
                                    worktree: w.path,
                                    branch: w.branch ?? '',
                                    fromSessionId: before?.sessionId ?? '',
                                    fromSessionFile: before?.sessionFile ?? '',
                                    fromCwd: before?.cwd ?? ''
                                  })
                                  .catch(() => undefined)
                                await window.yan.git
                                  .forkContext({
                                    worktree: w.path,
                                    sourceFile: before?.sessionFile,
                                    sourceCwd: before?.cwd,
                                    sourceSessionId: before?.sessionId
                                  })
                                  .then((ctx) => {
                                    if (ctx?.text) useStore.getState().injectComposerText(ctx.text)
                                  })
                                  .catch(() => undefined)
                              }
                              succeeded = true
                              if (succeeded) setOpen(false)
                              } catch (cause) {
                                setActionError(cause instanceof Error ? cause.message : String(cause))
                              }
                            })()
                          }}
                        >
                          {t('env.worktreeOpen')}
                        </button>
                        <button
                          type="button"
                          className="env-mini"
                          data-testid="env-worktree-remove"
                          disabled={!!write.busy}
                          onClick={async () => {
                            const deleteBranch = wtDeleteBranch
                            if (!(await confirm({ title: t('env.worktreeRemove'), body: `${t('env.worktreeRemoveNote')}${deleteBranch ? `\n${t('env.worktreeDeleteBranch')}` : ''}`, detail: w.path, confirmLabel: t('env.worktreeRemove'), tone: 'danger' }))) return
                            setWtDeleteBranch(false)
                            setWtBlockers([])
                            void window.yan.git
                              .worktreeRemove({ cwd: project ?? '', path: w.path, deleteBranch })
                              .then((res) => {
                                if (res.ok) {
                                  setTrees((prev) => prev.filter((x) => x.path !== w.path))
                                  repoView.refresh()
                                  return
                                }
                                setWtBlockers(res.blockers ?? [])
                                if (!res.blockers?.length && res.failure) {
                                  setWtBlockers([{ kind: 'missing', message: res.failure.message }])
                                }
                              })
                              .catch((e: unknown) =>
                                setWtBlockers([{ kind: 'missing', message: e instanceof Error ? e.message : String(e) }])
                              )
                          }}
                        >
                          {t('env.worktreeRemove')}
                        </button>
                        </>
                      ) : null}
                      {!w.main && (forkRefs[w.path]?.summary.total ?? 0) > 0 ? (
                        <div className="env-fork-refs" data-testid="env-fork-refs" title={forkRefsTip(forkRefs[w.path])}>
                          {t('env.forkRefs', {
                            total: String(forkRefs[w.path].summary.total),
                            resolved: String(forkRefs[w.path].summary.resolved)
                          })}
                          {forkRefs[w.path].summary.problems.length > 0
                            ? ' · ' + t('env.forkRefsProblems', { n: String(forkRefs[w.path].summary.problems.length) })
                            : ''}
                        </div>
                      ) : null}
                    </div>
                  ))}

                  {trees.some((w) => !w.main) ? (
                    <div className="env-carry-hint env-fork-note" data-testid="env-worktree-open-note">
                      <div className="env-fork-title">{t('env.worktreeForkTitle')}</div>
                      <div className="env-fork-carry" data-testid="env-worktree-fork-carry">
                        {t('env.worktreeForkCarry')}
                      </div>
                      <div className="env-fork-skip" data-testid="env-worktree-fork-skip">
                        {t('env.worktreeForkSkip')}
                      </div>
                    </div>
                  ) : null}

                  <label className="env-wt-check">
                    <input
                      type="checkbox"
                      checked={wtDeleteBranch}
                      data-testid="env-worktree-delete-branch"
                      onChange={(e) => setWtDeleteBranch(e.target.checked)}
                    />
                    <span>{t('env.worktreeDeleteBranch')}</span>
                  </label>

                  <div className="env-newbranch">
                    <input
                      className="env-branch-input"
                      data-testid="env-worktree-branch"
                      placeholder={t('env.worktreeBranch')}
                      value={wtBranch}
                      spellCheck={false}
                      onChange={(e) => setWtBranch(e.target.value)}
                    />
                    <button
                      type="button"
                      className="env-mini"
                      data-testid="env-worktree-create"
                      disabled={!!write.busy || !wtBranch.trim()}
                      onClick={() => {
                        setWtBlockers([])
                        void window.yan.git
                          .worktreeCreate({
                            cwd: project ?? '',
                            branch: wtBranch.trim(),
                            startPoint: null,
                            targetPath: wtPath.trim() || null,
                            carry:
                              carryStaged || carryUnstaged || picked.length > 0
                                ? { staged: carryStaged, unstaged: carryUnstaged, untracked: picked }
                                : null
                          })
                          .then((res) => {
                            const made = res.ok ? res.path : undefined
                            if (!made) {
                              setWtBlockers([{ kind: 'missing', message: res.failure?.message ?? '工作树创建失败' }])
                              return
                            }
                            if (made) {
                              setTrees((prev) => [
                                ...prev,
                                {
                                  path: made,
                                  head: '',
                                  branch: res.branch ?? null,
                                  bare: false,
                                  main: false,
                                  locked: false,
                                  prunable: false,
                                  ours: true
                                }
                              ])
                              setWtBranch('')
                              setWtPath('')
                              setCarryStaged(false)
                              setCarryUnstaged(false)
                              setPickOpen(false)
                              setPicked([])
                              repoView.refresh()
                              const known = settings?.projects ?? []
                              const samePath = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
                              if (!known.some((x) => samePath(x.cwd, made))) {
                                const now = Date.now()
                                void patchSettings({
                                  projects: [
                                    ...known,
                                    {
                                      id: `wt-${now.toString(36)}`,
                                      cwd: made,
                                      name: res.branch ?? made.split(/[\/]/).pop() ?? made,
                                      archived: false,
                                      createdAt: now,
                                      updatedAt: now
                                    }
                                  ]
                                }).catch((cause) => setWtBlockers([{ kind: 'missing', message: cause instanceof Error ? cause.message : String(cause) }]))
                              }
                            }
                          })
                          .catch((e: unknown) => {
                            setWtBlockers([{ kind: 'missing', message: e instanceof Error ? e.message : String(e) }])
                          })
                      }}
                    >
                      {t('env.worktreeCreate')}
                    </button>
                  </div>
                  <input
                    className="env-branch-input env-wt-path"
                    data-testid="env-worktree-path"
                    placeholder={t('env.worktreePath')}
                    value={wtPath}
                    spellCheck={false}
                    onChange={(e) => setWtPath(e.target.value)}
                  />

                  <div className="env-carry" data-testid="env-carry">
                    <label className="env-wt-check">
                      <input
                        type="checkbox"
                        checked={carryStaged}
                        data-testid="env-carry-staged"
                        onChange={(e) => setCarryStaged(e.target.checked)}
                      />
                      <span>{t('env.carryStaged')}</span>
                    </label>
                    <label className="env-wt-check">
                      <input
                        type="checkbox"
                        checked={carryUnstaged}
                        data-testid="env-carry-unstaged"
                        onChange={(e) => setCarryUnstaged(e.target.checked)}
                      />
                      <span>{t('env.carryUnstaged')}</span>
                    </label>
                    <label className="env-wt-check">
                      <input
                        type="checkbox"
                        checked={pickOpen}
                        data-testid="env-carry-untracked"
                        onChange={(e) => {
                          setPickOpen(e.target.checked)
                          if (!e.target.checked) setPicked([])
                        }}
                      />
                      <span>
                        {t('env.carryUntracked')}
                        {picked.length > 0 ? `（${picked.length}）` : ''}
                      </span>
                    </label>

                    {pickOpen ? (
                      <div className="env-carry-list" data-testid="env-carry-list">
                        {untracked.length === 0 ? (
                          <div className="env-branch-tag">{t('env.carryNone')}</div>
                        ) : (
                          untracked.slice(0, 40).map((f) => (
                            <label className="env-wt-check env-carry-file" key={f.path}>
                              <input
                                type="checkbox"
                                data-testid="env-carry-file"
                                checked={picked.includes(f.path)}
                                onChange={(e) =>
                                  setPicked((prev) => (e.target.checked ? [...prev, f.path] : prev.filter((x) => x !== f.path)))
                                }
                              />
                              <span title={f.path}>{f.path}</span>
                            </label>
                          ))
                        )}
                        {untracked.length > 40 ? (
                          <div className="env-branch-tag">{t('env.carryMore', { n: untracked.length - 40 })}</div>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="env-carry-hint">{t('env.carryNote')}</div>
                  </div>

                  {wtBlockers.length ? (
                    <div className="gwrite-fail" data-testid="env-worktree-blockers">
                      <div className="gwrite-fail-line">
                        <Icon name="alert-circle" size={12} />
                        <span className="gwrite-fail-msg">{t('env.worktreeBlocked')}</span>
                      </div>
                      {wtBlockers.map((b) => (
                        <div className="gwrite-fail-hint" key={`${b.kind}-${b.message}`}>
                          {b.message}
                          {typeof b.count === 'number' ? `（${b.count}）` : ''}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <button
                type="button"
                role="menuitem"
                className="env-item"
                data-testid="env-pr"
                title={pr?.message ?? pr?.title ?? ''}
                onClick={() => {
                  if (pr?.url) {
                    void window.yan.browser.open(pr.url).catch((cause) => setActionError(cause instanceof Error ? cause.message : String(cause)))
                  }
                }}
              >
                <Icon name="pull-request" size={14} />
                <span className="env-label">{t('env.pr')}</span>
                <span className="env-sub" data-testid="env-pr-state">
                  {prText()}
                </span>
              </button>


              {webRepo && repo.upstream && repo.branch ? (
                <button
                  type="button"
                  role="menuitem"
                  className="env-item"
                  data-testid="env-compare-web"
                  onClick={() => {
                    const link = compareWebUrl(webRepo, repo.upstream ?? '', repo.branch ?? '')
                    if (!link) return
                    void window.yan.browser.open(link).catch((cause) => setActionError(cause instanceof Error ? cause.message : String(cause)))
                  }}
                >
                  <Icon name="globe" size={14} />
                  <span className="env-label">{t('env.compareWeb')}</span>
                  <span className="env-sub">{new URL(webRepo).host}</span>
                </button>
              ) : null}
              </div>

              <SourceMenu sessionId={session?.sessionId ?? 'default'} open={open} onClose={() => setOpen(false)} />
            </>
          ) : (
            <div className="env-item env-static" data-testid="env-notgit" title={t('env.notGitHint')}>
              <Icon name="folder" size={14} />
              <span className="env-label">{t('env.notGit')}</span>
              <span className="env-sub">{repoView.loading ? t('env.checking') : t('env.notGitHint')}</span>
            </div>
          )}

          {repoView.error ? <div className="env-error">{repoView.error}</div> : null}
          {actionError ? <div className="env-error" role="alert" data-testid="env-action-error">{actionError}</div> : null}

          {write.failure ? (
            <WriteFailure msg={write.failure.message} hint={write.failure.hint} detail={write.failure.detail} />
          ) : null}
          {write.notice ? (
            <div className="gwrite-ok" data-testid="env-notice">
              <Icon name="check-circle" size={12} />
              <span>{write.notice}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
