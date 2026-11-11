import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { registerWriteLineEndings } from './write-line-endings.js'
import { callHostTool, hostToolsAvailable, toolText } from './host-tool-call.js'
import { createWebTools } from './web-tools.js'
import { hasPwsh } from './windows-powershell.js'
import { reserveInkstoneSections } from './prompt-sections.js'
import { codemodeWanted } from './codemode-policy.js'

const PLAN_WITH_CLI = '- Work with 3+ distinct steps, subagents or a plan the user asked for: list the steps with `yan tasks apply` before the first change and tick them off as they finish; chain each update into a command you are running anyway, never a step of its own.'
const PLAN_WITH_TOOL = '- Work with 3+ distinct steps, subagents or a plan the user asked for: list the steps with the `todos` tool before the first change and tick them off as they finish; send each update alongside other tool calls in the same response, never in a response of its own.'
const CODEMODE_WRITES = '- When direct tools are available, use `write`/`edit` directly for large file content: inside a codemode script string it needs escaping and is easy to get wrong.'
const SEARCH_GROUP = '- search: web search, page text, library docs'
const SEARCH_DOCS_GROUP = '- search: library docs (`yan search docs --library <name> --query-text "..."`)'
const CLI_ONLY_GROUPS = [
  '- question: ask the user one focused question',
  '- tasks: the user\'s to-do panel (see above); skip it for one- or two-step work'
]
const CLI_ONLY_WEB_TOOLS = ['web_docs']

const GUIDE_LINES = [
  'Capabilities beyond your tools come through the `yan` CLI (on PATH): run `yan <group> --help` before first use. Results give a summary and a `resultFile` path; read only what you need. Use `yan` (not custom scripts) for Inkstone pages, artifacts and state, and let Inkstone attach artifacts rather than pasting paths.',
  PLAN_WITH_CLI,
  CODEMODE_WRITES,
  '',
  'Command groups:',
  '- browser: open or operate pages in the built-in browser; `browser run --file` runs multi-step scripts',
  '- terminal: the session terminal the user sees; read it, run commands the user should watch, long-running servers or interactive programs',
  '- phone: read and operate the user\'s Android phone over adb',
  SEARCH_GROUP,
  '- subagent: delegate work to other agents; read skill subagent first',
  '- image: generate images; artifact: attach an existing file to this reply',
  '- file: recoverable delete; session: move this session to another folder; operations: look up an operation\'s result',
  '- capabilities: find installed commands, skills and MCP tools when unsure a capability exists',
  ...CLI_ONLY_GROUPS,
  '- Everything else: `yan --help`',
  '',
  'Prefer, in order: existing local tools or scripts → a fitting skill → the publisher\'s CLI or API → MCP only when needed.'
]

export function capabilityGuide(tools = false, { codemode = true } = {}) {
  return GUIDE_LINES
    .filter((line) => (codemode || line !== CODEMODE_WRITES) && (!tools || !CLI_ONLY_GROUPS.includes(line)))
    .map((line) => (!tools ? line : line === PLAN_WITH_CLI ? PLAN_WITH_TOOL : line === SEARCH_GROUP ? SEARCH_DOCS_GROUP : line))
    .join('\n')
}

export const CAPABILITY_GUIDE = capabilityGuide(false)

export const VISUAL_ANSWER_GUIDE = [
  'When a picture explains better than words (a trend, options compared side by side, a mechanism or process), show it as an Inkstone block: a fenced code block whose language is yan-chart, yan-stats, yan-cards, yan-record, yan-flow, yan-steps, yan-widget or mermaid (```yan-chart, not an XML-style tag), even unasked, placed where it belongs in the reply, and do not restate what it shows. Read skill visual-answer for their fields first. Change lists and test results stay as text.',
  'Charts must cite their data source and use only numbers from sources or the user; at most one or two blocks per answer.'
].join('\n')
const VISUAL_SECTION = 'inkstone_visual_answer'

function desktopSetting(key) {
  try {
    const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
    return JSON.parse(readFileSync(join(dir, 'desktop.json'), 'utf8'))?.[key]
  } catch {
    return undefined
  }
}

const visualAnswersEnabled = () => desktopSetting('visualAnswers') !== false

export function sessionSkillsBlock(sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(sessionId) || sessionId === '.' || sessionId === '..') return ''
  const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
  const base = join(dir, 'capabilities', 'session-skills', sessionId)
  let skills
  try {
    const index = JSON.parse(readFileSync(join(base, 'index.json'), 'utf8'))
    skills = index?.version === 1 && index.sessionId === sessionId && Array.isArray(index.skills) ? index.skills : []
  } catch {
    return ''
  }
  const lines = skills
    .filter((skill) => typeof skill?.name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name))
    .map((skill) => {
      const path = join(base, skill.name, 'SKILL.md')
      const description = String(skill.description ?? '').replace(/\s+/g, ' ').slice(0, 300)
      return existsSync(path) ? `- ${skill.name}: ${description} → ${path}` : ''
    })
    .filter(Boolean)
  if (lines.length === 0) return ''
  return ['Skills added for this session only (use them like other skills: read the SKILL.md first, resolve relative paths against its directory):', ...lines].join('\n')
}
const SESSION_SKILLS_SECTION = 'inkstone_session_skills'

const COMPUTER_USE_BASE = 'Computer use (Windows UI) is enabled. Inkstone connects the windows-mcp server itself, so its tools are not in your tool list: run `yan mcp list` to see them, `yan mcp describe --server windows-mcp --tool <name>` for arguments, then `yan mcp call --request-file call.json`.'
const COMPUTER_USE_VISION = 'Observe with Snapshot or Screenshot before clicking or typing; never repeat an input whose result is uncertain, check the screen first. Images in a call result (Screenshot, or Snapshot with use_vision=true) are saved as files and the result text gives the path: open it with the read tool to look at it, and do not write your own python screenshot code. If you cannot view the image, use Snapshot with use_vision=false and read the UI tree instead.'
const COMPUTER_USE_TEXT_ONLY = 'The current model cannot read images, so never call Screenshot and never use use_vision=true. Observe with Snapshot and use_vision=false before clicking or typing, and read the UI tree it returns; never repeat an input whose result is uncertain, check the screen first. If the task can only be done by looking at the picture, tell the user to switch to a model that supports image input.'

export function computerUseGuide(model) {
  const textOnly = Array.isArray(model?.input) && !model.input.includes('image')
  return `${COMPUTER_USE_BASE} ${textOnly ? COMPUTER_USE_TEXT_ONLY : COMPUTER_USE_VISION}`
}

export const COMPUTER_USE_GUIDE = computerUseGuide()
const COMPUTER_USE_SECTION = 'inkstone_computer_use'

function computerUseEnabled() {
  try {
    const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
    const file = process.env.YAN_MCP_SERVERS_FILE?.trim() || join(dir, 'mcp-servers.json')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.servers) ? raw.servers : []
    return list.some((server) => server?.id === 'windows-mcp' && server.enabled !== false && !server.migratedToNative)
  } catch {
    return false
  }
}

const OS_NAMES = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

export function environmentGuide(now = new Date(), platform = process.platform, shell = process.env.YAN_SHELL, pwsh = platform === 'win32' && hasPwsh(), options = {}) {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const os = OS_NAMES[platform] ?? platform
  if (options.readOnly) return `Today: ${day} (local date).`
  const shellLine = platform !== 'win32'
    ? `OS: ${os}.`
    : shell === 'powershell'
      ? 'OS: Windows; system commands run in PowerShell.'
      : 'OS: Windows; the bash tool runs Git Bash, so write bash syntax, not PowerShell cmdlets. Windows programs such as node and python do not understand Git Bash paths like /tmp/... or /c/...: pass them C:/... paths (convert with `cygpath -m`). Edit files with the edit/write tools; Python text-mode writes on Windows turn \\n into \\r\\n.' +
        (pwsh ? ' For PowerShell run `pwsh` (PowerShell 7); `powershell` 5.1 is blocked.' : '')
  return [
    `Today: ${day} (local date).`,
    shellLine,
    'Every command starts in the <cwd> folder and `cd` does not carry over between calls: use paths relative to it and do not prefix commands with a cd into it.'
  ].join('\n')
}
const ENVIRONMENT_SECTION = 'inkstone_environment'

const TODOS_TOOL = {
  name: 'todos',
  label: 'To-dos',
  description: 'Update the user\'s to-do panel. action "set" (the default when items are given) replaces the list; "add" appends; "complete"/"uncomplete"/"remove" take a 1-based index; "clear" empties it. Item status: pending, running (the step in progress), done or blocked; done: true is the same as status "done". Each text is a short title.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['set', 'add', 'complete', 'uncomplete', 'remove', 'clear'] },
      items: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', maxLength: 80 },
            done: { type: 'boolean' },
            status: { type: 'string', enum: ['pending', 'running', 'done', 'blocked'] }
          },
          required: ['text']
        }
      },
      index: { type: 'integer', minimum: 1 }
    },
  }
}

function todoDone(todo) {
  return todo?.done === true || todo?.status === 'done'
}

function todoLine(todo, index) {
  const done = todoDone(todo)
  const status = done ? '' : todo?.status === 'running' ? ' (in progress)' : todo?.status === 'blocked' ? ' (blocked)' : ''
  const mark = done ? '[x]' : todo?.status === 'running' ? '[>]' : todo?.status === 'blocked' ? '[!]' : '[ ]'
  return `${mark} ${index + 1}. ${todo?.text ?? ''}${status}`
}

export function todosResult(outcome) {
  if (!outcome.ok) {
    const current = Array.isArray(outcome.data?.todos) ? outcome.data.todos : null
    const lines = [outcome.cancelled ? 'To-do update cancelled.' : `To-do update failed: ${outcome.error}`]
    if (current) lines.push(...current.map(todoLine))
    return toolText(lines.join('\n'), { code: outcome.code, ...(current ? { todos: current } : {}) }, !outcome.cancelled)
  }
  const data = outcome.data ?? {}
  const todos = Array.isArray(data.todos) ? data.todos : []
  const done = todos.filter(todoDone).length
  const lines = [`To-dos (${done}/${todos.length} done):`, ...todos.map(todoLine)]
  return toolText(lines.join('\n'), { action: data.action, revision: data.revision, replayed: data.replayed === true, todos })
}

export function createTodosTool(call = callHostTool) {
  return {
    ...TODOS_TOOL,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const input = params ?? {}
      const action = input.action ?? (input.items !== undefined ? 'set' : undefined)
      const request = { action, ...(input.items !== undefined ? { items: input.items } : {}), ...(input.index !== undefined ? { index: input.index } : {}), operationId: toolCallId }
      return todosResult(await call({ command: 'tasks.apply', params: request, toolCallId, cwd: ctx?.cwd, signal }))
    }
  }
}

const MARKER = 'Capabilities beyond your tools come through the `yan` CLI'

export default function capabilityGuideExtension(pi) {
  const tools = hostToolsAvailable() && typeof pi.registerTool === 'function'
  if (tools) {
    pi.registerTool(createTodosTool())
    for (const tool of createWebTools()) if (!CLI_ONLY_WEB_TOOLS.includes(tool.name)) pi.registerTool(tool)
  }
  registerWriteLineEndings(pi)
  pi.on('before_agent_start', (event, ctx) => {
    const base = String(event?.systemPrompt ?? '')
    const guideText = capabilityGuide(tools, { codemode: codemodeWanted(ctx?.model) })
    const visual = visualAnswersEnabled()
    let sessionSkills = ''
    try {
      sessionSkills = sessionSkillsBlock(ctx?.sessionManager?.getSessionId?.())
    } catch {
    }
    const computerUse = computerUseEnabled()
    const sections = event?.systemPromptOptions?.sections
    if (sections && typeof sections === 'object') {
      reserveInkstoneSections(sections)
      sections.inkstone_capabilities = guideText
      sections[COMPUTER_USE_SECTION] = computerUse ? computerUseGuide(ctx?.model) : ''
      sections[VISUAL_SECTION] = visual ? VISUAL_ANSWER_GUIDE : ''
      sections[SESSION_SKILLS_SECTION] = sessionSkills
      sections[ENVIRONMENT_SECTION] = environmentGuide()
      return
    }
    if (base.includes(MARKER)) return
    const guide = [guideText, computerUse ? computerUseGuide(ctx?.model) : '', visual ? VISUAL_ANSWER_GUIDE : '', sessionSkills, environmentGuide()].filter(Boolean).join('\n\n')
    return { systemPrompt: base ? `${base}\n\n${guide}` : guide }
  })
}
