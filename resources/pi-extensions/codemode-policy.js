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
  const without = names.filter(name => name !== 'codemode')
  if (!codemodeEnabled()) return without
  const available = (pi.getAllTools?.() ?? []).some(tool => (typeof tool === 'string' ? tool : tool.name) === 'codemode')
  return available ? (names.includes('codemode') ? names : [...without, 'codemode']) : without
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
