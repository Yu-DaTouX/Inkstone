import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { Folder, FolderGit2, FolderPlus, GitBranch, Link2, Lock, Search, X } from 'lucide-react'
import type { GithubAccountStatus, GithubCloneProgress, GithubCloneRequest, GithubCreateProjectResult, GithubRepoSummary } from '../../../../shared/github'
import { useI18n, type MessageKey } from '../../i18n'
import { newSessionInPickedFolder } from '../../lib/new-session-in-folder'
import { useStore } from '../../state/store'
import {
  Badge,
  Button,
  CommandSurface,
  CommandSurfaceBody,
  CommandSurfaceFooter,
  CommandSurfaceHeader,
  EmptyState,
  IconButton,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Kbd,
  ListRow,
  MiddleTruncate,
  Notice,
  ProgressBar,
  Spinner,
  usePresence
} from '../../ui'
import { shouldExecuteOnEnter } from '../commands/command-items'
import { ADD_PROJECT_SOURCES, filterSources, formatStars, urlNameOf, wrapIndex, type AddProjectSource } from './add-project-model'
import { useAddProjectPalette } from './add-project-store'
import './add-project.css'

type View = 'root' | 'new' | 'url' | 'github' | 'setup'

interface Busy {
  id: string
  kind: 'clone' | 'create'
  name: string
  progress: GithubCloneProgress | null
}

const SOURCE_ICON = { new: FolderPlus, local: Folder, url: Link2, github: GitBranch } as const
const REPO_DEBOUNCE_MS = 250
const GLOBAL_DEBOUNCE_MS = 400
const SEARCH_MIN_LENGTH = 2

export function AddProjectPalette(): ReactElement | null {
  const isOpen = useAddProjectPalette((s) => s.isOpen)
  const presence = usePresence(isOpen, { exit: 'snap' })
  return presence.present ? <AddProjectBody isOpen={isOpen} /> : null
}

function AddProjectBody({ isOpen }: { isOpen: boolean }): ReactElement {
  const { t } = useI18n()
  const setOpen = useAddProjectPalette((s) => s.setOpen)
  const [view, setView] = useState<View>('root')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState<Busy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [account, setAccount] = useState<GithubAccountStatus | null>(null)
  const [defaultDir, setDefaultDir] = useState('')
  const [parentDir, setParentDir] = useState<string | null>(null)
  const [repos, setRepos] = useState<GithubRepoSummary[]>([])
  const [owners, setOwners] = useState<string[]>([])
  const [owner, setOwner] = useState('')
  const [reposState, setReposState] = useState<'idle' | 'loading' | 'done'>('idle')
  const [hasMore, setHasMore] = useState(false)
  const [globalRepos, setGlobalRepos] = useState<GithubRepoSummary[]>([])
  const [globalState, setGlobalState] = useState<'idle' | 'loading' | 'done'>('idle')
  const globalSeq = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef<Busy | null>(null)
  const repoSeq = useRef(0)

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  const checkAccount = useCallback(async (): Promise<GithubAccountStatus> => {
    const next = await window.yan.github.account().catch(() => ({ installed: false, authed: false }) as GithubAccountStatus)
    setAccount(next)
    return next
  }, [])

  useEffect(() => {
    void checkAccount()
    void window.yan.github.defaultCloneDir().then(setDefaultDir).catch(() => undefined)
  }, [checkAccount])

  useEffect(() => {
    inputRef.current?.focus()
  }, [view, busy])

  useEffect(
    () =>
      window.yan.onPush((message) => {
        if (message.ch !== 'github-clone') return
        const progress = message.payload
        setBusy((current) => (current && current.id === progress.id ? { ...current, progress } : current))
      }),
    []
  )

  const sources = useMemo(() => filterSources(ADD_PROJECT_SOURCES, view === 'root' ? query : '', t), [query, view, t])
  const listed = useMemo(() => {
    const mine = new Set(repos.map((repo) => repo.nameWithOwner.toLowerCase()))
    const global = owner ? [] : globalRepos.filter((repo) => !mine.has(repo.nameWithOwner.toLowerCase()))
    return { items: [...repos, ...global], mineCount: repos.length }
  }, [repos, globalRepos, owner])
  const count = view === 'root' ? sources.length : view === 'github' ? listed.items.length : 0
  const safeActive = count ? Math.min(active, count - 1) : -1

  useEffect(() => {
    setActive(0)
  }, [view, query, owner])

  useEffect(() => {
    if (safeActive < 0) return
    listRef.current?.querySelector<HTMLElement>(`[data-index="${safeActive}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [safeActive])

  useEffect(() => {
    if (view !== 'github') return
    const seq = ++repoSeq.current
    setReposState('loading')
    const timer = window.setTimeout(() => {
      void window.yan.github
        .repos({ query: query.trim(), ...(owner ? { owner } : {}) })
        .then((result) => {
          if (seq !== repoSeq.current) return
          if (!result.ok) {
            const failure = result.failure?.code
            if (failure === 'not-authenticated' || failure === 'gh-missing') {
              setAccount({ installed: failure !== 'gh-missing', authed: false })
              setView('setup')
              return
            }
            setError(t('project.add.failed', { error: result.error ?? '' }))
            setRepos([])
          } else {
            setError(null)
            setRepos(result.items)
            setOwners(result.owners)
            setHasMore(result.hasMore === true)
          }
          setReposState('done')
        })
        .catch(() => {
          if (seq === repoSeq.current) setReposState('done')
        })
    }, query ? REPO_DEBOUNCE_MS : 0)
    return () => window.clearTimeout(timer)
  }, [view, query, owner, t])

  useEffect(() => {
    const term = query.trim()
    if (view !== 'github' || term.length < SEARCH_MIN_LENGTH) {
      globalSeq.current++
      setGlobalRepos([])
      setGlobalState('idle')
      return
    }
    const seq = ++globalSeq.current
    setGlobalState('loading')
    const timer = window.setTimeout(() => {
      void window.yan.github
        .searchRepos(term)
        .then((result) => {
          if (seq !== globalSeq.current) return
          setGlobalRepos(result.ok ? result.items : [])
          setGlobalState('done')
        })
        .catch(() => {
          if (seq === globalSeq.current) setGlobalState('done')
        })
    }, GLOBAL_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [view, query])

  const enter = (next: View): void => {
    setView(next)
    setQuery('')
    setError(null)
  }

  const back = (): void => {
    if (view !== 'root') enter('root')
  }

  const close = useCallback((): void => {
    const running = busyRef.current
    if (running) void window.yan.github.cancelClone(running.id)
    setOpen(false)
  }, [setOpen])

  const finish = async (cwd: string, projectId: string | undefined, trusted: boolean | undefined): Promise<void> => {
    const store = useStore.getState()
    const settings = await window.yan.getSettings()
    useStore.setState({ settings })
    const project = settings.projects.find((item) => item.id === projectId) ?? settings.projects.find((item) => item.cwd === cwd)
    setOpen(false)
    store.notify('info', t('project.add.done', { name: project?.name || cwd.split(/[\\/]/).pop() || cwd }))
    if (trusted === false) store.notify('info', t('project.add.untrusted'))
    await store.newSession({ cwd, projectId: project?.id, scope: 'project' })
  }

  const runClone = async (request: Omit<GithubCloneRequest, 'id'>, name: string): Promise<void> => {
    if (busyRef.current) return
    const id = crypto.randomUUID()
    setError(null)
    setBusy({ id, kind: 'clone', name, progress: null })
    const result = await window.yan.github.clone({ ...request, id, ...(parentDir ? { parentDir } : {}) }).catch((cause: unknown) => ({
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause)
    }) as Awaited<ReturnType<typeof window.yan.github.clone>>)
    setBusy(null)
    if (result.ok && result.cwd) {
      await finish(result.cwd, result.projectId, result.trusted)
      return
    }
    if (result.cancelled) {
      setError(t('project.add.cancelled'))
      return
    }
    if (result.failure?.code === 'not-authenticated' && request.source.kind === 'github') {
      void checkAccount()
      setView('setup')
      return
    }
    setError(t('project.add.failed', { error: [result.error, result.failure?.hint].filter(Boolean).join(' ') }))
  }

  const createProject = async (): Promise<void> => {
    const name = query.trim()
    if (!name) {
      setError(t('project.add.needName'))
      return
    }
    if (busyRef.current) return
    setError(null)
    setBusy({ id: 'create', kind: 'create', name, progress: null })
    const result = await window.yan.github.createProject(name, parentDir ?? undefined).catch((cause: unknown): GithubCreateProjectResult => ({
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause)
    }))
    setBusy(null)
    if (result.ok && result.cwd) {
      await finish(result.cwd, result.projectId, false)
      return
    }
    setError(t('project.add.failed', { error: result.error ?? '' }))
  }

  const cloneUrl = (): void => {
    const url = query.trim()
    if (!url) {
      setError(t('project.add.needUrl'))
      return
    }
    void runClone({ source: { kind: 'url', url } }, urlNameOf(url))
  }

  const pickSource = (id: AddProjectSource): void => {
    if (id === 'local') {
      setOpen(false)
      void newSessionInPickedFolder(t)
      return
    }
    if (id === 'github') {
      const ready = account?.installed && account.authed
      if (account && !ready) {
        enter('setup')
        return
      }
      enter('github')
      return
    }
    enter(id)
  }

  const chooseDir = async (): Promise<void> => {
    const picked = await window.yan.pickCwd().catch(() => null)
    if (picked) setParentDir(picked)
  }

  const confirm = (): void => {
    if (busy) return
    if (view === 'root') {
      const item = sources[safeActive]
      if (item) pickSource(item.id)
    } else if (view === 'new') void createProject()
    else if (view === 'url') cloneUrl()
    else if (view === 'github') {
      const repo = listed.items[safeActive]
      if (repo) void runClone({ source: { kind: 'github', nameWithOwner: repo.nameWithOwner } }, repo.name)
    } else if (view === 'setup') void checkAccount().then((next) => next.installed && next.authed && enter('github'))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((current) => wrapIndex(Math.max(current, 0), count, event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (event.key === 'Backspace' && !query && view !== 'root' && !busy) {
      event.preventDefault()
      back()
      return
    }
    if (shouldExecuteOnEnter({ key: event.key, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })) {
      event.preventDefault()
      confirm()
    }
  }

  const placeholder: Record<View, MessageKey> = {
    root: 'project.add.search',
    new: 'project.add.namePlaceholder',
    url: 'project.add.urlPlaceholder',
    github: 'project.add.reposSearch',
    setup: 'project.add.search'
  }
  const titleKey: Record<View, MessageKey> = {
    root: 'project.add.title',
    new: 'project.add.new',
    url: 'project.add.url',
    github: 'project.add.github',
    setup: 'project.add.github'
  }
  const needsSetup = account ? !(account.installed && account.authed) : false
  const showDir = view === 'new' || view === 'url' || view === 'github'
  const targetDir = parentDir ?? defaultDir
  const percent = busy?.progress?.percent

  return (
    <CommandSurface isOpen={isOpen} onOpenChange={(open) => (open ? setOpen(true) : close())} aria-label={t(titleKey[view])} className="apm-surface" data-testid="v3-add-project">
      <CommandSurfaceHeader>
        <InputGroup>
          <InputGroupAddon align="start">
            <Search size={16} aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label={t(titleKey[view])}
            aria-expanded="true"
            aria-controls="apm-list"
            aria-autocomplete="list"
            aria-activedescendant={safeActive >= 0 ? `apm-opt-${safeActive}` : undefined}
            placeholder={t(placeholder[view])}
            value={query}
            disabled={!!busy}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            autoComplete="off"
            spellCheck={false}
            data-testid="v3-add-project-input"
          />
          {query || reposState === 'loading' ? (
            <InputGroupAddon align="end">
              {view === 'github' && reposState === 'loading' ? <Spinner label={t('project.add.reposLoading')} size="sm" /> : null}
              {query && !busy ? (
                <IconButton size="xs" aria-label={t('project.add.key.close')} excludeFromTabOrder onPress={() => setQuery('')}>
                  <X size={14} />
                </IconButton>
              ) : null}
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </CommandSurfaceHeader>

      <CommandSurfaceBody>
        <div className="apm-title" aria-hidden="true">
          {t(titleKey[view])}
        </div>

        {view === 'github' && owners.length > 1 ? (
          <div className="apm-owners" role="group" aria-label={t('project.add.github')}>
            {['', ...owners].map((name) => (
              <Button key={name || 'all'} size="sm" variant={owner === name ? 'secondary' : 'ghost'} aria-pressed={owner === name} excludeFromTabOrder onPress={() => setOwner(name)}>
                {name || t('project.add.ownerAll')}
              </Button>
            ))}
          </div>
        ) : null}

        <div ref={listRef} id="apm-list" className="apm-list" role="listbox" aria-label={t(titleKey[view])}>
          {view === 'root'
            ? sources.length === 0
              ? <EmptyState size="sm" title={t('project.add.empty')} />
              : sources.map((item, index) => {
                  const Icon = SOURCE_ICON[item.id]
                  return (
                    <ListRow
                      key={item.id}
                      id={`apm-opt-${index}`}
                      data-index={index}
                      role="option"
                      tabIndex={-1}
                      aria-selected={index === safeActive}
                      data-active={index === safeActive ? 'true' : undefined}
                      data-selected={index === safeActive ? '' : undefined}
                      hoverHighlight={false}
                      className="apm-option"
                      icon={<Icon size={16} />}
                      description={t(item.description)}
                      trailing={item.id === 'github' && needsSetup ? <Badge tone="ask">{t('project.add.needSetup')}</Badge> : undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => setActive(index)}
                      onClick={() => pickSource(item.id)}
                      data-testid={`v3-add-project-${item.id}`}
                    >
                      {t(item.title)}
                    </ListRow>
                  )
                })
            : null}

          {view === 'github'
            ? listed.items.length === 0
              ? <EmptyState size="sm" title={reposState === 'loading' ? t('project.add.reposLoading') : t('project.add.reposEmpty')} />
              : listed.items.map((repo, index) => (
                  <Fragment key={repo.nameWithOwner}>
                    {index === 0 && listed.mineCount > 0 ? <div className="apm-group" aria-hidden="true">{t('project.add.groupMine')}</div> : null}
                    {index === listed.mineCount ? <div className="apm-group" aria-hidden="true">{t('project.add.groupGlobal')}</div> : null}
                    <ListRow
                      id={`apm-opt-${index}`}
                      data-index={index}
                      role="option"
                      tabIndex={-1}
                      aria-selected={index === safeActive}
                      data-active={index === safeActive ? 'true' : undefined}
                      data-selected={index === safeActive ? '' : undefined}
                      hoverHighlight={false}
                      className="apm-option"
                      icon={repo.isPrivate ? <Lock size={16} /> : <FolderGit2 size={16} />}
                      description={repo.description || undefined}
                      trailing={
                        <>
                          {repo.stars !== undefined ? <span className="apm-stars" title={t('project.add.stars')}>{'\u2605'} {formatStars(repo.stars)}</span> : null}
                          {repo.isPrivate ? <Badge>{t('project.add.private')}</Badge> : null}
                        </>
                      }
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => setActive(index)}
                      onClick={() => void runClone({ source: { kind: 'github', nameWithOwner: repo.nameWithOwner } }, repo.name)}
                      data-testid={index < listed.mineCount ? 'v3-add-project-repo' : 'v3-add-project-global-repo'}
                    >
                      {repo.nameWithOwner}
                    </ListRow>
                  </Fragment>
                ))
            : null}

          {view === 'github' && globalState === 'loading' && listed.items.length > 0 ? <p className="apm-hint">{t('project.add.globalSearching')}</p> : null}

          {view === 'github' && hasMore ? <p className="apm-hint">{t('project.add.reposMore')}</p> : null}

          {view === 'setup' ? (
            <div className="apm-setup" data-testid="v3-add-project-setup">
              <span className="apm-setup__title">{account && !account.installed ? t('project.add.setupMissing') : account?.error ? t('project.add.failed', { error: account.error }) : `${t('project.add.setupTitle')} · ${t('project.add.setupLoggedOut')}`}</span>
              <code className="apm-code">gh auth login</code>
              <Button size="sm" variant="ghost" onPress={() => void navigator.clipboard?.writeText('gh auth login').catch(() => undefined)} data-testid="v3-add-project-copy">
                {t('project.add.copy')}
              </Button>
              <Button size="sm" variant="secondary" onPress={confirm} data-testid="v3-add-project-recheck">
                {t('project.add.retry')}
              </Button>
            </div>
          ) : null}
        </div>

        {showDir && targetDir ? (
          <div className="apm-dir">
            <MiddleTruncate value={t('project.add.targetDir', { path: targetDir })} className="apm-dir__path" />
            <Button size="sm" variant="ghost" excludeFromTabOrder isDisabled={!!busy} onPress={() => void chooseDir()}>
              {t('project.add.changeDir')}
            </Button>
          </div>
        ) : null}
      </CommandSurfaceBody>

      {busy ? (
        <div className="apm-busy" role="status" data-testid="v3-add-project-busy">
          <ProgressBar
            aria-label={busy.kind === 'clone' ? t('project.add.cloning', { name: busy.name }) : t('project.add.creating')}
            label={busy.kind === 'clone' ? t('project.add.cloning', { name: busy.name }) : t('project.add.creating')}
            isIndeterminate={percent === undefined}
            value={percent ?? 0}
            showValue={percent !== undefined}
          />
          <span className="apm-busy__phase">{t(`project.add.phase.${busy.progress?.phase ?? 'starting'}` as MessageKey)}</span>
          {busy.kind === 'clone' ? (
            <Button size="sm" variant="ghost" onPress={() => void window.yan.github.cancelClone(busy.id)} data-testid="v3-add-project-cancel">
              {t('project.add.cancel')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <Notice tone="fail" compact className="apm-error" data-testid="v3-add-project-error">
          {error}
        </Notice>
      ) : null}

      <CommandSurfaceFooter aria-hidden="true" className="apm-foot">
        <span className="apm-foot__item">
          <Kbd>↑↓</Kbd>
          {t('project.add.key.select')}
        </span>
        <span className="apm-foot__item">
          <Kbd>Enter</Kbd>
          {t('project.add.key.confirm')}
        </span>
        <span className="apm-foot__item">
          <Kbd>Backspace</Kbd>
          {t('project.add.key.back')}
        </span>
        <span className="apm-foot__item">
          <Kbd>Esc</Kbd>
          {t('project.add.key.close')}
        </span>
      </CommandSurfaceFooter>
    </CommandSurface>
  )
}
