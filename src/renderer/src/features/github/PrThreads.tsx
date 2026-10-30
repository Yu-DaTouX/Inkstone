import { useState, type ReactElement } from 'react'
import { ExternalLink, MessageSquareReply, Trash2 } from 'lucide-react'
import { Avatar, Badge, Button, Collapsible, CollapsibleHeader, CollapsiblePanel, IconButton, MiddleTruncate, Notice, TextArea } from '../../ui'
import { Markdown } from '../session/Markdown'
import type { PrThread } from './pr-model'
import { threadReplyTarget } from './pr-model'
import { lineExcerpt, type PendingComment } from './pr-actions-model'
import type { PrActionText } from './pr-action-text'
import type { PrActionController } from './PrActionStatus'

interface ThreadContext {
  cwd: string
  number: number
  when: (iso: string) => string
  action: PrActionController
  text: PrActionText
  onOpen: (url: string) => void
  patchOf: (path: string) => string
}

function Excerpt({ lines }: { lines: string[] }): ReactElement | null {
  if (!lines.length) return null
  return <pre className="gh-pr-thread__code">{lines.join('\n')}</pre>
}

export function ThreadCard({ thread, showPath, ctx }: { thread: PrThread; showPath: boolean; ctx: ThreadContext }): ReactElement {
  const { text, action } = ctx
  const [open, setOpen] = useState(!thread.isResolved)
  const [reply, setReply] = useState<string | null>(null)
  const target = threadReplyTarget(thread)
  const first = thread.comments[0]
  const excerpt = thread.isOutdated ? [] : lineExcerpt(ctx.patchOf(thread.path), thread.side, thread.startLine, thread.line)
  const send = async (): Promise<void> => {
    if (!reply?.trim() || target === null) return
    const result = await action.run({ kind: 'reply', number: ctx.number, commentId: target, body: reply.trim() })
    if (result?.ok) setReply(null)
  }
  return (
    <li className="gh-pr-thread" data-resolved={thread.isResolved ? '1' : undefined} data-testid={`gh-pr-thread-${target ?? thread.id}`}>
      <Collapsible isExpanded={open} onExpandedChange={setOpen}>
        <CollapsibleHeader
          size="compact"
          className="gh-pr-thread__head"
          tone={thread.isResolved ? 'muted' : 'emphasized'}
          data-testid={`gh-pr-thread-toggle-${target ?? thread.id}`}
          accessory={
            <span className="gh-pr-thread__badges">
              {thread.isResolved ? <Badge tone="ok">{text.threads.resolved}</Badge> : null}
              {thread.isOutdated ? <Badge>{text.threads.outdated}</Badge> : null}
              <span className="ui-meta-text">{text.threads.replies(thread.comments.length)}</span>
            </span>
          }
        >
          <span className="gh-pr-thread__where">
            {showPath ? <MiddleTruncate className="gh-pr-thread__path ui-num" value={thread.path} /> : null}
            <span className="ui-meta-text ui-num">{text.threads.where(thread.startLine, thread.line, thread.side)}</span>
            {!open && first ? <span className="gh-pr-thread__peek ui-meta-text">@{first.author || 'ghost'}: {first.body.replace(/\s+/g, ' ').slice(0, 80)}</span> : null}
          </span>
        </CollapsibleHeader>
        <CollapsiblePanel>
          {open ? (
            <div className="gh-pr-thread__body">
              <Excerpt lines={excerpt} />
              <ol className="gh-pr-thread__comments">
                {thread.comments.map((comment) => (
                  <li key={comment.id} className="gh-pr-thread__comment">
                    <div className="gh-pr-event__head">
                      <Avatar name={comment.author || '?'} />
                      <span className="gh-pr-event__author">{comment.author}</span>
                      <span className="gh-pr-event__time">{ctx.when(comment.at)}</span>
                      {comment.url ? (
                        <IconButton size="xs" variant="ghost" aria-label={text.threads.open} tooltip={text.threads.open} onPress={() => ctx.onOpen(comment.url)}>
                          <ExternalLink size={12} aria-hidden />
                        </IconButton>
                      ) : null}
                    </div>
                    {comment.body ? (
                      <div className="gh-pr-event__body">
                        <Markdown text={comment.body} sourceCwd={ctx.cwd} />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ol>
              {reply !== null ? (
                <div className="gh-pr-act__form" data-testid="gh-pr-reply-editor">
                  <TextArea
                    aria-label={text.threads.replyTitle(first?.author || '?')}
                    placeholder={text.threads.replyPlaceholder}
                    value={reply}
                    onChange={setReply}
                    rows={3}
                    size="sm"
                    autoFocus
                    isDisabled={action.busy}
                  />
                  <div className="gh-pr-act__footer">
                    <Button size="xs" variant="ghost" onPress={() => setReply(null)} isDisabled={action.busy}>
                      {text.threads.cancel}
                    </Button>
                    <Button size="xs" variant="primary" isDisabled={!reply.trim()} isPending={action.busy} onPress={() => void send()} data-testid="gh-pr-reply-send">
                      {text.threads.send}
                    </Button>
                  </div>
                </div>
              ) : target !== null ? (
                <div className="gh-pr-act__footer">
                  <Button
                    size="xs"
                    variant="ghost"
                    icon={<MessageSquareReply size={12} aria-hidden />}
                    isDisabled={action.busy}
                    onPress={() => setReply('')}
                    data-testid="gh-pr-reply-open"
                  >
                    {text.threads.reply}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
    </li>
  )
}

function ThreadNotices({ truncated, error, text }: { truncated: boolean; error: string; text: PrActionText }): ReactElement | null {
  if (error) return <Notice tone="ask" compact data-testid="gh-pr-threads-error">{text.threads.failed(error)}</Notice>
  if (truncated) return <Notice tone="ask" compact>{text.threads.truncated}</Notice>
  return null
}

export function orderThreads(threads: readonly PrThread[]): PrThread[] {
  return [...threads].sort((a, b) => Number(a.isResolved) - Number(b.isResolved))
}

export interface ThreadsSectionProps extends ThreadContext {
  threads: PrThread[]
  truncated: boolean
  error: string
}

export function ThreadsSection({ threads, truncated, error, ...ctx }: ThreadsSectionProps): ReactElement | null {
  const [open, setOpen] = useState(true)
  if (!threads.length && !truncated && !error) return null
  return (
    <Collapsible className="gh-prd__section" isExpanded={open} onExpandedChange={setOpen}>
      <CollapsibleHeader tone="emphasized" data-testid="gh-pr-threads-toggle">
        {ctx.text.threads.title(threads.length)}
      </CollapsibleHeader>
      <CollapsiblePanel>
        {open ? (
          <div className="gh-pr-threads">
            <ThreadNotices truncated={truncated} error={error} text={ctx.text} />
            {threads.length ? (
              <ul className="gh-pr-threads__list" data-testid="gh-pr-threads">
                {orderThreads(threads).map((thread) => (
                  <ThreadCard key={thread.id} thread={thread} showPath ctx={ctx} />
                ))}
              </ul>
            ) : (
              <span className="ui-meta-text">{ctx.text.threads.empty}</span>
            )}
          </div>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  )
}

export interface FileNotesProps extends ThreadContext {
  path: string
  threads: PrThread[]
  pending: PendingComment[]
  onRemovePending: (id: string) => void
}

export function FileNotes({ path, threads, pending, onRemovePending, ...ctx }: FileNotesProps): ReactElement | null {
  const total = threads.length + pending.length
  if (!total) return null
  const { text } = ctx
  const patch = ctx.patchOf(path)
  return (
    <section className="gh-pr-threads gh-pr-threads--file" aria-label={text.threads.fileNotes(total)} data-testid={`gh-pr-file-notes-${path}`}>
      <ul className="gh-pr-threads__list">
        {orderThreads(threads).map((thread) => (
          <ThreadCard key={thread.id} thread={thread} showPath={false} ctx={ctx} />
        ))}
        {pending.map((item) => (
          <li key={item.id} className="gh-pr-thread" data-pending="1" data-testid="gh-pr-file-pending">
            <div className="gh-pr-thread__pending-head">
              <Badge tone="accent">{text.threads.pending}</Badge>
              <span className="ui-meta-text ui-num">{text.threads.where(item.startLine, item.line, item.side)}</span>
              <span className="gh-pr-toolbar__spacer" />
              <IconButton
                size="xs"
                variant="ghost"
                aria-label={text.threads.deletePending}
                tooltip={text.threads.deletePending}
                isDisabled={ctx.action.busy}
                onPress={() => onRemovePending(item.id)}
              >
                <Trash2 size={12} aria-hidden />
              </IconButton>
            </div>
            <div className="gh-pr-thread__body">
              <Excerpt lines={lineExcerpt(patch, item.side, item.startLine, item.line)} />
              <p className="gh-pr-act__pending-body">{item.body}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
