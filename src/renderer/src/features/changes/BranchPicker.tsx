import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactElement, type RefObject } from 'react'
import { Autocomplete, Dialog } from 'react-aria-components'
import { ArrowLeft, GitBranch, Plus } from 'lucide-react'
import {
  Button,
  Header,
  ListBoxItem,
  Menu,
  MenuItem,
  MenuSection,
  Notice,
  Popover,
  SearchField,
  Select,
  Spinner,
  TextField,
  showToast,
  type PopoverProps
} from '../../ui'
import { useI18n, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import type { GitRefOption, GitRepoState } from '../../../../shared/git'
import type { GitActionExpected } from '../../../../shared/git-actions'
import { GitFailureNotice } from './GitFailureNotice'
import { branchNameIssue, buildBranchList, cwdBusy, type BranchBlock, type BranchNameIssue, type BranchOption } from './git-flow'
import { useGitAction } from './use-git-action'
import './git-flow.css'

export interface BranchPickerProps {
  cwd: string
  triggerRef: RefObject<Element | null>
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  onChanged?: () => void
  placement?: PopoverProps['placement']
}

interface PickerSnapshot {
  repo: GitRepoState | null
  expected: GitActionExpected | undefined
  refs: GitRefOption[]
  busyBranches: string[]
  error: string
}

const CREATE_KEY = '__create__'
const CURRENT_START = '__current__'

const BLOCK_REASON: Record<BranchBlock, MessageKey> = {
  current: 'gitflow.branch.current',
  worktree: 'gitflow.branch.busyWorktree',
  running: 'gitflow.branch.busyRunning'
}

const NAME_ISSUE: Record<BranchNameIssue, MessageKey> = {
  empty: 'gitflow.name.empty',
  'too-long': 'gitflow.name.tooLong',
  'leading-dash': 'gitflow.name.leadingDash',
  'slash-edge': 'gitflow.name.slashEdge',
  'dot-end': 'gitflow.name.dotEnd',
  'double-dot': 'gitflow.name.doubleDot',
  'double-slash': 'gitflow.name.doubleSlash',
  'at-brace': 'gitflow.name.atBrace',
  'bad-char': 'gitflow.name.badChar',
  control: 'gitflow.name.control',
  exists: 'gitflow.name.exists'
}

export function BranchPicker({ cwd, triggerRef, isOpen, onOpenChange, onChanged, placement = 'bottom start' }: BranchPickerProps): ReactElement {
  const { t } = useI18n()
  return (
    <Popover
      variant="panel"
      className="gitflow-branch"
      triggerRef={triggerRef}
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      placement={placement}
      offset={4}
    >
      <Dialog className="gitflow-branch__dialog" aria-label={t('gitflow.branch.dialog')} data-testid="git-branch-picker">
        {isOpen ? <BranchPickerBody cwd={cwd} onClose={() => onOpenChange(false)} onChanged={onChanged} /> : null}
      </Dialog>
    </Popover>
  )
}

function BranchPickerBody({ cwd, onClose, onChanged }: { cwd: string; onClose: () => void; onChanged?: () => void }): ReactElement {
  const { t } = useI18n()
  const runners = useStore((s) => s.runners)
  const [snapshot, setSnapshot] = useState<PickerSnapshot | null>(null)
  const [tick, setTick] = useState(0)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'list' | 'create'>('list')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [start, setStart] = useState(CURRENT_START)

  useEffect(() => {
    const git = window.yan?.git
    if (!git) {
      setSnapshot({ repo: null, expected: undefined, refs: [], busyBranches: [], error: t('gitflow.branch.unavailable') })
      return undefined
    }
    let alive = true
    void Promise.all([git.state(cwd), git.refs(cwd)])
      .then(([state, refs]) => {
        if (!alive) return
        setSnapshot({
          repo: state.repo,
          expected: state.expected,
          refs: refs.refs ?? [],
          busyBranches: refs.busyBranches ?? [],
          error: refs.ok ? state.error ?? '' : refs.error ?? state.error ?? ''
        })
      })
      .catch((error: unknown) => {
        if (alive) setSnapshot({ repo: null, expected: undefined, refs: [], busyBranches: [], error: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      alive = false
    }
  }, [cwd, tick, t])

  const reload = useCallback(() => setTick((n) => n + 1), [])
  const runner = useGitAction(cwd, snapshot?.expected, reload)
  const repo = snapshot?.repo ?? null
  const running = cwdBusy(runners, repo?.root ?? cwd)
  const list = useMemo(
    () => buildBranchList({ refs: snapshot?.refs ?? [], busyBranches: snapshot?.busyBranches ?? [], currentBranch: repo?.branch ?? null, query, running }),
    [snapshot, repo?.branch, query, running]
  )
  const localNames = useMemo(() => (snapshot?.refs ?? []).filter((ref) => ref.kind === 'local' || ref.kind === 'head').map((ref) => ref.ref), [snapshot])
  const startOptions = useMemo(() => {
    const refs = snapshot?.refs ?? []
    const seen = new Set<string>()
    const out: { id: string; label: string }[] = [
      { id: CURRENT_START, label: t('gitflow.branch.startCurrent', { branch: repo?.branch ?? 'HEAD' }) }
    ]
    for (const ref of refs) {
      if (ref.kind === 'tag' || ref.current || ref.ref === repo?.branch || ref.label.endsWith('/HEAD') || seen.has(ref.ref)) continue
      seen.add(ref.ref)
      out.push({ id: ref.ref, label: ref.ref })
    }
    return out
  }, [snapshot, repo?.branch, t])

  const finish = (message: string): void => {
    showToast(message, { tone: 'success' })
    onChanged?.()
    onClose()
  }

  const pick = async (option: BranchOption): Promise<void> => {
    if (option.block) return
    if (option.pick.kind === 'switch') {
      const res = await runner.run({ kind: 'switch-branch', branch: option.pick.branch })
      if (res?.ok) finish(t('gitflow.done.switch', { branch: option.pick.branch }))
      return
    }
    const res = await runner.run({ kind: 'create-branch', branch: option.pick.branch, startPoint: option.pick.startPoint, checkout: true })
    if (res?.ok) finish(t('gitflow.done.track', { branch: option.pick.branch, remote: option.pick.startPoint }))
  }

  const openCreate = (): void => {
    setName(query.trim())
    setNameTouched(query.trim().length > 0)
    setStart(CURRENT_START)
    runner.clear()
    setMode('create')
  }

  const issue = branchNameIssue(name, localNames)
  const createBlocked = running || !!issue || !snapshot?.expected
  const submitCreate = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    setNameTouched(true)
    if (createBlocked) return
    const branch = name.trim()
    const res = await runner.run({ kind: 'create-branch', branch, startPoint: start === CURRENT_START ? null : start, checkout: true })
    if (res?.ok) finish(t('gitflow.done.create', { branch }))
  }

  const failure = runner.failure ? (
    <GitFailureNotice
      className="gitflow-branch__failure"
      view={runner.failure.view}
      busy={!!runner.busy}
      onRetry={() => {
        const input = runner.failure?.input
        if (input) void runner.run(input)
      }}
      onRefresh={() => {
        runner.clear()
        reload()
      }}
      onDismiss={runner.clear}
    />
  ) : null

  if (!snapshot) {
    return (
      <Notice variant="hint" icon={<Spinner size="xs" />} className="gitflow-branch__note">
        {t('gitflow.branch.loading')}
      </Notice>
    )
  }

  if (mode === 'create') {
    return (
      <form className="gitflow-branch__create" onSubmit={(event) => void submitCreate(event)} data-testid="git-branch-create">
        <div className="gitflow-branch__create-head">
          <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onPress={() => setMode('list')}>
            {t('gitflow.branch.back')}
          </Button>
        </div>
        <TextField
          label={t('gitflow.branch.name')}
          value={name}
          autoFocus
          onChange={(value) => {
            setName(value)
            setNameTouched(true)
          }}
          isInvalid={nameTouched && !!issue}
          errorMessage={issue ? t(NAME_ISSUE[issue]) : undefined}
          placeholder={t('gitflow.branch.namePlaceholder')}
          data-testid="git-branch-name"
        />
        <Select
          label={t('gitflow.branch.startPoint')}
          selectedKey={start}
          onSelectionChange={(key) => setStart(String(key ?? CURRENT_START))}
          data-testid="git-branch-start"
        >
          {startOptions.map((option) => (
            <ListBoxItem key={option.id} id={option.id} textValue={option.label}>
              {option.label}
            </ListBoxItem>
          ))}
        </Select>
        {running ? (
          <Notice variant="hint" tone="ask" className="gitflow-branch__note">
            {t('gitflow.branch.busyRunning')}
          </Notice>
        ) : null}
        {failure}
        <div className="gitflow-branch__create-foot">
          <Button type="submit" size="sm" variant="primary" isDisabled={createBlocked} isPending={runner.busy === 'create-branch'} data-testid="git-branch-create-submit">
            {t('gitflow.branch.createSubmit')}
          </Button>
        </div>
      </form>
    )
  }

  const reasonOf = (option: BranchOption): string | undefined => (option.block ? t(BLOCK_REASON[option.block]) : undefined)
  const disabledKeys = [...list.local, ...list.remote].filter((option) => option.block || runner.busy).map((option) => option.id)
  const byId = new Map([...list.local, ...list.remote].map((option) => [option.id, option]))
  const trimmed = query.trim()
  const empty = list.local.length === 0 && list.remote.length === 0

  return (
    <div className="gitflow-branch__list">
      <Autocomplete inputValue={query} onInputChange={setQuery}>
        <SearchField
          aria-label={t('gitflow.branch.search')}
          placeholder={t('gitflow.branch.search')}
          autoFocus
          className="gitflow-branch__search"
          data-testid="git-branch-search"
        />
        <Menu
          aria-label={t('gitflow.branch.dialog')}
          className="gitflow-branch__menu"
          disabledKeys={runner.busy ? [...disabledKeys, CREATE_KEY] : disabledKeys}
          onAction={(key) => {
            if (key === CREATE_KEY) {
              openCreate()
              return
            }
            const option = byId.get(String(key))
            if (option) void pick(option)
          }}
        >
          {list.local.length > 0 ? (
            <MenuSection id="local">
              <Header>{t('gitflow.branch.local')}</Header>
              {list.local.map((option) => (
                <MenuItem
                  key={option.id}
                  id={option.id}
                  textValue={option.name}
                  icon={<GitBranch size={14} />}
                  checked={option.current}
                  disabledReason={reasonOf(option)}
                >
                  {option.name}
                </MenuItem>
              ))}
            </MenuSection>
          ) : null}
          {list.remote.length > 0 ? (
            <MenuSection id="remote">
              <Header>{t('gitflow.branch.remote')}</Header>
              {list.remote.map((option) => (
                <MenuItem
                  key={option.id}
                  id={option.id}
                  textValue={option.ref}
                  icon={<GitBranch size={14} />}
                  checked={false}
                  description={t('gitflow.branch.tracks', { branch: option.name })}
                  disabledReason={reasonOf(option)}
                >
                  {option.ref}
                </MenuItem>
              ))}
            </MenuSection>
          ) : null}
          <MenuSection id="create">
            <MenuItem id={CREATE_KEY} textValue={t('gitflow.branch.create')} icon={<Plus size={14} />} checked={false}>
              {trimmed && !list.exact ? t('gitflow.branch.createNamed', { name: trimmed }) : t('gitflow.branch.create')}
            </MenuItem>
          </MenuSection>
        </Menu>
      </Autocomplete>
      {empty && trimmed ? (
        <Notice variant="hint" className="gitflow-branch__note">
          {t('gitflow.branch.empty')}
        </Notice>
      ) : null}
      {snapshot.error ? (
        <Notice tone="fail" compact className="gitflow-branch__note">
          {t('gitflow.branch.loadFailed', { msg: snapshot.error })}
        </Notice>
      ) : null}
      {runner.busy ? (
        <Notice variant="hint" icon={<Spinner size="xs" />} className="gitflow-branch__note">
          {t('gitflow.branch.switching')}
        </Notice>
      ) : null}
      {failure}
    </div>
  )
}
