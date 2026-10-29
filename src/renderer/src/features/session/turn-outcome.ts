import { classifyLink } from '../../../../shared/links'
import type { Turn } from '../../../../shared/turns'

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
