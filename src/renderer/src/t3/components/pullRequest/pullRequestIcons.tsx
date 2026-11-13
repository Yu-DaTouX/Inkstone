import {
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  LayersIcon,
  Link2Icon,
  TriangleAlertIcon,
  Unlink2Icon
} from '../../../ui/icons'
import { cx } from '@/ui/cx'

export const PullRequestGlyph = {
  pullRequest: GitPullRequestArrowIcon,
  reopen: GitPullRequestArrowIcon,
  draft: GitPullRequestDraftIcon,
  closed: GitPullRequestClosedIcon,
  merged: GitMergeIcon,
  conflicting: TriangleAlertIcon,
  stack: LayersIcon,
  link: Link2Icon,
  unlink: Unlink2Icon
} as const

export type PullRequestGlyphIcon = (typeof PullRequestGlyph)[keyof typeof PullRequestGlyph]

export type PullRequestGlyphState = 'open' | 'draft' | 'closed' | 'merged'

export interface PullRequestStatePresentation {
  readonly toneClassName: string
  readonly Icon: PullRequestGlyphIcon
}

export const PULL_REQUEST_STATE_PRESENTATION = {
  open: {
    toneClassName: 't3-status--done',
    Icon: PullRequestGlyph.pullRequest
  },
  draft: {
    toneClassName: 't3-status--muted',
    Icon: PullRequestGlyph.draft
  },
  closed: {
    toneClassName: 't3-status--failed',
    Icon: PullRequestGlyph.closed
  },
  merged: {
    toneClassName: 't3-status--merged',
    Icon: PullRequestGlyph.merged
  }
} as const satisfies Record<PullRequestGlyphState, PullRequestStatePresentation>

export function pullRequestStatePresentation(input: {
  state: PullRequestGlyphState
  isDraft?: boolean
}): PullRequestStatePresentation {
  return PULL_REQUEST_STATE_PRESENTATION[
    input.state === 'open' && input.isDraft ? 'draft' : input.state
  ]
}

export function PullRequestStateIcon(props: {
  state?: PullRequestGlyphState
  isDraft?: boolean
  className?: string
}) {
  if (props.state === undefined) {
    return (
      <PullRequestGlyph.pullRequest
        aria-hidden
        className={cx('t3-icon--xs t3-status--waiting', props.className)}
      />
    )
  }
  const presentation = pullRequestStatePresentation({
    state: props.state,
    ...(props.isDraft === undefined ? {} : { isDraft: props.isDraft })
  })
  return (
    <presentation.Icon aria-hidden className={cx('t3-icon--xs', presentation.toneClassName, props.className)} />
  )
}
