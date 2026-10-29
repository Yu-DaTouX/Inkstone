export type OutputNotice =
  | { kind: 'truncated'; path: string }
  | { kind: 'lines'; from: number; to: number; total: number; path: string }
  | { kind: 'more'; n: number }
  | { kind: 'raw'; text: string }

export interface ToolOutputView {
  body: string
  notices: OutputNotice[]
  exitCode: number | null
}

const CODEMODE_HEADER = /^Script (?:completed|failed)\r?\nWall time [\d.]+ seconds\r?\nOutput:\r?\n?/
const EXIT_LINE = /(?:^|\n)\s*Command exited with code (-?\d+)\s*$/
const LEADING_WARNING = /^Warning: truncated output \(original token count: \d+\)\s*$/
const SHOWING_LINES = /^\[Showing lines (\d+)-(\d+) of (\d+)(?: \([^)]*\))?\.(?: Full output: (.+?))?(?: Use offset=\d+ to continue\.)?\]$/
const MORE_LINES = /^\[(\d+) more lines in file\. Use offset=\d+ to continue\.\]$/
const OUTPUT_TRUNCATED = /^\[Output truncated\. Full output: (.+)\]$/
const FULL_OUTPUT = /^\[Full output: (.+?)(?: \(read it with offset\/limit\))?\]$/
const LIMIT_NOTICE = /^\[([^\]]*(?:limit reached|truncated to)[^\]]*)\]$/

export function isCodemodeTool(name: string): boolean {
  return /(^|__|\.)codemode$/i.test(name)
}

export function stripCodemodeHeader(text: string): string {
  return text.replace(CODEMODE_HEADER, '')
}

function noticeOf(line: string): OutputNotice | null {
  const showing = SHOWING_LINES.exec(line)
  if (showing) return { kind: 'lines', from: Number(showing[1]), to: Number(showing[2]), total: Number(showing[3]), path: showing[4] ?? '' }
  const more = MORE_LINES.exec(line)
  if (more) return { kind: 'more', n: Number(more[1]) }
  const truncated = OUTPUT_TRUNCATED.exec(line) ?? FULL_OUTPUT.exec(line)
  if (truncated) return { kind: 'truncated', path: truncated[1] }
  const limit = LIMIT_NOTICE.exec(line)
  if (limit) return { kind: 'raw', text: limit[1] }
  return null
}

export function splitOutputNotices(text: string): { body: string; notices: OutputNotice[] } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const notices: OutputNotice[] = []
  if (lines.length && LEADING_WARNING.test(lines[0])) {
    lines.shift()
    while (lines.length && !lines[0].trim()) lines.shift()
    const path = lines.length ? FULL_OUTPUT.exec(lines[0].trim()) : null
    if (path) lines.shift()
    notices.push({ kind: 'truncated', path: path?.[1] ?? '' })
  }
  const tail: OutputNotice[] = []
  for (;;) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
    if (!lines.length) break
    const notice = noticeOf(lines[lines.length - 1].trim())
    if (!notice) break
    lines.pop()
    tail.unshift(notice)
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return { body: lines.join('\n'), notices: [...notices, ...tail] }
}

export function splitExitCode(text: string): { body: string; exitCode: number | null } {
  const match = EXIT_LINE.exec(text)
  if (!match) return { body: text, exitCode: null }
  return { body: text.slice(0, match.index).replace(/\s+$/, ''), exitCode: Number(match[1]) }
}

export function toolOutputView(name: string, output: string): ToolOutputView {
  const stripped = isCodemodeTool(name) ? stripCodemodeHeader(output) : output
  const { body: withoutExit, exitCode } = splitExitCode(stripped)
  const { body, notices } = splitOutputNotices(withoutExit)
  return { body, notices, exitCode }
}

export interface OutputPreview {
  text: string
  hidden: number
  total: number
}

export function previewOutput(text: string, options: { tail: boolean; maxLines: number; maxChars: number }): OutputPreview {
  const lines = text.split('\n')
  const total = lines.length
  if (total <= options.maxLines && text.length <= options.maxChars) return { text, hidden: 0, total }
  const picked = options.tail ? lines.slice(-options.maxLines) : lines.slice(0, options.maxLines)
  let size = picked.reduce((sum, line) => sum + line.length + 1, 0)
  while (picked.length > 1 && size > options.maxChars) {
    const dropped = options.tail ? picked.shift()! : picked.pop()!
    size -= dropped.length + 1
  }
  if (picked.length === 1 && picked[0].length > options.maxChars) {
    picked[0] = options.tail ? `\u2026${picked[0].slice(-options.maxChars)}` : `${picked[0].slice(0, options.maxChars)}\u2026`
  }
  return { text: picked.join('\n'), hidden: total - picked.length, total }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text
}

export function firstLinePreview(text: string, max = 60): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return ''
  const head = clip(lines[0], max)
  return lines.length > 1 && !head.endsWith('\u2026') ? `${head} \u2026` : head
}

const HIDDEN_ARG_KEYS = new Set(['description', 'timeout', 'timeout_ms', 'timeoutMs'])

export function scalarArgValues(args: unknown, count = 2, max = 48): string[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return []
  const values: string[] = []
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (HIDDEN_ARG_KEYS.has(key)) continue
    if (typeof value === 'string') {
      const line = value.split('\n').map((part) => part.trim()).find(Boolean)
      if (line) values.push(clip(line, max))
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      values.push(String(value))
    }
    if (values.length >= count) break
  }
  return values
}

export function readLineRange(args: unknown): { from: number; to: number | null } | null {
  if (!args || typeof args !== 'object') return null
  const record = args as Record<string, unknown>
  const offset = typeof record.offset === 'number' && record.offset > 0 ? Math.floor(record.offset) : null
  const limit = typeof record.limit === 'number' && record.limit > 0 ? Math.floor(record.limit) : null
  if (offset === null && limit === null) return null
  const from = offset ?? 1
  return { from, to: limit === null ? null : from + limit - 1 }
}

export function relativePath(path: string, cwd?: string | null): string {
  const shown = path.replace(/\\/g, '/')
  const root = cwd?.replace(/\\/g, '/').replace(/\/+$/, '')
  if (root && shown.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return shown.slice(root.length + 1)
  return shown
}

export function writeArgContent(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const record = args as Record<string, unknown>
  for (const key of ['content', 'contents', 'text']) if (typeof record[key] === 'string') return record[key] as string
  return null
}

export type ArgEntry = { key: string; value: string; block: boolean }

export function argEntries(args: unknown, skip: readonly string[] = []): ArgEntry[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return []
  const entries: ArgEntry[] = []
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (skip.includes(key) || value === undefined) continue
    if (typeof value === 'string') entries.push({ key, value, block: value.includes('\n') })
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) entries.push({ key, value: String(value), block: false })
    else entries.push({ key, value: JSON.stringify(value, null, 2), block: true })
  }
  return entries
}

const TEST_COMMAND = /(^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S+)?|npx\s+(?:vitest|jest|mocha)|vitest|jest|mocha|pytest|cargo\s+test|go\s+test|node\s+--test|dotnet\s+test)\b/

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command)
}

const TAP_COUNT = /^#\s*(pass|fail)\s+(\d+)\s*$/i
const COUNT_WORD = /(\d+)\s+(passed|passing|failed|failing)\b/gi

export function parseTestSummary(output: string): { passed: number; failed: number } | null {
  const lines = output.replace(/\r\n/g, '\n').split('\n').slice(-60)
  let passed: number | null = null
  let failed: number | null = null
  for (let i = lines.length - 1; i >= 0 && (passed === null || failed === null); i -= 1) {
    const line = lines[i].trim()
    const tap = TAP_COUNT.exec(line)
    if (tap) {
      if (/^pass$/i.test(tap[1])) passed ??= Number(tap[2])
      else failed ??= Number(tap[2])
      continue
    }
    for (const match of line.matchAll(COUNT_WORD)) {
      if (/^pass/i.test(match[2])) passed ??= Number(match[1])
      else failed ??= Number(match[1])
    }
  }
  if (passed === null && failed === null) return null
  return { passed: passed ?? 0, failed: failed ?? 0 }
}

export type YanSummary =
  | { kind: 'search'; count: number | null; points: string[] }
  | { kind: 'page'; title: string; points: string[]; body: string }

const YAN_COMMAND = /(^|[\s;&|(])yan(\.cmd|\.exe)?\s+(search|browser|fetch|web)\b/

export function isYanJsonCommand(command: string): boolean {
  return YAN_COMMAND.test(command)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function firstLine(value: unknown, max = 160): string {
  return clip(text(value).split('\n').map((line) => line.trim()).find(Boolean) ?? '', max)
}

function summaryOf(parsed: Record<string, unknown>): YanSummary | null {
  const summary = parsed.summary
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    const error = parsed.ok === false ? firstLine(typeof parsed.error === 'object' && parsed.error ? (parsed.error as Record<string, unknown>).message : parsed.error) : ''
    return error ? { kind: 'page', title: error, points: [], body: '' } : null
  }
  const entry = summary as Record<string, unknown>
  if (entry.kind === 'search' && entry.action === 'query') {
    const points = (Array.isArray(entry.queries) ? entry.queries : []).flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return []
      const query = raw as Record<string, unknown>
      const name = firstLine(query.query, 80)
      const detail = firstLine(query.summary, 120) || (typeof query.count === 'number' ? String(query.count) : '')
      return name ? [detail ? `${name} \u00b7 ${detail}` : name] : []
    })
    return { kind: 'search', count: typeof entry.count === 'number' ? entry.count : null, points }
  }
  const url = text(entry.url)
  const title = firstLine(entry.title) || url || firstLine(entry.summary) || [text(entry.kind), text(entry.action)].filter(Boolean).join(' ')
  if (!title) return null
  const points: string[] = []
  if (url && url !== title) points.push(clip(url, 160))
  const logs = Array.isArray(entry.logTail) ? entry.logTail : []
  for (const log of logs.slice(-3)) {
    const line = firstLine(log)
    if (line && !(url && line.includes(url))) points.push(line)
  }
  const error = firstLine(entry.error)
  if (error) points.push(error)
  return { kind: 'page', title, points, body: summaryBody(entry) }
}

const SUMMARY_SHOWN_KEYS = new Set(['kind', 'action', 'ok', 'title', 'url', 'error', 'summary', 'logTail', 'logs'])

function summaryBody(entry: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(entry)) {
    if (SUMMARY_SHOWN_KEYS.has(key)) continue
    if (typeof value === 'string' && (value.length > 120 || value.includes('\n'))) parts.push(value.trim())
    else if (value && typeof value === 'object') parts.push(`${key}: ${JSON.stringify(value, null, 2)}`)
  }
  return parts.join('\n\n')
}

export function parseYanSummaries(output: string): { summaries: YanSummary[]; rest: string } | null {
  const summaries: YanSummary[] = []
  const rest: string[] = []
  for (const raw of output.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim()
    if (line.startsWith('{') && line.endsWith('}') && line.includes('"ok"')) {
      try {
        const parsed = JSON.parse(line) as unknown
        const summary = parsed && typeof parsed === 'object' ? summaryOf(parsed as Record<string, unknown>) : null
        if (summary) {
          summaries.push(summary)
          continue
        }
      } catch {
        rest.push(raw)
        continue
      }
    }
    rest.push(raw)
  }
  if (!summaries.length) return null
  return { summaries, rest: rest.join('\n').trim() }
}
