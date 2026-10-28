import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const SEARCH_TOOL_BINARIES = { grep: 'rg', find: 'fd', ls: null }

export function binaryAvailable(name, env = process.env, platform = process.platform) {
  const file = platform === 'win32' ? `${name}.exe` : name
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
  const dirs = [join(agentDir, 'bin'), ...String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)]
  return dirs.some(dir => existsSync(join(dir, file)))
}

export function searchToolsToAdd(names, available, hasBinary = binaryAvailable) {
  if (!names.includes('read')) return []
  return Object.entries(SEARCH_TOOL_BINARIES)
    .filter(([tool, binary]) => !names.includes(tool) && available(tool) && (!binary || hasBinary(binary)))
    .map(([tool]) => tool)
}

export function codemodeEnabled() {
  const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
  try {
    return JSON.parse(readFileSync(join(dir, 'desktop.json'), 'utf8')).codemodeEnabled !== false
  } catch (error) {
    return error?.code === 'ENOENT'
  }
}

function applyCodemodePreference(pi, names, searchTools) {
  const all = pi.getAllTools?.() ?? []
  const available = name => all.some(tool => (typeof tool === 'string' ? tool : tool.name) === name)
  if (!searchTools.decided) {
    searchTools.add = searchToolsToAdd(names, available)
    searchTools.decided = true
  }
  const extra = names.includes('read') ? searchTools.add.filter(name => !names.includes(name)) : []
  const without = [...names, ...extra].filter(name => name !== 'codemode')
  const target = codemodeEnabled() && available('codemode') ? (names.includes('codemode') ? names : [...without, 'codemode']) : without
  const hasDeferred = all.some(tool => typeof tool === 'object' && tool?.exposure === 'deferred')
  return hasDeferred && available('tool_search') && !target.includes('tool_search') ? [...target, 'tool_search'] : target
}

export default function codemodePolicy(pi) {
  const searchTools = { decided: false, add: [] }
  pi.on('before_agent_start', () => {
    const active = (pi.getActiveTools?.() ?? []).map(tool => typeof tool === 'string' ? tool : tool.name)
    const target = applyCodemodePreference(pi, active, searchTools)
    if (active.length !== target.length || active.some((name, index) => name !== target[index])) {
      pi.setActiveTools(target)
    }
  })
  pi.on('tool_call', event => {
    if (event.toolName === 'codemode' && !codemodeEnabled()) {
      return { block: true, reason: 'Codemode 已在砚设置中关闭。' }
    }
  })
}
