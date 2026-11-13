import type { UIMessage, UIToolCall } from './ui-message'
import { parseHostNotice } from './host-notice'
import { pick } from './ui-lang'

export interface SessionMarkdownMeta {
  title?: string
  cwd?: string
  exportedAt: number
}

const HINT_KEYS = ['path', 'file_path', 'command', 'query', 'url', 'pattern', 'description']
const HINT_MAX = 160

function inlineCode(text: string): string {
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``
}

function stamp(at: number): string {
  const d = new Date(at)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

function toolLine(call: UIToolCall): string {
  const args = call.args && typeof call.args === 'object' ? (call.args as Record<string, unknown>) : {}
  const key = HINT_KEYS.find((name) => typeof args[name] === 'string' && args[name])
  const raw = key ? String(args[key]).replace(/\s+/g, ' ').trim() : ''
  const hint = raw.length > HINT_MAX ? `${raw.slice(0, HINT_MAX)}…` : raw
  const failed = call.status === 'error' ? pick('（失败）', ' (failed)') : ''
  return `- ${inlineCode(call.name)}${hint ? ` ${inlineCode(hint)}` : ''}${failed}`
}

function imageNote(count: number): string {
  return pick(`*（图片 ${count} 张，未包含在导出里）*`, `*(${count} image${count === 1 ? '' : 's'}, not included in this export)*`)
}

function blocksOf(message: UIMessage): { speaker: string; parts: string[] } | null {
  const parts: string[] = []
  if (message.role === 'note') return null
  if (message.role === 'bash') {
    if (!message.bash) return null
    const output = message.text.trimEnd()
    parts.push(`\`\`\`\n$ ${message.bash.command}${output ? `\n${output}` : ''}\n\`\`\``)
    return { speaker: pick('用户', 'User'), parts }
  }
  if (message.role === 'user') {
    if (parseHostNotice(message.text)) return null
    if (message.text.trim()) parts.push(message.text.trim())
    if (message.images?.length) parts.push(imageNote(message.images.length))
    return parts.length ? { speaker: pick('用户', 'User'), parts } : null
  }
  if (message.text.trim()) parts.push(message.text.trim())
  const calls = (message.toolCalls ?? []).filter((call) => !call.parentToolCallId)
  if (calls.length) parts.push(calls.map(toolLine).join('\n'))
  if (message.images?.length) parts.push(imageNote(message.images.length))
  if (message.error) parts.push(`> ${pick('出错', 'Error')}: ${message.error.replace(/\s+/g, ' ').trim()}`)
  return parts.length ? { speaker: pick('助手', 'Assistant'), parts } : null
}

export function sessionMarkdown(messages: readonly UIMessage[], meta: SessionMarkdownMeta): string {
  const title = meta.title?.replace(/\s+/g, ' ').trim() || pick('会话', 'Session')
  const facts = [pick('导出自 Inkstone', 'Exported from Inkstone'), stamp(meta.exportedAt), ...(meta.cwd ? [inlineCode(meta.cwd)] : [])]
  const out: string[] = [`# ${title}`, `> ${facts.join(' · ')}`]
  let speaker = ''
  for (const message of messages) {
    const block = blocksOf(message)
    if (!block) continue
    if (block.speaker !== speaker) {
      speaker = block.speaker
      out.push('---', `**${speaker}**`)
    }
    out.push(...block.parts)
  }
  return `${out.join('\n\n')}\n`
}
