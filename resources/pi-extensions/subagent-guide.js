import { environmentGuide } from './capability-guide.js'

const GROUPS = [
  {
    commands: ['search.query', 'search.fetch', 'search.docs'],
    line: '- search: web search, page text and library docs (`yan search query --query-text "..."`, `yan search fetch --url <url>`, `yan search docs --library <name> --query-text "..."`)'
  },
  {
    commands: ['artifact.preview'],
    line: '- artifact preview: screenshots of an HTML file in light/dark and desktop/narrow sizes (`yan artifact preview --path <file.html>`; a relative path resolves against the working folder, not a shell `cd`)'
  }
]

export function allowedCommands(env = process.env) {
  return String(env.YAN_SUBAGENT_COMMANDS ?? '').split(',').map((item) => item.trim()).filter(Boolean)
}

export function subagentCapabilityGuide(commands) {
  const allowed = new Set(commands)
  const lines = GROUPS.filter((group) => group.commands.some((command) => allowed.has(command))).map((group) => group.line)
  if (lines.length === 0) return ''
  return [
    'The `yan` CLI is on PATH. In this subagent only these groups work; the others listed in `yan --help` (browser, subagent, office and so on) are not available here:',
    ...lines,
    'Run `yan <group> --help` before first use. stdout holds a short summary and a `resultFile` path; read only the parts you need.'
  ].join('\n')
}

export default function subagentGuideExtension(pi) {
  const guide = subagentCapabilityGuide(allowedCommands())
  pi.on('before_agent_start', (event) => {
    const environment = environmentGuide()
    const sections = event?.systemPromptOptions?.sections
    if (sections && typeof sections === 'object') {
      if (guide) sections.inkstone_capabilities = guide
      sections.inkstone_environment = environment
      return
    }
    const base = String(event?.systemPrompt ?? '')
    const extra = [guide, environment].filter(Boolean).join('\n\n')
    return { systemPrompt: base ? `${base}\n\n${extra}` : extra }
  })
}
