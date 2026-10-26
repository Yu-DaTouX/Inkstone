import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, posix } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000
const PREFS_TIMEOUT_MS = 5000
const APPROVAL_DETAIL_MAX = 20000
const MAX_SHELL_DEPTH = 6

export function isBroadTarget(raw) {
  let target = String(raw ?? '').trim().replace(/^["']+|["']+$/g, '')
  if (!target) return false
  target = msysDrivePath(target.replace(/\\/g, '/').toLowerCase())
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

function deletesOutsideProject(raw, cwd) {
  const target = resolveTarget(raw, cwd)
  if (!target) return false
  const roots = [cwd || process.cwd(), tmpdir(), '/tmp', '/var/tmp'].map((p) => physicalPath(normalizePath(p)).replace(/\/$/, ''))
  return !isInside(target, roots)
}

function recursiveDeleteTarget({ head, args }, cwd) {
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
  const cmdFlag = head === 'rm' ? /^-/ : /^(-|\/[a-z]$)/i
  const targets = args.filter((a) => !cmdFlag.test(a) && !/^-{1,2}\w/.test(a))
  return targets.find((target) => isBroadTarget(target) || deletesOutsideProject(target, cwd)) ?? null
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

const MSYS_DRIVE = /^\/(?:cygdrive\/)?([a-z])(?:\/|$)/

function msysDrivePath(text) {
  return process.platform === 'win32' ? text.replace(MSYS_DRIVE, '$1:/') : text
}

function normalizePath(p) {
  const text = msysDrivePath(String(p ?? '').replace(/\\/g, '/').toLowerCase().replace(/^\/\/[?.]\/unc\//, '//').replace(/^\/\/[?.]\//, ''))
  const match = /^([a-z]:)?(.*)$/.exec(text)
  const drive = match?.[1] ?? ''
  const rest = match?.[2] ?? ''
  return drive + (rest ? posix.normalize(rest) : '')
}

function physicalPath(normalized) {
  if (process.platform === 'win32' && !/^(?:[a-z]:|\/\/)/.test(normalized)) return normalized
  let probe = normalized
  let rest = ''
  for (let i = 0; i < 64 && probe; i++) {
    try {
      if (existsSync(probe)) {
        const real = normalizePath(realpathSync.native(probe)).replace(/\/$/, '')
        return rest ? `${real}/${rest}` : real || normalized
      }
    } catch {}
    const cut = probe.replace(/\/$/, '').lastIndexOf('/')
    if (cut < 0) break
    let parent = cut === 0 ? '/' : probe.slice(0, cut)
    if (/^[a-z]:$/.test(parent)) parent += '/'
    if (parent === probe) break
    const name = probe.replace(/\/$/, '').slice(cut + 1)
    rest = rest ? `${name}/${rest}` : name
    probe = parent
  }
  return normalized
}

function encodedPowerShell({ head, args }) {
  if (head !== 'powershell' && head !== 'pwsh') return null
  for (let i = 0; i < args.length; i++) {
    const flag = args[i].toLowerCase()
    if (!/^[-/]/.test(flag)) continue
    const name = flag.slice(1)
    if (name !== 'ec' && !(name && 'encodedcommand'.startsWith(name))) continue
    const value = String(args[i + 1] ?? '').replace(/^["']|["']$/g, '')
    if (!/^[a-z0-9+/=]+$/i.test(value)) return ''
    const decoded = Buffer.from(value, 'base64').toString('utf16le')
    return decoded && !decoded.includes('\ufffd') ? decoded : ''
  }
  return null
}

function unwrapShellBody(body) {
  return body.trim().replace(/\\(["'])/g, '$1').replace(/^["']|["']$/g, '')
}

function isAbsolutePath(p) {
  return /^(?:[a-z]:)?[\\/]/i.test(p) || /^[a-z]:/i.test(p)
}

function scanCommand(command, reasons, depth = 0, cwd = '') {
  for (const segment of command.split(SEGMENT_SPLIT)) {
    const cmd = commandOf(segment)
    const hit = recursiveDeleteTarget(cmd, cwd)
    if (hit) reasons.push(isBroadTarget(hit) ? `递归删除大范围目录：${hit}` : `递归删除项目之外的目录：${hit}`)
    if (POWER_COMMANDS.has(cmd.head)) reasons.push('关机或重启')
    const encoded = encodedPowerShell(cmd)
    if (encoded === '') reasons.push('PowerShell 编码命令无法解读，砚无法检查其中的操作')
    else if (encoded !== null) {
      const inner = []
      if (depth < MAX_SHELL_DEPTH) scanCommand(encoded, inner, depth + 1, cwd)
      else inner.push('命令嵌套层数过多，砚无法检查最内层的操作')
      if (inner.length) reasons.push(...inner, `PowerShell 编码命令，解码后为：${encoded.slice(0, 300)}`)
    }
    const wrapped = SHELL_WRAPPER.exec(segment)
    if (wrapped && depth < MAX_SHELL_DEPTH) scanCommand(unwrapShellBody(wrapped[1]), reasons, depth + 1, cwd)
    else if (wrapped) reasons.push('命令嵌套层数过多，砚无法检查最内层的操作')
  }
  for (const rule of COMMAND_RULES) if (rule.re.test(command)) reasons.push(rule.label)
}

export function detectDanger(toolName, input, cwd) {
  const reasons = []
  const name = String(toolName ?? '')
  if (name === 'bash' || name === 'powershell') {
    const command = String(input?.command ?? '')
    scanCommand(command, reasons, 0, cwd)
    if (/\bsudo\b/i.test(command) && reasons.length === 0 && /\brm\b/i.test(command)) reasons.push('以管理员身份删除文件')
  } else if (name === 'write' || name === 'edit' || name === 'multi_edit' || name === 'apply_patch') {
    const raw = input?.path ?? input?.file_path ?? input?.filePath
    if (typeof raw === 'string' && raw.trim()) {
      const base = cwd || process.cwd()
      const abs = isAbsolutePath(raw) ? raw : `${String(base).replace(/[\\/]+$/, '')}/${raw}`
      const normalized = physicalPath(normalizePath(abs))
      const root = physicalPath(normalizePath(base)).replace(/\/$/, '')
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
  return physicalPath(normalizePath(isAbsolutePath(fixed) ? fixed : `${base}/${fixed}`))
}

function allowedRoots(cwd, prefs) {
  const list = [cwd, tmpdir(), '/tmp', '/var/tmp', join(homedir(), '.pi'), process.env.PI_CODING_AGENT_DIR, process.env.YAN_DATA_DIR, ...(prefs.allowRoots ?? [])]
  return list.filter((p) => typeof p === 'string' && p.trim()).map((p) => physicalPath(normalizePath(p)).replace(/\/$/, ''))
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

const STRICT_PREFS = { mode: 'danger', outsideWrites: true, allowRoots: [] }

async function hostPrefs() {
  const url = process.env.YAN_CLI_URL
  const token = process.env.YAN_CLI_TOKEN
  const sessionId = process.env.YAN_SESSION_ID
  const projectId = process.env.YAN_PROJECT_ID
  if (!url || !token || !sessionId || !projectId) return STRICT_PREFS
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ apiVersion: 1, command: 'danger.prefs', params: {}, sessionId, projectId }),
      signal: AbortSignal.timeout(PREFS_TIMEOUT_MS)
    })
    const summary = (await response.json())?.summary
    if (!summary || (summary.mode !== 'danger' && summary.mode !== 'all')) return STRICT_PREFS
    return {
      mode: summary.mode,
      outsideWrites: summary.outsideWrites !== false,
      allowRoots: Array.isArray(summary.allowRoots) ? summary.allowRoots.filter((p) => typeof p === 'string') : []
    }
  } catch {
    return STRICT_PREFS
  }
}

function claudeDelegationDanger(toolName, input, cwd) {
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
  if (detail.length > APPROVAL_DETAIL_MAX) return { allowed: false, why: `审批内容有 ${detail.length} 字，超过 ${APPROVAL_DETAIL_MAX} 字，无法完整展示给用户确认。请缩短内容或分步执行` }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        apiVersion: 1,
        command: 'danger.confirm',
        params: { tool: toolName, detail, reasons, ...(outsideDirs.length ? { outsideDirs } : {}), ...(toolCallId ? { toolCallId } : {}) },
        sessionId,
        projectId
      }),
      signal: AbortSignal.timeout(CONFIRM_TIMEOUT_MS)
    })
    const payload = await response.json()
    if (payload?.ok && payload?.summary?.allowed === true) return { allowed: true }
    const feedback = typeof payload?.summary?.feedback === 'string' ? payload.summary.feedback.trim() : ''
    if (feedback) return { allowed: false, why: `用户拒绝了这次操作，并给出理由：${feedback}。请按这个理由调整做法后再试` }
    const reason = typeof payload?.summary?.reason === 'string' ? payload.summary.reason.trim() : ''
    if (reason) return { allowed: false, why: reason }
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
    const prefs = await hostPrefs()
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
