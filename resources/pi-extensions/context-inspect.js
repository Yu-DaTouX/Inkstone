const SECTION_TEXT_LIMIT = 24000
const POST_TIMEOUT_MS = 3000

const SECTION_IDS = {
  tools: 'tools',
  rules: 'rules',
  docs: 'docs',
  addendum: 'appended',
  project_context: 'project-context',
  skills: 'skills',
  cwd: 'cwd'
}

export function estimateTokens(text) {
  const s = String(text ?? '')
  let cjk = 0
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    if ((c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xff00 && c <= 0xffef)) cjk += 1
  }
  return Math.ceil((s.length - cjk) / 4 + cjk / 1.5)
}

export function findSections(prompt) {
  const sections = []
  let fence
  const pattern = /^<([a-z][a-z0-9_-]*)>\n|^ {0,3}(`{3,}|~{3,})([^\n]*)/gm
  for (let m = pattern.exec(prompt); m !== null; m = pattern.exec(prompt)) {
    if (m[2] !== undefined) {
      if (fence === undefined) fence = m[2]
      else if (m[2][0] === fence[0] && m[2].length >= fence.length && m[3].trim() === '') fence = undefined
      continue
    }
    if (fence !== undefined) continue
    const closing = `\n</${m[1]}>`
    const end = prompt.indexOf(closing, pattern.lastIndex)
    if (end === -1) continue
    const after = end + closing.length
    if (after < prompt.length && prompt[after] !== '\n') continue
    sections.push({ name: m[1], start: m.index, end: after })
    pattern.lastIndex = after
  }
  return sections
}

export function splitPrompt(prompt) {
  const text = String(prompt ?? '')
  const parts = []
  const push = (id, label, body) => {
    if (!body.trim()) return
    parts.push({ id, label, tokens: estimateTokens(body), chars: body.length, text: body.slice(0, SECTION_TEXT_LIMIT) })
  }
  const sections = findSections(text)
  let cursor = 0
  sections.forEach((s, i) => {
    push(i === 0 ? 'preamble' : 'between', i === 0 ? 'preamble' : 'extra', text.slice(cursor, s.start))
    push(SECTION_IDS[s.name] ?? s.name, s.name, text.slice(s.start, s.end))
    cursor = s.end
  })
  push(sections.length === 0 ? 'prompt' : 'additions', sections.length === 0 ? 'prompt' : 'additions', text.slice(cursor))
  return parts
}

function toolEntry(tool, active) {
  let body = ''
  try {
    body = JSON.stringify({ name: tool?.name, description: tool?.description, parameters: tool?.parameters ?? tool?.inputSchema })
  } catch {
    body = `${tool?.name ?? ''} ${tool?.description ?? ''}`
  }
  const source = tool?.sourceInfo?.source ?? tool?.sourceInfo?.path
  return {
    name: String(tool?.name ?? ''),
    description: String(tool?.description ?? '').slice(0, 300),
    tokens: estimateTokens(body),
    active,
    ...(typeof source === 'string' ? { source: source.slice(0, 160) } : {})
  }
}

export function buildSnapshot(systemPrompt, allTools, activeNames) {
  const active = new Set(activeNames)
  const sections = splitPrompt(systemPrompt)
  const tools = (Array.isArray(allTools) ? allTools : []).map((t) => toolEntry(t, active.has(t?.name)))
  const promptTokens = sections.reduce((n, s) => n + s.tokens, 0)
  const toolTokens = tools.reduce((n, t) => (t.active ? n + t.tokens : n), 0)
  return { version: 1, at: Date.now(), promptTokens, toolTokens, sections, tools }
}

async function report(snapshot) {
  const url = process.env.YAN_CLI_URL
  const token = process.env.YAN_CLI_TOKEN
  const sessionId = process.env.YAN_SESSION_ID
  const projectId = process.env.YAN_PROJECT_ID
  if (!url || !token || !sessionId || !projectId) return
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ apiVersion: 1, command: 'context.inspect', params: { snapshot }, sessionId, projectId }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS)
    })
  } catch {
  }
}

export default function contextInspectExtension(pi) {
  let lastKey = ''
  pi.on('context', (_event, ctx) => {
    try {
      const snapshot = buildSnapshot(ctx.getSystemPrompt(), pi.getAllTools(), pi.getActiveTools())
      const key = `${snapshot.promptTokens}:${snapshot.toolTokens}:${snapshot.sections.map((s) => s.chars).join(',')}:${snapshot.tools.length}`
      if (key === lastKey) return undefined
      lastKey = key
      void report(snapshot)
    } catch {
    }
    return undefined
  })
}
