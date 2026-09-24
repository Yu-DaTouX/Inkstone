/**
 * pi 的原始消息类型 → UIMessage 的归一化。
 *
 * 为什么单独一个文件（原来在 agent.ts 里）：
 *   会话文件解析器（session-reader.ts）也要用它 —— 而 agent.ts 依赖 sessions.ts，
 *   如果让 sessions.ts 或 session-reader.ts 反向 import agent.ts 就会成环。
 *   这里只依赖 shared/ipc，谁都能安全地 import。
 *
 * 协议知识仍然集中：pi 的**字段名**只出现在这个文件与 agent.ts 里
 * （HANDOFF §9 原则 1）。
 */
import type { Usage, UIMessage, UIToolCall } from '../shared/ipc'

/* pi 的原始类型（只在这里出现） */

export interface PiContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: unknown
  /** 图片块（ImageContent） */
  data?: string
  mimeType?: string
}

export interface PiMessage {
  role: string
  content?: string | PiContentBlock[]
  usage?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    totalTokens?: number
    cost?: { total?: number }
  }
  model?: string
  stopReason?: string
  timestamp?: number
  toolCallId?: string
  toolName?: string
  isError?: boolean
  command?: string
  exitCode?: number | null
  cancelled?: boolean
}

export function toUsage(u: PiMessage['usage']): Usage | undefined {
  if (!u) return undefined
  return {
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    totalTokens:
      u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
    cost: u.cost?.total ?? 0
  }
}

/** 把 pi 的 AgentMessage 归一化成 UIMessage（历史回放用） */
export function normalizeMessage(m: PiMessage, idx: number): UIMessage | null {
  const id = `m${idx}`

  if (m.role === 'user') {
    let text = ''
    const images: { mimeType: string; data: string }[] = []

    if (typeof m.content === 'string') {
      text = m.content
    } else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === 'text') text += c.text ?? ''
        else if (c.type === 'image' && c.data) {
          images.push({ mimeType: c.mimeType ?? 'image/png', data: c.data })
        }
      }
    }

    // 去掉客户端塞进去的 XML 包裹
    text = text.replace(/^<[^>]{1,40}>/, '').replace(/<\/[^>]{1,40}>$/, '')
    return {
      id,
      role: 'user',
      text,
      images: images.length ? images : undefined,
      timestamp: m.timestamp
    }
  }

  if (m.role === 'assistant') {
    const blocks = Array.isArray(m.content) ? m.content : []
    const text = blocks
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
    const thinking = blocks
      .filter((c) => c.type === 'thinking')
      .map((c) => c.thinking ?? '')
      .join('')

    const toolCalls: UIToolCall[] = blocks
      .filter((c) => c.type === 'toolCall' && c.id)
      .map((c) => ({
        id: c.id!,
        name: c.name ?? 'unknown',
        args: c.arguments,
        // 历史里的工具调用已经没有结果了（结果在单独的 toolResult 消息里），
        // 后面用 toolResult 回填
        status: 'ok' as const
      }))

    return {
      id,
      role: 'assistant',
      text,
      thinking: thinking || undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: toUsage(m.usage),
      model: m.model,
      responseDetail: 'unknown',
      timestamp: m.timestamp,
      error: m.stopReason === 'error' ? '模型返回错误' : undefined
    }
  }

  if (m.role === 'toolResult') {
    // 归一化成一条工具结果（挂不上就独立显示）
    return {
      id,
      role: 'assistant',
      text: '',
      toolCalls: [
        {
          id: m.toolCallId ?? id,
          name: m.toolName ?? 'tool',
          args: undefined,
          /* 被取消的不是失败：方案 4.1 要求取消单独显示 */
          status: m.isError && !m.cancelled ? 'error' : 'ok',
          ...(m.cancelled ? { cancelled: true } : {}),
          output: Array.isArray(m.content)
            ? m.content
                .filter((c) => c.type === 'text')
                .map((c) => c.text ?? '')
                .join('')
            : typeof m.content === 'string'
              ? m.content
              : ''
        }
      ],
      timestamp: m.timestamp
    }
  }

  if (m.role === 'bashExecution') {
    return {
      id,
      role: 'bash',
      text: m.command ?? '',
      bash: {
        command: m.command ?? '',
        exitCode: m.exitCode ?? null,
        cancelled: !!m.cancelled
      },
      toolCalls: [
        {
          id,
          name: 'bash',
          args: { command: m.command },
          status: m.exitCode === 0 || m.cancelled ? 'ok' : 'error',
          ...(m.cancelled ? { cancelled: true } : {}),
          output: m.content as string | undefined
        }
      ],
      timestamp: m.timestamp
    }
  }

  return null
}

/** 历史回放：把 toolResult 的结果回填到对应的 toolCall 上 */
export function normalizeHistory(raw: unknown[]): UIMessage[] {
  const out: UIMessage[] = []
  const callIndex = new Map<string, { msg: UIMessage; call: UIToolCall }>()

  /*
   * ⚠️ 序号只按**真正产出的消息**递增，不能用 raw 下标。
   *
   * Pi 0.87 起会把 system prompt 作为一条 `type:"message"` 写进会话 JSONL，
   * 而实时事件流与 context 钩子都看不到它。继续用 raw 下标编号会让 system
   * 之后的每条消息 id 整体 +1：实时写入的回合计时锚点（`anchorId`，形如 `m0`）
   * 在重启读回时全部对不上 —— 表现为用时与「已中断」凭空消失。
   * 跳过 system、按产出顺序编号，两代 pi 下两侧才是同一口径。
   */
  let seq = 0
  for (const r of raw) {
    const m = r as PiMessage
    if (m?.role === 'system') continue
    const norm = normalizeMessage(m, seq)
    if (!norm) continue

    if (m.role === 'toolResult') {
      const hit = norm.toolCalls?.[0] ? callIndex.get(norm.toolCalls[0].id) : undefined
      if (hit) {
        // 挂到原有调用上，不新增消息（序号也不前进，与实时视图一致）
        hit.call.status = norm.toolCalls![0].status
        hit.call.output = norm.toolCalls![0].output
        continue
      }
    }

    seq += 1
    for (const c of norm.toolCalls ?? []) {
      callIndex.set(c.id, { msg: norm, call: c })
    }
    out.push(norm)
  }

  return out
}
