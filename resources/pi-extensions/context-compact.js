// 压缩摘要：替换 pi 默认的摘要生成。pi 序列化对话时把每个工具结果截到 2000 字，大段读取的内容
// 摘要模型根本看不到；这里原样交给摘要模型，放得下就一次调用，放不下才按顺序分段滚动更新。
// 出任何错都返回 undefined，让 pi 走默认压缩。

const SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`

const FORMAT = `## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Every constraint, preference or requirement the user stated, close to their own words]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Facts & Details
[The original tool outputs and file contents will be discarded after this summary; anything not written here is lost. List every concrete specific found in tool results and messages that may matter later: names, numbers, IDs, codes, amounts, dates, exact file paths with line numbers, function and API signatures, exact error messages, test results. Group them by source (file, command, document section). Be exhaustive here and terse: one fact per line, no prose.]

## Critical Context
- [Any other data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep the prose sections concise. Preserve exact file paths, function names, and error messages.`

const FIRST_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

${FORMAT}`

const UPDATE_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary, especially every line under Facts & Details
- ADD new progress, decisions, facts and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- If something is clearly no longer relevant, you may remove it

Use this EXACT format:

${FORMAT}`

// 估算比例的上下限（token/字符），防止会话太短时比例离谱
const MIN_RATIO = 0.2
const MAX_RATIO = 1.5
const PROMPT_OVERHEAD_TOKENS = 8_000
const DEFAULT_RESERVE_TOKENS = 16_384

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (part?.type === 'text' ? part.text : part?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n')
}

// 和 pi 的 serializeConversation 同样的格式，只是不截断工具结果
export function serializeMessage(msg) {
  if (!msg || typeof msg !== 'object') return ''
  switch (msg.role) {
    case 'user': {
      const text = textOf(msg.content)
      return text ? `[User]: ${text}` : ''
    }
    case 'assistant': {
      const parts = []
      const blocks = Array.isArray(msg.content) ? msg.content : []
      const thinking = blocks.filter((b) => b.type === 'thinking' && b.thinking).map((b) => b.thinking)
      if (thinking.length) parts.push(`[Assistant thinking]: ${thinking.join('\n')}`)
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      if (text) parts.push(`[Assistant]: ${text}`)
      const calls = blocks.filter((b) => b.type === 'toolCall').map((b) => {
        const args = Object.entries(b.arguments ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')
        return `${b.name}(${args})`
      })
      if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join('; ')}`)
      return parts.join('\n\n')
    }
    case 'toolResult': {
      const text = textOf(msg.content)
      return text ? `[Tool result]: ${text}` : ''
    }
    case 'bashExecution':
      return `[User ran]: ${msg.command ?? ''}\n${msg.output ?? ''}`.trim()
    case 'branchSummary':
    case 'compactionSummary':
      return msg.summary ? `[Earlier summary]: ${msg.summary}` : ''
    case 'custom':
      return msg.display === false ? '' : (textOf(msg.content) ? `[Note]: ${textOf(msg.content)}` : '')
    default:
      return ''
  }
}

// 按估算的 token 数把序列化后的各段切成若干块；单段超过预算就截掉尾部（极少见）
export function chunkParts(parts, ratio, budgetTokens) {
  const budgetChars = Math.max(1_000, Math.floor(budgetTokens / ratio))
  const chunks = []
  let current = []
  let size = 0
  for (let part of parts) {
    if (part.length > budgetChars) part = `${part.slice(0, budgetChars)}\n\n[... ${part.length - budgetChars} more characters truncated]`
    if (size + part.length > budgetChars && current.length) {
      chunks.push(current.join('\n\n'))
      current = []
      size = 0
    }
    current.push(part)
    size += part.length + 2
  }
  if (current.length) chunks.push(current.join('\n\n'))
  return chunks
}

// 用这次会话实测的 token 数估算"每字符多少 token"，不依赖具体模型的分词
export function tokensPerChar(tokensBefore, keepRecentTokens, chars) {
  if (!(chars > 0) || !(tokensBefore > 0)) return 0.5
  const ratio = Math.max(tokensBefore - (keepRecentTokens ?? 0), tokensBefore * 0.5) / chars
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
}

function fileLists(fileOps) {
  const read = fileOps?.read instanceof Set ? [...fileOps.read] : []
  const modified = new Set([...(fileOps?.written ?? []), ...(fileOps?.edited ?? [])])
  return { readFiles: read.filter((f) => !modified.has(f)).sort(), modifiedFiles: [...modified].sort() }
}

function formatFileLists({ readFiles, modifiedFiles }) {
  const sections = []
  if (readFiles.length) sections.push(`<read-files>\n${readFiles.join('\n')}\n</read-files>`)
  if (modifiedFiles.length) sections.push(`<modified-files>\n${modifiedFiles.join('\n')}\n</modified-files>`)
  return sections.length ? `\n\n${sections.join('\n\n')}` : ''
}

function addUsage(a, b) {
  if (!a) return b
  if (!b) return a
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) if (typeof v === 'number') out[k] = (out[k] ?? 0) + v
  return out
}

async function summarize(ctx, model, text, previousSummary, customInstructions, maxTokens, signal) {
  let prompt = `<conversation>\n${text}\n</conversation>\n\n`
  if (previousSummary) prompt += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`
  prompt += previousSummary ? UPDATE_PROMPT : FIRST_PROMPT
  if (customInstructions) prompt += `\n\nAdditional focus: ${customInstructions}`
  const options = { maxTokens, signal, cacheRetention: 'none' }
  const level = ctx.thinkingLevel
  if (model.reasoning && level && level !== 'off') options.reasoning = level
  const response = await ctx.modelRegistry.complete(model, {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() }]
  }, options)
  if (response.stopReason === 'error') throw new Error(response.errorMessage || 'summarization failed')
  if (response.stopReason === 'length') throw new Error('summary hit the token cap')
  const summary = textOf(response.content).trim()
  if (!summary) throw new Error('empty summary')
  return { summary, usage: response.usage }
}

export default function contextCompactExtension(pi) {
  pi.on('session_before_compact', async (event, ctx) => {
    const model = ctx.model
    const { preparation, customInstructions, signal } = event
    if (!model || !preparation?.firstKeptEntryId) return undefined
    try {
      const messages = [...(preparation.messagesToSummarize ?? []), ...(preparation.turnPrefixMessages ?? [])]
      const parts = messages.map(serializeMessage).filter(Boolean)
      if (!parts.length) return undefined
      const chars = parts.reduce((n, p) => n + p.length, 0)
      const settings = preparation.settings ?? {}
      const reserve = settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS
      const maxTokens = Math.min(Math.floor(0.8 * reserve), model.maxTokens > 0 ? model.maxTokens : Infinity)
      const window = model.contextWindow > 0 ? model.contextWindow : 128_000
      const ratio = tokensPerChar(preparation.tokensBefore, settings.keepRecentTokens, chars)
      const previous = preparation.previousSummary ?? ''
      const budget = window - maxTokens - PROMPT_OVERHEAD_TOKENS - Math.ceil(previous.length * ratio)
      const chunks = chunkParts(parts, ratio, Math.max(budget, Math.floor(window * 0.25)))
      let summary = previous || undefined
      let usage
      for (const chunk of chunks) {
        const result = await summarize(ctx, model, chunk, summary, customInstructions, maxTokens, signal)
        summary = result.summary
        usage = addUsage(usage, result.usage)
      }
      const files = fileLists(preparation.fileOps)
      return {
        compaction: {
          summary: summary + formatFileLists(files),
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage,
          details: { ...files, chunks: chunks.length, untruncated: true }
        }
      }
    } catch {
      if (signal?.aborted) return { cancel: true }
      return undefined
    }
  })
}
