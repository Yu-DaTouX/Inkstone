import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { ExternalLink, GitPullRequest, RefreshCw, Upload } from 'lucide-react'
import type { CollabLocalProject, CollabRemoteBranchView } from '../../../../shared/collab'
import { githubBranchName, isGithubLogin, isPublishBranchName, mergeChannels, type CollabChannelRow } from '../../../../shared/collab-github'
import type { GithubAccountStatus, GithubBranchListResult } from '../../../../shared/github'
import type { Lang } from '../../i18n'
import { useStore } from '../../state/store'
import { Badge, Button, Checkbox, ConfirmDialog, MiddleTruncate, Notice, TextArea, TextField } from '../../ui'
import { fill } from './collab-text'
import { githubChannelText } from './github-channel-text'
import './github-channel.css'

type Tone = 'info' | 'fail'

interface GithubChannelProps {
  lang: Lang
  peerId: string
  peerComputer: string
  localProject: CollabLocalProject | null
  branches: CollabRemoteBranchView[]
  notify: (tone: Tone, text: string) => void
  onChanged: () => Promise<unknown>
}

interface PublishDraft {
  row: CollabChannelRow
  trackingRef: string
  branch: string
  base: string
  title: string
  body: string
  draft: boolean
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: GithubBranchListResult; login: string; base: string; repo: string }
  | { status: 'blocked'; reason: 'login' | 'missing' | 'error'; message: string }

export function GithubChannel({ lang, peerId, peerComputer, localProject, branches, notify, onChanged }: GithubChannelProps): ReactElement {
  const text = githubChannelText(lang)
  const [state, setState] = useState<LoadState>({ status: 'idle' })
  const [draft, setDraft] = useState<PublishDraft | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const savedLogin = useStore((s) => s.settings?.peerGithubLogins?.[peerId] ?? '')
  const patchSettings = useStore((s) => s.patchSettings)
  const [loginDraft, setLoginDraft] = useState(savedLogin)
  useEffect(() => setLoginDraft(savedLogin), [savedLogin])
  const loginInvalid = loginDraft.trim() !== '' && !isGithubLogin(loginDraft.trim())

  const saveLogin = async (value: string): Promise<void> => {
    const current = useStore.getState().settings?.peerGithubLogins ?? {}
    const next = { ...current }
    if (value) next[peerId] = value
    else delete next[peerId]
    await patchSettings({ peerGithubLogins: next })
    notify('info', fill(text.accountSaved, { computer: peerComputer }))
  }
  const cwd = localProject?.isRepo ? localProject.cwd : null

  const load = useCallback(async (): Promise<void> => {
    if (!cwd) {
      setState({ status: 'idle' })
      return
    }
    setState({ status: 'loading' })
    const account: GithubAccountStatus = await window.yan.github.account().catch(() => ({ installed: false, authed: false }))
    if (!account.installed) {
      setState({ status: 'blocked', reason: 'missing', message: text.missingGh })
      return
    }
    if (!account.authed) {
      setState({ status: 'blocked', reason: 'login', message: text.needLogin })
      return
    }
    const [data, status] = await Promise.all([window.yan.github.branches(cwd), window.yan.github.status(cwd)])
    if (!data.ok) {
      setState({ status: 'blocked', reason: 'error', message: fill(text.loadFailed, { error: data.error ?? '' }) })
      return
    }
    setState({ status: 'ready', data, login: account.login ?? '', base: status.repo?.defaultBranch ?? 'main', repo: data.repo ?? status.repo?.nameWithOwner ?? '' })
  }, [cwd, text.loadFailed, text.missingGh, text.needLogin])

  useEffect(() => {
    void load()
  }, [load])

  const rows = useMemo(
    () =>
      mergeChannels(
        branches.map((branch) => ({ name: branch.name, author: branch.author, fetched: !!branch.fetchedOid })),
        state.status === 'ready' ? state.data.branches : [],
        state.status === 'ready' ? state.data.pulls : [],
        savedLogin || null
      ),
    [branches, state, savedLogin]
  )
  const trackingOf = (name: string): string => branches.find((branch) => branch.name === name)?.trackingRef ?? ''
  const subjectOf = (name: string): string => branches.find((branch) => branch.name === name)?.subject ?? name

  const openPublish = (row: CollabChannelRow): void => {
    if (state.status !== 'ready' || !state.login) return
    setDraft({
      row,
      trackingRef: trackingOf(row.name),
      branch: githubBranchName(state.login, row.name),
      base: state.base,
      title: subjectOf(row.name).slice(0, 200),
      body: '',
      draft: false
    })
  }

  const publish = async (): Promise<void> => {
    if (!draft || !cwd) return
    setPending('publish')
    const result = await window.yan.github
      .publishPeerBranch(cwd, {
        trackingRef: draft.trackingRef,
        branch: draft.branch,
        base: draft.base,
        title: draft.title,
        body: draft.body,
        draft: draft.draft,
        confirmed: true
      })
      .catch((cause: unknown) => ({ ok: false, failure: { code: 'other', message: cause instanceof Error ? cause.message : String(cause), hint: '', retrySafe: false } }) as Awaited<ReturnType<typeof window.yan.github.publishPeerBranch>>)
    setPending(null)
    if (result.ok) {
      notify('info', fill(text.published, { n: result.number ?? 0 }))
    } else {
      const error = [result.failure?.message, result.failure?.hint].filter(Boolean).join(' ')
      notify('fail', fill(result.completedSteps?.includes('push') ? text.partial : text.publishFailed, { error }))
    }
    setDraft(null)
    await Promise.all([load(), onChanged()])
  }

  const checkout = async (number: number): Promise<void> => {
    if (!cwd) return
    setPending(`pr:${number}`)
    const result = await window.yan.github.action(cwd, { kind: 'checkout', number }).catch(() => null)
    setPending(null)
    if (result?.ok) notify('info', result.gitResult?.summary ?? fill(text.checkedOut, { n: number }))
    else notify('fail', fill(text.checkoutFailed, { error: result?.failure?.message ?? '' }))
    await onChanged()
  }

  const login = state.status === 'ready' ? state.login : ''
  const branchValid = draft ? isPublishBranchName(draft.branch, login) : false
  const canConfirm = !!draft && branchValid && !!draft.base.trim() && !!draft.title.trim()

  return (
    <section className="collab-block gh-channel" aria-label={text.title} data-testid="v3-collab-github-channel">
      <div className="gh-channel__head">
        <p className="collab-label">{text.title}</p>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={14} aria-hidden />} isPending={state.status === 'loading'} isDisabled={!cwd} onPress={() => void load()} data-testid="v3-collab-github-refresh">
          {text.refresh}
        </Button>
      </div>

      <div className="gh-channel__account" data-testid="v3-collab-github-account">
        <TextField
          label={text.accountLabel}
          description={text.accountHint}
          value={loginDraft}
          maxLength={40}
          isInvalid={loginInvalid}
          errorMessage={loginInvalid ? text.accountInvalid : undefined}
          onChange={setLoginDraft}
          className="collab-grow"
        />
        <Button size="sm" variant="secondary" isDisabled={loginInvalid || loginDraft.trim() === savedLogin} onPress={() => void saveLogin(loginDraft.trim())} data-testid="v3-collab-github-account-save">
          {text.accountSave}
        </Button>
        {savedLogin ? (
          <Button size="sm" variant="ghost" onPress={() => void saveLogin('')}>
            {text.accountClear}
          </Button>
        ) : null}
      </div>

      {!cwd ? <p className="collab-hint">{text.needLocal}</p> : null}
      {state.status === 'blocked' ? (
        <Notice tone="info" variant="hint" role="note" data-testid="v3-collab-github-blocked">
          {state.message}
        </Notice>
      ) : null}
      {state.status === 'loading' ? <p className="collab-hint">{text.loading}</p> : null}

      {cwd && state.status !== 'loading' ? (
        rows.length === 0 ? (
          <p className="collab-hint">{text.empty}</p>
        ) : (
          <ul className="gh-channel__list">
            {rows.map((row) => {
              const onPeer = row.channels.includes('peer')
              const onGithub = row.channels.includes('github')
              return (
                <li key={row.name} className="gh-channel__row" data-testid={`v3-collab-channel-${row.name}`}>
                  <div className="gh-channel__line">
                    <MiddleTruncate value={row.name} className="gh-channel__name collab-code" />
                    {onPeer ? <Badge>{text.sourcePeer}</Badge> : null}
                    {onGithub ? <Badge tone="run">{text.sourceGithub}</Badge> : null}
                    {row.pr ? <Badge tone={row.pr.isDraft ? undefined : 'ok'}>{fill(text.prLabel, { n: row.pr.number })}{row.pr.isDraft ? ` · ${text.prDraft}` : ''}</Badge> : null}
                  </div>
                  <p className="gh-channel__meta">
                    <span title={row.peerAuthor ?? undefined}>{row.peerAuthor ? `${peerComputer} · ${row.peerAuthor}` : row.pr?.title ?? ''}</span>
                    <span className="gh-channel__owner">{row.owner ? `${fill(text.owner, { login: row.owner })} · ${row.ownerSource === 'manual' ? text.manualTag : text.inferredTag}` : text.unknownOwner}</span>
                  </p>
                  <div className="collab-actions">
                    {onPeer && !onGithub && state.status === 'ready' && state.login ? (
                      <Button
                        size="sm"
                        icon={<Upload size={14} aria-hidden />}
                        isDisabled={!row.peerFetched}
                        onPress={() => openPublish(row)}
                        data-testid="v3-collab-github-publish"
                      >
                        {row.peerFetched ? text.publish : text.needFetch}
                      </Button>
                    ) : null}
                    {row.pr ? (
                      <>
                        <Button size="sm" variant="ghost" icon={<GitPullRequest size={14} aria-hidden />} isPending={pending === `pr:${row.pr.number}`} onPress={() => void checkout(row.pr!.number)} data-testid="v3-collab-github-checkout">
                          {text.checkoutPr}
                        </Button>
                        <Button size="sm" variant="ghost" icon={<ExternalLink size={14} aria-hidden />} onPress={() => void window.yan.github.openUrl(row.pr!.url)}>
                          {text.openPr}
                        </Button>
                      </>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )
      ) : null}

      <ConfirmDialog
        isOpen={!!draft}
        onOpenChange={(open) => {
          if (!open && pending !== 'publish') setDraft(null)
        }}
        title={text.publishTitle}
        description={state.status === 'ready' ? fill(text.publishLead, { repo: state.repo }) : undefined}
        confirmLabel={text.confirm}
        cancelLabel={text.cancel}
        isConfirmDisabled={!canConfirm}
        isPending={pending === 'publish'}
        closeOnConfirm={false}
        onConfirm={publish}
        confirmTestId="v3-collab-github-publish-confirm"
        data-testid="v3-collab-github-publish-dialog"
      >
        {draft ? (
          <div className="collab-stack">
            <TextField
              label={text.branchLabel}
              value={draft.branch}
              maxLength={200}
              isInvalid={!branchValid}
              errorMessage={!branchValid ? fill(text.namingHint, { login: login.toLowerCase() }) : undefined}
              onChange={(value) => setDraft({ ...draft, branch: value })}
            />
            <TextField label={text.baseLabel} value={draft.base} maxLength={200} onChange={(value) => setDraft({ ...draft, base: value })} />
            <TextField label={text.titleLabel} value={draft.title} maxLength={256} onChange={(value) => setDraft({ ...draft, title: value })} />
            <TextArea label={text.bodyLabel} value={draft.body} rows={4} maxLength={65_000} onChange={(value) => setDraft({ ...draft, body: value })} />
            <Checkbox isSelected={draft.draft} onChange={(value) => setDraft({ ...draft, draft: value })}>
              {text.draftLabel}
            </Checkbox>
          </div>
        ) : null}
      </ConfirmDialog>
    </section>
  )
}
