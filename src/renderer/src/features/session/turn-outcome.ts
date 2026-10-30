import { classifyLink } from '../../../../shared/links'
import type { AssistantTurn, Turn } from '../../../../shared/turns'
import { isSubagentNotice } from '../../../../shared/subagent-notice'

const DECISION_MAX_CHARS = 320
const NOT_PROSE = /^\s*(?:[-*+]\s|\d+[.)]\s|\||#|>|```|~~~|<)/
const QUESTION = /[？?]/

export interface ReplyDecision {
  body: string
  question: string
}

export interface ReplyFileLink {
  path: string
  base: string
  label: string
  line?: number
  lineEnd?: number
}

function fenceCount(text: string): number {
  return (text.match(/^\s*(?:```|~~~)/gm) ?? []).length
}

function plainOf(block: string): string {
  return block
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
}

export function splitDecision(text: string): ReplyDecision | null {
  const trimmed = text.replace(/\s+$/, '')
  if (!trimmed) return null
  const breaks = [...trimmed.matchAll(/\n[ \t]*\n/g)]
  const cut = breaks.length ? breaks[breaks.length - 1].index! : -1
  const question = (cut < 0 ? trimmed : trimmed.slice(cut)).trim()
  const body = cut < 0 ? '' : trimmed.slice(0, cut).trim()
  if (!question || question.length > DECISION_MAX_CHARS) return null
  if (NOT_PROSE.test(question) || question.includes('\n\n')) return null
  if (fenceCount(body) % 2 !== 0) return null
  if (!QUESTION.test(plainOf(question))) return null
  return { body, question }
}

const TITLE_MAX_CHARS = 140
const SENTENCE_END = /[\u3002\uff01\uff1f!?]/
const CLOSERS = /[\u300d\u300f\u201d\uff09)"']/

export interface DecisionTitle {
  title: string
  rest: string
}

function sentencesOf(text: string): string[] {
  const sentences: string[] = []
  let from = 0
  let code = false
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '`') code = !code
    if (code) continue
    if (ch === '[' || ch === '(') depth += 1
    else if ((ch === ']' || ch === ')') && depth > 0) depth -= 1
    if (depth > 0 || !SENTENCE_END.test(ch)) continue
    let end = i + 1
    while (end < text.length && (SENTENCE_END.test(text[end]) || CLOSERS.test(text[end]))) end += 1
    sentences.push(text.slice(from, end))
    from = end
    i = end - 1
  }
  if (from < text.length) sentences.push(text.slice(from))
  return sentences.map((sentence) => sentence.trim()).filter(Boolean)
}

export function decisionTitle(question: string): DecisionTitle {
  const sentences = sentencesOf(question.replace(/\s+/g, ' ').trim())
  const at = sentences.findIndex((sentence) => QUESTION.test(plainOf(sentence)))
  const title = at < 0 ? '' : sentences[at]
  if (!title || title.length > TITLE_MAX_CHARS) return { title: '', rest: question.trim() }
  const rest = sentences.filter((_, index) => index !== at).reduce((text, sentence) => !text ? sentence : /[\u3000-\u303f\uff00-\uffef\u201d]$/.test(text) ? text + sentence : `${text} ${sentence}`, '')
  return { title, rest }
}

function baseOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function pathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

export function turnAnswers(turns: readonly Turn[]): Map<string, string | null> {
  const answers = new Map<string, string | null>()
  turns.forEach((turn, index) => {
    if (turn.kind !== 'assistant') return
    const next = turns[index + 1]
    if (!next) answers.set(turn.id, null)
    else if (next.kind === 'user') answers.set(turn.id, (next.msg.text ?? '').trim())
  })
  return answers
}

export type DecisionOutcome =
  | { state: 'running' }
  | { state: 'failed' }
  | { state: 'stopped' }
  | { state: 'done'; text: string }

const OUTCOME_MAX_CHARS = 120
const outcomeCache = new WeakMap<AssistantTurn, DecisionOutcome | null>()
const RUNNING_OUTCOME: DecisionOutcome = { state: 'running' }
const STOPPED_OUTCOME: DecisionOutcome = { state: 'stopped' }
const FAILED_OUTCOME: DecisionOutcome = { state: 'failed' }

function finalReply(turn: AssistantTurn): string {
  for (let i = turn.segments.length - 1; i >= 0; i -= 1) {
    const text = turn.segments[i].response?.text
    if (text?.trim()) return text
  }
  return turn.response?.text ?? ''
}

export function leadSentence(text: string): string {
  const plain = text
    .replace(/^(\s*)(```|~~~)[\s\S]*?^\s*\2/gm, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[`*_~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const first = sentencesOf(plain)[0] ?? ''
  return first.length > OUTCOME_MAX_CHARS ? `${first.slice(0, OUTCOME_MAX_CHARS - 1).trimEnd()}\u2026` : first
}

function outcomeOf(turn: AssistantTurn): DecisionOutcome | null {
  const cached = outcomeCache.get(turn)
  if (cached !== undefined) return cached
  let outcome: DecisionOutcome | null
  if (turn.streaming) outcome = RUNNING_OUTCOME
  else if (turn.terminalReason === 'stopped' || turn.terminalReason === 'interrupted') outcome = STOPPED_OUTCOME
  else if (turn.terminalReason === 'failed' || (turn.error && !turn.errorRecovered)) outcome = FAILED_OUTCOME
  else {
    const text = leadSentence(finalReply(turn))
    outcome = text ? { state: 'done', text } : null
  }
  outcomeCache.set(turn, outcome)
  return outcome
}

export function decisionOutcomes(turns: readonly Turn[]): Map<string, DecisionOutcome> {
  const outcomes = new Map<string, DecisionOutcome>()
  turns.forEach((turn, index) => {
    if (turn.kind !== 'assistant' || turns[index + 1]?.kind !== 'user') return
    let next: AssistantTurn | null = null
    for (let i = index + 2; i < turns.length; i += 1) {
      const later = turns[i]
      if (later.kind === 'user') break
      if (later.kind === 'assistant') next = later
    }
    const outcome = next ? outcomeOf(next) : null
    if (outcome) outcomes.set(turn.id, outcome)
  })
  return outcomes
}

export function userTurnOrdinals(turns: readonly Turn[]): Map<string, number> {
  const ordinals = new Map<string, number>()
  for (const turn of turns) {
    if (turn.kind !== 'user' || isSubagentNotice(turn.msg.text)) continue
    ordinals.set(turn.id, ordinals.size + 1)
  }
  return ordinals
}

function samePath(a: string, b: string): boolean {
  const x = pathKey(a)
  const y = pathKey(b)
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`)
}

function labelShowsFile(file: ReplyFileLink): boolean {
  const label = file.label.replace(/\\/g, '/').toLowerCase()
  return !label || label.includes(file.base.toLowerCase())
}

export function outcomeFiles(files: readonly ReplyFileLink[], changedPaths: readonly string[]): ReplyFileLink[] {
  return files.filter((file) => !labelShowsFile(file) && !changedPaths.some((path) => samePath(path, file.path)))
}

export function replyFileLinks(text: string): ReplyFileLink[] {
  const prose = text.replace(/^(\s*)(```|~~~)[\s\S]*?^\s*\2/gm, ' ')
  const found = new Map<string, ReplyFileLink>()
  for (const match of prose.matchAll(/(!?)\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    if (match[1]) continue
    const target = classifyLink(match[3])
    if (target.kind !== 'file' || /[\\/]$/.test(target.path)) continue
    const key = pathKey(target.path)
    if (found.has(key)) continue
    found.set(key, {
      path: target.path,
      base: baseOf(target.path),
      label: match[2].replace(/[`*_]/g, '').trim(),
      ...(target.line ? { line: target.line } : {}),
      ...(target.lineEnd ? { lineEnd: target.lineEnd } : {})
    })
  }
  return [...found.values()]
}
