/**
 * 权限档位 —— 薄层侧：询问档下，写文件与跑命令前先问用户；日常模式下删除文件永远要问。
 *
 * ══════════════════════════════════════════════════════════════════
 * 范围
 * ══════════════════════════════════════════════════════════════════
 * 档位是桌面设置里的 `permissionMode`（全局）：
 *   · `full`（缺省）—— 不逐步询问，对工作零开销；高危操作仍由 danger-guard 照旧询问；
 *   · `ask`         —— `write` / `edit` / `bash` 等会改动环境的工具，调用前先问一次。
 *
 * 删除是例外：桌面是「日常」界面模式时（表格、整理文件之类没有项目、没有版本控制的事务），
 * 任何档位下删除文件都要问，且不提供「记住」。编码模式不加这条，否则清构建产物会被问个没完。
 *
 * 只读的命令（`ls`、`git status`、`grep` …）与读类工具不问，否则询问档没法用。
 * 「只读」由工作模式里的计划档承担（工具表里直接拿掉写入口），这里不重复。
 *
 * ── 与 danger-guard 的关系 ──
 * 高危或越界写入会被 danger-guard 问一次；这里发现同一调用它会问，就**不再问第二次**
 * （否则同一步出现两张卡片）。两者各自独立，互不改对方。
 *
 * ── 失败方向 ──
 * 需要问却连不上宿主 / 没有窗口 / 超时 → **拦下**，与 danger-guard 一致。
 * 提醒式护栏，不是沙箱：命令文本的只读判断是白名单，宁可多问，不会漏放写入。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { detectDanger, outsideWrites } from './danger-guard.js'

const CONFIRM_TIMEOUT_MS = 4 * 60 * 1000

/** 询问档下需要先问的工具：改文件的和跑命令的 */
const GATED_TOOLS = new Set(['write', 'edit', 'multi_edit', 'apply_patch', 'bash', 'powershell'])
const SHELL_TOOLS = new Set(['bash', 'powershell'])

/* ------------------------------------------------------------------ 只读命令白名单 */

const SAFE_HEADS = new Set([
  'ls', 'dir', 'pwd', 'cd', 'cat', 'type', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'which', 'where',
  'whoami', 'date', 'tree', 'stat', 'file', 'du', 'df', 'sort', 'uniq', 'cut', 'tr', 'diff', 'basename', 'dirname',
  'realpath', 'true', 'false', 'echo', 'printf', 'test', 'hostname', 'uname', 'env', 'printenv',
  'get-childitem', 'gci', 'get-content', 'gc', 'select-string', 'sls', 'get-location', 'resolve-path', 'test-path',
  'get-item', 'gi', 'get-command', 'get-date', 'measure-object', 'sort-object', 'select-object', 'where-object', 'format-table',
  /* 电脑状况的只读查询（日常「体检」类任务）：磁盘、进程、服务、系统信息、已装更新、注册表读取 */
  'format-list', 'out-string', 'group-object', 'get-process', 'get-service', 'get-ciminstance', 'get-wmiobject',
  'get-psdrive', 'get-volume', 'get-disk', 'get-partition', 'get-physicaldisk', 'get-computerinfo', 'get-hotfix',
  'get-itemproperty', 'get-itempropertyvalue', 'get-netadapter', 'get-netipaddress', 'get-help', 'get-member',
  'get-scheduledtask', 'get-appxpackage', 'get-startapps', 'convertto-json', 'convertfrom-json',
  'write-output', 'write-host', 'tasklist', 'systeminfo', 'ipconfig', 'ver'
])

/**
 * PowerShell 里会改动环境的动词。命令头在白名单里也不够：`Where-Object { Remove-Item $_ }`
 * 的头是只读的，真正的写入藏在脚本块里，所以整条命令文本里出现就按「会写」处理。
 */
const PS_WRITE_VERB = /\b(?:remove|set|new|stop|start|restart|clear|move|copy|rename|invoke|install|uninstall|disable|enable|out-file|add|export|import|register|unregister|update|reset|send|suspend|resume|mount|dismount|format(?=-volume)|optimize|repair|checkpoint|restore)-[a-z]/i
/** 这些别名等价于上面的写入动词；只在带脚本块时检查，避免把普通词误伤 */
const PS_WRITE_ALIAS = /(?:^|[\s{;|(])(?:iex|saps|spps|sc|ac|ni|si|cpi|mi|rni|ri|kill|start|sleep|ii)(?=[\s;|)}]|$)/i

const SAFE_GIT = new Set([
  'status', 'diff', 'log', 'show', 'ls-files', 'rev-parse', 'blame', 'grep', 'describe', 'shortlog', 'ls-tree',
  'cat-file', 'rev-list', 'name-rev', 'diff-tree', 'show-ref', 'count-objects', 'help', 'version'
])

const SEGMENT_SPLIT = /&&|\|\||[;|\n]/

/** 删除文件的命令（递归的大范围删除由 danger-guard 先问，这里补上其余的删除） */
const DELETE_HEADS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'unlink', 'remove-item', 'ri', 'shred', 'trash'])

function tokens(segment) {
  return segment.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? []
}

function headOf(segment) {
  const parts = tokens(segment)
  let start = 0
  while (start < parts.length && /^\w+=/.test(parts[start])) start += 1
  const head = (parts[start] ?? '').toLowerCase().replace(/^["']|["']$/g, '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd)$/, '')
  return { head, args: parts.slice(start + 1) }
}

function isSafeGit(args) {
  const rest = args.filter((a) => !/^-/.test(a) || a === '--')
  const sub = (args.find((a) => !a.startsWith('-')) ?? '').toLowerCase()
  if (!sub) return true
  if (SAFE_GIT.has(sub)) return true
  /* 只列不改的写法 */
  if (sub === 'branch') return rest.length <= 1 && args.every((a) => /^(branch|-a|-r|-v|-vv|--list|--show-current|--all|--remotes)$/.test(a))
  if (sub === 'remote') return args.every((a) => /^(remote|-v|--verbose|show|get-url)$/.test(a) || !a.startsWith('-'))
  if (sub === 'config') return args.some((a) => /^--(get|get-all|list|show-origin)$/.test(a) || a === '-l')
  if (sub === 'tag') return args.every((a) => /^(tag|-l|--list|-n\d*)$/.test(a))
  return false
}

/**
 * 整条命令是否只读：每一段的命令都在白名单里，且没有重定向、命令替换。
 * 判不准就当作会写（返回 false）→ 多问一次，而不是漏放。
 */
export function isReadOnlyShell(command) {
  const text = String(command ?? '')
  if (!text.trim()) return true
  if (/[>`]|\$\(|<\(|\$\{/.test(text)) return false
  if (PS_WRITE_VERB.test(text)) return false
  if (text.includes('{') && PS_WRITE_ALIAS.test(text)) return false
  for (const segment of text.split(SEGMENT_SPLIT)) {
    if (!segment.trim()) continue
    const { head, args } = headOf(segment)
    if (!head) continue
    if (head === 'yan') continue
    if (head === 'git') {
      if (!isSafeGit(args)) return false
      continue
    }
    if (head === 'find') {
      if (args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/i.test(a))) return false
      continue
    }
    if (head === 'sort' && args.some((a) => /^-o/.test(a) || a === '--output')) return false
    if (head === 'env' || head === 'printenv') {
      /* `env VAR=x cmd` 会执行 cmd；只允许单独列环境变量 */
      if (args.some((a) => !a.startsWith('-'))) return false
      continue
    }
    if (!SAFE_HEADS.has(head)) return false
  }
  return true
}

/** 命令里是否含删除（逐段看命令名，不看参数里恰好出现的词） */
export function hasDelete(command) {
  for (const segment of String(command ?? '').split(SEGMENT_SPLIT)) {
    if (DELETE_HEADS.has(headOf(segment).head)) return true
  }
  return false
}

/* ------------------------------------------------------------------ 判定 */

function desktopPrefs() {
  try {
    const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
    const settings = JSON.parse(readFileSync(join(dir, 'desktop.json'), 'utf8'))
    return {
      mode: settings.permissionMode === 'ask' ? 'ask' : 'full',
      /* 界面模式缺省按「日常」（应用默认值）；明确是 coding 才不加删除确认 */
      daily: settings.workspaceMode !== 'coding',
      outsideWrites: settings.guardOutsideWrites !== false,
      allowRoots: Array.isArray(settings.guardAllowRoots) ? settings.guardAllowRoots.filter((p) => typeof p === 'string') : []
    }
  } catch {
    return { mode: 'full', daily: true, outsideWrites: true, allowRoots: [] }
  }
}

/**
 * 这次调用在当前档位下要不要先问。
 * 返回 `null` = 不问；否则 `{ kind, reasons }`，reasons 显示在卡片上。
 * kind：`delete` 不提供「记住」；`permission` 的「记住」是改成完全放行。
 */
export function permissionReasons(toolName, input, cwd, prefs) {
  const name = String(toolName ?? '')
  if (!GATED_TOOLS.has(name)) return null
  const deleting = SHELL_TOOLS.has(name) && hasDelete(input?.command)
  /* 删除：日常模式下任何档位都问；询问档下本来就问 */
  const askDelete = deleting && (prefs.daily === true || prefs.mode === 'ask')
  if (prefs.mode !== 'ask' && !askDelete) return null
  /* danger-guard 会问的调用（高危 / 越界写入）：不重复问 */
  if (detectDanger(name, input ?? {}, cwd).length > 0) return null
  if (outsideWrites(name, input ?? {}, cwd, { outsideWrites: prefs.outsideWrites, allowRoots: prefs.allowRoots }).length > 0) return null
  if (askDelete) return { kind: 'delete', reasons: ['这条命令会删除文件：删除不会被记住，每次都要你确认'] }
  if (SHELL_TOOLS.has(name)) {
    if (isReadOnlyShell(String(input?.command ?? ''))) return null
    return { kind: 'permission', reasons: ['权限设为「每次询问」：这条命令可能改动文件或环境'] }
  }
  return { kind: 'permission', reasons: ['权限设为「每次询问」：这一步会修改文件'] }
}

/* ------------------------------------------------------------------ 向宿主确认 */

async function askHost(toolName, input, reasons, kind) {
  const url = process.env.YAN_CLI_URL
  const token = process.env.YAN_CLI_TOKEN
  const sessionId = process.env.YAN_SESSION_ID
  const projectId = process.env.YAN_PROJECT_ID
  if (!url || !token || !sessionId || !projectId) return { allowed: false, why: '宿主确认通道不可用' }
  const detail = SHELL_TOOLS.has(toolName)
    ? String(input?.command ?? '')
    : String(input?.path ?? input?.file_path ?? input?.filePath ?? '')
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        apiVersion: 1,
        command: 'danger.confirm',
        params: { kind, tool: toolName, detail: detail.slice(0, 2000), reasons },
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

export default function permissionGuardExtension(pi) {
  pi.on('tool_call', async (event, ctx) => {
    if (process.env.YAN_DANGER_GUARD === '0') return undefined
    const name = String(event?.toolName ?? '')
    if (!name) return undefined
    const prefs = desktopPrefs()
    const verdict = permissionReasons(name, event?.input ?? {}, ctx?.cwd, prefs)
    if (!verdict) return undefined
    const answer = await askHost(name, event?.input ?? {}, verdict.reasons, verdict.kind)
    if (answer.allowed) return undefined
    const scope = verdict.kind === 'delete' ? '删除文件需要用户确认' : '权限：每次询问'
    return { block: true, reason: `用户没有批准这次操作（${scope}）。${answer.why}。可以换一种做法，或向用户说明为什么需要这一步。` }
  })
}
