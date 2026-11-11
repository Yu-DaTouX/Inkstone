import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_OLD_LINES = 80
const MAX_HINT_CHARS = 4000
const CONTEXT_LINES = 2

export function resolveEditPath(raw, cwd, platform = process.platform) {
  let path = String(raw ?? '').trim()
  if (!path) return ''
  if (path.startsWith('@')) path = path.slice(1)
  if (platform === 'win32') path = path.replace(/^\/(?:cygdrive\/)?([a-zA-Z])(?=\/|$)/, (_all, drive) => `${drive.toUpperCase()}:`)
  return isAbsolute(path) || /^[a-zA-Z]:/.test(path) ? resolve(path) : resolve(cwd || process.cwd(), path)
}

function failedOldText(event) {
  const input = event?.input ?? {}
  const edits = Array.isArray(input.edits) ? input.edits : [{ oldText: input.oldText }]
  const text = (event?.content ?? []).map((part) => part?.text ?? '').join('\n')
  const index = Number(/edits\[(\d+)\]/.exec(text)?.[1] ?? 0)
  const oldText = edits[index]?.oldText ?? edits[0]?.oldText
  return typeof oldText === 'string' ? oldText : ''
}

function notFound(event) {
  if (String(event?.toolName ?? '') !== 'edit' || !event?.isError) return false
  const text = (event?.content ?? []).map((part) => part?.text ?? '').join('\n')
  return /Could not find (?:the exact text|edits\[\d+\])/.test(text)
}

const squash = (line) => line.trim().replace(/\s+/g, ' ')

export function closestRegion(content, oldText) {
  const fileLines = content.replace(/\r\n?/g, '\n').split('\n')
  const wanted = oldText.replace(/\r\n?/g, '\n').split('\n').slice(0, MAX_OLD_LINES).map(squash)
  while (wanted.length && !wanted[wanted.length - 1]) wanted.pop()
  while (wanted.length && !wanted[0]) wanted.shift()
  if (wanted.length === 0) return null
  const keyed = fileLines.map(squash)
  const positions = new Map()
  keyed.forEach((line, i) => {
    if (line.length < 3) return
    const list = positions.get(line)
    if (list) list.push(i)
    else positions.set(line, [i])
  })
  const starts = new Set()
  wanted.forEach((line, offset) => {
    if (line.length < 3) return
    for (const i of positions.get(line) ?? []) if (i - offset >= 0) starts.add(i - offset)
  })
  let best = null
  for (const start of starts) {
    let score = 0
    for (let k = 0; k < wanted.length && start + k < keyed.length; k++) if (wanted[k] && keyed[start + k] === wanted[k]) score++
    if (!best || score > best.score) best = { start, score }
  }
  if (!best || best.score === 0) return null
  const from = Math.max(0, best.start - CONTEXT_LINES)
  const to = Math.min(fileLines.length, best.start + wanted.length + CONTEXT_LINES)
  return { from, to, matched: best.score, total: wanted.filter(Boolean).length, lines: fileLines.slice(from, to) }
}

export function lineEndingNote(content) {
  const features = []
  if (content.charCodeAt(0) === 0xfeff) features.push('a UTF-8 BOM')
  if (content.includes('\r\n')) features.push('CRLF line endings')
  if (features.length === 0) return ''
  return `Note: this file has ${features.join(' and ')}. edit ignores those when matching (write plain newlines) and keeps them on save, so that is not why the match failed.`
}

export function editMismatchHint(event, cwd) {
  if (!notFound(event)) return undefined
  const oldText = failedOldText(event)
  if (!oldText.trim()) return undefined
  const path = resolveEditPath(event?.input?.path, cwd)
  if (!path) return undefined
  let content
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return undefined
    content = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const region = closestRegion(content, oldText)
  const note = lineEndingNote(content)
  if (!region) return note ? { content: [...(event.content ?? []), { type: 'text', text: note }] } : undefined
  let body = region.lines.join('\n')
  if (body.length > MAX_HINT_CHARS) body = `${body.slice(0, MAX_HINT_CHARS)}\n…`
  const text = `Closest current text in the file (lines ${region.from + 1}-${region.to}; ${region.matched} of ${region.total} oldText lines match ignoring indentation). Copy oldText from here rather than from memory:\n\`\`\`\n${body}\n\`\`\`${note ? `\n${note}` : ''}`
  return { content: [...(event.content ?? []), { type: 'text', text }] }
}

export function registerEditHint(pi) {
  pi.on('tool_result', (event, ctx) => editMismatchHint(event, ctx?.cwd ?? process.cwd()))
}
