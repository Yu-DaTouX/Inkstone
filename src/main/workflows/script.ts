import { Script } from 'node:vm'
import type { WorkflowMeta } from '../../shared/workflows'

export type ScriptCheck =
  | { ok: true; meta: WorkflowMeta; code: string }
  | { ok: false; error: string }

const META_HEAD = /^export\s+const\s+meta\s*=/
const META_KEYS = new Set(['name', 'description', 'phases'])
const IDENT_START = /[A-Za-z_$]/
const IDENT_PART = /[\w$]/
const MAX_SCRIPT_CHARS = 200_000

export const WORKFLOW_SCRIPT_FILENAME = 'script.js'

class LiteralError extends Error {}

function skipTrivia(source: string, at: number): number {
  let i = at
  while (i < source.length) {
    const ch = source[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\uFEFF' || ch === '\u00A0' || ch === '\u2028' || ch === '\u2029') {
      i += 1
    } else if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i)
      i = end < 0 ? source.length : end + 1
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2)
      if (end < 0) throw new LiteralError('注释没有结束')
      i = end + 2
    } else break
  }
  return i
}

function unescape(body: string): string {
  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = body[i + 1]
    i += 1
    if (next === 'n') out += '\n'
    else if (next === 't') out += '\t'
    else if (next === 'r') out += '\r'
    else if (next === 'b') out += '\b'
    else if (next === 'f') out += '\f'
    else if (next === 'v') out += '\v'
    else if (next === '0') out += '\0'
    else if (next === 'x') {
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16))
      i += 2
    } else if (next === 'u' && body[i + 1] === '{') {
      const end = body.indexOf('}', i)
      out += String.fromCodePoint(parseInt(body.slice(i + 2, end), 16))
      i = end
    } else if (next === 'u') {
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16))
      i += 4
    } else if (next === '\r' && body[i + 1] === '\n') i += 1
    else if (next === '\n' || next === '\r') continue
    else out += next ?? ''
  }
  return out
}

function readString(source: string, at: number): { value: string; end: number } {
  const quote = source[at]
  let i = at + 1
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (quote === '`' && ch === '$' && source[i + 1] === '{') throw new LiteralError('meta 里的模板字符串不能带 ${…}')
    if (ch === quote) return { value: unescape(source.slice(at + 1, i)), end: i + 1 }
    if (quote !== '`' && (ch === '\n' || ch === '\r')) break
    i += 1
  }
  throw new LiteralError('字符串没有结束')
}

function readValue(source: string, at: number): { value: unknown; end: number } {
  const i = skipTrivia(source, at)
  const ch = source[i]
  if (ch === '{') return readObject(source, i)
  if (ch === '[') return readArray(source, i)
  if (ch === '"' || ch === "'" || ch === '`') return readString(source, i)
  const number = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i, i + 64))
  if (number && !IDENT_PART.test(source[i + number[0].length] ?? '')) return { value: Number(number[0]), end: i + number[0].length }
  for (const [word, value] of [['true', true], ['false', false], ['null', null]] as const) {
    if (source.startsWith(word, i) && !IDENT_PART.test(source[i + word.length] ?? '')) return { value, end: i + word.length }
  }
  const sample = source.slice(i, i + 24).split(/\r?\n/)[0]
  throw new LiteralError(`meta 只能写纯字面量（字符串、数字、布尔、null、数组、对象），不能用变量、函数调用或展开：${sample}`)
}

function readObject(source: string, at: number): { value: Record<string, unknown>; end: number } {
  const out: Record<string, unknown> = {}
  let i = at + 1
  for (;;) {
    i = skipTrivia(source, i)
    if (source[i] === '}') return { value: out, end: i + 1 }
    let key: string
    const ch = source[i]
    if (ch === '"' || ch === "'") {
      const read = readString(source, i)
      key = read.value
      i = read.end
    } else if (ch && IDENT_START.test(ch)) {
      let end = i + 1
      while (end < source.length && IDENT_PART.test(source[end])) end += 1
      key = source.slice(i, end)
      i = end
    } else if (source.startsWith('...', i)) {
      throw new LiteralError('meta 里不能用展开（...）')
    } else if (ch === '[') {
      throw new LiteralError('meta 里不能用计算属性名')
    } else {
      throw new LiteralError(`meta 的对象写法不对：${source.slice(i, i + 20).split(/\r?\n/)[0]}`)
    }
    i = skipTrivia(source, i)
    if (source[i] !== ':') throw new LiteralError(`meta 的「${key}」要写成 ${key}: 值（不能用简写或方法）`)
    const read = readValue(source, i + 1)
    if (Object.hasOwn(out, key)) throw new LiteralError(`meta 的「${key}」重复了`)
    out[key] = read.value
    i = skipTrivia(source, read.end)
    if (source[i] === ',') {
      i += 1
      continue
    }
    if (source[i] === '}') return { value: out, end: i + 1 }
    throw new LiteralError(`meta 的对象写法不对：${source.slice(i, i + 20).split(/\r?\n/)[0]}`)
  }
}

function readArray(source: string, at: number): { value: unknown[]; end: number } {
  const out: unknown[] = []
  let i = at + 1
  for (;;) {
    i = skipTrivia(source, i)
    if (source[i] === ']') return { value: out, end: i + 1 }
    if (source[i] === ',') throw new LiteralError('meta 的数组里不能有空位')
    if (source.startsWith('...', i)) throw new LiteralError('meta 里不能用展开（...）')
    const read = readValue(source, i)
    out.push(read.value)
    i = skipTrivia(source, read.end)
    if (source[i] === ',') {
      i += 1
      continue
    }
    if (source[i] === ']') return { value: out, end: i + 1 }
    throw new LiteralError(`meta 的数组写法不对：${source.slice(i, i + 20).split(/\r?\n/)[0]}`)
  }
}

export function validateMeta(raw: unknown): { ok: true; meta: WorkflowMeta } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'meta 必须是对象' }
  const box = raw as Record<string, unknown>
  const extra = Object.keys(box).find((key) => !META_KEYS.has(key))
  if (extra) return { ok: false, error: `meta 只能有 name、description、phases，多了「${extra}」` }
  const name = typeof box.name === 'string' ? box.name.trim() : ''
  if (!name) return { ok: false, error: 'meta.name 必须是非空字符串' }
  if ([...name].length > 80 || /[\r\n]/.test(name)) return { ok: false, error: 'meta.name 最多 80 字符、不能换行' }
  const description = typeof box.description === 'string' ? box.description.trim() : ''
  if (!description) return { ok: false, error: 'meta.description 必须是非空字符串' }
  if ([...description].length > 1000) return { ok: false, error: 'meta.description 最多 1000 字符' }
  if (box.phases === undefined) return { ok: true, meta: { name, description } }
  if (!Array.isArray(box.phases) || box.phases.some((item) => typeof item !== 'string' || !item.trim())) return { ok: false, error: 'meta.phases 必须是非空字符串数组' }
  const phases = (box.phases as string[]).map((item) => item.trim())
  if (phases.length > 50) return { ok: false, error: 'meta.phases 最多 50 个' }
  if (new Set(phases).size !== phases.length) return { ok: false, error: 'meta.phases 里有重复的阶段名' }
  return { ok: true, meta: { name, description, phases } }
}

const REGEX_AFTER = /[(,=:[!&|?{};+\-*%<>~^]$/
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/

export function forbiddenImportAt(code: string): number {
  const templates: number[] = []
  let i = 0
  let last = ''
  const regexAllowed = (): boolean => {
    const trimmed = last.trimEnd()
    return !trimmed || REGEX_AFTER.test(trimmed) || REGEX_AFTER_WORD.test(trimmed)
  }
  while (i < code.length) {
    const ch = code[i]
    if (ch === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i)
      i = end < 0 ? code.length : end
      continue
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)
      i = end < 0 ? code.length : end + 2
      continue
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < code.length && code[j] !== ch && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1
      i = j + 1
      last = '"'
      continue
    }
    if (ch === '`' || (ch === '}' && templates.length && templates[templates.length - 1] === 0)) {
      if (ch === '}') templates.pop()
      let j = i + 1
      while (j < code.length && code[j] !== '`' && !(code[j] === '$' && code[j + 1] === '{')) j += code[j] === '\\' ? 2 : 1
      if (code[j] === '$') {
        templates.push(0)
        i = j + 2
        last = '{'
      } else {
        i = j + 1
        last = '"'
      }
      continue
    }
    if (ch === '{' && templates.length) templates[templates.length - 1] += 1
    if (ch === '}' && templates.length) templates[templates.length - 1] -= 1
    if (ch === '/' && regexAllowed()) {
      let j = i + 1
      let inClass = false
      while (j < code.length && code[j] !== '\n') {
        if (code[j] === '\\') j += 2
        else if (code[j] === '[') { inClass = true; j += 1 }
        else if (code[j] === ']') { inClass = false; j += 1 }
        else if (code[j] === '/' && !inClass) break
        else j += 1
      }
      i = j + 1
      while (i < code.length && IDENT_PART.test(code[i])) i += 1
      last = '"'
      continue
    }
    if (IDENT_START.test(ch)) {
      let end = i + 1
      while (end < code.length && IDENT_PART.test(code[end])) end += 1
      const word = code.slice(i, end)
      if (word === 'import' && last !== '.') return i
      last = word
      i = end
      continue
    }
    if (ch.trim()) last = ch
    i += 1
  }
  return -1
}

function lineOf(code: string, at: number): number {
  let line = 1
  for (let i = 0; i < at && i < code.length; i += 1) if (code[i] === '\n') line += 1
  return line
}

export function wrapWorkflowCode(code: string): string {
  return `(async () => {${code}\n})()`
}

export function checkWorkflowScript(raw: string): ScriptCheck {
  const source = raw.replace(/^\uFEFF/, '')
  if (!source.trim()) return { ok: false, error: '脚本是空的' }
  if (source.length > MAX_SCRIPT_CHARS) return { ok: false, error: `脚本超过 ${MAX_SCRIPT_CHARS} 字符` }
  let start: number
  try {
    start = skipTrivia(source, 0)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const head = META_HEAD.exec(source.slice(start))
  if (!head) return { ok: false, error: '首条语句必须是 export const meta = { name: …, description: … }' }
  let parsed: { value: unknown; end: number }
  try {
    parsed = readValue(source, start + head[0].length)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const meta = validateMeta(parsed.value)
  if (!meta.ok) return meta
  const code = `${source.slice(0, start)}${' '.repeat('export'.length)}${source.slice(start + 'export'.length)}`
  const body = code.slice(parsed.end)
  const importAt = forbiddenImportAt(body)
  if (importAt >= 0) {
    return { ok: false, error: `第 ${lineOf(code, parsed.end + importAt)} 行用了 import：工作流脚本不能加载模块，需要库的工作交给 agent()` }
  }
  try {
    new Script(wrapWorkflowCode(code), { filename: WORKFLOW_SCRIPT_FILENAME })
  } catch (error) {
    const stack = error instanceof Error ? String(error.stack ?? '') : ''
    const line = new RegExp(`${WORKFLOW_SCRIPT_FILENAME}:(\\d+)`).exec(stack)?.[1]
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `语法错误${line ? `（第 ${line} 行）` : ''}：${message}` }
  }
  return { ok: true, meta: meta.meta, code }
}
