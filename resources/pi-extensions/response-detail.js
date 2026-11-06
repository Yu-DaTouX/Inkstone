import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function settingsFile() {
  const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
  return join(dir, 'desktop.json')
}

function responseDetail() {
  try {
    const j = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    const v = j?.responseDetail
    return v === 'brief' || v === 'detailed' ? v : 'standard'
  } catch {
    return 'standard'
  }
}

const BRIEF = [
  'Response detail: BRIEF.',
  '- Keep the main line and anything in bold; drop most supporting detail, keeping only what the reader needs to trust the result.',
  '- Still report errors, blockers and anything the user must decide.',
  '- Do not change the scope of the task; brevity is about wording, not about doing less.'
].join('\n')

const DETAILED = [
  'Response detail: DETAILED. The user chose this; it overrides the general "be concise" rule.',
  '- Keep the final-reply layers. After the main line, give fuller supporting detail (still in *single asterisks*): the trade-offs behind key choices,',
  '  the steps that mattered, a concrete example where it helps, and where the approach applies or does not.',
  '- Still report errors, blockers and anything the user must decide.',
  '- Do not change the scope of the task; detail is about explanation, not about doing more.'
].join('\n')

export default function responseDetailExtension(pi) {
  pi.on('before_agent_start', (event) => {
    const mode = responseDetail()
    if (mode === 'standard') return
    const base = String(event?.systemPrompt ?? '')
    const extra = mode === 'brief' ? BRIEF : DETAILED
    const sections = event?.systemPromptOptions?.sections
    if (sections && typeof sections === 'object') {
      sections.inkstone_response_detail = extra
      return
    }
    return { systemPrompt: base ? `${base}\n\n${extra}` : extra }
  })
}
