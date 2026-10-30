import { useState, type ReactElement } from 'react'
import { Button, CardCode, Notice } from '../../ui'
import { useI18n, type MessageKey } from '../../i18n'
import type { GitFailureCode } from '../../../../shared/git-actions'
import type { FailureNext, FailureView } from './git-flow'
import './git-flow.css'

const TITLE: Record<GitFailureCode, MessageKey> = {
  stale: 'gitflow.fail.stale',
  'not-a-repo': 'gitflow.fail.notRepo',
  identity: 'gitflow.fail.identity',
  hook: 'gitflow.fail.hook',
  sign: 'gitflow.fail.sign',
  lock: 'gitflow.fail.lock',
  conflict: 'gitflow.fail.conflict',
  auth: 'gitflow.fail.auth',
  'no-remote': 'gitflow.fail.noRemote',
  'non-fast-forward': 'gitflow.fail.nonFastForward',
  'no-upstream': 'gitflow.fail.noUpstream',
  'dirty-blocks-switch': 'gitflow.fail.dirtySwitch',
  'branch-exists': 'gitflow.fail.branchExists',
  'branch-missing': 'gitflow.fail.branchMissing',
  'branch-in-use': 'gitflow.fail.branchInUse',
  'invalid-input': 'gitflow.fail.invalidInput',
  unborn: 'gitflow.fail.unborn',
  'nothing-to-commit': 'gitflow.fail.nothingToCommit',
  'empty-message': 'gitflow.fail.emptyMessage',
  'path-rejected': 'gitflow.fail.pathRejected',
  'carry-rejected': 'gitflow.fail.carryRejected',
  busy: 'gitflow.fail.busy',
  timeout: 'gitflow.fail.timeout',
  cancelled: 'gitflow.fail.cancelled',
  unknown: 'gitflow.fail.unknown'
}

const HINT: Partial<Record<GitFailureCode, MessageKey>> = {
  stale: 'gitflow.failHint.stale',
  identity: 'gitflow.failHint.identity',
  hook: 'gitflow.failHint.hook',
  sign: 'gitflow.failHint.sign',
  lock: 'gitflow.failHint.lock',
  conflict: 'gitflow.failHint.conflict',
  auth: 'gitflow.failHint.auth',
  'no-remote': 'gitflow.failHint.noRemote',
  'non-fast-forward': 'gitflow.failHint.nonFastForward',
  'no-upstream': 'gitflow.failHint.noUpstream',
  'dirty-blocks-switch': 'gitflow.failHint.dirtySwitch',
  'branch-exists': 'gitflow.failHint.branchExists',
  'branch-in-use': 'gitflow.failHint.branchInUse',
  unborn: 'gitflow.failHint.unborn',
  'path-rejected': 'gitflow.failHint.pathRejected',
  busy: 'gitflow.failHint.busy',
  timeout: 'gitflow.failHint.timeout',
  unknown: 'gitflow.failHint.unknown'
}

export interface GitFailureNoticeProps {
  view: FailureView
  busy?: boolean
  onRetry?: () => void
  onRefresh: () => void
  onNext?: (next: Exclude<FailureNext, null>) => void
  onDismiss?: () => void
  className?: string
}

export function failureTitle(view: FailureView, lang: string, t: (key: MessageKey) => string): string {
  if (view.committed) return t('gitflow.fail.committed')
  if (lang.startsWith('zh') && view.message) return view.message
  return t(TITLE[view.code] ?? 'gitflow.fail.unknown')
}

export function failureHint(view: FailureView, lang: string, t: (key: MessageKey) => string): string | null {
  if (view.committed) return t('gitflow.failHint.committed')
  if (lang.startsWith('zh') && view.hint) return view.hint
  const key = HINT[view.code]
  return key ? t(key) : null
}

export function GitFailureNotice({ view, busy, onRetry, onRefresh, onNext, onDismiss, className }: GitFailureNoticeProps): ReactElement {
  const { lang, t } = useI18n()
  const [rawOpen, setRawOpen] = useState(false)
  const hint = failureHint(view, lang, t)
  const canRetry = view.retry === 'retry' && !!onRetry
  return (
    <Notice
      tone="fail"
      compact
      className={className}
      data-testid="git-failure"
      data-code={view.code}
      title={failureTitle(view, lang, t)}
    >
      {hint ? <p className="gitflow-fail__hint">{hint}</p> : null}
      {view.files.length > 0 ? (
        <div className="gitflow-fail__files">
          <span>{t('gitflow.fail.files')}</span>
          <CardCode tone="fail" data-testid="git-failure-files">
            {[...view.files, ...(view.moreFiles > 0 ? [t('gitflow.fail.moreFiles', { count: view.moreFiles })] : [])].join('\n')}
          </CardCode>
        </div>
      ) : null}
      {view.raw && rawOpen ? (
        <CardCode className="gitflow-fail__raw" tabIndex={0} data-testid="git-failure-raw">
          {view.raw}
        </CardCode>
      ) : null}
      <div className="gitflow-fail__actions">
        {view.next && onNext ? (
          <Button size="xs" variant="secondary" isDisabled={busy} onPress={() => onNext(view.next as Exclude<FailureNext, null>)}>
            {view.next === 'fetch' ? t('gitflow.fetch') : t('gitflow.action.publish')}
          </Button>
        ) : null}
        {canRetry ? (
          <Button size="xs" variant="secondary" isDisabled={busy} onPress={onRetry} data-testid="git-failure-retry">
            {t('gitflow.fail.retry')}
          </Button>
        ) : (
          <Button size="xs" variant="secondary" isDisabled={busy} onPress={onRefresh} data-testid="git-failure-refresh">
            {t('gitflow.fail.refresh')}
          </Button>
        )}
        {view.raw ? (
          <Button size="xs" variant="ghost" aria-expanded={rawOpen} onPress={() => setRawOpen((open) => !open)} data-testid="git-failure-raw-toggle">
            {rawOpen ? t('gitflow.fail.rawHide') : t('gitflow.fail.rawShow')}
          </Button>
        ) : null}
        {onDismiss ? (
          <Button size="xs" variant="ghost" onPress={onDismiss}>
            {t('gitflow.fail.dismiss')}
          </Button>
        ) : null}
      </div>
    </Notice>
  )
}
