export const CSV_MAX_BYTES = 1024 * 1024
export const CSV_MAX_ROWS = 500
export const CSV_MAX_COLUMNS = 64
export const CSV_MAX_CELL_UNITS = 300
const CSV_TRUNCATION_MARK = '…'

export type CsvColumnKind = 'number' | 'date' | 'text'

export interface CsvTable {
  rows: string[][]
  hasHeader: boolean
  rowsTruncated: boolean
  colsTruncated: boolean
  cellsTruncated: boolean
}

export type CsvParseResult = { kind: 'ok'; table: CsvTable } | { kind: 'empty' } | { kind: 'failed' }

const BLANK_CELL = /^(?:|[-\u2014\u2013]|n\/?a|null|nan|none)$/i
const NUMERIC_CELL = /^[-+(]?[$\u20AC\u00A3\u00A5]?\d[\d,._ ']*(?:[.,]\d+)?[)%]?[kKmMbB]?$/
const DATE_TIME_PREFIX = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?'
const DATE_WORDS = new RegExp(
  `^(?:${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH},?\\s+\\d{4})\\b`,
  'i'
)
const DATE_ORDINAL = /(\d)(?:st|nd|rd|th)\b/i

function countOf(value: string, char: string): number {
  let total = 0
  for (let i = 0; i < value.length; i += 1) if (value[i] === char) total += 1
  return total
}

function surrogateCut(value: string, at: number): number {
  const code = value.charCodeAt(at - 1)
  return code >= 0xd800 && code <= 0xdbff ? at - 1 : at
}

export function isBlankCsvCell(value: string): boolean {
  return BLANK_CELL.test(String(value ?? '').trim())
}

function normalizeNumberText(value: string): string | null {
  const commas = countOf(value, ',')
  const dots = countOf(value, '.')
  const last = Math.max(value.lastIndexOf(','), value.lastIndexOf('.'))
  if (last === -1) return value
  const separator = value[last]
  const major = separator === ',' ? commas : dots
  const minor = separator === ',' ? dots : commas
  const tail = value.slice(last + 1)
  const decimal = minor > 0 ? major === 1 : major === 1 && (separator === '.' || tail.length !== 3)
  const head = decimal ? value.slice(0, last) : value
  if (/[.,]/.test(head) && !/^-?\d{1,3}(?:[.,]\d{3})+$/.test(head)) return null
  const digits = head.replace(/[.,]/g, '')
  return decimal ? `${digits}.${tail}` : digits
}

export function parseCsvNumber(value: string): number {
  const trimmed = String(value ?? '').trim()
  if (!NUMERIC_CELL.test(trimmed)) return Number.NaN
  const negative = trimmed.startsWith('(') && trimmed.endsWith(')')
  const multiplier = /[kK]$/.test(trimmed) ? 1e3 : /[mM]$/.test(trimmed) ? 1e6 : /[bB]$/.test(trimmed) ? 1e9 : 1
  const normalized = normalizeNumberText(trimmed.replace(/[^\d.,-]/g, ''))
  if (normalized === null) return Number.NaN
  const parsed = Number.parseFloat(normalized) * multiplier
  return negative ? -parsed : parsed
}

export function parseCsvDate(value: string): number {
  const trimmed = String(value ?? '').trim()
  const match = DATE_TIME_PREFIX.exec(trimmed)
  if (match) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = match
    if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed) && trimmed.length > match[0].length) return Date.parse(trimmed)
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime()
  }
  return DATE_WORDS.test(trimmed) ? Date.parse(trimmed.replace(DATE_ORDINAL, '$1')) : Number.NaN
}

export function csvColumnKind(rows: string[][], column: number): CsvColumnKind {
  let numeric = true
  let dated = true
  let filled = 0
  for (const row of rows) {
    const value = row[column] ?? ''
    if (isBlankCsvCell(value)) continue
    filled += 1
    numeric &&= Number.isFinite(parseCsvNumber(value))
    dated &&= Number.isFinite(parseCsvDate(value))
    if (!numeric && !dated) return 'text'
  }
  if (filled === 0) return 'text'
  return numeric ? 'number' : 'date'
}

export function numericCsvColumns(rows: string[][]): Set<number> {
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0)
  const numeric = new Set<number>()
  for (let column = 0; column < width; column += 1) {
    let hits = 0
    let misses = 0
    for (const row of rows) {
      const value = (row[column] ?? '').trim()
      if (isBlankCsvCell(value)) continue
      const repeatedDots = value.indexOf('.') !== value.lastIndexOf('.') && Number.isNaN(parseCsvNumber(value))
      if (NUMERIC_CELL.test(value) && !repeatedDots) hits += 1
      else {
        misses += 1
        break
      }
    }
    if (hits > 0 && misses === 0) numeric.add(column)
  }
  return numeric
}

export function sortCsvRowOrder(
  rows: string[][],
  sort: { column: number; direction: 'asc' | 'desc' },
  kind: CsvColumnKind,
  locale: string
): number[] {
  const direction = sort.direction === 'asc' ? 1 : -1
  const order = rows.map((_, index) => index)
  const column = sort.column
  if (kind === 'text') {
    const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })
    const keys = rows.map((row) => {
      const value = row[column] ?? ''
      return isBlankCsvCell(value) ? null : value.trim()
    })
    return order.sort((left, right) => {
      const a = keys[left] ?? null
      const b = keys[right] ?? null
      if (a === null || b === null) return a === b ? left - right : a === null ? 1 : -1
      return collator.compare(a, b) * direction || left - right
    })
  }
  const read = kind === 'number' ? parseCsvNumber : parseCsvDate
  const keys = rows.map((row) => read(row[column] ?? ''))
  return order.sort((left, right) => {
    const a = keys[left]
    const b = keys[right]
    const aMissing = Number.isNaN(a)
    const bMissing = Number.isNaN(b)
    if (aMissing || bMissing) return aMissing === bMissing ? left - right : aMissing ? 1 : -1
    return (a - b) * direction || left - right
  })
}

export function filterCsvRowOrder(rows: string[][], order: number[], query: string): number[] {
  const needle = String(query ?? '').trim().toLowerCase()
  if (!needle) return order
  const joined = rows.map((row) => row.join('\n').toLowerCase())
  return order.filter((index) => joined[index].includes(needle))
}

function recordEnd(text: string, limit: number, delimiter: string): number {
  const delimiterCode = delimiter.charCodeAt(0)
  const end = Math.min(limit, text.length)
  let quoted = false
  let fieldStart = true
  let lastEnd = -1
  const started = text.charCodeAt(0) === 0xfeff ? 1 : 0
  for (let index = started; index < end; index += 1) {
    const code = text.charCodeAt(index)
    if (quoted) {
      if (code !== 34) continue
      if (text.charCodeAt(index + 1) === 34) index += 1
      else {
        quoted = false
        fieldStart = false
      }
    } else if (code === 34 && fieldStart) {
      quoted = true
    } else if (code === 10) {
      lastEnd = index + 1
      fieldStart = true
    } else {
      fieldStart = code === delimiterCode
    }
  }
  return lastEnd
}

function sniffDelimiter(text: string, fallback: string): string {
  if (fallback === '\t') return fallback
  const line = text
    .split(/\r?\n/)
    .slice(0, 16)
    .find((value) => value.trim() !== '')
  if (!line) return fallback
  const bare = line.replace(/"(?:[^"]|"")*"/g, '')
  const base = countOf(bare, fallback)
  const tabs = countOf(bare, '\t')
  if (tabs > base) return '\t'
  return countOf(bare, ';') > base ? ';' : fallback
}

function readRecords(text: string, delimiter: string, maxRows: number): { rows: string[][]; openQuote: boolean } {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let touched = false
  let limitHit = false
  const started = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const pushField = (): void => {
    row.push(field)
    field = ''
  }
  const pushRow = (): void => {
    pushField()
    const empty = row.length === 1 && row[0] === '' && !touched
    if (!empty) rows.push(row)
    row = []
    touched = false
    if (rows.length >= maxRows) limitHit = true
  }
  for (let index = started; index < text.length && !limitHit; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
      touched = true
      continue
    }
    if (char === delimiter) {
      pushField()
      touched = true
      continue
    }
    if (char === '\n') {
      pushRow()
      continue
    }
    if (char === '\r') continue
    field += char
    touched = true
  }
  if (!limitHit) {
    if (field !== '' || row.length > 0) pushRow()
    return { rows, openQuote: quoted }
  }
  return { rows, openQuote: false }
}

function truncateCell(value: string): { text: string; truncated: boolean } {
  if (value.length <= CSV_MAX_CELL_UNITS) return { text: value, truncated: false }
  return { text: `${value.slice(0, surrogateCut(value, CSV_MAX_CELL_UNITS))}${CSV_TRUNCATION_MARK}`, truncated: true }
}

function looksLikeHeader(rows: string[][]): boolean {
  if (rows.length < 2) return false
  const head = rows[0]
  const next = rows[1]
  const numericish = (value: string): boolean => value.trim() !== '' && !Number.isNaN(Number(value))
  const labelish = (value: string): boolean => value.trim() !== '' && !numericish(value)
  const labels = head.filter(labelish).length
  if (labels === 0 || labels / head.length < 0.5) return false
  return head.some((value, index) => labelish(value) && numericish(next[index] ?? ''))
}

export function parseCsvPreview(text: unknown, delimiter = ','): CsvParseResult {
  const source = String(text ?? '')
  const clipped = source.length > CSV_MAX_BYTES
  const head = clipped ? source.slice(0, CSV_MAX_BYTES) : source
  const used = sniffDelimiter(head, delimiter)
  let body = source
  if (clipped) {
    const end = recordEnd(source, CSV_MAX_BYTES, used)
    body = source.slice(0, end > 0 ? end : surrogateCut(source, CSV_MAX_BYTES))
  }
  let { rows, openQuote } = readRecords(body, used, CSV_MAX_ROWS + 1)
  let rowsTruncated = clipped
  if (openQuote) {
    if (!rows.length) return { kind: 'failed' }
    rows = rows.slice(0, -1)
    rowsTruncated = true
    if (!rows.length) return { kind: 'failed' }
  }
  if (!rows.length) return { kind: 'empty' }
  if (rows.length > CSV_MAX_ROWS) {
    rows = rows.slice(0, CSV_MAX_ROWS)
    rowsTruncated = true
  }
  const width = rows.reduce((widest, row) => Math.max(widest, Math.min(row.length, CSV_MAX_COLUMNS)), 0)
  const colsTruncated = rows.some((row) => row.length > CSV_MAX_COLUMNS)
  let cellsTruncated = false
  const cells = rows.map((row) => {
    const out: string[] = []
    for (let column = 0; column < width; column += 1) {
      const cell = truncateCell(row[column] ?? '')
      if (cell.truncated) cellsTruncated = true
      out.push(cell.text)
    }
    return out
  })
  return {
    kind: 'ok',
    table: { rows: cells, hasHeader: looksLikeHeader(cells), rowsTruncated, colsTruncated, cellsTruncated }
  }
}
