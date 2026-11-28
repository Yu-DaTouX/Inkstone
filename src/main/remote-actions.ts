import { createHash } from 'node:crypto'
import { pick } from '../shared/ui-lang'
import {
  REMOTE_MESSAGE_MAX_BYTES,
  type RemoteAction,
  type RemoteActionArgs,
  type RemoteAnswer,
  type RemoteDeviceSummary,
  type RemoteImageInput,
  type RemoteQueueOp
} from '../shared/remote-protocol'
import type { RemoteOperationResult, RemoteServerHandlers } from './remote-server'

export const ACTION_MAX_BODY_BYTES = 64 * 1024
export const VOICE_MAX_BODY_BYTES = 6 * 1024 * 1024
export const MAX_MESSAGE_CHARS = 20_000
const MAX_NAME_CHARS = 200
const SESSION_ID_MAX = 200

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= SESSION_ID_MAX && !/[\r\n]/.test(value)
}

function validRunId(value: unknown): value is string {
  return typeof value === 'string' && /^r[1-9]\d{0,8}$/.test(value)
}

function validSubagentId(value: unknown): value is string {
  return typeof value === 'string' && /^sub-[a-zA-Z0-9-]{1,120}$/.test(value)
}

export function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

function validQuestionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value)
}

export function validateRemoteImages(value: unknown): RemoteImageInput[] | null {
  if (!Array.isArray(value) || value.length > 4) return null
  const images: RemoteImageInput[] = []
  for (const item of value) {
    if (!isRecord(item) || !['image/jpeg', 'image/png', 'image/webp'].includes(String(item.mimeType)) || typeof item.data !== 'string') return null
    if (!item.data || item.data.length > 2_796_204 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data) || item.data.length % 4 !== 0) return null
    const bytes = Buffer.from(item.data, 'base64')
    if (bytes.length > 2 * 1024 * 1024) return null
    const valid = item.mimeType === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : item.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    if (!valid) return null
    images.push({ mimeType: item.mimeType as RemoteImageInput['mimeType'], data: item.data })
  }
  return images
}

export function parseRemoteQueueOp(body: unknown): RemoteQueueOp | null {
  if (!isRecord(body)) return null
  const target = (value: unknown): { id: string; expect: string } | null => {
    if (!isRecord(value) || typeof value.id !== 'string' || !/^q-[a-z0-9]{1,16}$/.test(value.id)) return null
    if (typeof value.expect !== 'string' || !/^[0-9a-f]{64}$/.test(value.expect)) return null
    return { id: value.id, expect: value.expect }
  }
  if (body.op === 'clear') {
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 40) return null
    const items = body.items.map(target)
    return items.every((item) => item !== null) ? { op: 'clear', items: items as Array<{ id: string; expect: string }> } : null
  }
  if (body.op !== 'remove' && body.op !== 'steer' && body.op !== 'edit') return null
  if (!target(body)) return null
  if (typeof body.id !== 'string' || typeof body.expect !== 'string') return null
  if (body.op !== 'edit') return { op: body.op, id: body.id, expect: body.expect }
  if (!validText(body.text, MAX_MESSAGE_CHARS)) return null
  return { op: 'edit', id: body.id, expect: body.expect, text: body.text }
}

export function fingerprintOf(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

export interface ActionContext {
  handlers: RemoteServerHandlers
  device: RemoteDeviceSummary | null
  info(): RemoteOperationResult
  renameDevice(name: string): Promise<RemoteOperationResult>
  revokeSelf(): Promise<RemoteOperationResult>
}

interface ActionSpec<A extends RemoteAction> {
  maxBytes?: number
  paired?: boolean
  idempotency?: { required: boolean | ((args: RemoteActionArgs[A]) => boolean); fingerprint?: (args: RemoteActionArgs[A]) => string }
  parse(body: Record<string, unknown>): RemoteActionArgs[A] | string
  run(ctx: ActionContext, args: RemoteActionArgs[A]): Promise<RemoteOperationResult> | RemoteOperationResult
}

const unsupported = (): RemoteOperationResult => ({ ok: false, status: 404, error: pick('请更新电脑端', 'Update the desktop app') })
const BAD_SESSION = pick('会话 id 无效', 'Invalid session id')
const BAD_SUBAGENT = pick('子 Agent标识无效', 'Invalid subagent id')
const BAD_MESSAGE = pick('消息不能为空且不得超过 20,000 个字符', 'Message must not be empty or exceed 20,000 characters')
const none = (): Record<string, never> => ({})

function session(body: Record<string, unknown>): { sessionId: string } | string {
  return validSessionId(body.sessionId) ? { sessionId: body.sessionId } : BAD_SESSION
}

function subagent(body: Record<string, unknown>): { sessionId: string; runId: string } | string {
  return validSessionId(body.sessionId) && validSubagentId(body.runId) ? { sessionId: body.sessionId, runId: body.runId } : BAD_SUBAGENT
}

type SessionRead = 'session.subagents' | 'session.jobs' | 'session.workflows' | 'session.branches' | 'session.insight' | 'session.models'

function sessionRead<A extends SessionRead>(handler: (h: RemoteServerHandlers) => ((sessionId: string) => Promise<RemoteOperationResult>) | undefined): ActionSpec<A> {
  return {
    parse: session,
    run: (ctx, args) => handler(ctx.handlers)?.((args as { sessionId: string }).sessionId) ?? unsupported()
  } as ActionSpec<A>
}

function withSession<T extends object>(body: Record<string, unknown>, rest: T | string): ({ sessionId: string } & T) | string {
  const base = session(body)
  if (typeof base === 'string') return base
  if (typeof rest === 'string') return rest
  return { ...base, ...rest }
}

export const REMOTE_ACTIONS: { [A in RemoteAction]: ActionSpec<A> } = {
  info: { parse: none, run: (ctx) => ctx.info() },
  status: { parse: none, run: async (ctx) => ({ ok: true, data: await ctx.handlers.snapshot() }) },
  sessions: {
    parse: none,
    run: async (ctx) => {
      const snapshot = await ctx.handlers.snapshot()
      return { ok: true, data: { sessions: isRecord(snapshot) && Array.isArray(snapshot.sessions) ? snapshot.sessions : [] } }
    }
  },
  questions: { parse: none, run: async (ctx) => ({ ok: true, data: { questions: ctx.handlers.questions ? await ctx.handlers.questions() : [] } }) },
  quota: { parse: none, run: (ctx) => ctx.handlers.quota?.() ?? unsupported() },
  usage: {
    parse: (body) => {
      const range = body.range ?? '7d'
      return range === '7d' || range === '30d' || range === 'all' ? { range } : pick('统计范围无效', 'Invalid usage range')
    },
    run: (ctx, args) => ctx.handlers.usage?.(args.range) ?? unsupported()
  },
  search: {
    parse: (body) => ({ q: typeof body.q === 'string' ? body.q.slice(0, 200) : '' }),
    run: (ctx, args) => ctx.handlers.search?.(args.q, 30) ?? unsupported()
  },
  'session.history': {
    parse: (body) => {
      if (!validSessionId(body.sessionId)) return BAD_SESSION
      if (body.before !== undefined && (typeof body.before !== 'string' || !body.before || body.before.length > 2000 || /[\r\n]/.test(body.before))) return pick('历史游标无效', 'Invalid history cursor')
      const limit = Number(body.limit ?? 200)
      return { sessionId: body.sessionId, limit: Number.isFinite(limit) ? Math.min(500, Math.max(1, Math.floor(limit))) : 200, ...(typeof body.before === 'string' ? { before: body.before } : {}) }
    },
    run: (ctx, args) => ctx.handlers.history(args.sessionId, args.limit ?? 200, args.before)
  },
  'session.subagents': sessionRead((h) => h.subagents),
  'session.jobs': sessionRead((h) => h.jobs),
  'session.workflows': sessionRead((h) => h.workflows),
  'session.branches': sessionRead((h) => h.branches),
  'session.insight': sessionRead((h) => h.insight),
  'session.models': sessionRead((h) => h.models),
  'session.new': {
    idempotency: { required: false, fingerprint: (args) => `project:${args.projectId ?? ''}${args.worktree ? ':worktree' : ''}` },
    parse: (body) => {
      if (body.projectId !== undefined && !validText(body.projectId, 200)) return pick('项目 id 无效', 'Invalid project id')
      return { ...(typeof body.projectId === 'string' ? { projectId: body.projectId } : {}), ...(body.worktree === true ? { worktree: true } : {}) }
    },
    run: (ctx, args) => ctx.handlers.command({ action: 'new', ...args })
  },
  'session.select': { parse: session, run: (ctx, args) => ctx.handlers.command({ action: 'select', sessionId: args.sessionId }) },
  'session.send': {
    maxBytes: REMOTE_MESSAGE_MAX_BYTES,
    idempotency: {
      required: (args) => !!args.images?.length,
      fingerprint: (args) => fingerprintOf('send', args.text, args.mode ?? null, args.images?.map((image) => [image.mimeType, image.data.length, createHash('sha256').update(image.data).digest('hex')]) ?? [])
    },
    parse: (body) => {
      let images: RemoteImageInput[] | undefined
      if (body.images !== undefined) {
        images = validateRemoteImages(body.images) ?? undefined
        if (!images) return pick('最多 4 张图片，每张不超过 2MB，仅支持 JPEG、PNG、WebP', 'Up to 4 images, 2MB each, JPEG, PNG or WebP only')
      }
      if (typeof body.text !== 'string' || body.text.length > MAX_MESSAGE_CHARS || (!body.text.trim() && !images?.length)) return BAD_MESSAGE
      const mode = body.mode === 'steer' || body.mode === 'followUp' ? body.mode : undefined
      return withSession(body, { text: body.text, ...(images ? { images } : {}), ...(mode ? { mode } : {}) })
    },
    run: (ctx, args) => ctx.handlers.command({ action: 'send', sessionId: args.sessionId, text: args.text, images: args.images, mode: args.mode })
  },
  'session.model': {
    idempotency: { required: true, fingerprint: (args) => fingerprintOf('model', args.provider, args.modelId) },
    parse: (body) => withSession(body, validText(body.provider, 200) && validText(body.modelId, 300) ? { provider: body.provider, modelId: body.modelId } : pick('模型标识无效', 'Invalid model id')),
    run: (ctx, args) => ctx.handlers.models ? ctx.handlers.command({ action: 'model', ...args }) : unsupported()
  },
  'session.thinking': {
    idempotency: { required: false, fingerprint: (args) => fingerprintOf('thinking', args.level) },
    parse: (body) => withSession(body, validText(body.level, 40) ? { level: body.level } : pick('思考档位无效', 'Invalid thinking level')),
    run: (ctx, args) => ctx.handlers.models ? ctx.handlers.command({ action: 'thinking', ...args }) : unsupported()
  },
  'session.flags': {
    idempotency: { required: false, fingerprint: (args) => `flags:${args.sessionId}:${JSON.stringify({ pinned: args.pinned, archived: args.archived })}` },
    parse: (body) => {
      const flags: { pinned?: boolean; archived?: boolean } = {}
      if (typeof body.pinned === 'boolean') flags.pinned = body.pinned
      if (typeof body.archived === 'boolean') flags.archived = body.archived
      return withSession(body, Object.keys(flags).length ? flags : pick('需要 pinned 或 archived', 'pinned or archived is required'))
    },
    run: (ctx, { sessionId, ...flags }) => ctx.handlers.sessionFlags?.(sessionId, flags) ?? unsupported()
  },
  'session.delete': {
    paired: true,
    idempotency: { required: false, fingerprint: (args) => `delete:${args.sessionId}` },
    parse: (body) => withSession(body, body.confirm === true ? { confirm: true as const } : pick('删除需要明确确认', 'Deletion requires explicit confirmation')),
    run: (ctx, args) => ctx.handlers.deleteSession?.(args.sessionId) ?? unsupported()
  },
  'session.queue': {
    idempotency: { required: true, fingerprint: (args) => fingerprintOf('queue', args.op) },
    parse: (body) => {
      const op = parseRemoteQueueOp(body.op)
      return withSession(body, op ? { op } : pick('排队操作无效', 'Invalid queue operation'))
    },
    run: (ctx, args) => ctx.handlers.queue?.(args.sessionId, args.op) ?? unsupported()
  },
  'session.compact': {
    idempotency: { required: false, fingerprint: (args) => `compact:${args.sessionId}` },
    parse: session,
    run: (ctx, args) => ctx.handlers.compact?.(args.sessionId) ?? unsupported()
  },
  'session.branch': {
    idempotency: { required: false, fingerprint: (args) => `branch:${args.sessionId}:${args.branch}` },
    parse: (body) => withSession(body, validText(body.branch, 250) ? { branch: body.branch } : pick('分支名无效', 'Invalid branch name')),
    run: (ctx, args) => ctx.handlers.switchBranch?.(args.sessionId, args.branch) ?? unsupported()
  },
  'session.rename': {
    parse: (body) => withSession(body, validText(body.name, MAX_NAME_CHARS) ? { name: body.name.trim() } : pick('名称不能为空且不得超过 200 个字符', 'Name must not be empty or exceed 200 characters')),
    run: (ctx, args) => ctx.handlers.command({ action: 'rename', ...args })
  },
  'subagent.patch': { parse: subagent, run: (ctx, args) => ctx.handlers.subagentPatch?.(args.sessionId, args.runId) ?? unsupported() },
  'subagent.stop': {
    idempotency: { required: false, fingerprint: (args) => `subagent-stop:${args.sessionId}:${args.runId}` },
    parse: subagent,
    run: (ctx, args) => ctx.handlers.stopSubagent?.(args.sessionId, args.runId) ?? unsupported()
  },
  'subagent.review': {
    paired: true,
    idempotency: { required: true, fingerprint: (args) => `subagent-${args.action}:${args.sessionId}:${args.runId}` },
    parse: (body) => {
      const base = subagent(body)
      if (typeof base === 'string') return base
      if (body.action !== 'merge' && body.action !== 'discard') return pick('处置方式无效', 'Invalid review action')
      if (body.confirm !== true) return pick('合并或放弃需要明确确认', 'Merging or discarding requires explicit confirmation')
      return { ...base, action: body.action, confirm: true as const }
    },
    run: (ctx, args) => ctx.handlers.reviewSubagent?.(args.sessionId, args.runId, args.action) ?? unsupported()
  },
  'subagent.send': {
    idempotency: { required: true, fingerprint: (args) => fingerprintOf('subagent-send', args.sessionId, args.runId, args.text) },
    parse: (body) => {
      const base = subagent(body)
      if (typeof base === 'string') return base
      return validText(body.text, MAX_MESSAGE_CHARS) ? { ...base, text: body.text } : BAD_MESSAGE
    },
    run: (ctx, args) => ctx.handlers.sendSubagent?.(args.sessionId, args.runId, args.text) ?? unsupported()
  },
  'job.stop': {
    idempotency: { required: true, fingerprint: (args) => `job-stop:${args.sessionId}:${args.jobId}` },
    parse: (body) => validSessionId(body.sessionId) && typeof body.jobId === 'string' && /^term-job-[a-z0-9]{1,16}-\d{1,9}$/.test(body.jobId)
      ? { sessionId: body.sessionId, jobId: body.jobId }
      : pick('后台任务标识无效', 'Invalid background task id'),
    run: (ctx, args) => ctx.handlers.stopJob?.(args.sessionId, args.jobId) ?? unsupported()
  },
  'workflow.control': {
    idempotency: { required: true, fingerprint: (args) => `workflow-${args.action}:${args.sessionId}:${args.workflowId}` },
    parse: (body) => validSessionId(body.sessionId) && typeof body.workflowId === 'string' && /^wf-[0-9a-f]{8}$/.test(body.workflowId) && (body.action === 'pause' || body.action === 'resume' || body.action === 'stop')
      ? { sessionId: body.sessionId, workflowId: body.workflowId, action: body.action }
      : pick('工作流标识无效', 'Invalid workflow id'),
    run: (ctx, args) => ctx.handlers.workflowControl?.(args.sessionId, args.workflowId, args.action) ?? unsupported()
  },
  'question.answer': {
    idempotency: { required: true },
    parse: (body) => {
      if (!validQuestionId(body.questionId)) return pick('问题 id 无效', 'Invalid question id')
      const given = isRecord(body.answer) ? body.answer : {}
      let answer: RemoteAnswer
      if (given.cancelled === true) answer = { cancelled: true }
      else if (typeof given.confirmed === 'boolean') answer = { confirmed: given.confirmed }
      else if (typeof given.value === 'string' && given.value.length <= MAX_MESSAGE_CHARS) answer = { value: given.value }
      else return pick('回答需要 value、confirmed 或 cancelled 之一', 'The answer needs one of value, confirmed or cancelled')
      return { questionId: body.questionId, answer }
    },
    run: (ctx, args) => ctx.handlers.answer?.(args.questionId, args.answer) ?? unsupported()
  },
  'question.approval': {
    paired: true,
    idempotency: { required: true },
    parse: (body) => {
      if (!validQuestionId(body.questionId) || !(body.sessionId === null || validSessionId(body.sessionId)) ||
          !(validRunId(body.runId) || (typeof body.runId === 'string' && /^approval:[0-9a-f-]{36}$/.test(body.runId))) ||
          typeof body.confirmed !== 'boolean' || typeof body.digest !== 'string' || !/^[0-9a-f]{64}$/.test(body.digest) ||
          !(body.scope === undefined || ((body.scope === 'once' || body.scope === 'session') && body.confirmed === true))) {
        return pick('人工批准必须绑定有效的问题、会话、运行和操作摘要', 'Manual approval must be bound to a valid question, session, run and action digest')
      }
      return { questionId: body.questionId, sessionId: body.sessionId, runId: body.runId, digest: body.digest, confirmed: body.confirmed, ...(body.scope === 'session' ? { scope: 'session' as const } : {}) }
    },
    run: (ctx, { questionId, ...answer }) => ctx.handlers.humanApproval?.(questionId, answer) ?? unsupported()
  },
  'run.abort': {
    idempotency: { required: false, fingerprint: (args) => fingerprintOf('abort', args.runId) },
    parse: (body) => validRunId(body.runId) ? { runId: body.runId } : pick('中止操作必须提供有效的目标 runId', 'Abort requires a valid target runId'),
    run: (ctx, args) => ctx.handlers.command({ action: 'abort', runId: args.runId })
  },
  'voice.transcribe': {
    paired: true,
    maxBytes: VOICE_MAX_BODY_BYTES,
    parse: (body) => typeof body.wav === 'string' && body.wav ? { wav: body.wav } : pick('录音为空', 'Recording is empty'),
    run: (ctx, args) => ctx.handlers.transcribe?.(new Uint8Array(Buffer.from(args.wav, 'base64'))) ?? unsupported()
  },
  'device.rename': {
    paired: true,
    parse: (body) => validText(body.name, 60) ? { name: body.name } : pick('设备名称需要 1–60 个字符', 'Device name must be 1–60 characters'),
    run: (ctx, args) => ctx.renameDevice(args.name)
  },
  'device.revoke': { paired: true, parse: none, run: (ctx) => ctx.revokeSelf() }
}

export function remoteAction(name: string): ActionSpec<RemoteAction> | null {
  return Object.hasOwn(REMOTE_ACTIONS, name) ? (REMOTE_ACTIONS[name as RemoteAction] as unknown as ActionSpec<RemoteAction>) : null
}
