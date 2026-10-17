import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function codemodeEnabled() {
  const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
  try {
    return JSON.parse(readFileSync(join(dir, 'desktop.json'), 'utf8')).codemodeEnabled !== false
  } catch (error) {
    return error?.code === 'ENOENT'
  }
}

export function applyCodemodePreference(pi, names) {
  const all = pi.getAllTools?.() ?? []
  const available = name => all.some(tool => (typeof tool === 'string' ? tool : tool.name) === name)
  const without = names.filter(name => name !== 'codemode')
  const target = codemodeEnabled() && available('codemode') ? (names.includes('codemode') ? names : [...without, 'codemode']) : without
  const hasDeferred = all.some(tool => typeof tool === 'object' && tool?.exposure === 'deferred')
  return hasDeferred && available('tool_search') && !target.includes('tool_search') ? [...target, 'tool_search'] : target
}

export default function codemodePolicy(pi) {
  pi.on('before_agent_start', () => {
    const active = (pi.getActiveTools?.() ?? []).map(tool => typeof tool === 'string' ? tool : tool.name)
    const target = applyCodemodePreference(pi, active)
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
