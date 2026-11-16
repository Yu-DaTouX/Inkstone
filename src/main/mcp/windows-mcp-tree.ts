import type { TreeProcess } from '../process-tree'

const HELPER_NAMES = new Set(['uv.exe', 'uvx.exe', 'windows-mcp.exe', 'conhost.exe', 'openconsole.exe'])

const PYTHON_NAMES = new Set(['python.exe', 'pythonw.exe', 'python3.exe'])

const UV_PATH_MARKERS = ['\\uv\\cache', '\\uv\\tools', '\\uv\\python', '/uv/cache', '/uv/tools', '/uv/python']

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
