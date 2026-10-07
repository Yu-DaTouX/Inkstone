import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { HubActivity, HubApproval, HubCommand, HubMessage, HubTask } from '../../../../shared/agent-hub'
import { useT, type MessageKey, type TFunc } from '../../i18n'
import { Markdown } from '../chat/MessageParts'
import { Badge, Button, Input } from '../ui'
import { AttachmentPicker, AttachmentTray, SentAttachments, useAttachments } from './AgentAttachments'
import { agentName } from './AgentHubHome'

type Item =
  | { kind: 'prompt'; at: number }
  | { kind: 'activity'; at: number; activity: HubActivity }
  | { kind: 'message'; at: number; message: HubMessage }
  | { kind: 'approval'; at: number; approval: HubApproval }

const DELIVERY: Record<HubMessage['delivery'], [MessageKey, string]> = { queued: ['hub.delivery.queued', 'warn'], injected: ['hub.delivery.injected', 'ok'], typed: ['hub.delivery.typed', 'ok'], failed: ['hub.delivery.failed', 'err'] }

/** Who a message came from, read from the host's request key (actor prefix) and source task. */
function messageSource(t: TFunc, message: HubMessage, tasks: HubTask[]): { role: 'report' | 'self' | 'other'; label: string } {
  const key = message.requestKey ?? ''
  if (message.parentSessionId && message.kind === 'note') return { role: 'report', label: t('hub.from.reportToMain') }
  if (key.startsWith('pi:')) return { role: 'other', label: t('hub.from.main') }
  if (key.startsWith('desktop:')) return { role: 'self', label: t('hub.from.you') }
  if (key.startsWith('phone:')) return { role: 'self', label: t('hub.from.youPhone') }
  const from = tasks.find(task => task.id === message.fromTaskId)
  return { role: 'other', label: from ? t('hub.from.run', { name: agentName(from.agent) }) : t('hub.from.otherRun') }
}
const ORIGIN: Record<string, MessageKey> = { session: 'hub.from.main', desktop: 'hub.from.you', phone: 'hub.from.youPhone', run: 'hub.from.parentRun' }

/** Paths inside the run's worktree read as project-relative paths. */
function relative(text: string, workspace?: string): string {
  if (!workspace || !text) return text
  const variants = [workspace, workspace.replace(/\\/g, '/')].map(v => v.replace(/[\\/]+$/, ''))
  let out = text
  for (const v of variants) out = out.split(v + (v.includes('/') ? '/' : '\\')).join('').split(v).join('.')
  return out
}

function DiffBlock({ text }: { text: string }) {
  return <div className="agent-chat-diff">{text.split('\n').map((line, i) => {
    const kind = line.startsWith('@@') ? 'h' : line.startsWith('+') && !line.startsWith('+++') ? 'p' : line.startsWith('-') && !line.startsWith('---') ? 'm' : ''
    return <div key={i} className={kind ? `d-${kind}` : undefined}>{line || ' '}</div>
  })}</div>
}

function ActivityView({ item, task }: { item: HubActivity; task: HubTask }) {
  const t = useT()
  const text = relative(item.text, task.workspace), detail = item.detail ? relative(item.detail, task.workspace) : ''
  if (item.kind === 'say') return <div className="agent-chat-say">
    <div className="agent-chat-who"><span className="ui-letter-mark" aria-hidden>{agentName(task.agent).slice(0, 1)}</span>{agentName(task.agent)}</div>
    <Markdown text={text} sourceCwd={task.workspace} />
  </div>
  if (item.kind === 'patch') {
    const plus = detail.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length
    const minus = detail.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length
    return <details className="agent-chat-tool agent-chat-patch" open={item.status === 'running' || undefined}>
      <summary><span className="agent-chat-kind">{t('hub.chat.patch')}</span><span className="agent-chat-cmd" title={text}>{text || t('hub.chat.filePatch')}</span>
        {detail ? <span className="agent-chat-count"><span className="add">+{plus}</span> <span className="del">−{minus}</span></span> : null}</summary>
      {detail ? <DiffBlock text={detail} /> : null}
    </details>
  }
  if (item.kind === 'tool') return <details className="agent-chat-tool" open={item.status === 'running' || undefined}>
    <summary><span className="agent-chat-kind">{item.title ?? t('hub.chat.tool')}</span><span className="agent-chat-cmd" title={text}>{item.title === 'Shell' ? `$ ${text}` : text}</span>
      <span className={`agent-chat-state ui-status ${item.status === 'failed' ? 'err' : item.status === 'running' ? 'live' : 'ok'}`}>{item.status === 'running' ? <><i className="ui-status-dot" />{t('hub.status.running')}</> : item.status === 'failed' ? t('hub.status.failed') : t('hub.chat.done')}</span></summary>
    {detail ? <pre className="agent-chat-out">{detail}</pre> : null}
  </details>
  return <div className="agent-chat-note">{item.title ? <b>{item.title} · </b> : null}{text}</div>
}

/**
 * A managed run as a conversation: the instruction, the agent's narration, tool calls, patches,
 * approvals and handoff packets in time order. The host's events are the only source.
 */
export function AgentRunChat({ task, tasks, messages, approvals, busy, act, onDetails }: {
  task: HubTask
  tasks: HubTask[]
  messages: HubMessage[]
  approvals: HubApproval[]
  busy: boolean
  act(command: HubCommand): Promise<boolean>
  onDetails(): void
}) {
  const t = useT()
  const live = ['queued', 'preparing', 'running', 'waiting_input'].includes(task.status)
  const items = useMemo<Item[]>(() => [
    { kind: 'prompt' as const, at: task.createdAt },
    ...(task.activity ?? []).map(activity => ({ kind: 'activity' as const, at: activity.at, activity })),
    ...messages.filter(m => m.taskId === task.id).map(message => ({ kind: 'message' as const, at: message.createdAt, message })),
    ...approvals.filter(a => a.taskId === task.id && a.runId === task.runId && ['pending', 'sent'].includes(a.status)).map(approval => ({ kind: 'approval' as const, at: Number.MAX_SAFE_INTEGER, approval }))
  ].sort((a, b) => a.at - b.at), [task, messages, approvals])

  const root = useRef<HTMLDivElement>(null), follow = useRef(true)
  useLayoutEffect(() => { if (follow.current && root.current) root.current.scrollTop = root.current.scrollHeight }, [items])

  const [text, setText] = useState('')
  const attach = useAttachments()
  const send = async () => {
    if (!text.trim() && !attach.items.length) return
    const ok = await act({ action: 'send-packet', requestId: crypto.randomUUID(), toTaskId: task.id, summary: text.trim() || t('hub.chat.seeAttachments'), attachments: attach.inputs() })
    if (ok) { setText(''); attach.clear() }
  }

  return <div className="agent-chat" data-testid="agent-run-chat">
    <div className="agent-chat-stream" ref={root} onScroll={() => { const el = root.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
      {items.map((item, i) => {
        if (item.kind === 'prompt') return <div key="prompt" className="agent-chat-user">
          <div className="agent-chat-meta">{t(ORIGIN[task.createdBy ?? 'desktop'] ?? 'hub.from.you')} · {t('hub.chat.instruction')}
            {task.startArtifact ? <Badge>{t('hub.chat.carried', { n: task.startArtifact.files })}</Badge> : null}
            {task.inPlace ? <Badge>{t('hub.chat.inPlace')}</Badge> : null}</div>
          {task.prompt ? <div className="agent-chat-bubble-text">{task.prompt}</div> : <div className="agent-chat-bubble-text muted">{t('hub.chat.noInstruction')}</div>}
          <SentAttachments list={task.attachments} />
        </div>
        if (item.kind === 'activity') return <ActivityView key={item.activity.id} item={item.activity} task={task} />
        if (item.kind === 'message') {
          const m = item.message, [label, tone] = DELIVERY[m.delivery]
          const source = messageSource(t, m, tasks)
          const packet = m.kind === 'packet' && source.role !== 'self'
          return <div key={m.id} className={source.role === 'report' ? 'agent-chat-report' : packet ? 'agent-chat-packet' : 'agent-chat-user'}>
            <div className="agent-chat-meta">{source.label}{packet ? ` · ${t('hub.chat.packet')}` : ''}<Badge tone={tone as 'ok' | 'warn' | 'err'}>{t(label)}</Badge></div>
            <div className="agent-chat-bubble-text">{m.text}</div>
            <SentAttachments list={m.attachments} />
          </div>
        }
        const a = item.approval
        return <div key={a.id} className="agent-chat-approval" data-testid="agent-chat-approval">
          <div className="agent-chat-approval-q">{t(a.kind === 'question' ? 'hub.ask.question' : a.kind === 'file' ? 'hub.ask.file' : 'hub.ask.command', { name: agentName(task.agent) })}{a.title ? t('hub.ask.titleSuffix', { title: a.title }) : ''}</div>
          {a.detail ? <code className="agent-chat-approval-detail">{relative(a.detail, task.workspace)}</code> : null}
          <div className="agent-chat-approval-acts">
            {a.status === 'sent' ? <Badge>{t('hub.ask.sent')}</Badge> : a.kind === 'question'
              ? <Button size="sm" variant="primary" onClick={onDetails}>{t('hub.ask.answer')}</Button>
              : <><Button size="sm" variant="primary" disabled={busy} onClick={() => void act({ action: 'answer', approvalId: a.id, answer: 'accept' })}>{t('hub.ask.acceptOnce')}</Button>
                <Button size="sm" variant="danger" disabled={busy} onClick={() => void act({ action: 'answer', approvalId: a.id, answer: 'decline' })}>{t('hub.ask.decline')}</Button></>}
          </div>
          {i === items.length - 1 ? <span className="agent-chat-hint">{t('hub.ask.timeout')}</span> : null}
        </div>
      })}
      {live && task.status !== 'waiting_input' ? <div className="agent-chat-working"><i className="ui-status-dot" />{task.status === 'preparing' || task.status === 'queued' ? t('hub.chat.preparing') : t('hub.chat.working', { name: agentName(task.agent) })}</div> : null}
      {task.status === 'needs_review' ? <div className="agent-chat-end">
        <span>{t('hub.chat.needsReview')}</span><Button size="sm" onClick={onDetails}>{t('hub.approvals')}</Button>
      </div> : task.error && !live ? <div className="agent-chat-end err">{task.error}</div> : null}
    </div>
    <div className="agent-chat-composer" onDrop={attach.onDrop} onDragOver={e => e.preventDefault()}>
      <AttachmentTray state={attach} />
      <form className="agent-collab-send" onSubmit={e => { e.preventDefault(); void send() }}>
        <AttachmentPicker state={attach} disabled={!live || busy} />
        <Input aria-label={t('hub.chat.followUp')} value={text} onChange={e => setText(e.target.value)} onPaste={attach.onPaste} maxLength={4000}
          placeholder={live ? t('hub.chat.followUpPlaceholder', { name: agentName(task.agent) }) : t('hub.chat.endedPlaceholder')} disabled={!live} data-testid="agent-chat-input" />
        <Button type="submit" size="sm" variant="primary" icon="send" disabled={busy || !live || (!text.trim() && !attach.items.length)}>{t('hub.chat.send')}</Button>
      </form>
    </div>
  </div>
}
