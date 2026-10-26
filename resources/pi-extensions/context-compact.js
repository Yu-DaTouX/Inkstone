// 压缩摘要：替换 pi 默认的摘要生成。pi 序列化对话时把每个工具结果截到 2000 字，大段读取的内容
// 摘要模型根本看不到；这里原样交给摘要模型，放得下就一次调用，放不下才按顺序分段滚动更新，
// 超长的单段按行切成几片，每片标明出处，不截断。出错时返回 undefined 让 pi 走默认压缩，
// 并在压缩完成后把失败原因记成不进上下文的会话条目；连续失败 3 次后直接交给 pi。
// 被压缩的原文按段加锚点，追加写进会话文件旁的 <会话>.jsonl.history.txt（常见密钥格式替换成占位符），
// 摘要末尾给出路径，模型缺细节时可以 grep 或读局部。
import { readFile, writeFile, rename, rm } from 'node:fs/promises'

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
[The original tool outputs and file contents will be discarded after this summary; anything not written here is lost. List every concrete specific found in tool results and messages that may matter later: names, numbers, IDs, codes, amounts, dates, exact file paths with line numbers, function and API signatures, exact error messages, test results. Group them by source (file, command, document section). Be exhaustive here and terse: one fact per line, no prose. Each part of the conversation starts with an anchor line such as "### [#2.17 tool_result read]"; end each fact with the anchor of the part it came from, e.g. (#2.17).]

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
const MIN_CHUNK_TOKENS = 4_000
const MAX_CAPACITY_RETRIES = 2
const MAX_CONSECUTIVE_FAILURES = 3
export const ENTRY_TYPE = 'yan-compaction'
const SNAPSHOT_HEADER = '=== compaction '
const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh_[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[REDACTED]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1[REDACTED]'],
  [/((?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*["']?)[^\s"',;]{12,}/gi, '$1[REDACTED]']
]

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (part?.type === 'text' ? part.text : part?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n')
}

// 和 pi 的 serializeConversation 同样的格式，只是不截断工具结果；工具结果带序号、工具名、调用 ID 和失败标记
export function serializeMessage(msg, index) {
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
        return b.id ? `${b.name}(${args}) call=${b.id}` : `${b.name}(${args})`
      })
      if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join('; ')}`)
      return parts.join('\n\n')
    }
    case 'toolResult': {
      const label = [Number.isInteger(index) ? `#${index}` : '', msg.toolName ?? '', msg.toolCallId ? `call=${msg.toolCallId}` : '', msg.isError ? 'error' : '']
        .filter(Boolean).join(' ')
      return `[Tool result${label ? ` ${label}` : ''}]: ${textOf(msg.content) || '(empty)'}`
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

export function redactSecrets(text) {
  return SECRET_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text)
}

export function anchorLine(msg, compactionNo, index) {
  const role = msg?.role === 'toolResult' ? 'tool_result' : msg?.role ?? 'entry'
  const extra = msg?.role === 'toolResult' ? [msg.toolName, msg.toolCallId ? `call=${msg.toolCallId}` : '', msg.isError ? 'error' : 'ok'] : []
  return `### [#${compactionNo}.${index} ${[role, ...extra].filter(Boolean).join(' ')}]`
}

export function snapshotPath(sessionFile) {
  return sessionFile ? `${sessionFile}.history.txt` : null
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

export function nextCompactionNo(existing) {
  return existing.split('\n').filter((line) => line.startsWith(SNAPSHOT_HEADER)).length + 1
}

// 先写临时文件、核对长度，再原子改名；返回路径和总字符数
export async function appendSnapshot(file, existing, compactionNo, parts) {
  const block = `${SNAPSHOT_HEADER}${compactionNo} · ${new Date().toISOString()} · ${parts.length} parts ===\n\n${redactSecrets(parts.join('\n\n'))}\n\n`
  const content = existing + block
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(tmp, content, 'utf8')
    if ((await readFile(tmp, 'utf8')).length !== content.length) throw new Error('snapshot verify failed')
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
  return { path: file, chars: content.length }
}

export function stripAppendices(summary) {
  return summary ? summary.replace(/\n*<(read-files|modified-files|history-snapshot)>[\s\S]*?<\/\1>/g, '').trim() : summary
}

export function snapshotPointer({ path, chars }) {
  return `\n\n<history-snapshot>\nThe full text of the conversation compacted so far, tool outputs included, is saved at ${path} (${chars} characters). Each part starts with an anchor line like "### [#2.17 tool_result read call=... ok]", matching the (#2.17) citations above. You can grep it or read parts of it when you need an exact detail; it records what was seen at the time, and files on disk may have changed since.\n</history-snapshot>`
}

// 把超长的一段按行切成不超过 maxChars 的几片（单行太长再按字符切），每片开头标明是第几片
export function splitPart(part, maxChars) {
  const room = Math.max(200, maxChars - 40)
  const pieces = []
  let current = ''
  for (const line of part.split('\n')) {
    let rest = line
    while (rest.length > room) {
      if (current) {
        pieces.push(current)
        current = ''
      }
      pieces.push(rest.slice(0, room))
      rest = rest.slice(room)
    }
    if (current && current.length + 1 + rest.length > room) {
      pieces.push(current)
      current = ''
    }
    current = current ? `${current}\n${rest}` : rest
  }
  if (current || !pieces.length) pieces.push(current)
  return pieces.map((piece, i) => `[piece ${i + 1}/${pieces.length} of one message]\n${piece}`)
}

// 从 start 开始取不超过 budgetChars 的若干段；第一段就放不下时先原地切片
export function takeChunk(parts, start, budgetChars) {
  if (parts[start].length > budgetChars) parts.splice(start, 1, ...splitPart(parts[start], budgetChars))
  let end = start
  let size = 0
  while (end < parts.length && (end === start || size + parts[end].length + 2 <= budgetChars)) {
    size += parts[end].length + 2
    end++
  }
  return { text: parts.slice(start, end).join('\n\n'), end }
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

// 逐项累加 usage，嵌套的 cost 等对象也一样累加
export function addUsage(a, b) {
  if (!a) return b
  if (!b) return a
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (typeof v === 'number') out[k] = (typeof out[k] === 'number' ? out[k] : 0) + v
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = addUsage(out[k] && typeof out[k] === 'object' ? out[k] : undefined, v)
  }
  return out
}

class SummaryError extends Error {
  constructor(category, message, usage) {
    super(message)
    this.category = category
    this.usage = usage
  }
}

const CAPACITY_PATTERN = /context[ _-]?(length|window)|too long|too large|maximum (context|input)|exceed|input tokens/i

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
  if (response.stopReason === 'error' || response.stopReason === 'aborted') {
    const message = response.errorMessage || 'summarization failed'
    const category = signal?.aborted || response.stopReason === 'aborted' ? 'aborted' : CAPACITY_PATTERN.test(message) ? 'capacity' : 'error'
    throw new SummaryError(category, message, response.usage)
  }
  if (response.stopReason === 'length') throw new SummaryError('length', 'summary hit the token cap', response.usage)
  const summary = textOf(response.content).trim()
  if (!summary) throw new SummaryError('empty', 'empty summary', response.usage)
  return { summary, usage: response.usage }
}

export default function contextCompactExtension(pi) {
  let failures = 0
  let pendingNote = null

  pi.on('session_compact', (event) => {
    const note = pendingNote
    pendingNote = null
    if (!note || event?.fromExtension) return
    try {
      pi.appendEntry?.(ENTRY_TYPE, note)
    } catch {
    }
  })

  pi.on('session_before_compact', async (event, ctx) => {
    const model = ctx.model
    const { preparation, customInstructions, signal } = event
    pendingNote = null
    if (!model || !preparation?.firstKeptEntryId) return undefined
    const startedAt = Date.now()
    let usage
    let calls = 0
    let chunks = 0
    const fallback = (category, message) => {
      pendingNote = {
        path: 'pi-default', category, message: String(message ?? '').slice(0, 300),
        consecutiveFailures: failures, chunks, calls, usage, ms: Date.now() - startedAt
      }
      return undefined
    }
    if (failures >= MAX_CONSECUTIVE_FAILURES) return fallback('circuit-open', `${failures} consecutive failures`)
    try {
      const messages = [...(preparation.messagesToSummarize ?? []), ...(preparation.turnPrefixMessages ?? [])]
      const historyFile = snapshotPath(ctx.sessionManager?.getSessionFile?.())
      const existing = historyFile ? await readText(historyFile) : ''
      const compactionNo = nextCompactionNo(existing)
      const parts = messages.flatMap((m, i) => {
        const body = serializeMessage(m, i + 1)
        return body ? [`${anchorLine(m, compactionNo, i + 1)}\n${body}`] : []
      })
      if (!parts.length) return undefined
      const chars = parts.reduce((n, p) => n + p.length, 0)
      const settings = preparation.settings ?? {}
      const reserve = settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS
      const maxTokens = Math.min(Math.floor(0.8 * reserve), model.maxTokens > 0 ? model.maxTokens : Infinity)
      const window = model.contextWindow > 0 ? model.contextWindow : 128_000
      const ratio = tokensPerChar(preparation.tokensBefore, settings.keepRecentTokens, chars)
      let summary = stripAppendices(preparation.previousSummary) || undefined
      let start = 0
      let shrink = 1
      let capacityRetries = 0
      while (start < parts.length) {
        const budget = Math.floor((window - maxTokens - PROMPT_OVERHEAD_TOKENS - Math.ceil((summary?.length ?? 0) * ratio)) * shrink)
        if (budget < MIN_CHUNK_TOKENS) throw new SummaryError('budget', `no room for another chunk (${budget} tokens)`)
        const chunk = takeChunk(parts, start, Math.floor(budget / ratio))
        calls++
        try {
          const result = await summarize(ctx, model, chunk.text, summary, customInstructions, maxTokens, signal)
          usage = addUsage(usage, result.usage)
          summary = result.summary
          start = chunk.end
          chunks++
          shrink = 1
        } catch (error) {
          usage = addUsage(usage, error?.usage)
          if (error?.category !== 'capacity' || capacityRetries >= MAX_CAPACITY_RETRIES) throw error
          capacityRetries++
          shrink /= 2
        }
      }
      const summaryTokens = Math.ceil(summary.length * ratio)
      const sourceTokens = Math.ceil((chars + (preparation.previousSummary?.length ?? 0)) * ratio)
      if (summaryTokens >= sourceTokens) throw new SummaryError('grew', `summary (${summaryTokens}) not smaller than source (${sourceTokens})`)
      failures = 0
      const files = fileLists(preparation.fileOps)
      let snapshot = null
      let snapshotError
      if (historyFile) {
        try {
          snapshot = await appendSnapshot(historyFile, existing, compactionNo, parts)
        } catch (error) {
          snapshotError = String(error?.message ?? error).slice(0, 200)
        }
      }
      return {
        compaction: {
          summary: summary + formatFileLists(files) + (snapshot ? snapshotPointer(snapshot) : ''),
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage,
          details: {
            ...files, path: 'chunked', chunks, calls, capacityRetries, parts: parts.length, ms: Date.now() - startedAt, untruncated: true,
            compactionNo, ...(snapshot ? { snapshot: snapshot.path, snapshotChars: snapshot.chars } : {}), ...(snapshotError ? { snapshotError } : {})
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) return { cancel: true }
      failures++
      return fallback(error?.category ?? 'error', error?.message)
    }
  })
}
