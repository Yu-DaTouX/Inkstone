import { useMemo, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import { ChevronDown, Minus, Plus } from 'lucide-react'
import {
  Button,
  Collapsible,
  CollapsibleHeader,
  CollapsiblePanel,
  DiffStat,
  IconButton,
  ListRow,
  Menu,
  MenuItem,
  MenuTrigger,
  Notice,
  Popover,
  TextArea
} from '../../ui'
import { FileTypeIcon } from '../../ui/FileTypeIcon'
import { useI18n } from '../../i18n'
import type { GitRepoState } from '../../../../shared/git'
import type { GitActionKind } from '../../../../shared/git-actions'
import { ChangePathLabel, ChangeStatusMark } from './ChangeEntryLabel'
import { groupByStage, primaryAction, stageState, stagedTotals, type PrimaryKind } from './git-flow'
import { PRIMARY_LABEL, REASON_KEY as REASON } from './git-flow-keys'
import type { ChangesText } from './text'
import type { ChangeItem } from './types'
import './git-flow.css'

export const COMMIT_GROUP_LIMIT = 200

export interface CommitPanelProps {
  items: readonly ChangeItem[]
  repo: GitRepoState
  hasRemote: boolean
  active: boolean
  ready: boolean
  busy: GitActionKind | null
  message: string
  lang: string
  text: ChangesText
  onMessageChange: (value: string) => void
  onStage: (item: ChangeItem) => void
  onUnstage: (item: ChangeItem) => void
  onStageAll: () => void
  onUnstageAll: () => void
  onCommit: (andPush: boolean) => void
  onPush: (kind: 'push' | 'publish') => void
  onOpenFile: (path: string) => void
}

const BUSY_KINDS: Record<PrimaryKind, GitActionKind[]> = {
  commit: ['commit'],
  push: ['push'],
  publish: ['push'],
  'up-to-date': [],
  behind: []
}

export function CommitPanel(props: CommitPanelProps): ReactElement {
  const { t } = useI18n()
  const { items, repo, hasRemote, active, ready, busy, message, lang, text } = props
  const groups = useMemo(() => groupByStage(items), [items])
  const totals = useMemo(() => stagedTotals(groups.staged), [groups.staged])
  const partial = groups.staged.some((item) => stageState(item).unstaged)
  const stagedCount = Math.max(groups.staged.length, repo.stagedCount)
  const primary = primaryAction({
    stagedCount,
    changedCount: Math.max(items.length, repo.changedCount),
    branch: repo.branch,
    detached: repo.detached,
    unborn: repo.unborn,
    upstream: repo.upstream,
    ahead: repo.ahead,
    behind: repo.behind,
    hasRemote,
    hasMessage: message.trim().length > 0
  })
  const locked = !active || !ready || busy !== null
  const reasonText = !active
    ? t('gitflow.reason.inactive')
    : primary.reason
      ? t(REASON[primary.reason], { upstream: repo.upstream ?? '', ahead: repo.ahead, behind: repo.behind })
      : ''
  const primaryDisabled = locked || primary.reason !== null || primary.kind === 'up-to-date' || primary.kind === 'behind'
  const pending = busy !== null && BUSY_KINDS[primary.kind].includes(busy)

  const runPrimary = (): void => {
    if (primaryDisabled) return
    if (primary.kind === 'commit') props.onCommit(false)
    else if (primary.kind === 'push' || primary.kind === 'publish') props.onPush(primary.kind)
  }

  const onMessageKey = (event: ReactKeyboardEvent): void => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return
    event.preventDefault()
    if (primary.kind === 'commit') runPrimary()
  }

  const row = (item: ChangeItem, staged: boolean): ReactElement => (
    <li key={`${staged ? 's' : 'u'}:${item.path}`} className="gitflow-commit__item">
      <ListRow
        icon={<FileTypeIcon name={item.path} size={12} />}
        className="gitflow-commit__row"
        trailing={
          item.added !== undefined || item.removed !== undefined ? <DiffStat added={item.added ?? 0} removed={item.removed ?? 0} hideZero /> : undefined
        }
        title={item.path}
        onClick={() => props.onOpenFile(item.path)}
        accessory={
          <IconButton
            size="sm"
            aria-label={staged ? t('gitflow.unstage', { path: item.path }) : t('gitflow.stage', { path: item.path })}
            tooltip={staged ? t('gitflow.unstageOne') : t('gitflow.stageOne')}
            isDisabled={locked}
            onPress={() => (staged ? props.onUnstage(item) : props.onStage(item))}
            data-testid={staged ? 'git-unstage-file' : 'git-stage-file'}
          >
            {staged ? <Minus size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
          </IconButton>
        }
      >
        <ChangePathLabel path={item.path} mark={<ChangeStatusMark item={item} lang={lang} text={text} />} />
      </ListRow>
    </li>
  )

  const group = (key: 'staged' | 'unstaged', list: ChangeItem[], count: number): ReactElement => {
    const staged = key === 'staged'
    const shown = list.slice(0, COMMIT_GROUP_LIMIT)
    return (
      <Collapsible defaultExpanded className="gitflow-commit__group" data-testid={`git-group-${key}`}>
        <CollapsibleHeader
          size="compact"
          accessory={<span className="ui-meta-num">{count}</span>}
          actions={
            <Button
              size="xs"
              variant="ghost"
              isDisabled={locked || count === 0}
              isPending={busy === (staged ? 'unstage-all' : 'stage-all')}
              onPress={staged ? props.onUnstageAll : props.onStageAll}
              data-testid={staged ? 'git-unstage-all' : 'git-stage-all'}
            >
              {staged ? t('gitflow.unstageAll') : t('gitflow.stageAll')}
            </Button>
          }
        >
          {staged ? t('gitflow.staged') : t('gitflow.unstaged')}
        </CollapsibleHeader>
        <CollapsiblePanel>
          {shown.length > 0 ? (
            <ul className="gitflow-commit__list">{shown.map((item) => row(item, staged))}</ul>
          ) : (
            <Notice variant="hint" className="gitflow-commit__empty">
              {staged ? t('gitflow.stagedEmpty') : t('gitflow.unstagedEmpty')}
            </Notice>
          )}
          {list.length > shown.length ? (
            <Notice variant="hint" className="gitflow-commit__empty">
              {t('gitflow.groupMore', { count: list.length - shown.length })}
            </Notice>
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
    )
  }

  return (
    <section className="gitflow-commit" aria-label={t('gitflow.commitArea')} data-testid="git-commit-panel">
      {items.length > 0 || repo.changedCount > 0 ? (
        <div className="gitflow-commit__groups">
          {group('staged', groups.staged, stagedCount)}
          {group('unstaged', groups.unstaged, Math.max(groups.unstaged.length, repo.unstagedCount + repo.untrackedCount))}
        </div>
      ) : null}
      <TextArea
        aria-label={t('gitflow.message')}
        placeholder={t('gitflow.messagePlaceholder')}
        className="gitflow-commit__message"
        rows={2}
        size="sm"
        value={message}
        onChange={props.onMessageChange}
        onKeyDown={onMessageKey}
        isDisabled={!active}
        data-testid="git-commit-message"
      />
      <div className="gitflow-commit__bar">
        <span className="gitflow-commit__summary" data-testid="git-commit-summary">
          <span>{stagedCount > 0 ? t('gitflow.summary', { count: stagedCount }) : t('gitflow.summaryNone')}</span>
          {stagedCount > 0 && totals.known && !partial ? <DiffStat added={totals.added} removed={totals.removed} hideZero /> : null}
        </span>
        <span className="gitflow-commit__actions">
          <Button
            variant="primary"
            size="sm"
            isDisabled={primaryDisabled}
            isPending={pending}
            onPress={runPrimary}
            data-testid="git-primary"
            data-kind={primary.kind}
          >
            {t(PRIMARY_LABEL[primary.kind], { behind: repo.behind })}
          </Button>
          <MenuTrigger>
            <IconButton size="sm" aria-label={t('gitflow.action.more')} tooltip={t('gitflow.action.more')} isDisabled={locked} data-testid="git-primary-more">
              <ChevronDown size={14} aria-hidden />
            </IconButton>
            <Popover placement="top end">
              <Menu
                aria-label={t('gitflow.action.more')}
                disabledKeys={primary.commitAndPush ? [] : ['commit-push']}
                onAction={(key) => {
                  if (key === 'commit-push') props.onCommit(true)
                }}
              >
                <MenuItem
                  id="commit-push"
                  textValue={t('gitflow.action.commitPush')}
                  disabledReason={
                    primary.commitPushReason
                      ? t(REASON[primary.commitPushReason], { upstream: repo.upstream ?? '', ahead: repo.ahead, behind: repo.behind })
                      : undefined
                  }
                >
                  {t('gitflow.action.commitPush')}
                </MenuItem>
              </Menu>
            </Popover>
          </MenuTrigger>
        </span>
      </div>
      {reasonText ? (
        <Notice variant="hint" className="gitflow-commit__reason" data-testid="git-primary-reason">
          {reasonText}
        </Notice>
      ) : null}
    </section>
  )
}
