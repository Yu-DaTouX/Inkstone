import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { TreeProcess } from '../process-tree'

export interface NativeSpawnSpec {
  name: string
  command: string
  args: string[]
}

const GENERIC_COMMANDS = new Set([
  'node', 'nodejs', 'npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'deno', 'uv', 'uvx', 'python', 'python3', 'py', 'pip', 'pipx',
  'java', 'dotnet', 'cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'docker', 'cargo', 'go', 'ruby', 'php', 'electron'
])
const SPEC_CACHE_MS = 2000

function readServers(path: string): Record<string, unknown> {
  try {
    const root = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: unknown }
    const servers = root?.mcpServers
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) return servers as Record<string, unknown>
    if (root && typeof root === 'object' && 'mcpServers' in root) console.warn('[pi-process-tree] mcpServers in', path, 'is not an object; no pi native MCP process will be matched from it')
    return {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[pi-process-tree] could not read', path, error instanceof Error ? error.message : String(error))
    return {}
  }
}

export function readNativeSpawnSpecs(agentDir: string, projectCwd?: string): NativeSpawnSpec[] {
  const specs: NativeSpawnSpec[] = []
  const sources = [join(agentDir, 'mcp.json'), ...(projectCwd ? [join(projectCwd, '.pi', 'mcp.json')] : [])]
  for (const source of sources) {
    for (const [name, raw] of Object.entries(readServers(source))) {
      if (!raw || typeof raw !== 'object') continue
      const entry = raw as { command?: unknown; args?: unknown; url?: unknown }
      if (typeof entry.command !== 'string' || !entry.command.trim() || typeof entry.url === 'string') continue
      const args = Array.isArray(entry.args) ? entry.args.filter((value): value is string | number => typeof value === 'string' || typeof value === 'number').map(String) : []
      specs.push({ name, command: entry.command.trim(), args })
    }
  }
  return specs
}

export function tokenizeCommandLine(line: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  let has = false
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted
      has = true
    } else if (!quoted && /\s/.test(char)) {
      if (has) tokens.push(current)
      current = ''
      has = false
    } else {
      current += char
      has = true
    }
  }
  if (has) tokens.push(current)
  return tokens
}

function executableName(token: string): string {
  return basename(token.replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '')
}

function normalizeText(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase()
}

function effectiveTokens(commandLine: string): string[] {
  const tokens = tokenizeCommandLine(commandLine)
  if (tokens.length === 0) return tokens
  if (executableName(tokens[0]) !== 'cmd') return tokens
  const wrapped = /\s\/[ck]\s+([\s\S]*)$/i.exec(commandLine)
  if (!wrapped) return tokens
  let rest = wrapped[1].trim()
  if (rest.length > 1 && rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1)
  return tokenizeCommandLine(rest)
}

function distinctive(spec: NativeSpawnSpec): boolean {
  if (!GENERIC_COMMANDS.has(executableName(spec.command))) return true
  return spec.args.some((arg) => !arg.startsWith('-') && arg.length >= 3)
}

export function matchNativeServer(row: Pick<TreeProcess, 'commandLine'>, specs: readonly NativeSpawnSpec[]): NativeSpawnSpec | null {
  if (!row.commandLine) return null
  const tokens = effectiveTokens(row.commandLine)
  if (tokens.length === 0) return null
  const executable = executableName(tokens[0])
  const rest = normalizeText(tokens.slice(1).join(' '))
  for (const spec of specs) {
    if (!distinctive(spec) || executableName(spec.command) !== executable) continue
    if (spec.args.every((arg) => rest.includes(normalizeText(arg)))) return spec
  }
  return null
}

export function nativeMcpSelector(input: {
  agentDir: string
  cwd: string
  now?: () => number
  read?: (agentDir: string, cwd: string) => NativeSpawnSpec[]
}): (row: TreeProcess) => boolean {
  const now = input.now ?? Date.now
  const read = input.read ?? readNativeSpawnSpecs
  const known = new Map<string, NativeSpawnSpec>()
  let loadedAt = Number.NEGATIVE_INFINITY
  return (row) => {
    const at = now()
    if (at - loadedAt > SPEC_CACHE_MS) {
      for (const spec of read(input.agentDir, input.cwd)) known.set(JSON.stringify([spec.command, spec.args]), spec)
      loadedAt = at
    }
    return matchNativeServer(row, [...known.values()]) !== null
  }
}
