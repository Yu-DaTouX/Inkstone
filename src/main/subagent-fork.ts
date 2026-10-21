import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface SubagentForkSource {
  cwd: string
  piBin?: string
  args: string[]
  env: Record<string, string | undefined>
  sessionFile: string
  model: string
  thinkingLevel?: string
  contextTokens?: number
  contextWindow?: number
}

export const FORK_CONTEXT_LIMIT = 0.6

export const FORK_PLACEHOLDER = 'Forked subagent started. Its result goes to the parent conversation.'

const VALUE_FLAGS = new Set(['--session-dir', '--session', '--fork', '--session-id', '--model', '--thinking'])
const SESSION_SWITCHES = new Set(['--continue', '-c', '--resume', '-r', '--no-session'])

export function forkPiArgs(
  parentArgs: readonly string[],
  options: { sessionDir: string; sessionFile: string; model: string; thinkingLevel?: string }
): string[] {
  const kept: string[] = []
  for (let i = 0; i < parentArgs.length; i += 1) {
    const arg = parentArgs[i]
    if (VALUE_FLAGS.has(arg)) {
      i += 1
      continue
    }
    if (SESSION_SWITCHES.has(arg)) continue
    kept.push(arg)
  }
  return [
    ...kept,
    '--session-dir', options.sessionDir,
    '--session', options.sessionFile,
    '--model', options.model,
    ...(options.thinkingLevel ? ['--thinking', options.thinkingLevel] : [])
  ]
}

export function forkContextError(source: Pick<SubagentForkSource, 'contextTokens' | 'contextWindow'>): string | undefined {
  const { contextTokens, contextWindow } = source
  if (!contextTokens || !contextWindow || contextTokens <= contextWindow * FORK_CONTEXT_LIMIT) return undefined
  const percent = Math.round((100 * contextTokens) / contextWindow)
  return `当前会话上下文已用 ${percent}%，fork 子代理会继承整段上下文，剩余空间不够它干活。先压缩当前会话，或改派普通子代理并把需要的背景写进任务`
}

interface SessionEntry {
  type?: string
  id?: string
  parentId?: string | null
  message?: {
    role?: string
    toolCallId?: string
    content?: Array<{ type?: string; id?: string; name?: string }>
  }
  [key: string]: unknown
}

function entryId(taken: Set<string>): string {
  for (;;) {
    const id = randomBytes(4).toString('hex')
    if (!taken.has(id)) {
      taken.add(id)
      return id
    }
  }
}

export async function writeForkSession(
  sourceFile: string,
  dir: string,
  now = new Date()
): Promise<{ file: string; sessionId: string; placeholders: number }> {
  const entries: SessionEntry[] = []
  for (const line of (await readFile(sourceFile, 'utf8')).split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line) as SessionEntry)
    } catch {
    }
  }
  const header = entries.find((entry) => entry?.type === 'session')
  if (!header || typeof header.id !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(header.id)) {
    throw new Error('来源会话文件缺少会话头，不能派 fork 子代理')
  }
  const body = entries.filter((entry) => entry?.type !== 'session')
  const byId = new Map<string, SessionEntry>()
  for (const entry of body) if (typeof entry.id === 'string') byId.set(entry.id, entry)
  const leaf = body.at(-1)
  const branch: SessionEntry[] = []
  for (let entry = leaf; entry && branch.length <= body.length; entry = entry.parentId ? byId.get(entry.parentId) : undefined) branch.push(entry)
  branch.reverse()

  let lastAssistant = -1
  branch.forEach((entry, index) => {
    if (entry.type === 'message' && entry.message?.role === 'assistant') lastAssistant = index
  })
  const answered = new Set(
    branch.slice(lastAssistant + 1)
      .filter((entry) => entry.type === 'message' && entry.message?.role === 'toolResult')
      .map((entry) => entry.message?.toolCallId)
  )
  const pending = lastAssistant < 0
    ? []
    : (branch[lastAssistant].message?.content ?? []).filter((part) => part?.type === 'toolCall' && typeof part.id === 'string' && !answered.has(part.id))

  const taken = new Set(byId.keys())
  const timestamp = now.toISOString()
  let parentId = typeof leaf?.id === 'string' ? leaf.id : null
  const placeholders = pending.map((call) => {
    const id = entryId(taken)
    const entry = {
      type: 'message',
      id,
      parentId,
      timestamp,
      message: {
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: FORK_PLACEHOLDER }],
        isError: false,
        timestamp: now.getTime()
      }
    }
    parentId = id
    return entry
  })

  await mkdir(dir, { recursive: true })
  const file = join(dir, `${timestamp.replace(/[:.]/g, '-')}_${header.id}.jsonl`)
  const lines = [{ ...header, timestamp, parentSession: sourceFile }, ...body, ...placeholders].map((entry) => JSON.stringify(entry))
  await writeFile(file, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'wx' })
  return { file, sessionId: header.id, placeholders: placeholders.length }
}

export function forkPrompt(task: string): string {
  return [
    '<fork-directive>',
    'You are a forked worker. Everything above is the parent conversation, inherited so you can act with its full context. The parent keeps working on its own and only sees your final message.',
    '- Do only the task below; do not pick up the parent\'s other plans or the placeholder tool result above.',
    '- Do not start subagents, ask the user questions, or use the to-do panel.',
    '- Finish with a concise report: what you found or changed, the files involved, and anything left open.',
    '',
    task,
    '</fork-directive>'
  ].join('\n')
}
