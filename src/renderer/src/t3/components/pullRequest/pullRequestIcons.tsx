import {
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  LayersIcon,
  Link2Icon,
  TriangleAlertIcon,
  Unlink2Icon
} from 'lucide-react'
import { cn } from '@/t3/lib/utils'

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
    toneClassName: 'text-(--ok-t)',
    Icon: PullRequestGlyph.pullRequest
  },
  draft: {
    toneClassName: 'text-(--fg3)',
    Icon: PullRequestGlyph.draft
  },
  closed: {
    toneClassName: 'text-(--fail-t)',
    Icon: PullRequestGlyph.closed
  },
  merged: {
    toneClassName: 'text-(--data-3)',
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
        className={cn('size-3 shrink-0 text-muted-foreground', props.className)}
      />
    )
  }
  const presentation = pullRequestStatePresentation({
    state: props.state,
    ...(props.isDraft === undefined ? {} : { isDraft: props.isDraft })
  })
  return (
    <presentation.Icon aria-hidden className={cn('size-3 shrink-0', presentation.toneClassName, props.className)} />
  )
}
