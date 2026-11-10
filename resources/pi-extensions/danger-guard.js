import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, posix } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000
const PREFS_TIMEOUT_MS = 5000
const APPROVAL_DETAIL_MAX = 20000
const CHANGE_PREVIEW_MAX = 12000
const MAX_SHELL_DEPTH = 6
const FILE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'apply_patch'])
const CHANGED_AFTER_APPROVAL = 'Not run: the operation changed while it was waiting for approval. Start it again.'
const CHANGE_CLIPPED = (rest) => `…（其余 ${rest} 字未显示，以哈希为准）`
const CHANGE_DIGEST = (length, digest) => `变更共 ${length} 字，SHA-256 ${digest}`

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

function heredocDelimiter(text, at) {
  const match = /^<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(text.slice(at))
  return match ? { tag: match[2], length: match[0].length, quoted: match[1] !== '' } : null
}

export function splitSegments(command) {
  const text = String(command ?? '')
  const parts = []
  let current = ''
  let quote = null
  let heredoc = null
  const flush = (sep) => { parts.push({ text: current, sep }); current = '' }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      current += ch
      if (ch === '\\' && quote === '"' && i + 1 < text.length) current += text[++i]
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '\n' && heredoc) {
      const end = text.slice(i + 1).split('\n').findIndex((line) => line.trim() === heredoc)
      const lines = text.slice(i + 1).split('\n')
      const bodyLines = end < 0 ? lines : lines.slice(0, end + 1)
      const body = bodyLines.join('\n')
      current += `\n${body}`
      i += body.length + 1
      heredoc = null
      flush('\n')
      continue
    }
    if (ch === '\\' && i + 1 < text.length) { current += ch + text[++i]; continue }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue }
    if (ch === '$' && text[i + 1] === '(') {
      const end = closingParen(text, i + 1)
      if (end > 0) { current += text.slice(i, end + 1); i = end; continue }
    }
    if (ch === '<' && text[i + 1] === '<') {
      const found = heredocDelimiter(text, i)
      if (found) { heredoc = found.tag; current += text.slice(i, i + found.length); i += found.length - 1; continue }
    }
    const two = text.slice(i, i + 2)
    if (two === '&&' || two === '||') { flush(two); i++; continue }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') { flush(ch); continue }
    current += ch
  }
  flush('')
  return parts
}

function closingParen(text, open) {
  let depth = 0
  let quote = null
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === '(') depth += 1
    else if (ch === ')' && --depth === 0) return i
  }
  return -1
}

function substitutions(text) {
  const found = []
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'" && quote !== '"') { quote = quote ? null : "'"; continue }
    if (quote === "'") continue
    if (ch === '"') { quote = quote ? null : '"'; continue }
    if (ch === '\\') { i += 1; continue }
    if ((ch === '$' || ch === '<' || ch === '>') && text[i + 1] === '(') {
      const end = closingParen(text, i + 1)
      if (end > 0) { found.push(text.slice(i + 2, end)); i = end }
    } else if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > 0) { found.push(text.slice(i + 1, end)); i = end }
    }
  }
  return found
}

const SEGMENT_TOKEN = /"[^"]*"|'[^']*'|\S+/g

function tokens(segment) {
  return segment.trim().match(SEGMENT_TOKEN) ?? []
}

function bareName(word) {
  return String(word ?? '').toLowerCase().replace(/^["']+|["']+$/g, '').replace(/^.*[\\/]/, '').replace(/\.exe$/, '')
}

const PREFIX_COMMANDS = new Map(Object.entries({
  sudo: { valued: ['-u', '-g', '-h', '-p', '-C', '-T', '-r', '-t', '-U', '--user', '--group', '--host', '--prompt'] },
  doas: { valued: ['-u', '-C'] },
  env: { valued: ['-u', '--unset', '-C', '--chdir'] },
  timeout: { valued: ['-k', '--kill-after', '-s', '--signal'], positionals: 1 },
  nohup: {},
  command: {},
  builtin: {},
  exec: { valued: ['-a'] },
  time: { valued: ['-f', '-o', '--format', '--output'] },
  nice: { valued: ['-n', '--adjustment'] },
  ionice: { valued: ['-c', '-n'] },
  stdbuf: { valued: ['-i', '-o', '-e'] },
  setsid: {},
  xargs: { valued: ['-I', '-L', '-n', '-P', '-s', '-d', '-E', '-a', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars', '--delimiter', '--eof', '--arg-file'], stdinArgs: true },
  if: {},
  then: {},
  elif: {},
  else: {},
  do: {},
  while: {},
  until: {},
  '!': {}
}))

function commandStart(parts) {
  let start = 0
  let stdinArgs = false
  while (start < parts.length) {
    if (/^\w+=/.test(parts[start])) { start += 1; continue }
    const prefix = PREFIX_COMMANDS.get(bareName(parts[start]))
    if (!prefix) break
    stdinArgs ||= prefix.stdinArgs === true
    start += 1
    let positionals = prefix.positionals ?? 0
    while (start < parts.length) {
      const arg = parts[start]
      if (prefix.valued?.includes(arg)) start += 2
      else if (/^-./.test(arg)) start += 1
      else if (positionals > 0) { positionals -= 1; start += 1 }
      else break
    }
  }
  return { start, stdinArgs }
}

function stripGrouping(segment) {
  return String(segment).replace(/^\s*[({]+\s*/, '')
}

function commandOf(segment) {
  const parts = tokens(stripGrouping(segment))
  const { start, stdinArgs } = commandStart(parts)
  return { head: bareName(parts[start]), args: parts.slice(start + 1), stdinArgs }
}

function deletesOutsideProject(raw, cwd, base = cwd) {
  if (base === null && !isAbsolutePath(expandHome(expandEnv(unquote(raw))))) return true
  const target = resolveTarget(raw, base ?? cwd)
  if (!target) return false
  const roots = [cwd || process.cwd(), tmpdir(), '/tmp', '/var/tmp'].map((p) => physicalPath(normalizePath(p)).replace(/\/$/, ''))
  return !isInside(target, roots)
}

const PS_RECURSE = /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?::\$?true)?$/i

function isRecursiveDelete({ head, args }) {
  if (head === 'rm') return args.some((a) => /^-[a-z]*r[a-z]*$/i.test(a) || a === '--recursive' || /^-recurse$/i.test(a))
  if (['rmdir', 'rd', 'del', 'erase'].includes(head)) return args.some((a) => /^\/s$/i.test(a) || PS_RECURSE.test(a))
  if (['remove-item', 'ri'].includes(head)) return args.some((a) => PS_RECURSE.test(a))
  return false
}

function recursiveDeleteTarget(cmd, cwd, base = cwd) {
  if (!isRecursiveDelete(cmd)) return null
  const cmdFlag = cmd.head === 'rm' ? /^-/ : /^(-|\/[a-z]$)/i
  const targets = cmd.args.filter((a) => !cmdFlag.test(a) && !/^-{1,2}\w/.test(a))
  return targets.find((target) => isBroadTarget(target) || deletesOutsideProject(target, cwd, base)) ?? null
}

const POWER_COMMANDS = new Set(['shutdown', 'reboot', 'halt', 'poweroff', 'stop-computer', 'restart-computer'])

const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash'])
const POSIX_VALUED_FLAGS = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file'])
const PS_VALUED_FLAGS = ['executionpolicy', 'ep', 'windowstyle', 'inputformat', 'outputformat', 'configurationname', 'configurationfile', 'custompipename', 'psconsolefile', 'settingsfile', 'version', 'workingdirectory', 'wd']

function cmdBody(rest, text) {
  for (const token of rest) {
    const flag = /^(?:\/[a-z](?::\w+)?)*?\/[ck]/i.exec(token[0])
    if (flag) return text.slice(token.index + flag[0].length)
    if (!token[0].startsWith('/')) return ''
  }
  return ''
}

function posixBody(rest, text) {
  const after = (i) => (i < rest.length ? text.slice(rest[i].index) : '')
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i][0]
    if (POSIX_VALUED_FLAGS.has(word)) { i += 1; continue }
    if (word.startsWith('--')) continue
    if (!/^[-+][a-z]+$/i.test(word)) return ''
    const takesOption = /[oO]$/.test(word)
    if (word[0] === '-' && word.includes('c')) return after(i + 1 + (takesOption ? 1 : 0))
    if (takesOption) i += 1
  }
  return ''
}

function powershellBody(rest, text) {
  const after = (i) => (i < rest.length ? text.slice(rest[i].index) : '')
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i][0]
    if (!/^[-/]/.test(word)) return after(i)
    const [name, inlineValue] = word.slice(1).toLowerCase().split(/:(.*)/s)
    if (!name) return ''
    if ('command'.startsWith(name)) return after(i + 1)
    if (name === 'ec' || 'encodedcommand'.startsWith(name) || 'file'.startsWith(name)) return ''
    if (inlineValue === undefined && PS_VALUED_FLAGS.some((flag) => flag.startsWith(name))) i += 1
  }
  return ''
}

function shellBody(segment) {
  const text = stripGrouping(segment)
  const found = [...text.matchAll(SEGMENT_TOKEN)]
  const { start } = commandStart(found.map((match) => match[0]))
  const head = bareName(found[start]?.[0])
  const rest = found.slice(start + 1)
  if (head === 'cmd') return cmdBody(rest, text)
  if (head === 'powershell' || head === 'pwsh') return powershellBody(rest, text)
  return POSIX_SHELLS.has(head) ? posixBody(rest, text) : ''
}

const GIT_PREFIX = String.raw`\bgit\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace)(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)\s+|-\S+\s+)*`
const gitRule = (rest) => new RegExp(GIT_PREFIX + rest, 'i')

const COMMAND_RULES = [
  { re: gitRule(String.raw`push\b[^;&|\n]*\s(?:--force(?!-with-lease)\b|-f\b|--mirror\b)`), label: 'Git 强制推送，会覆盖远端历史' },
  { re: gitRule(String.raw`reset\b[^;&|\n]*--hard\b`), label: 'git reset --hard，会丢弃未提交的改动' },
  { re: gitRule(String.raw`clean\b[^;&|\n]*\s(?:-[a-z]*f|--force\b)`), label: 'git clean -f，会永久删除未跟踪的文件' },
  { re: gitRule(String.raw`(?:checkout|restore)\b[^;&|\n]*(?:\s--\s+\.|\s\.)(?:\s|$)`), label: '还原整个工作区，会丢弃未提交的改动' },
  { re: gitRule(String.raw`stash\s+(?:clear|drop)\b`), label: '删除 Git stash 里暂存的改动' },
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

function scanCommand(command, reasons, depth = 0, cwd = '', base = cwd) {
  if (depth < MAX_SHELL_DEPTH) {
    for (const inner of substitutions(command)) scanCommand(inner, reasons, depth + 1, cwd, base)
  }
  for (const segment of command.split(SEGMENT_SPLIT)) {
    const cmd = commandOf(segment)
    const hit = recursiveDeleteTarget(cmd, cwd, base)
    if (hit) reasons.push(isBroadTarget(hit) ? `递归删除大范围目录：${hit}` : `递归删除项目之外的目录：${hit}`)
    if (cmd.stdinArgs && isRecursiveDelete(cmd)) reasons.push('递归删除的目标来自管道输入，砚无法判断范围')
    if (POWER_COMMANDS.has(cmd.head)) reasons.push('关机或重启')
    const encoded = encodedPowerShell(cmd)
    if (encoded === '') reasons.push('PowerShell 编码命令无法解读，砚无法检查其中的操作')
    else if (encoded !== null) {
      const inner = []
      if (depth < MAX_SHELL_DEPTH) scanCommand(encoded, inner, depth + 1, cwd, base)
      else inner.push('命令嵌套层数过多，砚无法检查最内层的操作')
      if (inner.length) reasons.push(...inner, `PowerShell 编码命令，解码后为：${encoded.slice(0, 300)}`)
    }
    const wrapped = shellBody(segment)
    if (wrapped && depth < MAX_SHELL_DEPTH) scanCommand(unwrapShellBody(wrapped), reasons, depth + 1, cwd, base)
    else if (wrapped) reasons.push('命令嵌套层数过多，砚无法检查最内层的操作')
  }
  const ruleSource = ruleText(command)
  for (const rule of COMMAND_RULES) if (rule.re.test(ruleSource)) reasons.push(rule.label)
}

const SEARCH_COMMANDS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'findstr', 'select-string', 'sls'])

function searchesText({ head, args }) {
  if (SEARCH_COMMANDS.has(head)) return true
  return head === 'git' && args.find((arg) => !/^-/.test(arg)) === 'grep'
}

export function ruleText(command) {
  return splitSegments(command).map(({ text, sep }) => (searchesText(commandOf(text.replace(/^\s*[({]+/, ''))) ? '' : text) + sep).join('')
}

export function hostScansTerminalInput(command) {
  const segments = splitSegments(command).filter((part) => part.text.trim())
  if (segments.length !== 1) return false
  const { head, args } = commandOf(segments[0].text)
  return /^yan(?:\.cmd|\.ps1)?$/.test(head) && args[0] === 'terminal' && ['run', 'write', 'keys'].includes(args[1])
}

export function detectDanger(toolName, input, cwd, options = {}) {
  const reasons = []
  const name = String(toolName ?? '')
  if (name === 'bash' || name === 'powershell') {
    const command = String(input?.command ?? '')
    if (!hostScansTerminalInput(command)) scanCommand(command, reasons, 0, cwd, options.base === undefined ? cwd : options.base)
    for (const { target } of shellWrites(command, cwd, 0, options.base === undefined ? undefined : { base: options.base, vars: new Map() })) {
      if (touchesHostConfig(target, cwd)) reasons.push(`${HOST_CONFIG_REASON}${target}`)
    }
    if (/\bsudo\b/i.test(command) && reasons.length === 0 && /\brm\b/i.test(command)) reasons.push('以管理员身份删除文件')
  } else if (FILE_TOOLS.has(name)) {
    const raw = fileToolPath(input?.path ?? input?.file_path ?? input?.filePath)
    if (typeof raw === 'string' && raw.trim()) {
      const base = cwd || process.cwd()
      const abs = isAbsolutePath(raw) ? raw : `${String(base).replace(/[\\/]+$/, '')}/${raw}`
      const normalized = physicalPath(normalizePath(abs))
      const root = physicalPath(normalizePath(base)).replace(/\/$/, '')
      const inside = normalized === root || normalized.startsWith(`${root}/`)
      if (touchesHostConfig(normalized, base)) reasons.push(`${HOST_CONFIG_REASON}${normalized}`)
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
const PS_VALUE_AFTER_PATH = new Set(['set-content', 'sc', 'add-content', 'ac', 'out-file'])

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

const HOST_CONFIG_REASON = '修改 pi 或砚的配置、凭据或扩展：'
const UNKNOWN_BASE_NOTE = '（命令切换目录后无法确定写入位置）'

function canonicalRoot(p) {
  return physicalPath(normalizePath(p)).replace(/\/$/, '')
}

function hostConfigAreas() {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
  const dataDir = process.env.YAN_DATA_DIR?.trim() || join(agentDir, 'yan')
  return {
    roots: [join(homedir(), '.pi'), agentDir, dataDir].map(canonicalRoot),
    outputs: [join(dataDir, 'tmp'), join(dataDir, 'artifacts')].map(canonicalRoot)
  }
}

function touchesHostConfig(target, cwd) {
  if (!target) return false
  const { roots, outputs } = hostConfigAreas()
  if (!isInside(target, roots) || isInside(target, outputs)) return false
  return !isInside(canonicalRoot(cwd || process.cwd()), roots)
}

function allowedRoots(cwd, prefs) {
  const list = [cwd, tmpdir(), '/tmp', '/var/tmp', ...hostConfigAreas().outputs, ...(prefs.allowRoots ?? [])]
  return list.filter((p) => typeof p === 'string' && p.trim()).map(canonicalRoot)
}

function isInside(target, roots) {
  return roots.some((root) => root && (target === root || target.startsWith(`${root}/`)))
}

const REDIRECT = /(?<![<>=-])\d?>{1,2}(?![&=>])\s*("[^"]+"|'[^']+'|[^\s;&|<>]+)/g
const LOCATION_COMMANDS = new Set(['cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl', 'push-location', 'pop-location'])
const CLONE_VALUE_FLAGS = new Set(['-b', '--branch', '-o', '--origin', '-c', '--config', '--depth', '-j', '--jobs', '--reference', '--separate-git-dir', '--template', '-u', '--upload-pack', '--filter'])

function unquote(text) {
  return String(text ?? '').trim().replace(/^["']+|["']+$/g, '')
}

function flagValues(args, names, { ignoreCase = false } = {}) {
  const wanted = names.map((name) => (ignoreCase ? name.toLowerCase() : name))
  const out = []
  args.forEach((arg, index) => {
    const flag = ignoreCase ? arg.toLowerCase() : arg
    for (const name of wanted) {
      if (flag === name && args[index + 1] !== undefined) out.push(args[index + 1])
      else if (name.startsWith('--') && flag.startsWith(`${name}=`)) out.push(arg.slice(name.length + 1))
    }
  })
  return out
}

function nextLocation({ head, args }, base) {
  if (head === 'popd' || head === 'pop-location') return null
  const plain = args.filter((arg) => !/^\d?[<>]/.test(arg))
  const flagged = flagValues(plain, ['-path', '-literalpath'], { ignoreCase: true })
  const skipDriveFlag = (head === 'cd' || head === 'chdir') && /^\/d$/i.test(plain[0] ?? '') && plain.length > 1
  const target = flagged[0] ?? (skipDriveFlag ? plain[1] : plain.find((arg) => !/^-./.test(arg)))
  if (target === undefined) return head === 'cd' || head === 'chdir' ? canonicalRoot(homedir()) : base
  const cleaned = expandHome(expandEnv(unquote(target)))
  if (!cleaned || cleaned === '-' || /[$%`(]/.test(cleaned)) return null
  if (base === null && !isAbsolutePath(cleaned)) return null
  return resolveTarget(cleaned, base ?? '')
}

function toolWriteTargets(head, args) {
  if (head === 'curl') {
    const bundled = args.flatMap((arg, index) => (/^-[a-zA-Z]+o$/.test(arg) && args[index + 1] !== undefined ? [args[index + 1]] : []))
    const files = [...flagValues(args, ['-o', '--output']), ...bundled]
    const dirs = flagValues(args, ['--output-dir'])
    const remoteName = args.some((arg) => arg === '--remote-name' || arg === '--remote-name-all' || /^-[a-zA-Z]*O[a-zA-Z]*$/.test(arg))
    return [...files, ...dirs, ...(remoteName && !dirs.length ? ['.'] : [])]
  }
  if (head === 'wget') {
    const files = flagValues(args, ['-O', '--output-document'])
    const dirs = flagValues(args, ['-P', '--directory-prefix'])
    return files.length || dirs.length ? [...files, ...dirs] : ['.']
  }
  if (['iwr', 'invoke-webrequest', 'irm', 'invoke-restmethod'].includes(head)) {
    return flagValues(args, ['-outfile'], { ignoreCase: true })
  }
  if (head === 'git') {
    const at = args.findIndex((arg) => arg === 'clone')
    if (at < 0) return []
    const positional = []
    for (let i = at + 1; i < args.length; i++) {
      if (CLONE_VALUE_FLAGS.has(args[i])) { i++; continue }
      if (!/^-/.test(args[i])) positional.push(args[i])
    }
    return [positional[1] ?? '.']
  }
  if (head === 'tar') {
    const dirs = flagValues(args, ['-C', '--directory'])
    const extract = /^[a-wyzA-Z]*x[a-zA-Z]*$/.test(args[0] ?? '') || args.some((arg) => arg === '--extract' || arg === '--get' || /^-[a-zA-Z]*x[a-zA-Z]*$/.test(arg))
    return dirs.length ? dirs : extract ? ['.'] : []
  }
  if (head === 'unzip') {
    const dirs = flagValues(args, ['-d'])
    return dirs.length ? dirs : ['.']
  }
  if (head === 'expand-archive') {
    const dirs = flagValues(args, ['-destinationpath'], { ignoreCase: true })
    return dirs.length ? dirs : ['.']
  }
  return []
}

export function withoutHeredocBodies(segment, quotedOnly = false) {
  let text = String(segment ?? '')
  let from = 0
  for (;;) {
    const at = text.indexOf('<<', from)
    if (at < 0) return text
    const found = heredocDelimiter(text, at)
    if (!found || (quotedOnly && !found.quoted)) { from = at + 2; continue }
    const lineEnd = text.indexOf('\n', at + found.length)
    if (lineEnd < 0) return text
    const lines = text.slice(lineEnd + 1).split('\n')
    const end = lines.findIndex((line) => line.trim() === found.tag)
    const rest = end < 0 ? '' : lines.slice(end + 1).join('\n')
    text = `${text.slice(0, lineEnd)}${rest ? `\n${rest}` : ''}`
    from = lineEnd
  }
}

function segmentWriteTargets(segment, { head, args }) {
  const out = []
  for (const match of withoutHeredocBodies(segment).matchAll(REDIRECT)) out.push(match[1])
  if (head === 'yan') {
    args.forEach((arg, index) => { if (arg === '--output' && args[index + 1]) out.push(args[index + 1]) })
  }
  const positional = args.filter((a) => !/^-/.test(a) && !/^\d?>/.test(a))
  if (head === 'tee') out.push(...positional)
  else if (WRITE_COMMANDS_ALL_ARGS.has(head)) {
    const flagged = []
    args.forEach((a, i) => { if (PS_PATH_FLAGS.has(a.toLowerCase()) && args[i + 1]) flagged.push(args[i + 1]) })
    out.push(...(flagged.length ? flagged : PS_VALUE_AFTER_PATH.has(head) ? positional.slice(0, 1) : positional))
  } else if (WRITE_COMMANDS_LAST_ARG.has(head)) {
    const flagged = []
    args.forEach((a, i) => { if (['-destination', '-path'].includes(a.toLowerCase()) && args[i + 1]) flagged.push(args[i + 1]) })
    out.push(...(flagged.length ? flagged : positional.slice(-1)))
  }
  out.push(...toolWriteTargets(head, args))
  return out
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

function fileToolPath(raw) {
  if (typeof raw !== 'string') return raw
  let text = raw.replace(UNICODE_SPACES, ' ')
  if (text.trimStart().startsWith('@')) text = text.trimStart().slice(1)
  if (process.platform === 'win32') text = text.replace(/^\/mnt\/([a-z])(?=\/|$)/i, '$1:')
  if (/^~(?:[\\/]|$)/.test(text)) return homedir() + text.slice(1)
  if (!/^file:\/\//i.test(text)) return text
  try {
    return fileURLToPath(text)
  } catch {
    return text
  }
}

const LOOP_ITEM = Symbol('loop-item')
const TEMP_DIR = Symbol('temp-dir')
const UNKNOWN_VARIABLE_NOTE = '（写入目标含无法静态确定的变量或表达式，无法判断位置）'
const RAW_TARGET_MAX = 80

function shownTarget(raw) {
  const text = unquote(raw).replace(/\s+/g, ' ').trim()
  return text.length > RAW_TARGET_MAX ? `${text.slice(0, RAW_TARGET_MAX)}…` : text
}

function variableValue(rawValue) {
  const value = unquote(rawValue)
  if (/^\$\(\s*mktemp\b|^`mktemp\b|New-TemporaryFile|GetTemp(?:Path|FileName)|^\$env:(?:TEMP|TMP)\b/i.test(value)) return TEMP_DIR
  if (/\$\(|`|^\(|^\[/.test(value)) return null
  return value
}

function loopValue(list) {
  return /(?:^|\s|["'(])(?:[a-z]:|[\\/]|~)/i.test(list) ? null : LOOP_ITEM
}

function rememberVariables(segment, vars) {
  const text = segment.trim()
  let match = /^\$([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(text)
  if (match) { vars.set(match[1].toLowerCase(), variableValue(match[2])); return }
  match = /\bfor\s+([A-Za-z_]\w*)\s+in\b([\s\S]*)$/.exec(text)
  if (match) { vars.set(match[1], loopValue(match[2])); return }
  match = /\bforeach\s*\(\s*\$([A-Za-z_]\w*)\s+in\b([^)]*)\)/i.exec(text)
  if (match) vars.set(match[1].toLowerCase(), loopValue(match[2]))
  match = /\bread\s+(?:-\w+\s+)*([A-Za-z_]\w*)\s*$/.exec(text)
  if (match) vars.set(match[1], LOOP_ITEM)
  const parts = tokens(text)
  let index = /^(?:export|local|readonly|declare)$/.test(parts[0] ?? '') ? 1 : 0
  for (; index < parts.length; index++) {
    const assignment = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(parts[index])
    if (!assignment) break
    vars.set(assignment[1], variableValue(assignment[2]))
  }
}

function lookupVariable(name, vars) {
  if (vars.has(name)) return vars.get(name)
  if (vars.has(name.toLowerCase())) return vars.get(name.toLowerCase())
  if (name === '_' || /^psitem$/i.test(name)) return LOOP_ITEM
  const key = Object.keys(process.env).find((k) => k === name) ?? Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ? process.env[key] : undefined
}

function substituteVariables(text, base, vars, depth = 0) {
  let unknown = false
  const replaced = text.replace(/\$(?:\{([A-Za-z_]\w*)[^}]*\}|([A-Za-z_]\w*))/g, (_all, braced, plain) => {
    const name = braced ?? plain
    if (/^pwd$/i.test(name)) {
      if (base === null) unknown = true
      return base ?? ''
    }
    if (/^home$/i.test(name)) return homedir().replace(/\\/g, '/')
    const value = lookupVariable(name, vars)
    if (value === LOOP_ITEM) return 'item'
    if (value === TEMP_DIR) return tmpdir().replace(/\\/g, '/')
    if (typeof value !== 'string' || depth > 4) { unknown = true; return '' }
    const inner = /[$`]/.test(value) ? substituteVariables(value, base, vars, depth + 1) : value
    if (inner === null) { unknown = true; return '' }
    return inner
  })
  if (unknown || /[$`]|%[A-Za-z_]\w*%/.test(replaced)) return null
  return replaced
}

function resolveFrom(raw, base, vars = new Map()) {
  let cleaned = expandHome(expandEnv(unquote(raw)))
  if (!cleaned) return ''
  if (/[$`]|%[A-Za-z_]\w*%/.test(cleaned)) {
    const substituted = substituteVariables(cleaned, base, vars)
    if (substituted === null) return undefined
    cleaned = expandHome(substituted)
  }
  if (isAbsolutePath(cleaned)) return resolveTarget(cleaned, base ?? '')
  return base === null ? null : resolveTarget(cleaned, base)
}

function nestedScript(segment, cmd) {
  const encoded = encodedPowerShell(cmd)
  if (encoded) return encoded
  const wrapped = shellBody(segment)
  return wrapped ? unwrapShellBody(wrapped) : ''
}

export function shellWrites(command, cwd, depth = 0, scope) {
  const out = []
  let base = scope ? scope.base : canonicalRoot(String(cwd || process.cwd()))
  const vars = scope?.vars ?? new Map()
  for (const part of splitSegments(String(command ?? '').replace(/>\|/g, '>'))) {
    const segment = part.text.replace(/^\s*[({]+/, '')
    rememberVariables(segment, vars)
    const cmd = commandOf(segment)
    for (const raw of segmentWriteTargets(segment, cmd)) out.push({ raw, target: resolveFrom(raw, base, vars) })
    const inner = depth < MAX_SHELL_DEPTH ? nestedScript(segment, cmd) : ''
    if (inner) out.push(...shellWrites(inner, cwd, depth + 1, { base, vars: new Map(vars) }))
    if (depth < MAX_SHELL_DEPTH) {
      for (const sub of substitutions(withoutHeredocBodies(part.text, true))) out.push(...shellWrites(sub, cwd, depth + 1, { base, vars: new Map(vars) }))
    }
    if (LOCATION_COMMANDS.has(cmd.head)) base = nextLocation(cmd, base)
  }
  return out
}

export function shellLocationAfter(command, base) {
  let current = base
  for (const part of splitSegments(String(command ?? ''))) {
    const cmd = commandOf(part.text)
    if (LOCATION_COMMANDS.has(cmd.head)) current = nextLocation(cmd, current)
  }
  return current
}

function writeTargets(toolName, input, cwd, base) {
  const name = String(toolName ?? '')
  if (FILE_TOOLS.has(name)) {
    const raw = fileToolPath(input?.path ?? input?.file_path ?? input?.filePath)
    return typeof raw === 'string' && raw.trim() ? [{ raw, target: resolveTarget(raw, cwd) }] : []
  }
  if (name === 'bash' || name === 'powershell') return shellWrites(String(input?.command ?? ''), cwd, 0, base === undefined ? undefined : { base, vars: new Map() })
  return []
}

export function outsideWrites(toolName, input, cwd, prefs = {}) {
  if (!prefs.outsideWrites) return []
  const roots = allowedRoots(cwd || process.cwd(), prefs)
  const hits = []
  for (const { raw, target } of writeTargets(toolName, input, cwd, prefs.base)) {
    if (/^(?:\/dev\/(?:null|stdout|stderr)|nul|\$null|&\d|-)$/i.test(String(raw).trim())) continue
    if (target === null) hits.push(`${shownTarget(raw)}${UNKNOWN_BASE_NOTE}`)
    else if (target === undefined) hits.push(`${shownTarget(raw)}${UNKNOWN_VARIABLE_NOTE}`)
    else if (target && !isInside(target, roots)) hits.push(target)
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

export function inputDigest(input) {
  return createHash('sha256').update(JSON.stringify(input ?? {})).digest('hex')
}

function changeText(input) {
  if (typeof input?.content === 'string') return input.content
  const pair = (edit) => `- ${String(edit?.oldText ?? edit?.old_string ?? '')}\n+ ${String(edit?.newText ?? edit?.new_string ?? '')}`
  if (Array.isArray(input?.edits)) return input.edits.map(pair).join('\n\n')
  if (['oldText', 'newText', 'old_string', 'new_string'].some((key) => typeof input?.[key] === 'string')) return pair(input)
  if (typeof input?.patch === 'string') return input.patch
  if (typeof input?.input === 'string') return input.input
  const { path: _path, file_path: _filePath, filePath: _camelPath, ...rest } = input ?? {}
  return JSON.stringify(rest)
}

export function approvalDetail(toolName, input) {
  const name = String(toolName ?? '')
  if (name === 'bash' || name === 'powershell') return String(input?.command ?? '')
  if (FILE_TOOLS.has(name)) {
    const path = String(input?.path ?? input?.file_path ?? input?.filePath ?? '')
    const change = changeText(input)
    const shown = change.length > CHANGE_PREVIEW_MAX ? `${change.slice(0, CHANGE_PREVIEW_MAX)}\n${CHANGE_CLIPPED(change.length - CHANGE_PREVIEW_MAX)}` : change
    return `${path}\n\n${shown}\n\n${CHANGE_DIGEST(change.length, inputDigest(input))}`
  }
  if (typeof input?.prompt === 'string' || name.startsWith('mcp__')) return JSON.stringify(input ?? {})
  return String(input?.path ?? input?.file_path ?? input?.filePath ?? '') ||
    (typeof input?.code === 'string' ? input.code : JSON.stringify(input ?? {}))
}

async function askHost(toolName, input, reasons, outsideDirs = [], toolCallId = '') {
  const url = process.env.YAN_CLI_URL
  const token = process.env.YAN_CLI_TOKEN
  const sessionId = process.env.YAN_SESSION_ID
  const projectId = process.env.YAN_PROJECT_ID
  if (!url || !token || !sessionId || !projectId) return { allowed: false, why: 'The approval channel is unavailable' }
  const detail = approvalDetail(toolName, input)
  if (detail.length > APPROVAL_DETAIL_MAX) return { allowed: false, why: `The approval detail is ${detail.length} characters, over the ${APPROVAL_DETAIL_MAX} limit, so it cannot be shown to the user in full. Shorten it or split the work` }
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
    if (feedback) return { allowed: false, why: `The user declined this operation and said: ${feedback}. Honour the refusal: do not retry this operation and do not reach the same result through another tool or route; tell the user what you would need, or ask which alternative they want` }
    const reason = typeof payload?.summary?.reason === 'string' ? payload.summary.reason.trim() : ''
    if (reason) return { allowed: false, why: reason }
    return { allowed: false, why: payload?.summary?.decision === 'no-answer' ? 'No answer from the user' : 'The user declined this operation' }
  } catch (err) {
    return { allowed: false, why: `Could not get the user's confirmation (${String(err?.message ?? err).slice(0, 80)})` }
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
    if (delegation.length && JSON.stringify(event?.input ?? {}).length > 20000) return { block: true, reason: 'The Claude Code delegation is too long to show in full for approval. Shorten the task, or use an Inkstone subagent.' }
    const mcpReasons = name.startsWith('mcp__') ? mcpCallDanger(name, toolAnnotations(pi, name)) : []
    const outside = outsideWrites(name, event?.input ?? {}, ctx?.cwd, prefs)
    const reasons = [
      ...detectDanger(name, event?.input ?? {}, ctx?.cwd),
      ...delegation,
      ...mcpReasons,
      ...outside.map((target) => `写入项目之外的路径：${target}`)
    ]
    if (reasons.length === 0) return undefined
    const approvedDigest = inputDigest(event?.input ?? {})
    const answer = await askHost(name, event?.input ?? {}, [...new Set(reasons)], outside, typeof event?.toolCallId === 'string' ? event.toolCallId : '')
    if (answer.allowed) {
      if (inputDigest(event?.input ?? {}) === approvedDigest) return undefined
      return { block: true, reason: CHANGED_AFTER_APPROVAL }
    }
    return { block: true, reason: `High-risk operation not confirmed by the user: ${reasons.join('; ')}. ${answer.why}. Do not retry it and do not work around the refusal by another route; tell the user why this one is needed, or ask which alternative they want.` }
  })
}
