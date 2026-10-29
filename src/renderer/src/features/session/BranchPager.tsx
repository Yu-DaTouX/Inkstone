import { useMemo, type JSX, type KeyboardEvent } from 'react'
import type { Lang } from '../../i18n'
import { useI18n } from '../../i18n'
import { IconButton } from '../../ui'
import { Icon } from './Icon'
import type { BranchPagerModel } from './branch-pager-model'
import './branch-pager.css'

interface BranchPagerText {
  group: string
  prev: string
  next: string
  position: (index: number, count: number) => string
  pending: string
}

const ZH: BranchPagerText = {
  group: '同一分叉点的兄弟分支',
  prev: '上一个分支',
  next: '下一个分支',
  position: (index, count) => `第 ${index} / ${count} 个分支`,
  pending: '切换中…'
}

const EN: BranchPagerText = {
  group: 'Sibling branches at the same fork point',
  prev: 'Previous branch',
  next: 'Next branch',
  position: (index, count) => `Branch ${index} of ${count}`,
  pending: 'Switching…'
}

export function branchPagerText(lang: Lang): BranchPagerText {
  return lang === 'en-US' ? EN : ZH
}

export interface BranchPagerBinding {
  models: ReadonlyMap<string, BranchPagerModel>
  pending: string | null
  error: string
  disabled: boolean
  onNavigate: (targetId: string) => void
}

interface BranchPagerProps {
  model: BranchPagerModel
  disabled?: boolean
  pending?: boolean
  error?: string | null
  onNavigate: (targetId: string) => void
  className?: string
}

export function BranchPager({
  model,
  disabled = false,
  pending = false,
  error = null,
  onNavigate,
  className
}: BranchPagerProps): JSX.Element {
  const { lang } = useI18n()
  const text = useMemo(() => branchPagerText(lang), [lang])
  const blocked = disabled || pending

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (blocked) return
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onNavigate(model.prevTargetId)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      onNavigate(model.nextTargetId)
    }
  }

  return (
    <span
      className={`branch-pager${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={text.group}
      data-testid="v3-branch-pager"
      data-index={model.index}
      data-count={model.count}
      onKeyDown={onKeyDown}
    >
      <IconButton
        size="sm"
        isDisabled={blocked}
        aria-label={text.prev}
        tooltip={text.prev}
        data-testid="v3-branch-prev"
        onPress={() => onNavigate(model.prevTargetId)}
      >
        <Icon name="chevron-left" size={14} />
      </IconButton>
      <span className="branch-pager__count" aria-label={text.position(model.index, model.count)}>
        {model.index}/{model.count}
      </span>
      <IconButton
        size="sm"
        isDisabled={blocked}
        aria-label={text.next}
        tooltip={text.next}
        data-testid="v3-branch-next"
        onPress={() => onNavigate(model.nextTargetId)}
      >
        <Icon name="chevron-right" size={14} />
      </IconButton>
      {pending ? <span className="branch-pager__state" role="status">{text.pending}</span> : null}
      {error ? (
        <span className="branch-pager__error" role="alert" title={error} data-testid="v3-branch-pager-error">
          {error}
        </span>
      ) : null}
    </span>
  )
}
