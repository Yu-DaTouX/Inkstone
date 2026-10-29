export type NotebookCellKind = 'markdown' | 'code' | 'raw'

export type NotebookOutput =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mime: string; dataUrl: string }
  | { kind: 'mime'; mime: string }

export interface NotebookCell {
  kind: NotebookCellKind
  source: string
  markdown: string
  executionCount: number | null
  outputs: NotebookOutput[]
  hiddenOutputs: number
}

export type NotebookParse =
  | { kind: 'ok'; language: string; cells: NotebookCell[]; hiddenCells: number; hiddenOutputs: number }
  | { kind: 'empty' }
  | { kind: 'failed'; reason: 'json' | 'shape' }

export const NOTEBOOK_MAX_CELLS = 400
export const NOTEBOOK_MAX_OUTPUTS = 40
export const NOTEBOOK_MAX_TEXT = 20_000

const IMAGE_MIMES: Record<string, string> = { 'image/png': 'image/png', 'image/jpeg': 'image/jpeg', 'image/gif': 'image/gif' }

const ANSI = /\u001b\[[0-9;]*m/g

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').join('')
  return ''
}

function clip(text: string): string {
  return text.length > NOTEBOOK_MAX_TEXT ? `${text.slice(0, NOTEBOOK_MAX_TEXT)}\n…` : text
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function notebookCellsOf(root: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(root.cells)) return root.cells
  if (Array.isArray(root.worksheets)) {
    const cells: unknown[] = []
    for (const sheet of root.worksheets) {
      const list = record(sheet)?.cells
      if (Array.isArray(list)) cells.push(...list)
    }
    return cells.length ? cells : null
  }
  return null
}

function languageOf(root: Record<string, unknown>): string {
  const metadata = record(root.metadata)
  const kernelspec = record(metadata?.kernelspec)
  const languageInfo = record(metadata?.language_info)
  const name = asText(languageInfo?.name) || asText(kernelspec?.language)
  return name.trim().toLowerCase() || 'python'
}

function cellKindOf(type: string): NotebookCellKind | null {
  if (type === 'markdown' || type === 'heading') return 'markdown'
  if (type === 'code') return 'code'
  if (type === 'raw') return 'raw'
  return null
}

function outputsOf(cell: Record<string, unknown>): { outputs: NotebookOutput[]; hidden: number } {
  const list = Array.isArray(cell.outputs) ? cell.outputs : []
  const outputs: NotebookOutput[] = []
  let hidden = 0
  const push = (output: NotebookOutput): void => {
    if (outputs.length < NOTEBOOK_MAX_OUTPUTS) outputs.push(output)
    else hidden += 1
  }
  for (const item of list) {
    const output = record(item)
    if (!output) continue
    const type = asText(output.output_type)
    if (type === 'stream') {
      const text = asText(output.text)
      if (text) push({ kind: 'text', text: clip(text) })
      continue
    }
    if (type === 'error') {
      const name = asText(output.ename)
      const value = asText(output.evalue)
      const trace = Array.isArray(output.traceback)
        ? output.traceback.map((line) => asText(line).replace(ANSI, '')).join('\n')
        : ''
      const text = [`${name}: ${value}`.replace(/^:\s*/, ''), trace].filter((part) => part.trim() !== '').join('\n')
      if (text) push({ kind: 'text', text: clip(text) })
      continue
    }
    if (type === 'pyout' && asText(output.text)) {
      push({ kind: 'text', text: clip(asText(output.text)) })
    }
    if (asText(output.png)) {
      push({ kind: 'image', mime: 'image/png', dataUrl: `data:image/png;base64,${asText(output.png).replace(/\s+/g, '')}` })
    }
    const data = record(output.data)
    if (!data) continue
    const bitmap = IMAGE_MIMES[Object.keys(data).find((mime) => mime in IMAGE_MIMES) ?? '']
    if (bitmap) {
      const encoded = asText(data[bitmap]).replace(/\s+/g, '')
      if (encoded) push({ kind: 'image', mime: bitmap, dataUrl: `data:${bitmap};base64,${encoded}` })
    }
    const plain = asText(data['text/plain'])
    if (plain) push({ kind: 'text', text: clip(plain) })
    for (const mime of Object.keys(data)) {
      if (mime === 'text/plain' || mime in IMAGE_MIMES) continue
      push({ kind: 'mime', mime })
    }
  }
  return { outputs, hidden }
}

const LINK_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*\S/

function inertSegment(segment: string): string {
  return segment
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<(https?:\/\/|mailto:)([^>\s]+)>/g, '$1$2')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\bhttps?:\/\//gi, '')
    .replace(/\bwww\./gi, '')
}

function inertLine(line: string): string {
  if (LINK_DEFINITION.test(line)) return ''
  let out = ''
  let index = 0
  for (const match of line.matchAll(/`+[^`]*`+/g)) {
    const start = match.index ?? 0
    out += inertSegment(line.slice(index, start)) + match[0]
    index = start + match[0].length
  }
  return out + inertSegment(line.slice(index))
}

export function notebookMarkdown(source: string): string {
  const lines: string[] = []
  let fence: string | null = null
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? ''
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      lines.push(line)
      continue
    }
    lines.push(fence ? line : inertLine(line))
  }
  return lines.join('\n')
}

export function notebookFence(source: string, language: string): string {
  const longest = Math.max(0, ...Array.from(source.matchAll(/`+/g), (match) => match[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${language}\n${source.replace(/\r\n?/g, '\n').replace(/\n$/, '')}\n${fence}`
}

function cellOf(raw: unknown): NotebookCell | null {
  const cell = record(raw)
  if (!cell) return null
  const type = asText(cell.cell_type)
  const kind = cellKindOf(type)
  if (!kind) return null
  let source = asText(cell.source) || asText(cell.input)
  if (type === 'heading') {
    const level = Math.min(6, Math.max(1, Number(cell.level) || 1))
    source = `${'#'.repeat(level)} ${source.trim()}`
  }
  const count = cell.execution_count
  const executionCount = typeof count === 'number' && Number.isFinite(count) ? count : null
  const outputs = kind === 'code' ? outputsOf(cell) : { outputs: [] as NotebookOutput[], hidden: 0 }
  return { kind, source, markdown: kind === 'markdown' ? notebookMarkdown(source) : '', executionCount, outputs: outputs.outputs, hiddenOutputs: outputs.hidden }
}

export function parseNotebook(text: string): NotebookParse {
  const source = text.trim()
  if (!source) return { kind: 'empty' }
  let json: unknown
  try {
    json = JSON.parse(source)
  } catch {
    return { kind: 'failed', reason: 'json' }
  }
  const root = record(json)
  const raw = root ? notebookCellsOf(root) : null
  if (!root || !raw) return { kind: 'failed', reason: 'shape' }
  const cells: NotebookCell[] = []
  for (const item of raw) {
    const cell = cellOf(item)
    if (cell) cells.push(cell)
    if (cells.length >= NOTEBOOK_MAX_CELLS) break
  }
  const hiddenOutputs = cells.reduce((count, cell) => count + cell.hiddenOutputs, 0)
  return { kind: 'ok', language: languageOf(root), cells, hiddenCells: raw.length - cells.length, hiddenOutputs }
}
