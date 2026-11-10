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

export function isReadOnlySubagent(env = process.env) {
  return env.YAN_READ_ONLY_SUBAGENT === '1'
}

export function subagentCapabilityGuide(commands, { readOnly = false } = {}) {
  const allowed = new Set(commands)
  const lines = GROUPS.filter((group) => group.commands.some((command) => allowed.has(command))).map((group) => group.line)
  if (readOnly) {
    return [
      'This task is read-only: there is no shell and no write or edit tool. Work with the read tools in your tool list (read, grep, find, ls, and when present git_inspect and the web tools).',
      ...(lines.length
        ? [
            'Some Inkstone capabilities come through the `yan` CLI (on PATH); in this subagent only these groups work:',
            ...lines,
            'Run `yan <group> --help` before first use. stdout holds a short summary and a `resultFile` path; read only the parts you need.'
          ]
        : []),
      'Do not plan shell commands for yourself: if a command is needed, say in your report that the main agent should run it.'
    ].join('\n')
  }
  if (lines.length === 0) return ''
  return [
    'The `yan` CLI is on PATH. In this subagent only these groups work; the others listed in `yan --help` (browser, subagent, office and so on) are not available here:',
    ...lines,
    'Run `yan <group> --help` before first use. stdout holds a short summary and a `resultFile` path; read only the parts you need.'
  ].join('\n')
}

export default function subagentGuideExtension(pi) {
  const commands = allowedCommands()
  const readOnly = isReadOnlySubagent()
  const guide = subagentCapabilityGuide(commands, { readOnly })
  pi.on('before_agent_start', (event) => {
    const environment = environmentGuide(new Date(), process.platform, process.env.YAN_SHELL, undefined, { readOnly })
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
