import { useEffect, useState, type ReactElement } from 'react'
import { GitPullRequestCreate } from 'lucide-react'
import { Button, Checkbox, Dialog, DialogFooter, IconButton, Modal, ModalOverlay, Notice, Spinner, Switch, TextField } from '../../ui'
import { useI18n } from '../../i18n'
import type { Lang } from '../../i18n'
import { openPanelSurface } from '../workbench/panel-actions'
import { pullRequestSurface } from '../../state/right-panel'
import { createDefaults, createProblem, type CreateDefaults, type CreateDraft } from './pr-actions-model'
import { prActionText } from './pr-action-text'
import { PrActionStatus, usePrAction } from './PrActionStatus'
import { MarkdownEditor } from './PrEditors'
import './pr-actions.css'

export interface CreatePullRequestDialogProps {
  cwd: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  lang?: Lang
}

const EMPTY: CreateDraft = { title: '', body: '', base: '', head: '', draft: false, pushFirst: false }

export function CreatePullRequestDialog({ cwd, isOpen, onOpenChange, lang }: CreatePullRequestDialogProps): ReactElement {
  const { lang: uiLang } = useI18n()
  const text = prActionText(lang ?? uiLang)
  const [loading, setLoading] = useState(false)
  const [defaults, setDefaults] = useState<CreateDefaults | null>(null)
  const [draft, setDraft] = useState<CreateDraft>(EMPTY)
  const [touched, setTouched] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const action = usePrAction(cwd, (_request, result) => {
    if (typeof result.number !== 'number') return
    onOpenChange(false)
    openPanelSurface(pullRequestSurface(result.number, { title: draft.title.trim(), state: draft.draft ? 'draft' : 'open' }))
  })

  useEffect(() => {
    if (!isOpen) return undefined
    let alive = true
    setLoading(true)
    setTouched(false)
    action.reset()
    const git = window.yan?.git
    void (async () => {
      try {
        const [state, changes] = await Promise.all([
          git ? git.state(cwd) : Promise.resolve({ repo: null }),
          git ? git.changes(cwd, { scope: { kind: 'branch' }, patches: false }).catch(() => null) : Promise.resolve(null)
        ])
        if (!alive) return
        const repo = state.repo
        const next = createDefaults({
          branch: repo?.branch ?? null,
          detached: repo?.detached ?? false,
          baseRef: changes?.baseRef ?? null,
          upstream: repo?.upstream ?? null,
          unpushed: repo?.unpushedCount ?? null
        })
        setDefaults(next)
        setDraft({ title: next.title, body: '', base: next.base, head: next.head, draft: false, pushFirst: next.pushFirst })
      } catch {
        if (alive) setDefaults(createDefaults({ branch: null, detached: true, baseRef: null, upstream: null, unpushed: null }))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [cwd, isOpen, refresh])

  const problem = createProblem(draft)
  const blocked = defaults?.blocked ?? null
  const busy = action.busy
  const set = (patch: Partial<CreateDraft>): void => setDraft((prev) => ({ ...prev, ...patch }))

  const submit = (): void => {
    setTouched(true)
    if (problem || blocked || busy) return
    void action.run({
      kind: 'create',
      title: draft.title.trim(),
      body: draft.body,
      base: draft.base.trim(),
      head: draft.head.trim(),
      draft: draft.draft,
      ...(draft.pushFirst ? { pushFirst: { setUpstream: true } } : {})
    })
  }

  return (
    <ModalOverlay isDismissable={!busy} isOpen={isOpen} onOpenChange={(open) => (busy ? undefined : onOpenChange(open))}>
      <Modal data-dialog-size="md">
        <Dialog title={text.create.title} data-testid="gh-pr-create">
          <form
            className="gh-pr-act__form"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            {loading ? (
              <Notice variant="hint" icon={<Spinner size="xs" />}>
                {text.create.loading}
              </Notice>
            ) : null}
            {blocked === 'default-branch' ? (
              <Notice tone="ask" compact data-testid="gh-pr-create-blocked">
                {text.create.blockedDefault(defaults?.head ?? '')}
              </Notice>
            ) : null}
            {blocked === 'detached' && !loading ? (
              <Notice tone="ask" compact data-testid="gh-pr-create-blocked">
                {text.create.blockedDetached}
              </Notice>
            ) : null}
            <TextField
              label={text.create.titleField}
              placeholder={text.create.titlePlaceholder}
              description={text.create.titleHint}
              value={draft.title}
              onChange={(value) => set({ title: value })}
              isInvalid={touched && problem === 'title'}
              errorMessage={text.create.problem.title}
              isDisabled={busy}
              autoFocus
              data-testid="gh-pr-create-title"
            />
            <div className="gh-pr-act__branches">
              <TextField
                label={text.create.base}
                value={draft.base}
                onChange={(value) => set({ base: value })}
                isInvalid={touched && (problem === 'base' || problem === 'same')}
                errorMessage={problem === 'same' ? text.create.problem.same : text.create.problem.base}
                isDisabled={busy}
                inputClassName="ui-num"
                data-testid="gh-pr-create-base"
              />
              <TextField label={text.create.head} value={draft.head} isReadOnly inputClassName="ui-num" data-testid="gh-pr-create-head" />
            </div>
            <MarkdownEditor
              label={text.create.body}
              value={draft.body}
              onChange={(value) => set({ body: value })}
              text={text.edit}
              cwd={cwd}
              placeholder={text.create.bodyPlaceholder}
              rows={7}
              isDisabled={busy}
              testId="gh-pr-create-body"
            />
            <div className="gh-pr-act__options">
              <Switch isSelected={draft.draft} onChange={(value) => set({ draft: value })} isDisabled={busy} data-testid="gh-pr-create-draft">
                {text.create.draft}
              </Switch>
              <Checkbox isSelected={draft.pushFirst} onChange={(value) => set({ pushFirst: value })} isDisabled={busy} data-testid="gh-pr-create-push">
                {text.create.pushFirst}
              </Checkbox>
            </div>
            <PrActionStatus controller={action} text={text.result} onRefresh={() => setRefresh((value) => value + 1)} />
            <DialogFooter>
              <Button variant="ghost" onPress={() => onOpenChange(false)} isDisabled={busy}>
                {text.create.cancel}
              </Button>
              <Button type="submit" variant="primary" isDisabled={!!blocked || loading} isPending={busy} data-testid="gh-pr-create-submit">
                {text.create.submit}
              </Button>
            </DialogFooter>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}

export interface CreatePullRequestButtonProps {
  cwd: string
  lang?: Lang
  variant?: 'icon' | 'button'
}

export function CreatePullRequestButton({ cwd, lang, variant = 'icon' }: CreatePullRequestButtonProps): ReactElement {
  const { lang: uiLang } = useI18n()
  const text = prActionText(lang ?? uiLang)
  const [open, setOpen] = useState(false)
  return (
    <>
      {variant === 'icon' ? (
        <IconButton size="sm" aria-label={text.create.open} tooltip={text.create.open} onPress={() => setOpen(true)} data-testid="gh-pr-create-open">
          <GitPullRequestCreate size={14} aria-hidden />
        </IconButton>
      ) : (
        <Button size="sm" variant="secondary" icon={<GitPullRequestCreate size={14} aria-hidden />} onPress={() => setOpen(true)} data-testid="gh-pr-create-open">
          {text.create.open}
        </Button>
      )}
      {open ? <CreatePullRequestDialog cwd={cwd} lang={lang} isOpen={open} onOpenChange={setOpen} /> : null}
    </>
  )
}
