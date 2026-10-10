/**
 * 高危操作确认 —— 薄层侧：判定 + 向宿主要一次确认。
 *
 * ══════════════════════════════════════════════════════════════════
 * 范围（有意收得很窄）
 * ══════════════════════════════════════════════════════════════════
 * 只拦「做错了很难挽回」的那几类：大范围递归删除、丢弃未提交改动 / 强推的 Git 操作、
 * 删库、格式化磁盘、把网络内容直接交给 shell 执行、关机重启、发布包，以及写系统或
 * 凭证目录。普通的写文件、跑测试、装依赖都不问。
 *
 * ⚠️ 这是**提醒式的护栏，不是沙箱**：靠命令文本识别，绕得开（拼接、编码、脚本里再调用）。
 *    它的作用是让「模型顺手敲出一条毁灭性命令」在执行前多一次人眼确认，不承诺挡住恶意。
 *
 * ── 为什么在薄层 ──
 * `tool_call` 钩子是唯一能在工具执行前看到参数并拦下它的地方（与 work-mode.js 同理）。
 * 确认框在宿主：这里用宿主注入的 `YAN_CLI_URL` 发一条 `danger.confirm`，宿主弹框，
 * 答复回来后才决定放行还是 `{ block: true }`。
 *
 * ── 权限档位（桌面设置 `permissionMode`）──
 * `danger`（缺省，危险批准）：命中高危就问；`all`（全部允许）：砚不额外审批或拦截，保留原生工具行为（2026-10-08）。
 *
 * ── 失败方向 ──
 * 命中高危却连不上宿主 / 没有窗口 / 超时 → **拦下**（宁可让模型换路，也不在没人看着时放行）。
 * 没命中的调用不产生任何网络请求，对正常工作零开销。
 *
 * `YAN_DANGER_GUARD=0` 只给自动化测试用，关闭整个护栏。
 */

import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { homedir, tmpdir } from 'node:os'

/** 确认框等用户的最长时间；超过就当作拒绝 */
const CONFIRM_TIMEOUT_MS = 4 * 60 * 1000

/* ------------------------------------------------------------------ 判定 */

/** 目标路径是不是「大范围」：根、家目录、上级目录、通配、浅层绝对路径 */
export function isBroadTarget(raw) {
  let target = String(raw ?? '').trim().replace(/^["']+|["']+$/g, '')
  if (!target) return false
  target = target.replace(/\\/g, '/').toLowerCase()
  if (['/', '/*', '~', '~/', '~/*', '.', './', './*', '*', '*.*', '..', '../', '../*'].includes(target)) return true
  if (/^(~|\$home|\$\{home\}|%userprofile%|%homepath%|\$env:userprofile)(\/|$)/.test(target)) return true
  if (target.split('/').includes('..')) return true
  /* 绝对路径：盘符或以 / 开头，且不超过两层（/home/x、c:/users、/usr/local） */
  if (/^([a-z]:)?\//.test(target)) {
    const segments = target.replace(/^[a-z]:/, '').split('/').filter(Boolean)
    return segments.length <= 2
  }
  return false
}

const SEGMENT_SPLIT = /&&|\|\||[;|\n]/

function tokens(segment) {
  return segment.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? []
}

/** 命令段的可执行名与参数：跳过 sudo / 环境变量前缀，去掉目录和 .exe */
function commandOf(segment) {
  const parts = tokens(segment)
  let start = 0
  while (start < parts.length && (/^sudo$/i.test(parts[start]) || /^\w+=/.test(parts[start]))) start += 1
  const head = (parts[start] ?? '').toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, '')
  return { head, args: parts.slice(start + 1) }
}

/** 一条命令段里的递归删除：返回被命中的大范围目标，没有则 null */
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

/** 只在命令位（而不是任意参数里）出现才算：`grep reboot log` 不是重启 */
const POWER_COMMANDS = new Set(['shutdown', 'reboot', 'halt', 'poweroff', 'stop-computer', 'restart-computer'])

/** `bash -c "…"` / `powershell -Command "…"` / `cmd /c …`：取出脚本部分再判一次 */
const SHELL_WRAPPER = /^\s*(?:sudo\s+)?(?:\S*[\\/])?(?:bash|sh|zsh|dash|powershell|pwsh|cmd)(?:\.exe)?\s+(?:-\S+\s+)*?(?:-c|-command|\/c)\s+([\s\S]+)$/i

/** 命令文本里的高危模式（整条匹配，不分段） */
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

/** 写入这些位置视为高危（写在项目外时才算） */
const SENSITIVE_PATH =
  /\/(?:\.ssh|\.aws|\.gnupg|\.kube)(?:\/|$)|^\/(?:etc|usr|bin|sbin|boot|lib)(?:\/|$)|^[a-z]:\/windows(?:\/|$)|^[a-z]:\/program files|\/\.(?:bashrc|zshrc|profile|gitconfig|npmrc)$|\/start menu\/programs\/startup/i

/**
 * 统一成小写、正斜杠，并**归一化 `..` 与 `.`**：
 * 不做这一步，`项目/../../Windows/…` 会因为前缀仍是项目根而被当成「在项目里」。
 * 盘符单独拆出来，否则 `..` 会把 `c:` 当成一层目录弹掉。
 */
function normalizePath(p) {
  const text = String(p ?? '').replace(/\\/g, '/').toLowerCase()
  const match = /^([a-z]:)?(.*)$/.exec(text)
  const drive = match?.[1] ?? ''
  const rest = match?.[2] ?? ''
  return drive + (rest ? posix.normalize(rest) : '')
}

/** 是不是绝对路径（POSIX 根或带盘符），不依赖当前系统的路径规则 */
function isAbsolutePath(p) {
  return /^(?:[a-z]:)?[\\/]/i.test(p) || /^[a-z]:/i.test(p)
}

/** 分段扫描一段 shell 文本；`bash -c "…"` 之类的包装最多再往里看两层 */
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

/**
 * 判定一次工具调用是否高危。返回原因数组（空 = 不需要确认）。
 * `cwd` 用来判断写入是否落在项目外。
 */
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
      /* 家目录下的凭证 / 配置：统一成 ~/ 再比 */
      const shown = normalized.startsWith(`${home}/`) ? `~${normalized.slice(home.length)}` : normalized
      if (!inside && (SENSITIVE_PATH.test(normalized) || SENSITIVE_PATH.test(shown.replace(/^~/, '')))) {
        reasons.push(`修改项目之外的系统或凭证文件：${abs}`)
      }
    }
  }
  return [...new Set(reasons)]
}

/* ------------------------------------------------------------------ 项目之外的写入 */

/**
 * 写入项目之外的路径（可选，设置里「写入项目之外要确认」，默认关；只在「危险批准」档生效）。
 *
 * 与上面的 `SENSITIVE_PATH` 不同：这里不看路径「是不是系统或凭证目录」，只看
 * 「是不是在项目、临时目录、pi 数据目录、用户允许的目录之内」。
 * 同样是提醒式护栏：只认文件写入工具，以及 shell 命令里写得出来的重定向与常见写入命令，
 * 拼接、编码、脚本里再调用都绕得开。
 */
const WRITE_COMMANDS_ALL_ARGS = new Set([
  'rm', 'rmdir', 'del', 'erase', 'rd', 'mkdir', 'md', 'touch', 'chmod', 'chown', 'mv', 'move', 'ren', 'rename',
  'remove-item', 'ri', 'new-item', 'ni', 'move-item', 'mi', 'rename-item', 'rni', 'set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content'
])
/* 复制类：只有最后一个参数是被写入的一端，来源只是被读 */
const WRITE_COMMANDS_LAST_ARG = new Set(['cp', 'copy', 'xcopy', 'robocopy', 'ln', 'install', 'copy-item', 'ci', 'cpi'])
const PS_PATH_FLAGS = new Set(['-path', '-literalpath', '-filepath', '-destination', '-name'])

function expandHome(text) {
  return String(text)
    .replace(/^(~|\$home|\$\{home\}|%userprofile%|%homepath%|\$env:userprofile)(?=[\\/]|$)/i, homedir())
}

/** `$env:TEMP`、`%LOCALAPPDATA%`、`$TMPDIR` 这类开头的环境变量换成实际值（认不出的原样保留） */
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

/** 目标路径解析成归一化的绝对路径；`..`、`.` 一并折叠 */
function resolveTarget(raw, cwd) {
  const cleaned = expandHome(expandEnv(String(raw ?? '').trim().replace(/^["']+|["']+$/g, '')))
  if (!cleaned) return ''
  /* 通配符：取通配之前的部分，等价于「这一层目录下的东西」 */
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

/** 一段 shell 命令里会被写入或删除的路径（原样文本，未解析） */
function shellWriteTargets(command) {
  const out = []
  const redirect = /(?:^|[\s;&|])\d?>{1,2}\s*("[^"]+"|'[^']+'|[^\s;&|<>]+)/g
  let match
  while ((match = redirect.exec(command))) out.push(match[1])
  for (const segment of command.split(SEGMENT_SPLIT)) {
    const { head, args } = commandOf(segment)
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

/**
 * 这次调用会写到项目之外的哪些路径（已归一化的绝对路径）。
 * `prefs.outsideWrites` 为假时一律返回空。
 */
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

/* ------------------------------------------------------------------ 删除改走回收站 */

/** 删除文件的命令名（只认命令位，`grep rm x` 不算） */
export const DELETE_HEADS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'unlink', 'remove-item', 'ri', 'shred', 'trash'])

/** 命令里是否含删除（逐段看命令名） */
export function hasDelete(command) {
  for (const segment of String(command ?? '').split(SEGMENT_SPLIT)) {
    if (DELETE_HEADS.has(commandOf(segment).head)) return true
  }
  return false
}

/** 删除命令要删的路径（已解析、归一化）。管道喂进来的目标看不到，返回空数组 */
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

/** 是不是系统临时目录里的路径：这些删除照常执行，否则清理临时文件腾不出空间 */
export function isTempPath(target) {
  const roots = [tmpdir(), process.env.TEMP, process.env.TMP, '/tmp', '/var/tmp']
    .filter((p) => typeof p === 'string' && p.trim())
    .map((p) => normalizePath(p).replace(/\/$/, ''))
  const normalized = normalizePath(target)
  return roots.some((root) => normalized !== root && normalized.startsWith(`${root}/`))
}

/** 拦下删除时给模型的说明 */
export function trashHint(targets = []) {
  const list = targets.length ? `要删除的是：${targets.slice(0, 6).join('、')}。` : ''
  return '砚的权限设置不对这次删除做确认，删除要移到回收站，方便用户找回。' + list +
    '请改用 `yan file trash --path <路径>`；多个路径用 `yan file trash --request-file trash.json`（{"paths":[…]}）。' +
    '系统临时目录里的文件可以直接删除。'
}

/**
 * 桌面设置里与护栏相关的几项。
 * 旧档位（ask / full，或没有这个字段）迁到「危险批准」，并关掉项目外写入确认——与主进程
 * `settings.ts` 的迁移同一口径（设置文件可能还没被重新保存）。读不到就取默认。
 */
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

/* ------------------------------------------------------------------ 向宿主确认 */

/** Bridge 的原生工具在 pi 钩子之外执行，批准的是整次委派，不能承诺逐条命令审批。 */
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

async function askHost(toolName, input, reasons, outsideDirs = []) {
  const url = process.env.YAN_CLI_URL
  const token = process.env.YAN_CLI_TOKEN
  const sessionId = process.env.YAN_SESSION_ID
  const projectId = process.env.YAN_PROJECT_ID
  if (!url || !token || !sessionId || !projectId) return { allowed: false, why: '宿主确认通道不可用' }
  const detail =
    toolName === 'bash' || toolName === 'powershell'
      ? String(input?.command ?? '')
      : typeof input?.prompt === 'string' ? JSON.stringify(input) : String(input?.path ?? input?.file_path ?? input?.filePath ?? '')
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        apiVersion: 1,
        command: 'danger.confirm',
        params: { tool: toolName, detail: typeof input?.prompt === 'string' ? detail : detail.slice(0, 2000), reasons, ...(outsideDirs.length ? { outsideDirs } : {}) },
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
    const reasons = [...detectDanger(name, event?.input ?? {}, ctx?.cwd), ...delegation]
    if (reasons.length === 0) return undefined
    const answer = await askHost(name, event?.input ?? {}, [...new Set(reasons)])
    if (answer.allowed) return undefined
    return { block: true, reason: `高危操作未获用户确认：${reasons.join('；')}。${answer.why}。请换一种更安全的做法，或向用户说明为什么必须这样做。` }
  })
}
