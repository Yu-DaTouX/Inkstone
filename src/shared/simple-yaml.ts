interface Line { indent: number; text: string }

class YamlError extends Error {}

function scalar(raw: string): unknown {
  const text = raw.trim()
  if (text === '' || text === '~' || text === 'null') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return Number(text)
  if (text.startsWith('"')) {
    try { return JSON.parse(text) } catch { throw new YamlError('bad string') }
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new YamlError('bad string')
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text.startsWith('[') || text.startsWith('{')) {
    try { return JSON.parse(text) } catch {}
    if (text.startsWith('[') && text.endsWith(']')) {
      const inner = text.slice(1, -1).trim()
      return inner ? inner.split(',').map(scalar) : []
    }
    throw new YamlError('bad flow value')
  }
  return text
}

function splitKey(text: string): { key: string; rest: string } | null {
  const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(?:\s+(.*))?$/.exec(text)
  if (quoted) return { key: String(scalar(quoted[1])), rest: quoted[2] ?? '' }
  const at = text.indexOf(': ')
  if (at > 0) return { key: text.slice(0, at).trim(), rest: text.slice(at + 2) }
  if (text.endsWith(':') && text.length > 1) return { key: text.slice(0, -1).trim(), rest: '' }
  return null
}

const isItem = (text: string): boolean => text === '-' || text.startsWith('- ')

function block(lines: Line[], start: number, indent: number): [unknown, number] {
  return isItem(lines[start].text) ? sequence(lines, start, indent) : mapping(lines, start, indent)
}

function child(lines: Line[], next: number, indent: number, allowSameIndentList: boolean): [unknown, number] {
  const line = lines[next]
  if (line && (line.indent > indent || (allowSameIndentList && line.indent === indent && isItem(line.text)))) return block(lines, next, line.indent)
  return [null, next]
}

function sequence(lines: Line[], start: number, indent: number): [unknown[], number] {
  const out: unknown[] = []
  let i = start
  while (i < lines.length && lines[i].indent === indent && isItem(lines[i].text)) {
    const rest = lines[i].text.slice(1).trimStart()
    if (!rest) {
      const [value, next] = child(lines, i + 1, indent, false)
      out.push(value)
      i = next
    } else if (isItem(rest) || splitKey(rest)) {
      const inner = indent + lines[i].text.length - rest.length
      const nested = [{ indent: inner, text: rest }, ...lines.slice(i + 1)]
      const [value, used] = block(nested, 0, inner)
      out.push(value)
      i += used
    } else {
      out.push(scalar(rest))
      i++
    }
  }
  if (i < lines.length && lines[i].indent > indent) throw new YamlError('bad indent')
  return [out, i]
}

function mapping(lines: Line[], start: number, indent: number): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {}
  let i = start
  while (i < lines.length && lines[i].indent === indent && !isItem(lines[i].text)) {
    const pair = splitKey(lines[i].text)
    if (!pair || !pair.key) throw new YamlError('expected key')
    if (pair.rest.trim()) {
      out[pair.key] = scalar(pair.rest)
      i++
    } else {
      const [value, next] = child(lines, i + 1, indent, true)
      out[pair.key] = value
      i = next
    }
  }
  if (i < lines.length && lines[i].indent > indent) throw new YamlError('bad indent')
  return [out, i]
}

export function parseSimpleYaml(source: string): unknown {
  const lines: Line[] = []
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(?:#.*)?$/.test(raw) || raw.trim() === '---') continue
    if (/^ *\t/.test(raw)) throw new YamlError('tab indent')
    const text = raw.trimStart()
    lines.push({ indent: raw.length - text.length, text: text.trimEnd() })
  }
  if (!lines.length) throw new YamlError('empty')
  const [value, end] = block(lines, 0, lines[0].indent)
  if (end !== lines.length) throw new YamlError('trailing content')
  return value
}
