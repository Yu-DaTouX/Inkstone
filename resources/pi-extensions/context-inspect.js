/*
 * 砚内置「上下文构成」扩展 —— 只读地把「实际发给模型的固定部分」报给宿主。
 *
 * 界面上的上下文条原先只能按消息文本估算，系统提示与工具定义合成一项，
 * 看不出谁占了多少。这里在每轮第一次请求前读 pi 已经拼好的东西：
 *   · 系统提示：按 pi 的顶层 XML 段（tools / rules / docs / skills …）拆开；
 *   · 工具定义：每个工具的 name + description + 参数 schema 各估一份；
 * 然后通过 `context.inspect` 交给宿主，界面据此显示明细与「注入内容」。
 *
 * ── 边界 ──
 *   · 不改系统提示、不改消息、不发起任何模型请求（零占用）；
 *   · 内容不变就不重复上报（按指纹去重），失败只静默丢弃；
 *   · token 数是估算（宿主界面会标明），总量仍以 Agent 上报为准；
 *   · 思路参考 pi-context-view（MIT，dimk90），此处只取「读 pi 已有数据」这一部分。
 */

/** 每段文本上报的字符上限，防止异常大的提示拖慢宿主 */
const SECTION_TEXT_LIMIT = 24000
const POST_TIMEOUT_MS = 3000

/** pi 顶层 XML 段 → 界面用的稳定 id（未知段保留原名） */
const SECTION_IDS = {
  tools: 'tools',
  rules: 'rules',
  docs: 'docs',
  addendum: 'appended',
  project_context: 'project-context',
  skills: 'skills',
  cwd: 'cwd'
}

/** 估算 token：ASCII 约 4 字符 / token，CJK 与全角约 1.5 字符 / token */
export function estimateTokens(text) {
  const s = String(text ?? '')
  let cjk = 0
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    if ((c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xff00 && c <= 0xffef)) cjk += 1
  }
  return Math.ceil((s.length - cjk) / 4 + cjk / 1.5)
}

/** 跳过围栏代码块，找出顶层 `<name>\n … \n</name>` 段（与 pi 渲染方式一致） */
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

/** 把系统提示切成 [开场白][各 XML 段][段与段之间 / 末尾的追加文本] */
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
    /* 观测失败不影响对话 */
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
      /* 同上 */
    }
    return undefined
  })
}
