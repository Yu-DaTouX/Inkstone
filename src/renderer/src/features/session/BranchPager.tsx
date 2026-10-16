/**
 * 用户消息旁的「2/3 ‹ ›」同分叉点切换（v3 · 设计 §8.8）。
 *
 * 只呈现 `branch-pager-model.ts` 的纯投影：当前序号 / 兄弟总数，以及前后切换。
 * 控件全部来自正式原语 `ui/IconButton`，图标来自本目录 `Icon`；本文件与
 * `branch-pager.css` 只写版面，不自画按钮外观。键盘 `←` / `→` 只在 pager 自己
 * 获得焦点时处理，不注册全局监听、不抢输入框的方向键。
 *
 * 分支不存在 / 无稳定 `entryId` / 只有一个兄弟时，模型为空，这里不渲染任何东西
 * ——不放假按钮，也不拿消息文字或时间猜分支。
 */
import { useMemo, type JSX, type KeyboardEvent } from 'react'
import type { Lang } from '../../i18n'
import { useI18n } from '../../i18n'
import { IconButton } from '../../ui'
import { Icon } from './Icon'
import type { BranchPagerModel } from './branch-pager-model'
import './branch-pager.css'

export interface BranchPagerText {
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

/** 传给 `TurnView` 的只读绑定：模型表 + 切换在途 / 错误 / 忙状态 + 导航回调。 */
export interface BranchPagerBinding {
  /** key = 用户消息稳定 `entryId`；没有对应条目就不画 pager。 */
  models: ReadonlyMap<string, BranchPagerModel>
  /** 在途导航的目标 `entryId`；非 null 时禁连续点击。 */
  pending: string | null
  /** 导航失败的宿主原文；空串表示没有错误。 */
  error: string
  /** 会话忙（运行 / 流式 / 压缩中）：只读展示，不切换。 */
  disabled: boolean
  onNavigate: (targetId: string) => void
}

export interface BranchPagerProps {
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
        title={text.prev}
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
        title={text.next}
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
