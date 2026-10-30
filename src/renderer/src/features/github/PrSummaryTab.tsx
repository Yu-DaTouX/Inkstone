import { useState, type ReactElement, type ReactNode } from 'react'
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ListFilter, MessageSquarePlus, Pencil, Tag, Users, X } from 'lucide-react'
import {
  Avatar,
  Badge,
  Button,
  Collapsible,
  CollapsibleHeader,
  CollapsiblePanel,
  Dialog,
  DialogTrigger,
  IconButton,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  StatusDot,
  TextArea
} from '../../ui'
import { Markdown } from '../session/Markdown'
import type { PrCheckItem, PrDetail, PrReviewerState, PrTimelineItem } from './pr-model'
import { commentView } from './pr-actions-model'
import type { PrActionText } from './pr-action-text'
import type { PrDetailText } from './pr-detail-text'
import type { PrActionController } from './PrActionStatus'
import { CandidatePicker, EditFooter, MarkdownEditor } from './PrEditors'
import { ThreadsSection } from './PrThreads'

type BadgeTone = 'neutral' | 'accent' | 'ok' | 'run' | 'ask' | 'stall' | 'fail'

function reviewerTone(state: PrReviewerState): BadgeTone {
  if (state === 'approved') return 'ok'
  if (state === 'changes') return 'fail'
  if (state === 'pending') return 'ask'
  return 'neutral'
}

export function checkTone(item: PrCheckItem): 'ok' | 'pending' | 'fail' {
  if (item.state === 'pass') return 'ok'
  if (item.state === 'fail') return 'fail'
  return 'pending'
}

export function ChecksList({ items, detailsLabel, onOpen }: { items: PrCheckItem[]; detailsLabel: string; onOpen: (url: string) => void }): ReactElement {
  return (
    <ul className="gh-pr-checks">
      {items.map((item) => (
        <li key={`${item.name}:${item.detail}`} className="gh-pr-check" data-state={checkTone(item)}>
          <StatusDot kind={checkTone(item)} />
          <span className="gh-pr-check__name" title={item.name}>{item.name}</span>
          <span className="gh-pr-check__state">{item.detail}</span>
          {item.url ? (
            <Button size="xs" variant="plain" onPress={() => onOpen(item.url)}>
              {detailsLabel}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function MetaRow({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }): ReactElement {
  return (
    <div className="gh-pr-meta">
      <span className="gh-pr-meta__label ui-meta-text">
        {icon}
        {label}
      </span>
      <span className="gh-pr-meta__value">{children}</span>
    </div>
  )
}

export interface CommentCardProps {
  item: PrTimelineItem
  cwd: string
  when: (iso: string) => string
  reviewBadge: ReactNode
}

export function CommentCard({ item, cwd, when, reviewBadge }: CommentCardProps): ReactElement {
  return (
    <li className="gh-pr-event" data-kind={item.kind}>
      <div className="gh-pr-event__head">
        <Avatar name={item.author || '?'} />
        <span className="gh-pr-event__author">{item.author}</span>
        {reviewBadge}
        <span className="gh-pr-event__time">{when(item.at)}</span>
      </div>
      {item.body ? (
        <div className="gh-pr-event__body">
          <Markdown text={item.body} sourceCwd={cwd} />
        </div>
      ) : null}
    </li>
  )
}

export function FloatingComment({ number, action, text }: { number: number; action: PrActionController; text: PrActionText }): ReactElement {
  const [draft, setDraft] = useState('')
  return (
    <div className="gh-pr-float">
      <DialogTrigger>
        <Button size="sm" variant="primary" icon={<MessageSquarePlus size={14} aria-hidden />} isDisabled={action.busy} data-testid="gh-pr-comment-open">
          {text.summary.comment}
        </Button>
        <Popover variant="panel" placement="top end" className="gh-pr-float__pop">
          <Dialog aria-label={text.summary.commentTitle} showClose={false} body="flush">
            {({ close }) => (
              <div className="gh-pr-act__form" data-testid="gh-pr-comment-box">
                <span className="ui-field__label">{text.summary.commentTitle}</span>
                <TextArea aria-label={text.summary.commentTitle} placeholder={text.comment.placeholder} value={draft} onChange={setDraft} rows={5} autoFocus isDisabled={action.busy} />
                <div className="gh-pr-act__footer">
                  <Button size="sm" variant="ghost" onPress={close} isDisabled={action.busy}>
                    {text.comment.cancel}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    isDisabled={!draft.trim()}
                    isPending={action.busy}
                    data-testid="gh-pr-comment-submit"
                    onPress={() => {
                      void action.run({ kind: 'comment', number, body: draft.trim() }).then((result) => {
                        if (!result?.ok) return
                        setDraft('')
                        close()
                      })
                    }}
                  >
                    {text.comment.submit}
                  </Button>
                </div>
              </div>
            )}
          </Dialog>
        </Popover>
      </DialogTrigger>
    </div>
  )
}

export interface PrSummaryTabProps {
  cwd: string
  detail: PrDetail
  dText: PrDetailText
  text: PrActionText
  action: PrActionController
  when: (iso: string) => string
  reviewBadge: (item: PrTimelineItem) => ReactNode
  openExternal: (url: string) => void
  checksDetailsLabel: string
  checksEmpty: string
  bodyEmpty: string
}

export function PrSummaryTab({ cwd, detail, dText, text, action, when, reviewBadge, openExternal, checksDetailsLabel, checksEmpty, bodyEmpty }: PrSummaryTabProps): ReactElement {
  const patchOf = (path: string): string => detail.files.find((file) => file.path === path)?.patch ?? ''
  const [descriptionOpen, setDescriptionOpen] = useState(true)
  const [checksOpen, setChecksOpen] = useState(false)
  const [commentsOpen, setCommentsOpen] = useState(true)
  const [editingBody, setEditingBody] = useState(false)
  const [bodyDraft, setBodyDraft] = useState('')
  const [hideBots, setHideBots] = useState(false)
  const [order, setOrder] = useState<'newest' | 'oldest'>('newest')
  const busy = action.busy
  const number = detail.number
  const requested = detail.reviewers.filter((item) => item.state === 'pending').map((item) => item.name)
  const comments = commentView(detail.timeline, { hideBots, order })

  const saveBody = async (): Promise<void> => {
    const result = await action.run({ kind: 'edit', number, body: bodyDraft })
    if (result?.ok) setEditingBody(false)
  }

  return (
    <>
      <section className="gh-pr-metas" aria-label={dText.reviewers}>
        <MetaRow icon={<Users size={14} aria-hidden />} label={dText.reviewers}>
          {detail.reviewers.length ? (
            detail.reviewers.map((reviewer) => (
              <span key={reviewer.name} className="gh-pr-meta__chip">
                <Avatar name={reviewer.name} />
                <span>{reviewer.name}</span>
                <Badge tone={reviewerTone(reviewer.state)}>{dText.reviewer[reviewer.state]}</Badge>
                {reviewer.state === 'pending' ? (
                  <IconButton
                    size="xs"
                    variant="ghost"
                    aria-label={text.edit.remove(reviewer.name)}
                    tooltip={text.edit.remove(reviewer.name)}
                    isDisabled={busy}
                    onPress={() => void action.run({ kind: 'edit', number, removeReviewers: [reviewer.name] })}
                  >
                    <X size={12} aria-hidden />
                  </IconButton>
                ) : null}
              </span>
            ))
          ) : (
            <span className="ui-meta-text">{text.summary.none}</span>
          )}
          <span className="gh-pr-meta__add">
            <CandidatePicker
              cwd={cwd}
              kind="reviewers"
              label={text.edit.addReviewer}
              exclude={[...requested, detail.author]}
              text={text}
              isDisabled={busy}
              testId="gh-pr-reviewers-add"
              onPick={(name) => void action.run({ kind: 'edit', number, addReviewers: [name] })}
            />
          </span>
        </MetaRow>
        <MetaRow icon={<Tag size={14} aria-hidden />} label={dText.labels}>
          {detail.labels.length ? (
            detail.labels.map((label) => (
              <span key={label} className="gh-pr-meta__chip">
                <Badge>{label}</Badge>
                <IconButton
                  size="xs"
                  variant="ghost"
                  aria-label={text.edit.remove(label)}
                  tooltip={text.edit.remove(label)}
                  isDisabled={busy}
                  onPress={() => void action.run({ kind: 'edit', number, removeLabels: [label] })}
                >
                  <X size={12} aria-hidden />
                </IconButton>
              </span>
            ))
          ) : (
            <span className="ui-meta-text">{text.summary.none}</span>
          )}
          <span className="gh-pr-meta__add">
            <CandidatePicker
              cwd={cwd}
              kind="labels"
              label={text.edit.addLabel}
              exclude={detail.labels}
              text={text}
              isDisabled={busy}
              testId="gh-pr-labels-add"
              onPick={(name) => void action.run({ kind: 'edit', number, addLabels: [name] })}
            />
          </span>
        </MetaRow>
      </section>
      <Collapsible className="gh-prd__section" isExpanded={descriptionOpen} onExpandedChange={setDescriptionOpen}>
        <CollapsibleHeader
          tone="emphasized"
          aria-label={descriptionOpen ? dText.hideDescription : dText.showDescription}
          data-testid="gh-pr-description-toggle"
          actions={
            editingBody ? undefined : (
              <IconButton
                size="xs"
                variant="ghost"
                aria-label={`${text.edit.edit} ${dText.description}`}
                tooltip={text.edit.edit}
                isDisabled={busy}
                onPress={() => {
                  action.reset()
                  setDescriptionOpen(true)
                  setBodyDraft(detail.body)
                  setEditingBody(true)
                }}
                data-testid="gh-pr-body-edit"
              >
                <Pencil size={12} aria-hidden />
              </IconButton>
            )
          }
        >
          {dText.description}
        </CollapsibleHeader>
        <CollapsiblePanel>
          {descriptionOpen && editingBody ? (
            <div className="gh-pr-act__form" data-testid="gh-pr-body-editor">
              <MarkdownEditor label={text.edit.body} value={bodyDraft} onChange={setBodyDraft} text={text.edit} cwd={cwd} rows={10} isDisabled={busy} showLabel={false} testId="gh-pr-body-md" />
              <EditFooter text={text.edit} busy={busy} canSave={bodyDraft !== detail.body} onSave={() => void saveBody()} onCancel={() => setEditingBody(false)} testId="gh-pr-body-save" />
            </div>
          ) : descriptionOpen ? (
            detail.body ? (
              <div className="gh-prd__markdown">
                <Markdown text={detail.body} sourceCwd={cwd} />
              </div>
            ) : (
              <span className="ui-meta-text">{bodyEmpty}</span>
            )
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
      <Collapsible className="gh-prd__section" isExpanded={checksOpen} onExpandedChange={setChecksOpen}>
        <CollapsibleHeader tone="emphasized" data-testid="gh-pr-checks-toggle">
          {text.summary.checksTitle(detail.checkItems.length)}
        </CollapsibleHeader>
        <CollapsiblePanel>
          {checksOpen ? (
            detail.checkItems.length ? (
              <ChecksList items={detail.checkItems} detailsLabel={checksDetailsLabel} onOpen={openExternal} />
            ) : (
              <span className="ui-meta-text">{checksEmpty}</span>
            )
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
      <ThreadsSection
        threads={detail.threads}
        truncated={detail.threadsTruncated}
        error={detail.threadsError}
        cwd={cwd}
        number={number}
        when={when}
        action={action}
        text={text}
        onOpen={openExternal}
        patchOf={patchOf}
      />
      <Collapsible className="gh-prd__section" isExpanded={commentsOpen} onExpandedChange={setCommentsOpen}>
        <CollapsibleHeader
          tone="emphasized"
          data-testid="gh-pr-comments-toggle"
          actions={
            <span className="gh-pr-comments__tools">
              <MenuTrigger>
                <Button size="xs" variant="ghost" icon={<ListFilter size={12} aria-hidden />} data-testid="gh-pr-comments-filter">
                  {comments.hidden ? text.summary.hidden(comments.hidden) : text.summary.filter}
                </Button>
                <Popover placement="bottom end">
                  <Menu aria-label={text.summary.filter} onAction={() => setHideBots((value) => !value)}>
                    <MenuItem id="bots" checked={hideBots}>
                      {text.summary.hideBots}
                    </MenuItem>
                  </Menu>
                </Popover>
              </MenuTrigger>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`${text.summary.orderLabel}: ${order === 'newest' ? text.summary.newest : text.summary.oldest}`}
                icon={order === 'newest' ? <ArrowDownWideNarrow size={12} aria-hidden /> : <ArrowUpNarrowWide size={12} aria-hidden />}
                onPress={() => setOrder((value) => (value === 'newest' ? 'oldest' : 'newest'))}
                data-testid="gh-pr-comments-order"
              >
                {order === 'newest' ? text.summary.newest : text.summary.oldest}
              </Button>
            </span>
          }
        >
          {text.summary.comments(comments.total)}
        </CollapsibleHeader>
        <CollapsiblePanel>
          {commentsOpen ? (
            comments.total === 0 ? (
              <span className="ui-meta-text">{text.summary.noComments}</span>
            ) : comments.items.length === 0 ? (
              <span className="ui-meta-text">{text.summary.allHidden(comments.hidden)}</span>
            ) : (
              <ol className="gh-pr-timeline" data-testid="gh-pr-comments">
                {comments.items.map((item) => (
                  <CommentCard key={item.id} item={item} cwd={cwd} when={when} reviewBadge={reviewBadge(item)} />
                ))}
              </ol>
            )
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
    </>
  )
}
