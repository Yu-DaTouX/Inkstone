import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { HubActivity, HubApproval, HubCommand, HubMessage, HubTask } from '../../../../shared/agent-hub'
import { Markdown } from '../chat/MessageParts'
import { Badge, Button, Input } from '../ui'
import { AttachmentPicker, AttachmentTray, SentAttachments, useAttachments } from './AgentAttachments'
import { agentName } from './AgentHubHome'

type Item =
  | { kind: 'prompt'; at: number }
  | { kind: 'activity'; at: number; activity: HubActivity }
  | { kind: 'message'; at: number; message: HubMessage }
  | { kind: 'approval'; at: number; approval: HubApproval }

const DELIVERY: Record<HubMessage['delivery'], [string, string]> = { queued: ['等待发送', 'warn'], injected: ['已送达', 'ok'], typed: ['已写入终端', 'ok'], failed: ['投递失败', 'err'] }

/** Who a message came from, read from the host's request key (actor prefix) and source task. */
function messageSource(message: HubMessage, tasks: HubTask[]): string {
  const key = message.requestKey ?? ''
  if (message.parentSessionId && message.kind === 'note') return '回报给 砚主会话'
  if (key.startsWith('pi:')) return '来自 砚主会话'
  if (key.startsWith('desktop:')) return '你'
  if (key.startsWith('phone:')) return '你（手机）'
  const from = tasks.find(t => t.id === message.fromTaskId)
  return from ? `来自 ${agentName(from.agent)} 运行` : '来自 其他运行'
}
const ORIGIN: Record<string, string> = { session: '来自 砚主会话', desktop: '你', phone: '你（手机）', run: '来自 上级运行' }

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
  const text = relative(item.text, task.workspace), detail = item.detail ? relative(item.detail, task.workspace) : ''
  if (item.kind === 'say') return <div className="agent-chat-say">
    <div className="agent-chat-who"><span className="ui-letter-mark" aria-hidden>{agentName(task.agent).slice(0, 1)}</span>{agentName(task.agent)}</div>
    <Markdown text={text} sourceCwd={task.workspace} />
  </div>
  if (item.kind === 'patch') {
    const plus = detail.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length
    const minus = detail.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length
    return <details className="agent-chat-tool agent-chat-patch" open={item.status === 'running' || undefined}>
      <summary><span className="agent-chat-kind">改动</span><span className="agent-chat-cmd" title={text}>{text || '文件改动'}</span>
        {detail ? <span className="agent-chat-count"><span className="add">+{plus}</span> <span className="del">−{minus}</span></span> : null}</summary>
      {detail ? <DiffBlock text={detail} /> : null}
    </details>
  }
  if (item.kind === 'tool') return <details className="agent-chat-tool" open={item.status === 'running' || undefined}>
    <summary><span className="agent-chat-kind">{item.title ?? '工具'}</span><span className="agent-chat-cmd" title={text}>{item.title === 'Shell' ? `$ ${text}` : text}</span>
      <span className={`agent-chat-state ui-status ${item.status === 'failed' ? 'err' : item.status === 'running' ? 'live' : 'ok'}`}>{item.status === 'running' ? <><i className="ui-status-dot" />运行中</> : item.status === 'failed' ? '失败' : '完成'}</span></summary>
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
    const ok = await act({ action: 'send-packet', requestId: crypto.randomUUID(), toTaskId: task.id, summary: text.trim() || '见附件', attachments: attach.inputs() })
    if (ok) { setText(''); attach.clear() }
  }

  return <div className="agent-chat" data-testid="agent-run-chat">
    <div className="agent-chat-stream" ref={root} onScroll={() => { const el = root.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
      {items.map((item, i) => {
        if (item.kind === 'prompt') return <div key="prompt" className="agent-chat-user">
          <div className="agent-chat-meta">{ORIGIN[task.createdBy ?? 'desktop'] ?? '你'} · 派活指令
            {task.startArtifact ? <Badge>带上 {task.startArtifact.files} 处未提交改动</Badge> : null}
            {task.inPlace ? <Badge>在项目目录运行</Badge> : null}</div>
          {task.prompt ? <div className="agent-chat-bubble-text">{task.prompt}</div> : <div className="agent-chat-bubble-text muted">（没有初始指令）</div>}
          <SentAttachments list={task.attachments} />
        </div>
        if (item.kind === 'activity') return <ActivityView key={item.activity.id} item={item.activity} task={task} />
        if (item.kind === 'message') {
          const m = item.message, [label, tone] = DELIVERY[m.delivery]
          const source = messageSource(m, tasks)
          const outgoing = source.startsWith('回报')
          return <div key={m.id} className={outgoing ? 'agent-chat-report' : m.kind === 'packet' && !source.startsWith('你') ? 'agent-chat-packet' : 'agent-chat-user'}>
            <div className="agent-chat-meta">{source}{m.kind === 'packet' && !source.startsWith('你') ? ' · 交接包' : ''}<Badge tone={tone as 'ok' | 'warn' | 'err'}>{label}</Badge></div>
            <div className="agent-chat-bubble-text">{m.text}</div>
            <SentAttachments list={m.attachments} />
          </div>
        }
        const a = item.approval
        return <div key={a.id} className="agent-chat-approval" data-testid="agent-chat-approval">
          <div className="agent-chat-approval-q">{agentName(task.agent)} {a.kind === 'question' ? '有问题需要你回答' : a.kind === 'file' ? '想修改文件' : '想运行命令'}{a.title ? `：${a.title}` : ''}</div>
          {a.detail ? <code className="agent-chat-approval-detail">{relative(a.detail, task.workspace)}</code> : null}
          <div className="agent-chat-approval-acts">
            {a.status === 'sent' ? <Badge>已答复，等待确认</Badge> : a.kind === 'question'
              ? <Button size="sm" variant="primary" onClick={onDetails}>去回答</Button>
              : <><Button size="sm" variant="primary" disabled={busy} onClick={() => void act({ action: 'answer', approvalId: a.id, answer: 'accept' })}>批准一次</Button>
                <Button size="sm" variant="danger" disabled={busy} onClick={() => void act({ action: 'answer', approvalId: a.id, answer: 'decline' })}>拒绝</Button></>}
          </div>
          {i === items.length - 1 ? <span className="agent-chat-hint">超过两分钟未答复会自动拒绝</span> : null}
        </div>
      })}
      {live && task.status !== 'waiting_input' ? <div className="agent-chat-working"><i className="ui-status-dot" />{task.status === 'preparing' || task.status === 'queued' ? '正在准备工作区…' : `${agentName(task.agent)} 正在工作`}</div> : null}
      {task.status === 'needs_review' ? <div className="agent-chat-end">
        <span>执行结束，成果已冻结，等你验收。</span><Button size="sm" onClick={onDetails}>审批与成果</Button>
      </div> : task.error && !live ? <div className="agent-chat-end err">{task.error}</div> : null}
    </div>
    <div className="agent-chat-composer" onDrop={attach.onDrop} onDragOver={e => e.preventDefault()}>
      <AttachmentTray state={attach} />
      <form className="agent-collab-send" onSubmit={e => { e.preventDefault(); void send() }}>
        <AttachmentPicker state={attach} disabled={!live || busy} />
        <Input aria-label="补充要求" value={text} onChange={e => setText(e.target.value)} onPaste={attach.onPaste} maxLength={4000}
          placeholder={live ? `发送补充要求，作为新一轮输入交给 ${agentName(task.agent)}` : '运行已结束，不能再发送'} disabled={!live} data-testid="agent-chat-input" />
        <Button type="submit" size="sm" variant="primary" icon="send" disabled={busy || !live || (!text.trim() && !attach.items.length)}>发送</Button>
      </form>
    </div>
  </div>
}
