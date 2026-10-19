import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const CONFIRM_TIMEOUT_MS = 4 * 60 * 1000

export function isBroadTarget(raw) {
  let target = String(raw ?? '').trim().replace(/^["']+|["']+$/g, '')
  if (!target) return false
  target = target.replace(/\\/g, '/').toLowerCase()
  if (['/', '/*', '~', '~/', '~/*', '.', './', './*', '*', '*.*', '..', '../', '../*'].includes(target)) return true
  if (/^(\$home|\$\{home\}|%userprofile%|%homepath%|\$env:userprofile)\/?$/.test(target)) return true
  if (target.split('/').includes('..')) return true
  if (/^([a-z]:)?\//.test(target)) {
    const segments = target.replace(/^[a-z]:/, '').split('/').filter(Boolean)
    return segments.length <= 2
  }
  return false
}

const SEGMENT_SPLIT = /&&|\|\||[;&|\n]/

function tokens(segment) {
  return segment.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? []
}

function commandOf(segment) {
  const parts = tokens(segment)
  let start = 0
  while (start < parts.length && (/^sudo$/i.test(parts[start]) || /^\w+=/.test(parts[start]))) start += 1
  const head = (parts[start] ?? '').toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, '')
  return { head, args: parts.slice(start + 1) }
}

function recursiveDeleteTarget({ head, args }) {
  let recursive = false
  if (head === 'rm') {
    recursive = args.some((a) => /^-[a-z]*r[a-z]*$/i.test(a) || a === '--recursive' || /^-recurse$/i.test(a))
  } else if (['rmdir', 'rd', 'del', 'erase'].includes(head)) {
    recursive = args.some((a) => /^\/s$/i.test(a) || /^-recurse$/i.test(a))
  } else if (['remove-item', 'ri'].includes(head)) {
    recursive = args.some((a) => /^-recurse$/i.test(a))
  } else {
    return null
  }
  if (!recursive) return null
  const targets = args.filter((a) => !/^(-|\/[a-z]$)/i.test(a) && !/^-{1,2}\w/.test(a))
  return targets.find(isBroadTarget) ?? null
}

const POWER_COMMANDS = new Set(['shutdown', 'reboot', 'halt', 'poweroff', 'stop-computer', 'restart-computer'])

const SHELL_WRAPPER = /^\s*(?:sudo\s+)?(?:\S*[\\/])?(?:bash|sh|zsh|dash|powershell|pwsh|cmd)(?:\.exe)?\s+(?:-\S+\s+)*?(?:-c|-command|\/c)\s+([\s\S]+)$/i

const COMMAND_RULES = [
  { re: /\bgit\s+(?:-\S+\s+)*push\b[^;&|\n]*\s(?:--force(?!-with-lease)\b|-f\b|--mirror\b)/i, label: 'Git 强制推送，会覆盖远端历史' },
  { re: /\bgit\s+reset\b[^;&|\n]*--hard\b/i, label: 'git reset --hard，会丢弃未提交的改动' },
  { re: /\bgit\s+clean\b[^;&|\n]*\s(?:-[a-z]*f|--force\b)/i, label: 'git clean -f，会永久删除未跟踪的文件' },
  { re: /\bgit\s+(?:checkout|restore)\b[^;&|\n]*(?:\s--\s+\.|\s\.)(?:\s|$)/i, label: '还原整个工作区，会丢弃未提交的改动' },
  { re: /\bgit\s+stash\s+(?:clear|drop)\b/i, label: '删除 Git stash 里暂存的改动' },
  { re: /\b(?:drop\s+(?:database|schema|table)|truncate\s+table)\b/i, label: '删除数据库或数据表' },
  { re: /\b(?:mkfs(?:\.\w+)?|diskpart|fdisk|shred)\b|\bdd\s+[^;&|\n]*\bof=\/dev\/|\bformat\s+[a-z]:/i, label: '格式化或直接写磁盘' },
  { re: /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(?:sudo\s+)?(?:\S*[\\/])?(?:sh|bash|zsh|iex|invoke-expression|powershell|pwsh)\b/i, label: '把网络内容直接交给 shell 执行' },
  { re: /\bchmod\s+-R\b[^;&|\n]*\s\/(?:\s|$)|\bchown\s+-R\b[^;&|\n]*\s\/(?:\s|$)/i, label: '递归修改根目录的权限或属主' },
  { re: /\breg(?:\.exe)?\s+delete\b/i, label: '删除注册表项' },
  { re: /\bnpm\s+publish\b/i, label: '发布 npm 包（对外发布）' }
]

const SENSITIVE_PATH =
  /\/(?:\.ssh|\.aws|\.gnupg|\.kube)(?:\/|$)|^\/(?:etc|usr|bin|sbin|boot|lib)(?:\/|$)|^[a-z]:\/windows(?:\/|$)|^[a-z]:\/program files|\/\.(?:bashrc|zshrc|profile|gitconfig|npmrc)$|\/start menu\/programs\/startup/i

function normalizePath(p) {
  const text = String(p ?? '').replace(/\\/g, '/').toLowerCase()
  const match = /^([a-z]:)?(.*)$/.exec(text)
  const drive = match?.[1] ?? ''
  const rest = match?.[2] ?? ''
  return drive + (rest ? posix.normalize(rest) : '')
}

function isAbsolutePath(p) {
  return /^(?:[a-z]:)?[\\/]/i.test(p) || /^[a-z]:/i.test(p)
}

function scanCommand(command, reasons, depth = 0) {
  for (const segment of command.split(SEGMENT_SPLIT)) {
    const cmd = commandOf(segment)
    const hit = recursiveDeleteTarget(cmd)
    if (hit) reasons.push(`递归删除大范围目录：${hit}`)
    if (POWER_COMMANDS.has(cmd.head)) reasons.push('关机或重启')
    if (depth < 2) {
      const wrapped = SHELL_WRAPPER.exec(segment)
      if (wrapped) scanCommand(wrapped[1].trim().replace(/^["']|["']$/g, ''), reasons, depth + 1)
    }
  }
  for (const rule of COMMAND_RULES) if (rule.re.test(command)) reasons.push(rule.label)
}

export function detectDanger(toolName, input, cwd) {
  const reasons = []
  const name = String(toolName ?? '')
  if (name === 'bash' || name === 'powershell') {
    const command = String(input?.command ?? '')
    scanCommand(command, reasons)
    if (/\bsudo\b/i.test(command) && reasons.length === 0 && /\brm\b/i.test(command)) reasons.push('以管理员身份删除文件')
  } else if (name === 'write' || name === 'edit' || name === 'multi_edit' || name === 'apply_patch') {
    const raw = input?.path ?? input?.file_path ?? input?.filePath
    if (typeof raw === 'string' && raw.trim()) {
      const base = cwd || process.cwd()
      const abs = isAbsolutePath(raw) ? raw : `${String(base).replace(/[\\/]+$/, '')}/${raw}`
      const normalized = normalizePath(abs)
      const root = normalizePath(base).replace(/\/$/, '')
      const inside = normalized === root || normalized.startsWith(`${root}/`)
      const home = normalizePath(homedir()).replace(/\/$/, '')
      const shown = normalized.startsWith(`${home}/`) ? `~${normalized.slice(home.length)}` : normalized
      if (!inside && (SENSITIVE_PATH.test(normalized) || SENSITIVE_PATH.test(shown.replace(/^~/, '')))) {
        reasons.push(`修改项目之外的系统或凭证文件：${abs}`)
      }
    }
  }
  return [...new Set(reasons)]
}

export function mcpApprovalNeeded(annotations) {
  const hints = annotations && typeof annotations === 'object' ? annotations : {}
  if (hints.destructiveHint === true) return true
  if (hints.readOnlyHint === true) return false
  const mayDestroy = hints.destructiveHint ?? true
  const mayReachOutside = hints.openWorldHint ?? true
  return mayDestroy || mayReachOutside
}

export function mcpTarget(toolName) {
  const match = /^mcp__(.+?)__(.+)$/.exec(String(toolName ?? ''))
  return { server: match?.[1] ?? '', tool: match?.[2] ?? String(toolName ?? '') }
}

export function mcpCallDanger(toolName, annotations) {
  const name = String(toolName ?? '')
  if (!name.startsWith('mcp__')) return []
  if (!mcpApprovalNeeded(annotations)) return []
  const { server, tool } = mcpTarget(name)
  const target = [server, tool].filter(Boolean).join(' / ')
  return [`MCP 工具可能修改数据或对外操作：${target}`]
}

function toolAnnotations(pi, toolName) {
  try {
    const tools = pi?.getAllTools?.()
    if (!Array.isArray(tools)) return undefined
    const found = tools.find((item) => (typeof item === 'string' ? item : item?.name) === toolName)
    return found && typeof found === 'object' ? found.annotations : undefined
  } catch {
    return undefined
  }
}

const WRITE_COMMANDS_ALL_ARGS = new Set([
  'rm', 'rmdir', 'del', 'erase', 'rd', 'mkdir', 'md', 'touch', 'chmod', 'chown', 'mv', 'move', 'ren', 'rename',
  'remove-item', 'ri', 'new-item', 'ni', 'move-item', 'mi', 'rename-item', 'rni', 'set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content'
])
const WRITE_COMMANDS_LAST_ARG = new Set(['cp', 'copy', 'xcopy', 'robocopy', 'ln', 'install', 'copy-item', 'ci', 'cpi'])
const PS_PATH_FLAGS = new Set(['-path', '-literalpath', '-filepath', '-destination', '-name'])

function expandHome(text) {
  return String(text)
    .replace(/^(~|\$home|\$\{home\}|%userprofile%|%homepath%|\$env:userprofile)(?=[\\/]|$)/i, homedir())
}

function expandEnv(text) {
  const lookup = (name) => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? process.env[key] : undefined
  }
  return String(text)
    .replace(/^\$env:([a-z_]\w*)/i, (all, name) => lookup(name) ?? all)
    .replace(/^%([a-z_]\w*)%/i, (all, name) => lookup(name) ?? all)
    .replace(/^\$\{?(TMPDIR|TEMP|TMP)\}?(?=[\\/]|$)/, (all, name) => lookup(name) ?? all)
}

function resolveTarget(raw, cwd) {
  const cleaned = expandHome(expandEnv(String(raw ?? '').trim().replace(/^["']+|["']+$/g, '')))
  if (!cleaned) return ''
  const fixed = cleaned.replace(/[*?].*$/, '')
  const base = String(cwd || process.cwd()).replace(/[\\/]+$/, '')
  return normalizePath(isAbsolutePath(fixed) ? fixed : `${base}/${fixed}`)
}

function allowedRoots(cwd, prefs) {
  const list = [cwd, tmpdir(), '/tmp', '/var/tmp', join(homedir(), '.pi'), process.env.PI_CODING_AGENT_DIR, process.env.YAN_DATA_DIR, ...(prefs.allowRoots ?? [])]
  return list.filter((p) => typeof p === 'string' && p.trim()).map((p) => normalizePath(p).replace(/\/$/, ''))
}

function isInside(target, roots) {
  return roots.some((root) => root && (target === root || target.startsWith(`${root}/`)))
}

function shellWriteTargets(command) {
  const out = []
  const redirect = /(?:^|[\s;&|])\d?>{1,2}\s*("[^"]+"|'[^']+'|[^\s;&|<>]+)/g
  let match
  while ((match = redirect.exec(command))) out.push(match[1])
  for (const segment of command.split(SEGMENT_SPLIT)) {
    const { head, args } = commandOf(segment)
    if (head === 'yan') {
      args.forEach((arg, index) => { if (arg === '--output' && args[index + 1]) out.push(args[index + 1]) })
    }
    const positional = args.filter((a) => !/^-/.test(a) && !/^\d?>/.test(a))
    if (head === 'tee') out.push(...positional)
    else if (WRITE_COMMANDS_ALL_ARGS.has(head)) {
      const flagged = []
      args.forEach((a, i) => { if (PS_PATH_FLAGS.has(a.toLowerCase()) && args[i + 1]) flagged.push(args[i + 1]) })
      out.push(...(flagged.length ? flagged : positional))
    } else if (WRITE_COMMANDS_LAST_ARG.has(head)) {
      const flagged = []
      args.forEach((a, i) => { if (['-destination', '-path'].includes(a.toLowerCase()) && args[i + 1]) flagged.push(args[i + 1]) })
      const last = flagged.length ? flagged : positional.slice(-1)
      out.push(...last)
    }
  }
  return out
}

export function outsideWrites(toolName, input, cwd, prefs = {}) {
  if (!prefs.outsideWrites) return []
  const name = String(toolName ?? '')
  const raws = []
  if (name === 'write' || name === 'edit' || name === 'multi_edit' || name === 'apply_patch') {
    const raw = input?.path ?? input?.file_path ?? input?.filePath
    if (typeof raw === 'string' && raw.trim()) raws.push(raw)
  } else if (name === 'bash' || name === 'powershell') {
    raws.push(...shellWriteTargets(String(input?.command ?? '')))
  } else {
    return []
  }
  const roots = allowedRoots(cwd || process.cwd(), prefs)
  const hits = []
  for (const raw of raws) {
    if (/^(?:\/dev\/(?:null|stdout|stderr)|nul|&\d)$/i.test(String(raw).trim())) continue
    const target = resolveTarget(raw, cwd)
    if (target && !isInside(target, roots)) hits.push(target)
  }
  return [...new Set(hits)].slice(0, 6)
}

export const DELETE_HEADS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'unlink', 'remove-item', 'ri', 'shred', 'trash'])

export function hasDelete(command) {
  for (const segment of String(command ?? '').split(SEGMENT_SPLIT)) {
    if (DELETE_HEADS.has(commandOf(segment).head)) return true
  }
  return false
}

export function shellDeleteTargets(command, cwd) {
  const out = []
  for (const segment of String(command ?? '').split(SEGMENT_SPLIT)) {
    const { head, args } = commandOf(segment)
    if (!DELETE_HEADS.has(head)) continue
    const flagged = []
    args.forEach((a, i) => { if (PS_PATH_FLAGS.has(a.toLowerCase()) && args[i + 1]) flagged.push(args[i + 1]) })
    const raws = flagged.length ? flagged : args.filter((a) => !/^-/.test(a) && !/^\d?>/.test(a))
    for (const raw of raws) {
      const target = resolveTarget(raw, cwd)
      if (target) out.push(target)
    }
  }
  return [...new Set(out)]
}

export function isTempPath(target) {
  const roots = [tmpdir(), process.env.TEMP, process.env.TMP, '/tmp', '/var/tmp']
    .filter((p) => typeof p === 'string' && p.trim())
    .map((p) => normalizePath(p).replace(/\/$/, ''))
  const normalized = normalizePath(target)
  return roots.some((root) => normalized !== root && normalized.startsWith(`${root}/`))
}

export function trashHint(targets = []) {
  const list = targets.length ? `要删除的是：${targets.slice(0, 6).join('、')}。` : ''
  return '砚的权限设置不对这次删除做确认，删除要移到回收站，方便用户找回。' + list +
    '请改用 `yan file trash --path <路径>`；多个路径用 `yan file trash --request-file trash.json`（{"paths":[…]}）。' +
    '系统临时目录里的文件可以直接删除。'
}

function guardPrefs() {
  try {
    const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
    const settings = JSON.parse(readFileSync(join(dir, 'desktop.json'), 'utf8'))
    const legacy = settings.permissionMode !== 'danger' && settings.permissionMode !== 'all'
    return {
      mode: settings.permissionMode === 'all' ? 'all' : 'danger',
      outsideWrites: !legacy && settings.guardOutsideWrites === true,
      allowRoots: Array.isArray(settings.guardAllowRoots) ? settings.guardAllowRoots.filter((p) => typeof p === 'string') : []
    }
  } catch {
    return { mode: 'danger', outsideWrites: false, allowRoots: [] }
  }
}

export function claudeDelegationDanger(toolName, input, cwd) {
  if (['read', 'write', 'edit', 'bash', 'powershell', 'grep', 'find', 'ls', 'multi_edit', 'apply_patch'].includes(toolName)) return []
  const readConfig = (path) => {
    try { return JSON.parse(readFileSync(path, 'utf8'))?.askClaude ?? {} } catch { return {} }
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR || process.env.YAN_PI_DIR || join(homedir(), '.pi', 'agent')
  const config = { ...readConfig(join(agentDir, 'claude-bridge.json')), ...readConfig(join(cwd || process.cwd(), '.pi', 'claude-bridge.json')) }
  if (toolName !== (config.name || 'AskClaude')) return []
  return ['Claude Code 原生工具委派：砚无法逐条检查内部操作；允许将授权本次完整任务。需要逐条危险审批时，请使用指定 claude-bridge 模型的砚子 Agent']
}

async function askHost(toolName, input, reasons, outsideDirs = [], toolCallId = '') {
  const url = process.env.YAN_CLI_URL
  const token = process.env.YAN_CLI_TOKEN
  const sessionId = process.env.YAN_SESSION_ID
  const projectId = process.env.YAN_PROJECT_ID
  if (!url || !token || !sessionId || !projectId) return { allowed: false, why: '宿主确认通道不可用' }
  const fullDetail = typeof input?.prompt === 'string' && !String(toolName ?? '').startsWith('mcp__')
  const detail =
    toolName === 'bash' || toolName === 'powershell'
      ? String(input?.command ?? '')
      : fullDetail || String(toolName ?? '').startsWith('mcp__')
        ? JSON.stringify(input ?? {})
        : String(input?.path ?? input?.file_path ?? input?.filePath ?? '') ||
          (typeof input?.code === 'string' ? input.code : JSON.stringify(input ?? {}))
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        apiVersion: 1,
        command: 'danger.confirm',
        params: { tool: toolName, detail: fullDetail ? detail : detail.slice(0, 2000), reasons, ...(outsideDirs.length ? { outsideDirs } : {}), ...(toolCallId ? { toolCallId } : {}) },
        sessionId,
        projectId
      }),
      signal: AbortSignal.timeout(CONFIRM_TIMEOUT_MS)
    })
    const payload = await response.json()
    if (payload?.ok && payload?.summary?.allowed === true) return { allowed: true }
    return { allowed: false, why: payload?.summary?.decision === 'no-answer' ? '没有得到用户确认' : '用户拒绝了这次操作' }
  } catch (err) {
    return { allowed: false, why: `没能取得用户确认（${String(err?.message ?? err).slice(0, 80)}）` }
  }
}

export default function dangerGuardExtension(pi) {
  pi.on('tool_call', async (event, ctx) => {
    if (process.env.YAN_DANGER_GUARD === '0') return undefined
    const name = String(event?.toolName ?? '')
    if (!name) return undefined
    const prefs = guardPrefs()
    if (prefs.mode === 'all') return undefined
    const delegation = claudeDelegationDanger(name, event?.input ?? {}, ctx?.cwd)
    if (delegation.length && JSON.stringify(event?.input ?? {}).length > 20000) return { block: true, reason: 'Claude Code 委派任务过长，无法完整展示审批内容。请缩短任务，或使用砚子 Agent。' }
    const mcpReasons = name.startsWith('mcp__') ? mcpCallDanger(name, toolAnnotations(pi, name)) : []
    const outside = outsideWrites(name, event?.input ?? {}, ctx?.cwd, prefs)
    const reasons = [
      ...detectDanger(name, event?.input ?? {}, ctx?.cwd),
      ...delegation,
      ...mcpReasons,
      ...outside.map((target) => `写入项目之外的路径：${target}`)
    ]
    if (reasons.length === 0) return undefined
    const answer = await askHost(name, event?.input ?? {}, [...new Set(reasons)], outside, typeof event?.toolCallId === 'string' ? event.toolCallId : '')
    if (answer.allowed) return undefined
    return { block: true, reason: `高危操作未获用户确认：${reasons.join('；')}。${answer.why}。请换一种更安全的做法，或向用户说明为什么必须这样做。` }
  })
}
