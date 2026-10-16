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
  '- Lead with the result and what changed; keep explanation to the minimum needed to trust it.',
  '- Still report errors, blockers and anything the user must decide.',
  '- Do not change the scope of the task; brevity is about wording, not about doing less.'
].join('\n')

const DETAILED = [
  'Response detail: DETAILED. The user chose this; it overrides the earlier "be concise" guideline.',
  '- Lead with the result. Besides the result, explain the trade-offs behind key choices, the steps that mattered,',
  '  a concrete example where it helps, and the boundaries where the approach applies or does not.',
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
    if (sections && typeof sections === 'object') sections.inkstone_response_detail = extra
    return { systemPrompt: base ? `${base}\n\n${extra}` : extra }
  })
}
