/**
 * 回合分组 —— 把扁平的 UIMessage[] 折成「一轮一块」。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要这个（实测数据）
 * ══════════════════════════════════════════════════════════════════
 * pi 的协议是「每次 API 往返 = 一条 assistant 消息」。一个带工具的回合
 * 会产生**很多条** assistant 消息：
 *
 *   user: 帮我把标题改成模型生成
 *   assistant: "我先看看现在的实现" + tool(read)      ← 第 1 条
 *   [工具结果]
 *   assistant: "找到了，改成独立进程" + tool(edit)     ← 第 2 条
 *   [工具结果]
 *   assistant: "改好了，说明：……"                    ← 第 3 条
 *
 * 界面上就是**3 个独立的「砚」块**，各带一个左侧符号槽。实测一个真实会话里
 * 最长连续 34 条 assistant 消息 —— 屏幕上 34 个「砚」，读起来全是碎片，
 * 而它们其实是**同一轮回答**。
 *
 * 参考实现：craft-agents-oss 的 `packages/ui/src/components/chat/turn-utils.ts`
 * 里的 `groupMessagesByTurn()`。核心结论抄过来了：
 *   · 用户消息 = 新回合的开始
 *   · 一轮里的工具调用 + 中间解说都归**当前回合**
 *   · 最后一个「有文字且没有工具调用」的 assistant 消息 = 最终回答
 *   · 前面那些有文字的 = 中间解说（commentary）
 *
 * 差异（我们没法照抄的地方）：
 *   他们依赖 SDK 给的 `isIntermediate` 标记来区分「中间」与「最终」。
 *   pi 的 RPC 协议**没有**这个字段（查过 docs/rpc.md 的
 *   assistantMessageEvent：只有 text_start/delta/end、thinking_*、toolcall_*）。
 *   所以这里改用结构推断：「最后一条有文字的」就是最终回答。
 *   末尾停在工具调用上（没有最终文字）时，把最后一条解说**提升**为回答 ——
 *   这与 craft-agents 的 fallback 行为一致，避免整轮在界面上没有正文。
 * ══════════════════════════════════════════════════════════════════
 */
import type { UIMessage, Usage } from './ipc'

/** 一段文字（解说或回答） */
export interface TurnText {
  id: string
  text: string
  /**
   * 这段文字所在的原始消息**是否带工具调用**。
   *
   * 用途：把解说与回复分开（带工具 = 那批工具的前言 = 解说）。
   * 注意它不是「段」的属性，是「这条消息」的属性 ——
   * 同一条消息拆出的多段共享同一个值。
   */
  hasTools: boolean
}

/** 一轮助手回答 */
export interface AssistantTurn {
  kind: 'assistant'
  /** 稳定 key：用这一轮第一条消息的 id */
  id: string
  /** 合并后的思考（多段拼起来） */
  thinking: string
  /** 思考耗时合计 */
  thinkingMs?: number
  /** 是否**正在**流式思考（推理胶囊据此展开/折叠） */
  thinkingLive: boolean
  /** 中间解说，按时间顺序；每条是一段 */
  commentary: TurnText[]
  /** 整个回合的工具调用（合并后按时间排） */
  tools: NonNullable<UIMessage['toolCalls']>
  /** 最终回答；末尾停在工具上时会把最后一条解说提升上来 */
  response: TurnText | null
  streaming: boolean
  /** 取这一轮最后一条带 usage 的消息（provider 报的是累计值） */
  usage?: Usage
  speed?: number
  elapsedMs?: number
  model?: string
  error?: string
  errorMsgId?: string
  /** 构成这一轮的原始消息 id（调试 / 分叉用） */
  sourceIds: string[]
}

/** 一条用户消息（自己一轮） */
export interface UserTurn {
  kind: 'user'
  id: string
  msg: UIMessage
}

/**
 * 用户主动执行的 `!` 命令的结果。
 *
 * 为什么不并进助手回合：它是**用户发起的动作**，不是模型的回答。
 * 符号槽用 `$` 而不是 `✦`，混在一起会分不清「谁干的」。
 */
export interface BashTurn {
  kind: 'bash'
  id: string
  msg: UIMessage
}

export type Turn = AssistantTurn | UserTurn | BashTurn

/** 文本是否有实质内容（只有空格的 delta 不算） */
function hasText(s: string | undefined): boolean {
  return !!s && s.trim().length > 0
}

/**
 * 把一条 UIMessage 的文字按「段」拆开。
 *
 * 为什么要拆：用户要求「每次发送的信息要根据段落来显示」。
 * 模型经常一次吐好几段（一段解释 + 一段清单 + 一段结论），
 * 合成一个死长的 <p> 读起来是一坨；拆成段落后有段落间距、能各自淡入。
 *
 * 规则：
 *   · 空行（≥2 个换行）分段 —— 这是 Markdown 的段落定义
 *   · **代码围栏内的空行不分段** —— 否则一个 ``` 块会被切成两半，
 *     前半段会丢掉语言标记，高亮就废了
 *   · 单换行不分段（Markdown 里那是同一段内的 soft break）
 */
export function splitParagraphs(text: string): string[] {
  const out: string[] = []
  let buf: string[] = []
  let inFence = false

  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence

    // 只在围栏外、且遇到空行时切段
    if (!inFence && line.trim() === '') {
      if (buf.length) {
        out.push(buf.join('\n'))
        buf = []
      }
      continue
    }
    buf.push(line)
  }
  if (buf.length) out.push(buf.join('\n'))

  return out.map((s) => s.trim()).filter(Boolean)
}

/**
 * 把扁平消息折成回合。
 *
 * 纯函数、无副作用、不依赖 React —— 所以能用 node 单测钉住
 * （见 scripts/test-unit.mjs 的「回合分组」一节）。
 *
 * ── 回合内的结构（实测的一条真实回合） ──
 * ```
 *   msg 0      文字22字 + tools[bash,recall]   ← 领起句：「我先看看环境」
 *   msg 1..15  无文字  + tools[bash,bash]×15   ← 干活
 *   msg 16     文字1615字 + tools[]            ← 结论
 * ```
 * 所以分类规则是**按位置**，不是按「哪条是最后一条」：
 *   · 带工具调用的消息里的文字 → 中间解说（它是那批工具的前言）
 *   · 最后一次工具调用**之后**的无工具消息里的文字 → 最终回复（可能跨多条）
 *
 * ⚠️ 为什么不能只用「最后一条文字」：实测有一个回合的答案是拆在
 *   两条无工具消息里的（结论 + 「说一声就走。」），
 *   只取最后一条就把 1600 字的正文全归到解说里去了。
 */
export function groupIntoTurns(messages: UIMessage[], streamingId?: string): Turn[] {
  const turns: Turn[] = []
  /** 正在累积的助手回合 */
  let cur: {
    firstId: string
    sourceIds: string[]
    thinking: string[]
    thinkingMs: number
    thinkingLive: boolean
    /** 按时间顺序缓存的「有文字」的段，带位置标记 */
    texts: TurnText[]
    tools: NonNullable<UIMessage['toolCalls']>
    last: UIMessage | undefined
    /** 是否还在流式（由调用方传入的 streamingId 决定） */
    streaming: boolean
  } | null = null

  const flush = (): void => {
    if (!cur) return

    const texts = cur.texts

    /*
     * 分类：最后一次工具调用**之后**的文字算回复，其余算解说。
     *
     * 边界：如果整个回合都没有工具调用（纯回答），那就是回复 ——
     * 这也是「重试一次、只说一句话」那种回合的正确形态。
     */
    /*
     * 用一个更直接的实现：记录每一段文字对应的**消息是否带工具**。
     * 这样不用去反查 sourceIds 的下标。
     */
    const responseParts: TurnText[] = []
    const commentary: TurnText[] = []
    const afterWork = texts.filter((x) => !x.hasTools)
    const beforeWork = texts.filter((x) => x.hasTools)

    if (!cur.tools.length) {
      // 纯回答回合：全部是回复
      responseParts.push(...afterWork, ...beforeWork)
    } else if (afterWork.length) {
      // 有工作，且工作之后还有无工具的文字 → 那些就是回复
      responseParts.push(...afterWork)
      commentary.push(...beforeWork)
    } else {
      /*
       * 末尾停在工具上（没有最终文字）→ 把最后一条解说**提升**为回复。
       * 与 craft-agents 的 fallback 行为一致：
       * 否则整轮在界面上没有正文，用户只看到一堆工作量。
       */
      responseParts.push(...beforeWork.slice(-1))
      commentary.push(...beforeWork.slice(0, -1))
    }

    turns.push({
      kind: 'assistant',
      id: cur.firstId,
      thinking: cur.thinking.join('\n\n'),
      thinkingMs: cur.thinkingMs || undefined,
      thinkingLive: cur.thinkingLive,
      commentary,
      tools: cur.tools,
      // 多段回复用双换行拼成一段（渲染时 Markdown 自己会分段）
      response: responseParts.length
        ? {
            id: responseParts[0].id,
            text: responseParts.map((x) => x.text).join('\n\n'),
            // 拼出来的这一段是「回复」，按定义它来自无工具的消息；
            // 若走的是「提升最后一条解说」那条分支，则继承原值。
            hasTools: responseParts.some((x) => x.hasTools)
          }
        : null,
      streaming: cur.streaming,
      usage: cur.last?.usage,
      speed: cur.last?.speed,
      elapsedMs: cur.last?.elapsedMs,
      model: cur.last?.model,
      error: cur.last?.error,
      errorMsgId: cur.last?.error ? cur.last.id : undefined,
      sourceIds: cur.sourceIds
    })
    cur = null
  }

  for (const m of messages) {
    if (m.role === 'user') {
      flush()
      turns.push({ kind: 'user', id: m.id, msg: m })
      continue
    }

    if (m.role === 'bash') {
      flush()
      turns.push({ kind: 'bash', id: m.id, msg: m })
      continue
    }

    // ---- assistant：累积进当前回合 ----
    if (!cur) {
      cur = {
        firstId: m.id,
        sourceIds: [],
        thinking: [],
        thinkingMs: 0,
        thinkingLive: false,
        texts: [],
        tools: [],
        streaming: false,
        last: undefined
      }
    }
    cur.sourceIds.push(m.id)
    if (m.id === streamingId) cur.streaming = true

    if (hasText(m.thinking)) {
      cur.thinking.push(m.thinking!.trim())
      cur.thinkingMs += m.thinkingMs ?? 0
    }
    // 取最新一条的「正在思考」信号（同一回合可能想好几次）
    if (m.thinkingLive !== undefined) cur.thinkingLive = m.thinkingLive

    if (m.toolCalls?.length) cur.tools.push(...m.toolCalls)

    if (hasText(m.text)) {
      // 一条消息里可能有好几段 —— 拆开，好让界面按段落排
      const hasTools = (m.toolCalls?.length ?? 0) > 0
      for (const p of splitParagraphs(m.text)) {
        cur.texts.push({ id: `${m.id}#${cur.texts.length}`, text: p, hasTools })
      }
    }

    /*
     * 取哪条消息的元数据（usage / speed / elapsedMs / model / error）：
     *   · usage 是**累计**的，所以取最后一条带的（后续消息不会更少）
     *   · error 一旦出现就要留下 —— 不能因为后面来了条正常消息就看不见了
     */
    if (m.usage) cur.last = m
    if (m.error) cur.last = m
    if (!cur.last) cur.last = m
    if (m.elapsedMs !== undefined || m.speed !== undefined) cur.last = m
  }

  flush()
  return turns
}

/**
 * 一轮的用量。
 *
 * ⚠️ 我们**不**把一轮里 N 次 API 往返的 usage 相加。
 *   为什么：pi 报的 usage 本身就是**这一轮的累计值**（同一条消息的 usage
 *   会随往返次数增大），相加会重复计数。所以取最后一条即可。
 *
 * 保留这个函数是为了把「取哪一份 usage」这个决定集中在一处 ——
 * 调用方不必知道这个细节。
 */
export function turnUsage(turn: AssistantTurn): Usage | undefined {
  return turn.usage
}

/**
 * 缓存命中率：缓存读 /（输入 + 缓存读）。
 *
 * 为什么分母要加上 cacheRead：pi 报的 `input` 是**未命中缓存**的那部分，
 * 真正的提示词总量 = input + cacheRead。只用 input 当分母会算出 >100%。
 */
export function cacheHitRate(u?: Usage): number | null {
  if (!u) return null
  const promptTotal = u.input + u.cacheRead
  if (promptTotal <= 0) return null
  return (u.cacheRead / promptTotal) * 100
}

/**
 * 命中率的显示串。
 *
 * 实测这个 provider 的命中率能到 99.98%（几乎整段提示词都在缓存里），
 * `toFixed(0)` 会显示成刺眼的「100%」—— 看着像算错了。
 * 所以：
 *   ≥ 99.5%   显示 ≈100%（明确表示「几乎全部」，不假装精确）
 *   否则      保留一位小数
 */
export function formatHitRate(pct: number | null): string | null {
  if (pct === null) return null
  return pct >= 99.5 ? '≈100%' : `${pct.toFixed(1)}%`
}
