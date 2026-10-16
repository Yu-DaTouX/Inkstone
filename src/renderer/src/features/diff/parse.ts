import type { DiffFile, DiffHunk, DiffLine, DiffParseResult } from './types'

const HUNK_RE = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+ ?(.*)$/

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v'
}

export function unquotePath(value: string): string {
  const s = value.trim()
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s
  const body = s.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch !== '\\') {
      bytes.push(ch.charCodeAt(0) & 0xff)
      continue
    }
    const next = body[i + 1]
    if (next >= '0' && next <= '7') {
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))?.[0] ?? ''
      bytes.push(parseInt(oct, 8))
      i += oct.length
      continue
    }
    const mapped = next != null ? ESCAPES[next] : undefined
    if (mapped != null) {
      for (const c of mapped) bytes.push(c.charCodeAt(0) & 0xff)
      i += 1
      continue
    }
    bytes.push('\\'.charCodeAt(0))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

function stripPrefix(path: string): string {
  return /^[ab]\//.test(path) ? path.slice(2) : path
}

function pathFromMarker(line: string, prefix: '--- ' | '+++ '): string | null {
  if (!line.startsWith(prefix)) return null
  const rest = line.slice(prefix.length)
  const tab = rest.indexOf('\t')
  const raw = (tab >= 0 ? rest.slice(0, tab) : rest).trim()
  if (!raw || raw === '/dev/null') return null
  return stripPrefix(unquotePath(raw))
}

function pathFromGitHeader(line: string): string | null {
  const quoted = /^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)\s*$/.exec(line)
  if (!quoted) return null
  return stripPrefix(unquotePath(quoted[2]))
}

const FILE_HEADER_RE =
  /^(index |old mode|new mode|similarity index|dissimilarity index|copy from|copy to|rename from|rename to|new file mode|deleted file mode)/

function newFile(): DiffFile {
  return {
    path: '',
    additions: 0,
    deletions: 0,
    hunks: [],
    binary: false,
    newFile: false,
    deletedFile: false,
    renamed: false,
    headers: []
  }
}

function newHunk(header: string, oldStart: number, oldCount: number, newStart: number, newCount: number, section: string): DiffHunk {
  return { header, oldStart, oldCount, newStart, newCount, section, lines: [] }
}

export function parsePatch(patch: string): DiffParseResult {
  const result: DiffParseResult = { files: [], preamble: [] }
  const text = patch.replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  const flushHunk = (): void => {
    if (file && hunk) file.hunks.push(hunk)
    hunk = null
  }
  const flushFile = (): void => {
    flushHunk()
    if (file) result.files.push(file)
    file = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (hunk) {
      if (line.startsWith('\\')) {
        const previous = hunk.lines[hunk.lines.length - 1]
        if (previous) previous.noNewline = true
        else hunk.lines.push({ kind: 'context', text: line, raw: line, oldLine: null, newLine: null, noNewline: true })
        continue
      }
      const kind: DiffLine['kind'] | null =
        line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith(' ') || line === '' ? 'context' : null
      if (kind) {
        if (kind === 'add') {
          hunk.lines.push({ kind, text: line.slice(1), raw: line, oldLine: null, newLine: newNo })
          newNo += 1
          if (file) file.additions += 1
        } else if (kind === 'del') {
          hunk.lines.push({ kind, text: line.slice(1), raw: line, oldLine: oldNo, newLine: null })
          oldNo += 1
          if (file) file.deletions += 1
        } else {
          const content = line === '' ? '' : line.slice(1)
          hunk.lines.push({ kind, text: content, raw: line, oldLine: oldNo, newLine: newNo })
          oldNo += 1
          newNo += 1
        }
        continue
      }
      flushHunk()
    }

    if (line.startsWith('diff --git ')) {
      flushFile()
      file = newFile()
      file.headers.push(line)
      file.path = pathFromGitHeader(line) ?? ''
      continue
    }

    if (line.startsWith('@@')) {
      if (!file) file = newFile()
      flushHunk()
      const m = HUNK_RE.exec(line)
      if (!m) {
        hunk = newHunk(line, 0, 0, 0, 0, '')
        file.headers.push(line)
        oldNo = 0
        newNo = 0
        continue
      }
      hunk = newHunk(line, Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4]), m[5] ?? '')
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      continue
    }

    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      if (!file) file = newFile()
      const oldPath = pathFromMarker(line, '--- ')
      const newPath = pathFromMarker(line, '+++ ')
      if (oldPath) file.oldPath = oldPath
      if (newPath) file.path = newPath
      else if (oldPath && !file.path) file.path = oldPath
      file.headers.push(line)
      continue
    }

    if (/^Binary files .+ differ\s*$/.test(line) || line.startsWith('GIT binary patch')) {
      if (!file) file = newFile()
      file.binary = true
      file.headers.push(line)
      continue
    }

    if (file) {
      if (line.startsWith('new file mode')) file.newFile = true
      if (line.startsWith('deleted file mode')) file.deletedFile = true
      if (line.startsWith('rename from')) file.renamed = true
      if (FILE_HEADER_RE.test(line) || line.startsWith('new file mode') || line.startsWith('deleted file mode')) {
        file.headers.push(line)
        continue
      }
    }

    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
      if (!file) file = newFile()
      hunk = newHunk('', 0, 0, 0, 0, '')
      const kind: DiffLine['kind'] = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'context'
      hunk.lines.push({ kind, text: line.slice(1), raw: line, oldLine: null, newLine: null })
      if (kind === 'add') file.additions += 1
      if (kind === 'del') file.deletions += 1
      continue
    }

    if (!file) result.preamble.push(line)
    else file.headers.push(line)
  }

  flushFile()
  return result
}
