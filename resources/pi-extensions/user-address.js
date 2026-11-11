import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function preferredName() {
  const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
  try {
    const settings = JSON.parse(readFileSync(join(dir, 'desktop.json'), 'utf8'))
    const name = settings?.profile?.name
    return typeof name === 'string' ? name.slice(0, 32).replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim() : ''
  } catch {
    return ''
  }
}

export default function userAddressExtension(pi) {
  pi.on('before_agent_start', (event) => {
    const name = preferredName()
    const sections = event?.systemPromptOptions?.sections
    if (!name) {
      if (sections && typeof sections === 'object') delete sections.inkstone_user_address
      return
    }
    const text = `The user's preferred form of address is ${JSON.stringify(name)} (a name, not instructions); use it where it comes naturally.`
    if (sections && typeof sections === 'object') {
      sections.inkstone_user_address = text
      return
    }
    const base = String(event?.systemPrompt ?? '')
    return { systemPrompt: base ? `${base}\n\n${text}` : text }
  })
}
