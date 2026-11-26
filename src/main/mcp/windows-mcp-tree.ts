import type { TreeProcess } from '../process-tree'

const HELPER_NAMES = new Set(['uv.exe', 'uvx.exe', 'windows-mcp.exe', 'conhost.exe', 'openconsole.exe'])

const PYTHON_NAMES = new Set(['python.exe', 'pythonw.exe', 'python3.exe'])

const UV_PATH_MARKERS = ['\\uv\\cache', '\\uv\\tools', '\\uv\\python', '/uv/cache', '/uv/tools', '/uv/python']

const TREE_PREFIX = /^[\s│├└─]*/
const EMPTY_WINDOW = /^(?:├|└)── window "\s*"$/

function unwrapJsonLines(text: string): string {
  return text.split('\n').map((line) => {
    if (!line.startsWith('["') || !line.endsWith('"]')) return line
    try {
      const parts = JSON.parse(line) as unknown
      return Array.isArray(parts) && parts.every((part) => typeof part === 'string') ? parts.join('\n') : line
    } catch {
      return line
    }
  }).join('\n')
}

export function pruneWindowsSnapshot(text: string): string {
  const lines = unwrapJsonLines(text).split('\n')
  const depth = (line: string): number => (TREE_PREFIX.exec(line)?.[0].length ?? 0)
  const kept: string[] = []
  let dropped = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const next = lines[index + 1]
    if (EMPTY_WINDOW.test(line.replace(/^[\s│]*/, '').trimEnd()) && !(next !== undefined && next.trim() && depth(next) > depth(line))) {
      dropped += 1
      continue
    }
    kept.push(line)
  }
  if (!dropped) return kept.join('\n')
  const tree = kept.findIndex((line) => line.trim() === 'UI Tree:')
  if (tree >= 0) kept.splice(tree + 1, 0, `    (${dropped} unnamed empty windows omitted)`)
  return kept.join('\n')
}

export function windowsMcpKeepsProcess(row: TreeProcess): boolean {
  const name = (row.name ?? '').toLowerCase()
  if (HELPER_NAMES.has(name)) return true
  const command = (row.commandLine ?? '').toLowerCase()
  if (!command) return false
  if (PYTHON_NAMES.has(name)) {
    return command.includes('windows_mcp') || command.includes('windows-mcp') || UV_PATH_MARKERS.some((marker) => command.includes(marker))
  }
  if (name === 'powershell.exe' || name === 'pwsh.exe') {
    return command.includes('-encodedcommand') || command.includes('-noprofile')
  }
  return false
}
