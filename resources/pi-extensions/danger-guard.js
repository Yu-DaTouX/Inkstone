import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, posix } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { isHostAutomatedMessage } from './host-message.js'
import { REVIEW_STREAK_LIMIT, REVIEW_STOP_NOTE, parentUserMessages, reviewDeniedReason, reviewFailedReason, reviewPrompt, reviewTranscript, runReview } from './danger-review.js'

const CONFIRM_TIMEOUT_MS = 35 * 60 * 1000
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

function heredocDelimiter(text, at) {
  const match = /^<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(text.slice(at))
  return match ? { tag: match[2], length: match[0].length, quoted: match[1] !== '' } : null
}

function endsWindowsPath(current, next) {
  if (!/[;&|]/.test(next ?? '')) return false
  const word = (/\S*$/.exec(current)?.[0] ?? '').replace(/^["']/, '')
  return /^[a-z]:/i.test(word) || word.includes('\\')
}

function dialectOf(head) {
  if (head === 'powershell' || head === 'pwsh') return 'powershell'
  return head === 'cmd' ? 'cmd' : 'posix'
}

function toolDialect(toolName) {
  return String(toolName ?? '') === 'powershell' ? 'powershell' : 'posix'
}

export function splitSegments(command, dialect = 'posix') {
  const text = String(command ?? '')
  const escapes = dialect === 'posix'
  const parts = []
  let current = ''
  let quote = null
  let heredoc = null
  const flush = (sep) => { parts.push({ text: current, sep }); current = '' }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      current += ch
      if (escapes && ch === '\\' && quote === '"' && i + 1 < text.length) current += text[++i]
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
    if (escapes && ch === '\\' && i + 1 < text.length && !endsWindowsPath(current, text[i + 1])) { current += ch + text[++i]; continue }
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

function deleteRoots(cwd) {
  return [cwd || process.cwd(), tmpdir(), '/tmp', '/var/tmp'].map((p) => physicalPath(normalizePath(p)).replace(/\/$/, ''))
}

function deletesOutsideProject(raw, cwd, base = cwd) {
  if (base === null && !isAbsolutePath(expandHome(expandEnv(unquote(raw))))) return true
  const target = resolveTarget(raw, base ?? cwd)
  if (!target) return false
  return !isInside(target, deleteRoots(cwd))
}

function deletesInsideAllowedFolder(raw, cwd, base = cwd) {
  if (base === null && !isAbsolutePath(expandHome(expandEnv(unquote(raw))))) return false
  const target = resolveTarget(raw, base ?? cwd)
  if (!target) return false
  return deleteRoots(cwd).some((root) => /^(?:[a-z]:)?\/[^/]/.test(root) && target.replace(/\/+$/, '').startsWith(root + '/'))
}

const PS_RECURSE = /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?::\$?true)?$/i

function isRecursiveDelete({ head, args }) {
  if (head === 'rm') return args.some((a) => /^-[a-z]*r[a-z]*$/i.test(a) || a === '--recursive' || /^-recurse$/i.test(a))
  if (['rmdir', 'rd', 'del', 'erase'].includes(head)) return args.some((a) => /^\/s$/i.test(a) || PS_RECURSE.test(a))
  if (['remove-item', 'ri'].includes(head)) return args.some((a) => PS_RECURSE.test(a))
  return false
}

function driveRootTarget(raw) {
  const text = unquote(raw)
  return /^[a-z]:[\\/]?$/i.test(text) ? `${text.slice(0, 2)}/` : raw
}

const PS_PATH_COLON = /^-(?:path|literalpath|lp|pspath):(.+)$/i

function recursiveDeleteArgs(cmd) {
  const cmdFlag = cmd.head === 'rm' ? /^-/ : /^(-|\/[a-z]$)/i
  return cmd.args.flatMap((a) => {
    const colon = PS_PATH_COLON.exec(a)
    if (colon) return [colon[1]]
    return !cmdFlag.test(a) && !/^-{1,2}\w/.test(a) ? [a] : []
  }).map(driveRootTarget)
}

function riskyDeleteTarget(targets, cwd, base, filtered = false) {
  return targets.find((target) => (!filtered && isBroadTarget(target) && !deletesInsideAllowedFolder(target, cwd, base)) || deletesOutsideProject(target, cwd, base)) ?? null
}

function recursiveDeleteTarget(cmd, cwd, base = cwd) {
  if (!isRecursiveDelete(cmd)) return null
  return riskyDeleteTarget(recursiveDeleteArgs(cmd), cwd, base)
}

const LISTING_CHILDREN = new Set(['get-childitem', 'gci', 'ls', 'dir'])
const LISTING_SELF = new Set(['get-item', 'gi'])
const LISTING_FILTERS = new Set(['-filter', '-include', '-exclude'])
const LISTING_PATHS = new Set(['-path', '-literalpath', '-lp'])
const LISTING_VALUED = new Set(['-depth', '-attributes', '-stream', '-credential'])

function pipedSegments(command) {
  const pieces = String(command).split(/(&&|\|\||[;&|\n])/)
  const out = []
  for (let i = 0; i < pieces.length; i += 2) out.push({ text: pieces[i], upstream: pieces[i - 1] === '|' ? pieces[i - 2] : null })
  return out
}

function listingTargets(text) {
  const { head, args } = deleteCommand(text)
  const children = LISTING_CHILDREN.has(head)
  if (!children && !LISTING_SELF.has(head)) return null
  const targets = []
  let filtered = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const colon = /^(-[a-z]+):(.*)$/i.exec(arg)
    const name = (colon ? colon[1] : arg).toLowerCase()
    if (LISTING_FILTERS.has(name)) { filtered = true; if (!colon) i += 1; continue }
    if (LISTING_PATHS.has(name)) {
      const value = colon ? colon[2] : args[++i]
      if (value !== undefined) targets.push(...value.split(',').filter(Boolean))
      continue
    }
    if (LISTING_VALUED.has(name)) { if (!colon) i += 1; continue }
    if (/^\d?[<>]/.test(arg) || /^-/.test(arg)) continue
    targets.push(...arg.split(',').filter(Boolean))
  }
  const list = targets.length ? targets : ['.']
  return { targets: list, children, filtered: filtered || list.some((target) => /[*?]/.test(target)) }
}

function pipedDeleteReason(cmd, upstream, cwd, base) {
  if (upstream === null || cmd.stdinArgs || !DELETE_HEADS.has(cmd.head) || !isRecursiveDelete(cmd) || recursiveDeleteArgs(cmd).length) return null
  const listing = listingTargets(upstream)
  if (!listing) return '递归删除的目标来自管道输入，砚无法判断范围'
  const hit = riskyDeleteTarget(listing.targets.map(driveRootTarget), cwd, base, listing.filtered)
  if (!hit) return null
  return isBroadTarget(hit) ? `递归删除大范围目录：${hit}` : `递归删除项目之外的目录：${hit}`
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

const NETWORK_EXEC = '把网络内容直接交给 shell 执行'
const GIT_PREFIX = String.raw`\bgit(?:\.exe|\.cmd)?["']?\s+(?:(?:-C|-c|--git-dir|--work-tree|--namespace)(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)\s+|-\S+\s+)*`
const gitRule = (rest) => new RegExp(GIT_PREFIX + rest, 'i')

const COMMAND_RULES = [
  { re: gitRule(String.raw`push\b[^;&|\n]*\s(?:--force\b|-[a-z]*f[a-z]*\b|--mirror\b|["']?\+[^\s"']+)`), label: 'Git 强制推送，会覆盖远端历史' },
  { re: gitRule(String.raw`push\b[^;&|\n]*\s(?:--delete\b|-[a-z]*d[a-z]*\b|--prune\b|["']?:[^\s"']+)`), label: 'Git 删除远端分支或标签' },
  { re: gitRule(String.raw`reset\b[^;&|\n]*--hard\b`), label: 'git reset --hard，会丢弃未提交的改动' },
  { re: gitRule(String.raw`clean\b[^;&|\n]*\s(?:-[a-z]*f|--force\b)`), label: 'git clean -f，会永久删除未跟踪的文件' },
  { re: gitRule(String.raw`checkout\b[^;&|\n]*(?:\s--\s+\.|\s\.)(?:\s|$)`), label: '还原整个工作区，会丢弃未提交的改动' },
  { re: gitRule(String.raw`restore\b(?:(?![^;&|\n]*\s(?:--staged|-S)\b)|(?=[^;&|\n]*\s(?:--worktree|-W)\b))[^;&|\n]*(?:\s--\s+\.|\s\.)(?:\s|$)`), label: '还原整个工作区，会丢弃未提交的改动' },
  { re: gitRule(String.raw`stash\s+(?:clear|drop)\b`), label: '删除 Git stash 里暂存的改动' },
  { re: /\b(?:drop\s+(?:database|schema|table)|truncate\s+table)\b/i, label: '删除数据库或数据表' },
  { re: /\b(?:mkfs(?:\.\w+)?|diskpart|fdisk|shred|format-volume|clear-disk|initialize-disk|remove-partition)\b|\bdd\s+[^;&|\n]*\bof=\/dev\/|\bformat\s+[a-z]:/i, label: '格式化或直接写磁盘' },
  { re: /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(?:sudo\s+)?(?:\S*[\\/])?(?:sh|bash|zsh|iex|invoke-expression|powershell|pwsh)\b/i, label: NETWORK_EXEC },
  { re: /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]*\|\s*(?:sudo\s+)?(?:\S*[\\/])?(?:python[\d.]*|node|perl|ruby|php)(?:\.exe)?(?:\s+-)?\s*(?:$|[;&|)\n])/i, label: NETWORK_EXEC },
  { re: /(?:\b(?:iex|invoke-expression)\b|\[scriptblock\]::create\b)[^\n]*(?:\b(?:iwr|irm|curl|wget|invoke-webrequest|invoke-restmethod)\b|\.download(?:string|data)\b|net\.webclient\b)/i, label: NETWORK_EXEC },
  { re: /(?:\b(?:sh|bash|zsh|dash|ksh|source)|(?:^|[\s;&|(])\.)\s+(?:-\S+\s+)*<\(\s*(?:sudo\s+)?(?:curl|wget)\b/i, label: NETWORK_EXEC },
  { re: /\b(?:sh|bash|zsh|dash|ksh)(?:\.exe)?\s+(?:-\S+\s+)*-[a-z]*c\s+["']?(?:\$\(|`)\s*(?:sudo\s+)?(?:curl|wget)\b/i, label: NETWORK_EXEC },
  { re: /\beval\s+["']?(?:\$\(|`)\s*(?:curl|wget)\b/i, label: NETWORK_EXEC },
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
  const text = msysDrivePath(String(p ?? '').replace(/\\/g, '/').toLowerCase().replace(/^\/{2,}[?.]\/+unc\//, '//').replace(/^\/{2,}[?.]\/+/, ''))
  const match = /^([a-z]:)?(.*)$/.exec(text)
  const drive = match?.[1] ?? ''
  const rest = match?.[2] ?? ''
  return drive + (rest ? posix.normalize(rest) : '')
}

function windowsAliases(p) {
  if (process.platform !== 'win32') return [p]
  const trimmed = p.split('/').map((s) => (/[^. ]/.test(s) ? s.replace(/[. ]+$/, '') : s)).join('/')
  return trimmed === p ? [p] : [p, trimmed]
}

function sensitiveOutside(normalized, cwd) {
  const root = canonicalRoot(cwd || process.cwd())
  if (normalized === root || normalized.startsWith(`${root}/`)) return false
  const home = normalizePath(homedir()).replace(/\/$/, '')
  return windowsAliases(normalized).some((p) => SENSITIVE_PATH.test(p) || (p.startsWith(`${home}/`) && SENSITIVE_PATH.test(p.slice(home.length))))
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

function scanCommand(command, reasons, depth = 0, cwd = '', base = cwd, dialect = 'posix') {
  if (depth < MAX_SHELL_DEPTH) {
    for (const inner of substitutions(command)) scanCommand(inner, reasons, depth + 1, cwd, base, dialect)
  }
  for (const { text: segment, upstream } of pipedSegments(command)) {
    const cmd = commandOf(segment)
    const hit = recursiveDeleteTarget(cmd, cwd, base)
    if (hit) reasons.push(isBroadTarget(hit) ? `递归删除大范围目录：${hit}` : `递归删除项目之外的目录：${hit}`)
    if (cmd.stdinArgs && isRecursiveDelete(cmd)) reasons.push('递归删除的目标来自管道输入，砚无法判断范围')
    const piped = pipedDeleteReason(cmd, upstream, cwd, base)
    if (piped) reasons.push(piped)
    if (POWER_COMMANDS.has(cmd.head)) reasons.push('关机或重启')
    const encoded = encodedPowerShell(cmd)
    if (encoded === '') reasons.push('PowerShell 编码命令无法解读，砚无法检查其中的操作')
    else if (encoded !== null) {
      const inner = []
      if (depth < MAX_SHELL_DEPTH) scanCommand(encoded, inner, depth + 1, cwd, base, 'powershell')
      else inner.push('命令嵌套层数过多，砚无法检查最内层的操作')
      if (inner.length) reasons.push(...inner, `PowerShell 编码命令，解码后为：${encoded.slice(0, 300)}`)
    }
    const wrapped = shellBody(segment)
    if (wrapped && depth < MAX_SHELL_DEPTH) scanCommand(unwrapShellBody(wrapped), reasons, depth + 1, cwd, base, dialectOf(cmd.head))
    else if (wrapped) reasons.push('命令嵌套层数过多，砚无法检查最内层的操作')
  }
  const ruleSource = ruleText(command, dialect)
  for (const rule of COMMAND_RULES) if (rule.re.test(ruleSource)) reasons.push(rule.label)
}

const DELETE_HEADS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri'])
const SHALLOW_SAFE_DELETES = new Set(['rm', 'rmdir', 'rd'])
const PS_DELETE_PATH = new Set(['-path', '-literalpath', '-lp', '-pspath'])
const PS_DELETE_VALUED = new Set(['-include', '-exclude', '-filter', '-credential', '-stream'])
const COMMON_TOP_DIRS = new Set(['bin', 'boot', 'data', 'dev', 'etc', 'home', 'lib', 'media', 'mnt', 'opt', 'proc', 'program files', 'program files (x86)', 'programdata', 'root', 'run', 'sbin', 'srv', 'sys', 'tmp', 'users', 'usr', 'var', 'volumes', 'windows'])
const DISK_WIPE = /\b(?:mkfs(?:\.\w+)?|diskpart|format-volume|clear-disk|initialize-disk|remove-partition)\b|\bdd\s+[^;&|\n]*\bof=\/dev\/|\bformat(?:\.com)?\s+[a-z]:/i
const TARGET_TOKEN = /\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`|\$\{([^}]*)\}|\$env:([A-Za-z_]\w*)|\$([A-Za-z_]\w*|\d|[@*?#])|%([A-Za-z_]\w*)%/gi
const DIRECTORY_PRINTERS = /^\s*(?:pwd|git\s+rev-parse\s+--show-toplevel|get-location|\(get-location\)\.path)\s*$/i
const CRITICAL_TOO_DEEP = '命令嵌套层数过多，无法排除删除关键位置'
const BASE_VALUE = Symbol('base')

function shellWords(segment) {
  const words = []
  let word = ''
  let quote = null
  let has = false
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (quote) {
      word += ch
      if (ch === '\\' && quote === '"' && i + 1 < segment.length) { word += segment[++i]; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; word += ch; has = true; continue }
    if (/\s/.test(ch)) {
      if (has) words.push(word)
      word = ''
      has = false
      continue
    }
    word += ch
    has = true
  }
  if (has) words.push(word)
  return words
}

function deleteCommand(segment) {
  const parts = shellWords(stripGrouping(segment))
  const { start, stdinArgs } = commandStart(parts)
  return { head: bareName(parts[start]), args: parts.slice(start + 1), stdinArgs }
}

function deleteTargets({ head, args }) {
  const plain = args.filter((arg) => !/^\d?[<>]/.test(arg))
  if (head === 'remove-item' || head === 'ri') {
    const out = []
    for (let i = 0; i < plain.length; i++) {
      const lower = plain[i].toLowerCase()
      const colon = PS_PATH_COLON.exec(plain[i])
      if (colon) { out.push(colon[1]); continue }
      if (PS_DELETE_PATH.has(lower)) { if (plain[i + 1] !== undefined) out.push(plain[++i]); continue }
      if (PS_DELETE_VALUED.has(lower)) { i += 1; continue }
      if (/^-/.test(plain[i])) continue
      out.push(...plain[i].split(',').filter(Boolean))
    }
    return out
  }
  const flag = head === 'rm' ? /^-/ : /^(?:-|\/[a-z]$)/i
  let rest = false
  return plain.flatMap((arg) => {
    if (arg === '--') { rest = true; return [] }
    if (rest) return [arg]
    const colon = PS_PATH_COLON.exec(arg)
    if (colon) return [colon[1]]
    return flag.test(arg) ? [] : [arg]
  })
}

function assignedVariables(command) {
  const vars = new Map()
  const text = String(command ?? '')
  for (const match of text.matchAll(/(?:^|[\s;&|(])\$?([A-Za-z_]\w*)\s*=\s*["']?(\$\(([^()]*)\)|`([^`]*)`|\$\{?pwd\}?\b|\(get-location\)(?:\.path)?)/gi)) {
    const body = match[3] ?? match[4]
    if (body === undefined || DIRECTORY_PRINTERS.test(body)) vars.set(match[1].toLowerCase(), BASE_VALUE)
  }
  for (const match of text.matchAll(/(?:^|[\s;&|(])\$?([A-Za-z_]\w*)\s*=\s*(?:"([^"$`]*)"|'([^']*)'|([^\s;&|$`'"()]+))/g)) {
    const name = match[1].toLowerCase()
    if (!vars.has(name)) vars.set(name, match[2] ?? match[3] ?? match[4] ?? '')
  }
  return vars
}

function variableText(name, base, vars) {
  const lower = String(name).toLowerCase()
  if (lower === 'pwd') return base ?? undefined
  if (vars.has(lower)) {
    const value = vars.get(lower)
    return value === BASE_VALUE ? base ?? undefined : value
  }
  if (lower === 'home' || lower === 'userprofile') return homedir()
  if (/^\d$|^[@*?#]$/.test(lower)) return undefined
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === lower)
  return key ? process.env[key] : undefined
}

function expandTarget(raw, base, vars) {
  const unquoted = String(raw ?? '').replace(/["']/g, '')
  if (/^\\+$/.test(unquoted)) return { path: '/', unknown: false }
  const text = unquoted.replace(/^~(?=[\\/]|$)/, homedir())
  let unknown = false
  let subst = false
  let tail = null
  const path = text.replace(TARGET_TOKEN, (match, braced, psName, plain, cmdName, offset) => {
    let value
    if (match.startsWith('$(') || match.startsWith('`')) {
      const body = match.startsWith('`') ? match.slice(1, -1) : match.slice(2, -1)
      value = DIRECTORY_PRINTERS.test(body) ? base ?? undefined : undefined
      if (value === undefined) subst = true
    } else if (braced !== undefined) {
      const parts = /^([A-Za-z_]\w*|\d|[@*])(:?[?+\-=])?(.*)$/.exec(braced)
      value = variableText(parts?.[1] ?? braced, base, vars)
      if (value === undefined && parts?.[2]?.includes('?')) value = 'guarded'
      else if (value === undefined && parts?.[2] && /[-=]/.test(parts[2]) && parts[3]) value = parts[3]
    } else {
      value = variableText(psName ?? plain ?? cmdName, base, vars)
    }
    if (value !== undefined) return String(value)
    if (!unknown) {
      const before = text.slice(0, offset)
      const after = text.slice(offset + match.length).replace(TARGET_TOKEN, '')
      tail = /(?:[\\/]|^[a-z]:)$/i.test(before) && /^[\\/]*\*?$/.test(after) ? before : null
    }
    unknown = true
    return ''
  })
  return { path, unknown, subst, tail, onlySubst: subst && !text.replace(TARGET_TOKEN, '').trim() }
}

function normalizeCritical(raw) {
  let text = String(raw ?? '').replace(/\\/g, '/').trim()
  if (/^\/{2,}[?.]\/+volume\{/i.test(text)) return { volume: true }
  text = text.replace(/^\/\/(?:localhost|127\.0\.0\.1|\.)\/([a-z])\$(?=\/|$)/i, '$1:')
  text = normalizePath(text)
  if (/^[a-z]:$/.test(text)) text += '/'
  return { path: text }
}

function splitGlob(path) {
  const segments = path.split('/')
  const at = segments.findIndex((segment) => /[*?[]/.test(segment))
  if (at < 0) return { folder: path, glob: false }
  const folder = segments.slice(0, at).join('/')
  return { folder: folder || (path.startsWith('/') ? '/' : '.'), glob: true }
}

function absoluteFrom(folder, base) {
  if (isAbsolutePath(folder)) return folder
  if (base === null || base === undefined) return null
  return `${String(base).replace(/\\/g, '/').replace(/\/+$/, '')}/${folder}`
}

function comparable(path) {
  const normalized = normalizePath(path)
  const physical = physicalPath(normalized)
  return [...new Set([normalized, physical].flatMap(windowsAliases).map((p) => (p.length > 1 && !/^[a-z]:\/$/.test(p) ? p.replace(/\/+$/, '') : p)))]
}

function ancestorOrEqual(parent, child) {
  if (!parent || !child) return false
  if (parent === child) return true
  const prefix = parent.endsWith('/') ? parent : `${parent}/`
  return child.startsWith(prefix)
}

function isRootPath(path) {
  return path === '/' || path === '' || /^[a-z]:\/?$/.test(path)
}

function topLevelName(path) {
  const match = /^(?:[a-z]:)?\/([^/]+)$/.exec(path)
  return match ? match[1] : null
}

function criticalKind(abs, cwd, restricted, shallow) {
  const forms = comparable(abs)
  if (forms.some(isRootPath)) return '盘根或文件系统根'
  const top = shallow ? null : forms.map(topLevelName).find(Boolean)
  if (restricted) return top && COMMON_TOP_DIRS.has(top) ? '顶层目录' : null
  if (top) return '顶层目录'
  if (forms.some((p) => /^[a-z]:\/users\/[^/]*~\d+$/.test(p))) return '用户目录'
  const homes = comparable(homedir())
  if (forms.some((p) => homes.some((home) => ancestorOrEqual(p, home)))) return '用户目录'
  const cwds = cwd ? comparable(cwd) : []
  if (forms.some((p) => cwds.some((dir) => ancestorOrEqual(p, dir)))) return '工作目录或其上级'
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
  const dataDir = process.env.YAN_DATA_DIR?.trim() || join(agentDir, 'yan')
  const data = [agentDir, dataDir].flatMap(comparable)
  if (forms.some((p) => data.some((dir) => ancestorOrEqual(p, dir)))) return '砚与 pi 的数据目录'
  return null
}

function criticalTarget(raw, { base, cwd, vars, recursive, head }) {
  const shown = shownTarget(String(raw).replace(/["']/g, '')) || String(raw)
  const expanded = expandTarget(raw, base, vars)
  if (expanded.onlySubst) return recursive ? `删除的目标只来自命令替换，无法检查：${shown}` : null
  const checks = []
  if (expanded.unknown && expanded.tail) checks.push({ text: expanded.tail, restricted: false, glob: true })
  checks.push({ text: expanded.path, restricted: expanded.unknown, glob: false })
  for (const check of checks) {
    if (!check.text.trim()) continue
    const normalized = normalizeCritical(check.text)
    if (normalized.volume) return `删除用卷 GUID 表示的路径，无法确定在哪个盘：${shown}`
    const { folder, glob } = splitGlob(normalized.path)
    const shallow = !recursive && !glob && !check.glob
    if (shallow && SHALLOW_SAFE_DELETES.has(head)) continue
    const abs = absoluteFrom(folder, base)
    if (abs === null) {
      if (!shallow && (folder === '.' || folder === '')) return `切换目录后清空当前目录，无法确定位置：${shown}`
      continue
    }
    const kind = criticalKind(abs, cwd, check.restricted, shallow)
    if (kind) return `删除关键位置（${kind}）：${shown}`
  }
  return null
}

function pipedCriticalTargets(cmd, targets, upstream, recursive) {
  if (upstream === null || cmd.stdinArgs || !recursive || targets.length) return []
  const listing = listingTargets(upstream)
  if (!listing || listing.filtered) return []
  return listing.targets.map((target) => (listing.children ? `${target.replace(/[\\/]+$/, '')}/*` : target))
}

function scanCritical(command, reasons, depth, cwd, start, dialect = 'posix') {
  if (depth < MAX_SHELL_DEPTH) {
    for (const inner of substitutions(command)) scanCritical(inner, reasons, depth + 1, cwd, start, dialect)
  }
  const vars = assignedVariables(command)
  let base = start
  for (const { text: segment, upstream } of pipedSegments(command)) {
    const cmd = deleteCommand(segment)
    if (DELETE_HEADS.has(cmd.head)) {
      const recursive = isRecursiveDelete(cmd)
      const targets = deleteTargets(cmd)
      for (const raw of [...targets, ...pipedCriticalTargets(cmd, targets, upstream, recursive)]) {
        const hit = criticalTarget(raw, { base, cwd, vars, recursive, head: cmd.head })
        if (hit) reasons.push(hit)
      }
      if (cmd.stdinArgs && recursive) reasons.push('递归删除的目标来自管道输入，无法排除删到关键位置')
    }
    const plain = commandOf(segment)
    const encoded = encodedPowerShell(plain)
    if (encoded === '') reasons.push('PowerShell 编码命令无法解读，无法排除删除关键位置')
    else if (encoded !== null) {
      if (depth < MAX_SHELL_DEPTH) scanCritical(encoded, reasons, depth + 1, cwd, base, 'powershell')
      else reasons.push(CRITICAL_TOO_DEEP)
    }
    const wrapped = shellBody(segment)
    if (wrapped && depth < MAX_SHELL_DEPTH) scanCritical(unwrapShellBody(wrapped), reasons, depth + 1, cwd, base, dialectOf(plain.head))
    else if (wrapped) reasons.push(CRITICAL_TOO_DEEP)
    if (LOCATION_COMMANDS.has(plain.head)) base = nextLocation(plain, base)
  }
  if (DISK_WIPE.test(ruleText(command, dialect))) reasons.push('格式化或擦除磁盘')
}

const CREDENTIAL_REASON = '访问 pi 与砚保存的模型凭据：'

export function credentialAccess(toolName, input, cwd) {
  const name = String(toolName ?? '')
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
  const dir = canonicalRoot(agentDir)
  const file = canonicalRoot(join(agentDir, 'auth.json'))
  if (name === 'bash' || name === 'powershell') {
    const command = String(input?.command ?? '')
    if (hostScansTerminalInput(command)) return []
    const text = command.replace(/\\+/g, '/').replace(/\/{2,}/g, '/').toLowerCase()
    if (!/(?:^|[^\w.-])auth\.json(?![\w.-])/.test(text)) return []
    const near = text.includes('.pi/agent') || text.includes(dir) || isInside(canonicalRoot(cwd || process.cwd()), [dir])
    return near ? [`${CREDENTIAL_REASON}${file}`] : []
  }
  if (name !== 'read') return []
  const raw = fileToolPath(input?.path ?? input?.file_path ?? input?.filePath)
  return typeof raw === 'string' && raw.trim() && windowsAliases(resolveTarget(raw, cwd)).includes(file) ? [`${CREDENTIAL_REASON}${file}`] : []
}

const VAULT_REASON = '读取砚保存的账号与 Key（或它们的明文备份）：'
const VAULT_NAMES = '(?:api-keys|codex-accounts|image-config|oauth-accounts|relay-bridge|search-config)\\.json'
const VAULT_FILE = new RegExp(`^${VAULT_NAMES}(?:\\.plaintext-[^/]*\\.bak)?$`)
const VAULT_IN_COMMAND = new RegExp(`(?:^|[^\\w.-])(${VAULT_NAMES})(?:\\.plaintext-[^\\s'"\`;|&)<>]*)?(?![\\w.-])`)

export function vaultCredentialAccess(toolName, input, cwd) {
  const name = String(toolName ?? '')
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
  const dataDir = process.env.YAN_DATA_DIR?.trim() || join(agentDir, 'yan')
  const dir = canonicalRoot(dataDir)
  if (name === 'bash' || name === 'powershell') {
    const command = String(input?.command ?? '')
    if (hostScansTerminalInput(command)) return []
    const text = command.replace(/\\+/g, '/').replace(/\/{2,}/g, '/').toLowerCase()
    const hit = VAULT_IN_COMMAND.exec(text)
    if (!hit) return []
    const near = text.includes('.pi/agent') || text.includes(dir) || text.includes('yan_data_dir') || isInside(canonicalRoot(cwd || process.cwd()), [dir, canonicalRoot(agentDir)])
    return near ? [`${VAULT_REASON}${dir}/${hit[1]}`] : []
  }
  if (name !== 'read') return []
  const raw = fileToolPath(input?.path ?? input?.file_path ?? input?.filePath)
  if (typeof raw !== 'string' || !raw.trim()) return []
  const target = windowsAliases(resolveTarget(raw, cwd)).find((p) => {
    const slash = p.lastIndexOf('/')
    return slash > 0 && p.slice(0, slash) === dir && VAULT_FILE.test(p.slice(slash + 1))
  })
  return target ? [`${VAULT_REASON}${target}`] : []
}

export function criticalDanger(toolName, input, cwd, options = {}) {
  const name = String(toolName ?? '')
  const secrets = credentialAccess(name, input, cwd)
  if (name !== 'bash' && name !== 'powershell') return secrets
  const command = String(input?.command ?? '')
  if (!command.trim() || hostScansTerminalInput(command)) return []
  const root = cwd || process.cwd()
  const reasons = []
  scanCritical(command, reasons, 0, root, options.base === undefined ? canonicalRoot(root) : options.base, toolDialect(name))
  return [...new Set([...reasons, ...secrets])]
}

export function criticalBlockReason(reasons, why) {
  if (reasons.every((reason) => reason.startsWith(CREDENTIAL_REASON))) {
    return `Blocked: ${reasons.join('; ')}. This file holds the model credentials Inkstone and pi store. ${why}. Do not retry it and do not get at the credentials another way. If the user asked for this, tell them it needs their approval; otherwise carry on without it.`
  }
  return `Blocked: ${reasons.join('; ')}. This deletes a critical location (a drive root, a top-level folder, the home folder, the working folder or one of its parents, or Inkstone's data folder) or wipes a disk. ${why}. Do not retry it and do not reach the same result another way. If you meant something narrower, rewrite the command so it names the exact path to delete; otherwise stop and ask the user.`
}

const SEARCH_COMMANDS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'findstr', 'select-string', 'sls'])

const TEXT_PRINTERS = new Set(['echo', 'printf', 'write-output'])
const PLAIN_COMMANDS = new Set(['cd', 'pwd', 'ls', 'mkdir'])
const GIT_READ_ONLY = new Set(['status', 'diff', 'log', 'show', 'rev-parse'])
const GIT_REMOTE = new Set(['push', 'pull', 'fetch'])
const GIT_COMMIT_FLAGS = new Set(['-a', '--all', '--allow-empty', '--allow-empty-message', '--no-edit', '-q', '--quiet', '-s', '--signoff', '-n', '--no-verify'])
const YAN_GROUPS = new Set(['subagent', 'workflow', 'model'])
const YAN_TEXT_FLAGS = new Set(['--task', '--message', '--title'])
const RELAX_SEPS = new Set(['&&', '||', ';', '\n', ''])
const RELAX_KEYWORDS = /\.git\b|hooks|home=|git_|editor|visual|(?<!no-)pager/i
const POWERSHELL_UNSAFE = /[$@(){}[\]|`*?\u2018-\u201e]|\\["']/
const SAFE_SUBSTITUTION = /^pwd(?:\s+-W(?:\s+2>\/dev\/null\s+\|\|\s+pwd)?)?$/

function bare(word) {
  return String(word ?? '').replace(/["'\\]/g, '')
}

function quotedExpansions(body) {
  const kept = []
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\\') { i += 1; continue }
    if (ch === '`') {
      const end = body.indexOf('`', i + 1)
      if (end < 0 || !SAFE_SUBSTITUTION.test(body.slice(i + 1, end).trim())) return null
      kept.push(body.slice(i, end + 1))
      i = end
    } else if (ch === '$' && body[i + 1] === '(') {
      const end = closingParen(body, i + 1)
      if (end < 0 || !SAFE_SUBSTITUTION.test(body.slice(i + 2, end).trim())) return null
      kept.push(body.slice(i, end + 1))
      i = end
    } else if (ch === '$' && body[i + 1] === '{') {
      const name = /^\$\{[A-Za-z_]\w*\}/.exec(body.slice(i))
      if (!name) return null
      i += name[0].length - 1
    } else if (ch === '$' && body[i + 1] === '[') return null
  }
  return kept
}

function wholeQuote(inner, quote, dialect) {
  const escapes = quote === '"' && dialect === 'posix'
  for (let i = 0; i < inner.length; i++) {
    if (escapes && inner[i] === '\\') {
      if (++i >= inner.length) return false
      continue
    }
    if (inner[i] === quote) return false
  }
  return true
}

function blankValue(word, prefix, dialect, native) {
  const value = word.slice(prefix.length)
  const quote = value[0]
  if (value.length < 2 || (quote !== '"' && quote !== "'") || value.at(-1) !== quote) return word
  const inner = value.slice(1, -1)
  if (!wholeQuote(inner, quote, dialect) || (native && /["&|<>^%]/.test(inner))) return word
  if (quote === "'") return `${prefix}''`
  const kept = quotedExpansions(inner)
  return kept ? `${prefix}"${kept.join(' ')}"` : word
}

function unquotedSpecial(text, dialect) {
  const escapes = dialect === 'posix'
  let quote = null
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (escapes && ch === '\\' && quote === '"') i += 1
      else if (ch === quote) {
        if (escapes && quote === '"' && !quotedExpansions(text.slice(start, i))) return true
        quote = null
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
      start = i + 1
    } else if (escapes && ch === '\\') i += 1
    else if ('(){}$@`<>'.includes(ch)) return true
  }
  return quote !== null
}

function printerWords(words, head, blank) {
  const option = (word) => head !== 'printf' && (/^-[neE]+$/.test(word) || (word.length > 1 && '-noenumerate'.startsWith(word.toLowerCase())))
  if (words.slice(1).some((word) => /^-/.test(bare(word)) && !option(bare(word)))) return null
  return words.map((word, i) => (i > 0 ? blank(word) : word))
}

function yanWords(words, blank) {
  if (!YAN_GROUPS.has(bare(words[1]))) return null
  return words.map((word, i) => {
    const inline = /^--(?:task|message|title)=/.exec(word)
    if (inline) return blank(word, inline[0])
    return i > 2 && YAN_TEXT_FLAGS.has(bare(words[i - 1])) ? blank(word) : word
  })
}

function longPrefix(flag, ...names) {
  const name = /^--([a-z-]+)/i.exec(flag)?.[1]?.toLowerCase()
  return !!name && names.some((full) => full.startsWith(name))
}

function commitWords(words, at, blank, watched) {
  const out = words.slice(0, at + 1)
  let paths = false
  for (let i = at + 1; i < words.length; i++) {
    const raw = words[i]
    const flag = bare(raw)
    if (paths) watched.push(raw)
    if (paths || !/^-/.test(flag)) { out.push(raw); continue }
    if (flag === '--') { out.push(raw); paths = true; continue }
    const inline = /^(--message=|-[aqsn]*m)(?=["'])/.exec(raw)
    if (inline) { out.push(blank(raw, inline[1])); continue }
    if (flag === '--message' || /^-[aqsn]*m$/.test(flag)) {
      if (i + 1 >= words.length) return null
      out.push(raw, blank(words[++i]))
      continue
    }
    if (!GIT_COMMIT_FLAGS.has(flag) && !/^-[aqsn]+$/.test(flag)) return null
    out.push(raw)
  }
  return out
}

function gitWords(words, blank, watched) {
  let at = 1
  while (at < words.length && /^-/.test(bare(words[at]))) {
    const flag = bare(words[at])
    if (flag === '-C') {
      watched.push(words[at + 1] ?? '')
      at += 2
    } else if (flag === '--no-pager' || flag === '-P') at += 1
    else return null
  }
  if (at >= words.length) return null
  const sub = bare(words[at])
  const rest = words.slice(at + 1).map(bare)
  if (sub === 'branch') return rest.length === 1 && rest[0] === '--show-current' ? words : null
  if (GIT_REMOTE.has(sub)) return rest.some((word) => /^-/.test(word)) ? null : words
  if (GIT_READ_ONLY.has(sub)) return rest.some((flag) => /^-O/.test(flag) || longPrefix(flag, 'output', 'ext-diff', 'textconv', 'open-files-in-pager')) ? null : words
  if (sub === 'add') return rest.some((flag) => /^-[a-z]*[pie]/i.test(flag) || longPrefix(flag, 'patch', 'interactive', 'edit')) ? null : words
  return sub === 'commit' ? commitWords(words, at, blank, watched) : null
}

function powershellPlainWords(words, head) {
  return words.slice(1).every((word) => {
    const flag = bare(word)
    if (flag.replace(/^[A-Za-z]:(?=[\\/]|$)/, '').includes(':')) return false
    const name = /^-([A-Za-z]+)$/.exec(flag)?.[1]?.toLowerCase()
    return !(head === 'mkdir' && name && ['name', 'value'].some((full) => full.startsWith(name)))
  })
}

function relaxedSegment(text, dialect) {
  if (unquotedSpecial(text, dialect)) return null
  const words = shellWords(text)
  if (!words.length || !/^[A-Za-z][\w.-]*$/.test(words[0])) return null
  const head = words[0].toLowerCase()
  const native = dialect === 'powershell' && head !== 'echo' && head !== 'write-output'
  const blank = (word, prefix = '') => blankValue(word, prefix, dialect, native)
  const watched = []
  const kept = PLAIN_COMMANDS.has(head) ? (dialect !== 'powershell' || powershellPlainWords(words, head) ? words : null)
    : TEXT_PRINTERS.has(head) ? printerWords(words, head, blank)
      : head === 'git' || head === 'git.exe' ? gitWords(words, blank, watched)
        : head === 'yan' ? yanWords(words, blank)
          : null
  if (!kept || RELAX_KEYWORDS.test(bare(watched.join(' ')))) return null
  return kept.join(' ')
}

function relaxedSegments(segments, command, dialect) {
  if (dialect === 'cmd' || (dialect === 'powershell' && POWERSHELL_UNSAFE.test(command))) return null
  const out = []
  for (const { text, sep } of segments) {
    if (!RELAX_SEPS.has(sep)) return null
    const kept = text.trim() ? relaxedSegment(text, dialect) : text
    if (kept === null) return null
    out.push(kept)
  }
  return out
}

const DISPLAY_COMMANDS = new Set(['head', 'tail', 'sort', 'uniq', 'wc', 'cut', 'less', 'more', 'select-object', 'select', 'measure-object', 'measure', 'out-string'])
const SEARCH_REDIRECT = /(^|\s)\d?>>?\s*(?:&[12]|\/dev\/null)(?=\s|$)/g
const SEARCH_RUNS = /(?:^|\s)--(?:pa|pre|ou|hostname|exec|cmd|command|program|ackrc)/i
const GIT_GREP_PAGER = /(?:^|\s)(?:-[a-zA-Z]*O|--op)/
const POWERSHELL_SEARCH_UNSAFE = /[$@(){}`\u2018-\u201e]/

const SEARCH_FILE_REDIRECT = /(^|\s)\d?>>?\s*([^\s|;&<>()$`"'{}@]+)(?=\s|$)/g
const WRITE_TARGET_UNSAFE = /[*?[\]~]|\.git|gitconfig|\.husky|hooks|\.vscode|\.envrc|profile|\.\w*rc\b|(?<![\w.-])_\w*rc\b|\.ssh|\.config\/+git(?:\/|$|\s)|(?:^|[\s/])git\/+config|lesskey|\.bash_log(?:in|out)|\.zshenv|\.zlog(?:in|out)/i

function unsafeWriteTarget(text) {
  const flat = bare(text)
  const slashed = String(text ?? '').replace(/["']/g, '').replace(/\\/g, '/')
  return WRITE_TARGET_UNSAFE.test(flat) || WRITE_TARGET_UNSAFE.test(slashed) || RELAX_KEYWORDS.test(flat)
}

function plainWords(text, dialect, files = false) {
  let rest = text.replace(SEARCH_REDIRECT, ' ')
  if (files) rest = rest.replace(SEARCH_FILE_REDIRECT, (all, lead, target) => (unsafeWriteTarget(target) ? all : lead))
  if (unquotedSpecial(rest, dialect)) return null
  const words = shellWords(text)
  return words.length && /^[A-Za-z][\w.-]*$/.test(words[0]) ? words : null
}

function searchSegment(text, dialect, files) {
  const words = plainWords(text, dialect, files)
  if (!words) return false
  const head = bareName(words[0])
  const flat = bare(text)
  if (head === 'git') return bare(words[1]) === 'grep' && !GIT_GREP_PAGER.test(flat)
  return SEARCH_COMMANDS.has(head) && !SEARCH_RUNS.test(flat)
}

function joinFdCopies(segments) {
  const out = []
  for (const part of segments) {
    const last = out.at(-1)
    if (last?.sep === '&' && /\d?>$/.test(last.text) && /^\d(?:\s|$)/.test(part.text)) out[out.length - 1] = { text: `${last.text}&${part.text}`, sep: part.sep }
    else out.push({ ...part })
  }
  return out
}

function displaySegment(text, dialect) {
  const words = plainWords(text, dialect)
  if (!words) return false
  const head = words[0].toLowerCase()
  const args = words.slice(1).map(bare)
  if (!DISPLAY_COMMANDS.has(head) || args.some((word) => /^(?:--|\+)/.test(word))) return false
  if ((head === 'sort' || head === 'less') && args.some((word) => /^-[A-Za-z]*[oO]/.test(word))) return false
  return head !== 'uniq' || args.filter((word) => !/^-./.test(word)).length < 2
}

function searchedSegments(segments, command, dialect) {
  if (dialect === 'cmd' || (dialect === 'powershell' && POWERSHELL_SEARCH_UNSAFE.test(command))) return null
  const out = []
  const single = segments.filter((part) => part.text.trim()).length === 1
  let found = false
  for (let i = 0; i < segments.length; i++) {
    const { text, sep } = segments[i]
    const piped = i > 0 && segments[i - 1].sep === '|'
    if (sep === '&' || (sep === '|' && !segments[i + 1]?.text.trim())) return null
    if (!text.trim()) { if (piped) return null; out.push(text); continue }
    if (searchSegment(text, dialect, single)) { out.push(''); found = true; continue }
    if (piped) {
      if (!displaySegment(text, dialect)) return null
      out.push(text)
      continue
    }
    if (relaxedSegment(text, dialect) === null) return null
    out.push(text)
  }
  return found ? out : null
}

const HEREDOC_OPERATOR = /(^|\s)<<(-?)(['"])([A-Za-z_][\w-]*)\3(?=[\s<>]|$)/
const HEREDOC_REDIRECT = /(^|\s)1?>>?\s*[^\s|;&<>()$`"'{}@*?[\]]+(?=\s|$)/g

function heredocLine(text) {
  const start = text.search(/\S/)
  const nl = text.indexOf('\n', start)
  if (start < 0 || nl < 0) return null
  const line = text.slice(0, nl)
  const op = HEREDOC_OPERATOR.exec(line)
  if (!op || (line.match(/<</g) ?? []).length !== 1 || line.includes('<<<')) return null
  const rest = line.replace(op[0], ' ').replace(HEREDOC_REDIRECT, ' ')
  const words = shellWords(rest)
  if (unquotedSpecial(rest, 'posix') || (words[0] !== 'cat' && words[0] !== 'tee')) return null
  if (words.slice(1).some((word) => words[0] === 'cat' || (word !== '-a' && !/^[\w.][\w./-]*$/.test(word)))) return null
  if (unsafeWriteTarget(line)) return null
  const last = text.slice(nl + 1).split('\n').at(-1)
  return (op[2] ? last.replace(/^\t+/, '') : last) === op[4] ? line : null
}

function heredocSegments(segments, dialect) {
  if (dialect !== 'posix') return null
  const out = []
  let found = false
  for (const { text, sep } of segments) {
    if (!RELAX_SEPS.has(sep)) return null
    const line = text.trim() ? heredocLine(text) : null
    if (line !== null) { out.push(line); found = true; continue }
    const kept = text.trim() ? relaxedSegment(text, dialect) : text
    if (kept === null || /^\s*(?:yan|git|cd)\b/i.test(kept)) return null
    out.push(kept)
  }
  return found ? out : null
}

export function ruleText(command, dialect = 'posix') {
  const segments = joinFdCopies(splitSegments(command, dialect))
  const shown = heredocSegments(segments, dialect) ?? searchedSegments(segments, command, dialect) ?? relaxedSegments(segments, command, dialect)
  return segments.map(({ text, sep }, i) => (shown ? shown[i] : text) + sep).join('')
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
    const dialect = toolDialect(name)
    if (!hostScansTerminalInput(command)) scanCommand(command, reasons, 0, cwd, options.base === undefined ? cwd : options.base, dialect)
    for (const { target } of shellWrites(command, cwd, 0, options.base === undefined ? undefined : { base: options.base, vars: new Map() }, dialect)) {
      if (touchesHostConfig(target, cwd)) reasons.push(`${HOST_CONFIG_REASON}${target}`)
      if (target && sensitiveOutside(target, cwd)) reasons.push(`修改项目之外的系统或凭证文件：${target}`)
    }
    if (/\bsudo\b/i.test(command) && reasons.length === 0 && /\brm\b/i.test(command)) reasons.push('以管理员身份删除文件')
  } else if (FILE_TOOLS.has(name)) {
    const raw = fileToolPath(input?.path ?? input?.file_path ?? input?.filePath)
    if (typeof raw === 'string' && raw.trim()) {
      const base = cwd || process.cwd()
      const abs = isAbsolutePath(raw) ? raw : `${String(base).replace(/[\\/]+$/, '')}/${raw}`
      const normalized = physicalPath(normalizePath(abs))
      if (touchesHostConfig(normalized, base)) reasons.push(`${HOST_CONFIG_REASON}${normalized}`)
      if (sensitiveOutside(normalized, base)) reasons.push(`修改项目之外的系统或凭证文件：${abs}`)
    }
  }
  reasons.push(...credentialAccess(name, input, cwd), ...vaultCredentialAccess(name, input, cwd))
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
const WRITE_COMMANDS_LAST_ARG = new Set(['cp', 'copy', 'xcopy', 'robocopy', 'ln', 'install', 'copy-item', 'ci', 'cpi', 'rsync', 'scp'])
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
  if (!windowsAliases(target).some((t) => isInside(t, roots) && !isInside(t, outputs))) return false
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

function psColonValues(args, names) {
  return args.flatMap((arg) => {
    const colon = /^(-[a-z]+):(.+)$/i.exec(arg)
    return colon && names.includes(colon[1].toLowerCase()) ? [colon[2]] : []
  })
}

function psFlagValues(args, names) {
  return [...flagValues(args, names, { ignoreCase: true }), ...psColonValues(args, names)]
}

function withoutRedirects(args) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    if (/^\d?(?:>{1,2}|<)&?$/.test(args[i])) { i += 1; continue }
    if (/^\d?[<>]/.test(args[i])) continue
    out.push(args[i])
  }
  return out
}

function inPlaceTargets(head, raw) {
  const args = withoutRedirects(raw)
  const cluster = head === 'sed' ? /^-[nrEsuz]*i/ : /^-[anpslwWTtUuXv]*i/
  const inPlace = args.some((arg) => (head === 'sed' && /^--in-place(?:=|$)/.test(arg)) || cluster.test(arg))
  if (!inPlace) return []
  const files = []
  let script = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { files.push(...args.slice(i + 1)); break }
    if (/^--(?:expression|file)=/.test(arg)) { script = true; continue }
    if (['--expression', '--file', '--line-length'].includes(arg)) { script ||= arg !== '--line-length'; i += 1; continue }
    if (/^-[a-zA-Z]/.test(arg)) {
      const letters = arg.slice(1).split('i')[0]
      const takesScript = head === 'sed' ? /^[a-zA-Z]*[ef]$/.test(letters) : /[eE]$/.test(letters)
      if (takesScript && !arg.slice(1).includes('i')) { script = true; i += 1 }
      else if (head === 'sed' && /^[a-zA-Z]*l$/.test(letters) && !arg.slice(1).includes('i')) i += 1
      continue
    }
    if (/^-/.test(arg)) continue
    files.push(arg)
  }
  return script ? files : files.slice(1)
}

function toolWriteTargets(head, args) {
  if (head === 'sed' || head === 'perl') return inPlaceTargets(head, args)
  if (head === 'dd') return args.filter((arg) => /^of=./i.test(arg)).map((arg) => arg.slice(3))
  if (head === 'truncate') {
    const files = []
    for (let i = 0; i < args.length; i++) {
      if (['-s', '--size', '-r', '--reference'].includes(args[i])) { i += 1; continue }
      if (!/^-/.test(args[i]) && !/^\d?[<>]/.test(args[i])) files.push(args[i])
    }
    return files
  }
  if (['7z', '7za', '7zr'].includes(head)) {
    const verb = String(args[0] ?? '').toLowerCase()
    const outputs = args.filter((arg) => /^-o./i.test(arg)).map((arg) => arg.slice(2))
    if (['a', 'u', 'd', 'rn'].includes(verb)) return [args.slice(1).find((arg) => !/^-/.test(arg)), ...outputs].filter(Boolean)
    if (['x', 'e'].includes(verb)) return outputs.length ? outputs : ['.']
    return outputs
  }
  if (head === 'curl') {
    const bundled = args.flatMap((arg, index) => (/^-[a-zA-Z]+o$/.test(arg) && args[index + 1] !== undefined ? [args[index + 1]] : []))
    const attached = args.flatMap((arg) => (/^-o./.test(arg) ? [arg.slice(2)] : []))
    const files = [...flagValues(args, ['-o', '--output']), ...bundled, ...attached]
    const dirs = flagValues(args, ['--output-dir'])
    const remoteName = args.some((arg) => arg === '--remote-name' || arg === '--remote-name-all' || /^-[a-zA-Z]*O[a-zA-Z]*$/.test(arg))
    return [...files, ...dirs, ...(remoteName && !dirs.length ? ['.'] : [])]
  }
  if (head === 'wget') {
    const bundled = args.flatMap((arg, index) => (/^-[a-zA-Z]+O$/.test(arg) && args[index + 1] !== undefined ? [args[index + 1]] : []))
    const attached = args.flatMap((arg) => (/^-O./.test(arg) ? [arg.slice(2)] : []))
    const files = [...flagValues(args, ['-O', '--output-document']), ...bundled, ...attached]
    const dirs = flagValues(args, ['-P', '--directory-prefix'])
    return files.length || dirs.length ? [...files, ...dirs] : ['.']
  }
  if (['iwr', 'invoke-webrequest', 'irm', 'invoke-restmethod'].includes(head)) {
    return psFlagValues(args, ['-o', '-ou', '-out', '-outf', '-outfi', '-outfil', '-outfile'])
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
    const bundles = args.flatMap((arg, index) => (/^-[a-zA-Z]+$/.test(arg) || (index === 0 && /^[a-zA-Z]+$/.test(arg)) ? [{ letters: arg.replace(/^-/, ''), index }] : []))
    const creates = bundles.some(({ letters }) => /[cru]/.test(letters)) || args.some((arg) => ['--create', '--append', '--update', '--concatenate'].includes(arg))
    const archives = creates
      ? [...flagValues(args, ['--file']), ...bundles.filter(({ letters }) => letters.includes('f')).flatMap(({ index }) => (args[index + 1] !== undefined ? [args[index + 1]] : []))]
      : []
    return [...(dirs.length ? dirs : extract ? ['.'] : []), ...archives]
  }
  if (head === 'unzip') {
    const dirs = flagValues(args, ['-d'])
    return dirs.length ? dirs : ['.']
  }
  if (head === 'expand-archive') {
    const dirs = psFlagValues(args, ['-destinationpath'])
    if (dirs.length) return dirs
    const plain = withoutRedirects(args)
    const named = plain.some((arg) => /^-(?:path|literalpath)(?::|$)/i.test(arg))
    const positional = plain.filter((arg, index) => !/^-/.test(arg) && !/^-(?:path|literalpath)$/i.test(plain[index - 1] ?? ''))
    return [positional[named ? 0 : 1] ?? '.']
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
    const flagged = flagValues(args, [...PS_PATH_FLAGS], { ignoreCase: true }).filter(Boolean)
    out.push(...(flagged.length ? flagged : PS_VALUE_AFTER_PATH.has(head) ? positional.slice(0, 1) : positional), ...psColonValues(args, [...PS_PATH_FLAGS]))
  } else if (WRITE_COMMANDS_LAST_ARG.has(head)) {
    const flagged = flagValues(args, ['-destination', '-path'], { ignoreCase: true }).filter(Boolean)
    const destination = flagValues(args, ['-destination'], { ignoreCase: true }).length > 0
    out.push(...(flagged.length ? flagged : positional.slice(-1)), ...psColonValues(args, ['-destination', '-path']), ...flagValues(args, ['-t', '--target-directory']), ...(destination ? [] : positional.slice(-1)))
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

const ARITHMETIC_BODY = /^[\w\s+\-*/%<>=!&|^~?()]*$/
const ARITHMETIC_OPERATOR = /[+\-*/%<>=!&|^~]/

function integerVariable(name, vars) {
  const value = vars.get(name)
  return value === LOOP_ITEM || (typeof value === 'string' && /^-?\d+$/.test(value))
}

function arithmeticBody(body, vars) {
  const bare = body.replace(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, (all, braced, plain) => (integerVariable(braced ?? plain, vars) ? 'n' : all))
  return ARITHMETIC_BODY.test(bare) && ARITHMETIC_OPERATOR.test(bare)
}

function replaceArithmetic(text, vars) {
  let out = ''
  let index = 0
  while (index < text.length) {
    if (!text.startsWith('$((', index)) {
      out += text[index++]
      continue
    }
    let depth = 2
    let end = index + 3
    while (end < text.length && depth > 0) {
      if (text[end] === '(') depth++
      else if (text[end] === ')') depth--
      end++
    }
    const body = text.slice(index + 3, end - 2)
    if (depth !== 0 || text.slice(end - 2, end) !== '))' || !arithmeticBody(body, vars)) {
      out += text[index++]
      continue
    }
    out += '0'
    index = end
  }
  return out
}

function resolveFrom(raw, base, vars = new Map()) {
  let cleaned = expandHome(expandEnv(unquote(raw)))
  if (!cleaned) return ''
  if (cleaned.includes('$((')) cleaned = replaceArithmetic(cleaned, vars)
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

function bothStreamsTarget(part, next) {
  if (part.sep !== '&' || !/(?<![<>&\d])\d?>\s*$/.test(part.text)) return null
  const word = tokens(next?.text ?? '')[0]
  return word && !/^(?:\d+|-)$/.test(word) ? word : null
}

export function shellWrites(command, cwd, depth = 0, scope, dialect = 'posix') {
  const out = []
  let base = scope ? scope.base : canonicalRoot(String(cwd || process.cwd()))
  const vars = scope?.vars ?? new Map()
  const parts = splitSegments(String(command ?? '').replace(/>\|/g, '>'), dialect)
  parts.forEach((part, index) => {
    const segment = part.text.replace(/^\s*[({]+/, '')
    rememberVariables(segment, vars)
    const cmd = commandOf(segment)
    const both = bothStreamsTarget(part, parts[index + 1])
    for (const raw of [...segmentWriteTargets(segment, cmd), ...(both ? [both] : [])]) out.push({ raw, target: resolveFrom(raw, base, vars) })
    const inner = depth < MAX_SHELL_DEPTH ? nestedScript(segment, cmd) : ''
    if (inner) out.push(...shellWrites(inner, cwd, depth + 1, { base, vars: new Map(vars) }, encodedPowerShell(cmd) ? 'powershell' : dialectOf(cmd.head)))
    if (depth < MAX_SHELL_DEPTH) {
      for (const sub of substitutions(withoutHeredocBodies(part.text, true))) out.push(...shellWrites(sub, cwd, depth + 1, { base, vars: new Map(vars) }, dialect))
    }
    if (LOCATION_COMMANDS.has(cmd.head)) base = nextLocation(cmd, base)
  })
  return out
}

export function shellLocationAfter(command, base, toolName) {
  let current = base
  for (const part of splitSegments(String(command ?? ''), toolDialect(toolName))) {
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
  if (name === 'bash' || name === 'powershell') return shellWrites(String(input?.command ?? ''), cwd, 0, base === undefined ? undefined : { base, vars: new Map() }, toolDialect(name))
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
  return [...new Set(hits)]
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

async function askHost(toolName, input, reasons, outsideDirs = [], toolCallId = '', options = {}) {
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
        params: { tool: toolName, detail, reasons, ...(outsideDirs.length ? { outsideDirs } : {}), ...(toolCallId ? { toolCallId } : {}), ...(options.critical ? { critical: true } : {}) },
        sessionId,
        projectId
      }),
      signal: AbortSignal.timeout(CONFIRM_TIMEOUT_MS)
    })
    const payload = await response.json()
    if (payload?.ok && payload?.summary?.allowed === true) return { allowed: true }
    if (payload?.summary?.decision === 'timeout') return { allowed: false, timedOut: true, why: 'The user did not answer within 1 minute' }
    const feedback = typeof payload?.summary?.feedback === 'string' ? payload.summary.feedback.trim() : ''
    if (feedback) return { allowed: false, why: `The user declined this operation and said: ${feedback}. Honour the refusal: do not retry this operation and do not reach the same result through another tool or route; tell the user what you would need, or ask which alternative they want` }
    const reason = typeof payload?.summary?.reason === 'string' ? payload.summary.reason.trim() : ''
    if (reason) return { allowed: false, why: reason }
    return { allowed: false, why: payload?.summary?.decision === 'no-answer' ? 'No answer from the user' : 'The user declined this operation' }
  } catch (err) {
    return { allowed: false, why: `Could not get the user's confirmation (${String(err?.message ?? err).slice(0, 80)})` }
  }
}

async function reportReview(review) {
  const url = process.env.YAN_CLI_URL
  const token = process.env.YAN_CLI_TOKEN
  const sessionId = process.env.YAN_SESSION_ID
  const projectId = process.env.YAN_PROJECT_ID
  if (!url || !token || !sessionId || !projectId || !review.toolCallId) return
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ apiVersion: 1, command: 'danger.review', params: review, sessionId, projectId }),
      signal: AbortSignal.timeout(PREFS_TIMEOUT_MS)
    })
  } catch {}
}

async function reviewAction(ctx, toolName, input, reasons) {
  const subagent = process.env.YAN_RUNNER_KIND === 'subagent'
  const entries = typeof ctx?.sessionManager?.getBranch === 'function' ? ctx.sessionManager.getBranch() : []
  const prompt = reviewPrompt({
    transcript: reviewTranscript(entries),
    parent: subagent ? parentUserMessages(process.env.YAN_PARENT_SESSION_FILE) : undefined,
    subagent,
    toolName,
    detail: approvalDetail(toolName, input),
    reasons,
    cwd: ctx?.cwd
  })
  return runReview(ctx, prompt)
}

function stopRun(ctx) {
  try { ctx?.abort?.() } catch {}
}

export default function dangerGuardExtension(pi) {
  let criticalTimeouts = 0
  let reviewStreak = 0

  pi.on('before_agent_start', (event) => {
    if (event?.messageType === 'custom') return undefined
    if (isHostAutomatedMessage(String(event?.prompt ?? ''))) return undefined
    criticalTimeouts = 0
    reviewStreak = 0
    return undefined
  })

  pi.on('tool_call', async (event, ctx) => {
    if (process.env.YAN_DANGER_GUARD === '0') return undefined
    const name = String(event?.toolName ?? '')
    if (!name) return undefined
    const input = event?.input ?? {}
    const toolCallId = typeof event?.toolCallId === 'string' ? event.toolCallId : ''
    const prefs = await hostPrefs()
    if (prefs.mode === 'all') {
      const critical = criticalDanger(name, input, ctx?.cwd)
      if (critical.length === 0) return undefined
      if (criticalTimeouts >= REVIEW_STREAK_LIMIT) return { block: true, reason: criticalBlockReason(critical, 'The user has left several of these requests unanswered, so it was declined without asking') }
      const digest = inputDigest(input)
      const answer = await askHost(name, input, critical, [], toolCallId, { critical: true })
      if (answer.allowed) return inputDigest(input) === digest ? undefined : { block: true, reason: CHANGED_AFTER_APPROVAL }
      if (answer.timedOut) criticalTimeouts += 1
      return { block: true, reason: criticalBlockReason(critical, answer.why) }
    }
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
    const unique = [...new Set(reasons)]
    const approvedDigest = inputDigest(input)
    const askedAt = Date.now()
    const answer = await askHost(name, input, unique, outside, toolCallId)
    if (answer.allowed) {
      reviewStreak = 0
      return inputDigest(input) === approvedDigest ? undefined : { block: true, reason: CHANGED_AFTER_APPROVAL }
    }
    if (!answer.timedOut) return { block: true, reason: `High-risk operation not confirmed by the user: ${unique.join('; ')}. ${answer.why}. Do not retry it and do not work around the refusal by another route; tell the user why this one is needed, or ask which alternative they want.` }
    const verdict = await reviewAction(ctx, name, input, unique)
    const allowed = verdict.decision === 'allow'
    await reportReview({ toolCallId, tool: name, reasons: unique, allowed, reason: verdict.reason, askedAt })
    if (allowed) {
      reviewStreak = 0
      return inputDigest(input) === approvedDigest ? undefined : { block: true, reason: CHANGED_AFTER_APPROVAL }
    }
    if (verdict.decision !== 'deny') return { block: true, reason: reviewFailedReason(unique, verdict.reason) }
    reviewStreak += 1
    const reason = reviewDeniedReason(unique, verdict.reason)
    if (reviewStreak < REVIEW_STREAK_LIMIT) return { block: true, reason }
    reviewStreak = 0
    stopRun(ctx)
    return { block: true, reason: `${reason} ${REVIEW_STOP_NOTE}` }
  })
}
