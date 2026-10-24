export type TomlValue = string | number | boolean | TomlValue[] | TomlTable

export interface TomlTable {
  [key: string]: TomlValue
}

interface Cursor {
  text: string
  pos: number
}

const BARE_KEY = /[A-Za-z0-9_-]/

function skipSpace(c: Cursor): void {
  while (c.pos < c.text.length) {
    const ch = c.text[c.pos]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      c.pos += 1
      continue
    }
    if (ch === '#') {
      while (c.pos < c.text.length && c.text[c.pos] !== '\n') c.pos += 1
      continue
    }
    break
  }
}

function skipInlineSpace(c: Cursor): void {
  while (c.pos < c.text.length && (c.text[c.pos] === ' ' || c.text[c.pos] === '\t')) c.pos += 1
}

function escapeChar(ch: string): string {
  if (ch === 'n') return '\n'
  if (ch === 't') return '\t'
  if (ch === 'r') return '\r'
  if (ch === '"') return '"'
  if (ch === '\\') return '\\'
  if (ch === 'u' || ch === 'U') return ''
  return ch
}

function parseString(c: Cursor): string {
  const quote = c.text[c.pos]
  const triple = c.text.startsWith(quote.repeat(3), c.pos)
  if (triple) {
    c.pos += 3
    const end = c.text.indexOf(quote.repeat(3), c.pos)
    const raw = end < 0 ? c.text.slice(c.pos) : c.text.slice(c.pos, end)
    c.pos = end < 0 ? c.text.length : end + 3
    return quote === '"' ? raw.replace(/\\(.)/g, (_match, ch: string) => escapeChar(ch)) : raw
  }
  c.pos += 1
  let out = ''
  while (c.pos < c.text.length) {
    const ch = c.text[c.pos]
    if (ch === quote) {
      c.pos += 1
      break
    }
    if (ch === '\\' && quote === '"') {
      const next = c.text[c.pos + 1] ?? ''
      if (next === 'u' || next === 'U') {
        const length = next === 'u' ? 4 : 8
        const hex = c.text.slice(c.pos + 2, c.pos + 2 + length)
        c.pos += 2 + length
        out += String.fromCodePoint(Number.parseInt(hex, 16) || 0)
        continue
      }
      out += escapeChar(next)
      c.pos += 2
      continue
    }
    if (ch === '\n') break
    out += ch
    c.pos += 1
  }
  return out
}

function parseBareValue(c: Cursor): TomlValue {
  const start = c.pos
  while (c.pos < c.text.length && !/[\s,\]}#]/.test(c.text[c.pos])) c.pos += 1
  const token = c.text.slice(start, c.pos)
  if (token === 'true') return true
  if (token === 'false') return false
  if (/^[-+]?\d[\d_]*$/.test(token)) return Number(token.replace(/_/g, ''))
  if (/^[-+]?\d[\d_]*\.\d[\d_]*([eE][-+]?\d+)?$/.test(token)) return Number(token.replace(/_/g, ''))
  return token
}

function parseArray(c: Cursor): TomlValue[] {
  c.pos += 1
  const out: TomlValue[] = []
  while (c.pos < c.text.length) {
    skipSpace(c)
    if (c.text[c.pos] === ']') {
      c.pos += 1
      return out
    }
    if (c.pos >= c.text.length) return out
    out.push(parseValue(c))
    skipSpace(c)
    if (c.text[c.pos] === ',') {
      c.pos += 1
      continue
    }
    if (c.text[c.pos] === ']') {
      c.pos += 1
      return out
    }
    return out
  }
  return out
}

function parseInlineTable(c: Cursor): TomlTable {
  c.pos += 1
  const table: TomlTable = {}
  while (c.pos < c.text.length) {
    skipSpace(c)
    if (c.text[c.pos] === '}') {
      c.pos += 1
      return table
    }
    const path = parseKeyPath(c)
    skipInlineSpace(c)
    if (c.text[c.pos] === '=') c.pos += 1
    const value = parseValue(c)
    assignPath(table, path, value)
    skipSpace(c)
    if (c.text[c.pos] === ',') c.pos += 1
  }
  return table
}

function parseValue(c: Cursor): TomlValue {
  skipInlineSpace(c)
  const ch = c.text[c.pos]
  if (ch === '"' || ch === "'") return parseString(c)
  if (ch === '[') return parseArray(c)
  if (ch === '{') return parseInlineTable(c)
  return parseBareValue(c)
}

function parseKeyPath(c: Cursor): string[] {
  const parts: string[] = []
  while (c.pos < c.text.length) {
    skipInlineSpace(c)
    const ch = c.text[c.pos]
    if (ch === '"' || ch === "'") {
      parts.push(parseString(c))
    } else {
      const start = c.pos
      while (c.pos < c.text.length && BARE_KEY.test(c.text[c.pos])) c.pos += 1
      const token = c.text.slice(start, c.pos)
      if (token) parts.push(token)
      else break
    }
    skipInlineSpace(c)
    if (c.text[c.pos] === '.') {
      c.pos += 1
      continue
    }
    break
  }
  return parts
}

function asTable(value: TomlValue | undefined): TomlTable | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value
}

function ensureTable(root: TomlTable, path: string[]): TomlTable {
  let current = root
  for (const key of path) {
    const existing = current[key]
    if (Array.isArray(existing)) {
      const last = existing[existing.length - 1]
      const table = asTable(last)
      if (table) {
        current = table
        continue
      }
      const created: TomlTable = {}
      existing.push(created)
      current = created
      continue
    }
    const table = asTable(existing)
    if (table) {
      current = table
      continue
    }
    const created: TomlTable = {}
    current[key] = created
    current = created
  }
  return current
}

function pushArrayTable(root: TomlTable, path: string[]): TomlTable {
  if (path.length === 0) return root
  const parent = ensureTable(root, path.slice(0, -1))
  const key = path[path.length - 1]
  const existing = parent[key]
  const created: TomlTable = {}
  if (Array.isArray(existing)) existing.push(created)
  else parent[key] = [created]
  return created
}

function assignPath(target: TomlTable, path: string[], value: TomlValue): void {
  if (path.length === 0) return
  const parent = path.length === 1 ? target : ensureTable(target, path.slice(0, -1))
  parent[path[path.length - 1]] = value
}

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {}
  const c: Cursor = { text: text.replace(/^\uFEFF/, ''), pos: 0 }
  let current = root
  while (c.pos < c.text.length) {
    skipSpace(c)
    if (c.pos >= c.text.length) break
    if (c.text.startsWith('[[', c.pos)) {
      c.pos += 2
      const path = parseKeyPath(c)
      while (c.pos < c.text.length && c.text[c.pos] !== ']') c.pos += 1
      c.pos += 2
      current = pushArrayTable(root, path)
      continue
    }
    if (c.text[c.pos] === '[') {
      c.pos += 1
      const path = parseKeyPath(c)
      while (c.pos < c.text.length && c.text[c.pos] !== ']') c.pos += 1
      c.pos += 1
      current = ensureTable(root, path)
      continue
    }
    const path = parseKeyPath(c)
    skipInlineSpace(c)
    if (c.text[c.pos] !== '=') {
      const nextLine = c.text.indexOf('\n', c.pos)
      if (nextLine < 0) break
      c.pos = nextLine + 1
      continue
    }
    c.pos += 1
    const value = parseValue(c)
    assignPath(current, path, value)
    const nextLine = c.text.indexOf('\n', c.pos)
    const rest = c.text.slice(c.pos, nextLine < 0 ? c.text.length : nextLine)
    if (rest.trim() && !rest.trim().startsWith('#')) {
      c.pos = nextLine < 0 ? c.text.length : nextLine + 1
    }
  }
  return root
}

export function tableArray(value: TomlValue | undefined): TomlTable[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => asTable(item)).filter((item): item is TomlTable => !!item)
}

export function textOf(value: TomlValue | undefined): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

export function boolOf(value: TomlValue | undefined): boolean | null {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}
