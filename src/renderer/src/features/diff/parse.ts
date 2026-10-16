/**
 * 统一 diff（`git diff` / `git format-patch` / `patch -u`）的解析器。纯函数，无 IO。
 *
 * ── 解析到什么程度 ──
 * 只认**统一格式**（`@@ -a,b +c,d @@`）。行号来自 hunk 头 + 行在 hunk 里的位置，
 * 即「补丁里真实写着的」；缺 hunk 头时行号一律 `null`，界面不编造。
 * 增删统计只数实际的 `+` / `-` 行，不拿 `@@` 里的计数冒充。
 *
 * ── 路径的坑 ──
 * · git 默认 `core.quotepath=true`：含非 ASCII 的路径会被引号包成八进制转义
 *   （`"\344\270\255"`），这里做一次解引用，否则中文文件名显示成乱码。
 * · 含空格的路径在 `diff --git` 行里同样被引号包住；未加引号的路径按空格切分
 *   本来就是歧义的，退化为取最后一个 `b/` 段。
 */
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

/**
 * 还原 git 引号路径。只在整段被引号包住时处理，避免把普通路径里的
 * 反斜杠（Windows 风格）误当转义。八进制转义按字节还原后用 UTF-8 解码，
 * 这样中文路径能被正确读回。
 */
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
    /* 未知转义：原样保留反斜杠，不猜 */
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
  /* 普通 diff 会带时间戳（以 tab 分隔），git diff 不带 */
  const tab = rest.indexOf('\t')
  const raw = (tab >= 0 ? rest.slice(0, tab) : rest).trim()
  if (!raw || raw === '/dev/null') return null
  return stripPrefix(unquotePath(raw))
}

/** 从 `diff --git a/x b/y` 行取新侧路径（a/b 前缀已剥掉）。 */
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

/**
 * 解析统一 diff 文本。
 *
 * 一次调用可以处理多文件补丁；无法归属到文件的头部行放进 `preamble`。
 */
export function parsePatch(patch: string): DiffParseResult {
  const result: DiffParseResult = { files: [], preamble: [] }
  /* 处理 CRLF：先归一，避免行尾 `\r` 混进正文 */
  const text = patch.replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  /* 末尾若只有一个空串（以换行结尾），去掉它 */
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

    /*
     * hunk 正文优先于文件头解析：`--- foo` 既可能是文件标记，也可能是
     * 「删除了一行内容为 `-- foo`」。只有不在 hunk 里时前者才成立。
     */
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
      /* 不是 hunk 行：当前 hunk 结束，继续按文件结构解析 */
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
        /* 认不出的 hunk 头（例如 combined diff `@@@`）：保留原文，行号不可信 */
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

    /*
     * 不在 hunk 里、又没有 `@@` 头的 +/- 行：可能是没有 hunk 头的手写补丁。
     * 起一个行号不可信的隐式 hunk，让内容仍能看到，但绝不编造行号。
     */
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
