import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const SEARCH_TOOL_BINARIES = { grep: 'rg', find: 'fd', ls: null }
const CODEMODE_SEARCH_TOOLS = ['find', 'ls']
const MODES = ['auto', 'on', 'off']

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

export function codemodeMode() {
  const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
  try {
    const settings = JSON.parse(readFileSync(join(dir, 'desktop.json'), 'utf8'))
    return MODES.includes(settings.codemode) ? settings.codemode : 'auto'
  } catch (error) {
    return error?.code === 'ENOENT' ? 'auto' : 'off'
  }
}

export function codemodeWanted(model, mode = codemodeMode()) {
  return mode === 'on' || (mode === 'auto' && model?.compat?.supportsOpenAIGrammarTools === true)
}

function applyCodemodePreference(pi, names, searchTools, model) {
  const all = pi.getAllTools?.() ?? []
  const available = name => all.some(tool => (typeof tool === 'string' ? tool : tool.name) === name)
  if (!searchTools.decided) {
    searchTools.add = searchToolsToAdd(names, available)
    searchTools.decided = true
  }
  const codemode = codemodeWanted(model) && available('codemode')
  const skipped = codemode ? [] : searchTools.add.filter(name => CODEMODE_SEARCH_TOOLS.includes(name))
  const kept = names.filter(name => !skipped.includes(name))
  const extra = kept.includes('read') ? searchTools.add.filter(name => !skipped.includes(name) && !kept.includes(name)) : []
  const without = [...kept, ...extra].filter(name => name !== 'codemode')
  const target = codemode ? (kept.includes('codemode') ? [...kept, ...extra] : [...without, 'codemode']) : without
  const hasDeferred = all.some(tool => typeof tool === 'object' && tool?.exposure === 'deferred')
  return hasDeferred && available('tool_search') && !target.includes('tool_search') ? [...target, 'tool_search'] : target
}

export default function codemodePolicy(pi) {
  const searchTools = { decided: false, add: [] }
  pi.on('before_agent_start', (_event, ctx) => {
    const active = (pi.getActiveTools?.() ?? []).map(tool => typeof tool === 'string' ? tool : tool.name)
    const target = applyCodemodePreference(pi, active, searchTools, ctx?.model)
    if (active.length !== target.length || active.some((name, index) => name !== target[index])) {
      pi.setActiveTools(target)
    }
  })
  pi.on('tool_call', event => {
    if (event.toolName === 'codemode' && codemodeMode() === 'off') {
      return { block: true, reason: 'Codemode is turned off in Inkstone settings.' }
    }
  })
}
