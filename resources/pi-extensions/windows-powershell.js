/**
 * bash 里用双引号把脚本交给 PowerShell 时的写法冲突检查（由 shell-fallback.js 接入，不依赖 pi）。
 *
 * `powershell -Command "..."` 的双引号由 bash 先处理：`$_`、`$env:X`、`$x = ...` 被当成 bash 变量
 * 展开（`$_` 变成上一条命令的参数，如 `/usr/bin/bash`），反引号被当成命令替换。PowerShell 收到的
 * 已不是模型写的脚本，结果常是看似 PowerShell 语法错的报错，或在错误对象上照样执行下去。
 * 这些写法在 bash 双引号里没有合理用途，执行前拦下并说明改法，比执行一条被改过的脚本更安全。
 * 单引号、`\$` 转义与 `$(...)` 命令替换都不在此列。
 */

const POWERSHELL = /\b(?:powershell|pwsh)(?:\.exe)?\b/gi
/* PowerShell 自动变量与 `$env:`；以及 `$name =` 赋值（bash 会展开成 ` = ...`） */
const PS_VARIABLE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)?|\{[^}\n]+\}|\(|[0-9])/i

/** 从 PowerShell 命令名之后找本条命令里第一个双引号参数，返回 [起点, 终点)；没有则返回 null。 */
function doubleQuotedScript(command, from) {
  for (let i = from; i < command.length; i++) {
    const ch = command[i]
    if (ch === "'" || ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '<') return null
    if (ch === '"') {
      for (let j = i + 1; j < command.length; j++) {
        if (command[j] === '\\') j++
        else if (command[j] === '"') return [i + 1, j]
      }
      return [i + 1, command.length]
    }
  }
  return null
}

/** 返回第一处冲突的写法（如 `$_`、反引号），没有冲突返回 null。 */
export function findPowerShellQuotingConflict(command) {
  if (typeof command !== 'string') return null
  for (const match of command.matchAll(POWERSHELL)) {
    const range = doubleQuotedScript(command, match.index + match[0].length)
    if (!range) continue
    const [start, end] = range
    for (let i = start; i < end; i++) {
      const ch = command[i]
      if (ch === '\\') { i++; continue }
      if (ch === '`') return '`'
      if (ch === '$') {
        const hit = PS_VARIABLE.exec(command.slice(i, end))
        if (hit) return hit[0].replace(/\s*=$/, '')
      }
    }
  }
  return null
}

/* PowerShell 的 Verb-Noun 命令名：只认常见动词且首字母大写，bash 里没有这类可执行文件 */
const CMDLET = /^(?:Get|Set|New|Remove|Select|Where|ForEach|Measure|Write|Out|Test|Invoke|Join|Split|Sort|Format|Import|Export|Start|Stop|Copy|Move|Add|Clear|ConvertTo|ConvertFrom)-[A-Z][A-Za-z]+$/
/* 命令位置：行首，或在 ; | & ( 与 $( 之后 */
const COMMAND_POSITION = /(?:^|[;&|(\n])[ \t]*([A-Za-z]+-[A-Za-z]+)(?![\w-])/g

/** 把引号里的内容抹成空格，只保留 bash 真正当命令解析的部分；遇到 heredoc 返回 null（内容无法可靠区分）。 */
function unquoted(command) {
  if (/<<-?\s*['"\\]?\w/.test(command)) return null
  let out = ''
  let quote = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      if (ch === '\\' && quote === '"') { i++; out += '  '; continue }
      if (ch === quote) quote = null
      out += ch === '\n' ? '\n' : ' '
    } else if (ch === '\\') { i++; out += '  ' }
    else if (ch === "'" || ch === '"') { quote = ch; out += ' ' }
    else if (ch === '#' && (i === 0 || /\s/.test(command[i - 1]))) { while (i < command.length && command[i] !== '\n') i++; out += '\n' }
    else out += ch
  }
  return out
}

/**
 * bash 工具里直接写了 PowerShell 命令（如 `(Get-Content a | Measure-Object -Line).Lines`）时返回该命令名，否则 null。
 * 只看引号外的命令位置；整条命令里出现 powershell/pwsh 调用、heredoc 一律放行，宁可漏拦也不误拦。
 */
export function findPowerShellInBash(command) {
  if (typeof command !== 'string' || /\b(?:powershell|pwsh)(?:\.exe)?\b/i.test(command)) return null
  const text = unquoted(command)
  if (text === null) return null
  for (const match of text.matchAll(COMMAND_POSITION)) {
    if (CMDLET.test(match[1])) return match[1]
  }
  return null
}

export function powerShellInBashReason(name) {
  return `没有执行：这是 bash 工具，\`${name}\` 是 PowerShell 命令，bash 里没有它。请改用 bash 写法（如 \`wc -l\`、\`cat\`、\`grep\`、\`rg\`）；确实要用 PowerShell，就用 powershell 工具，或在 bash 里写 \`powershell -NoProfile -Command '...'\`（脚本用单引号包住）。`
}

export function powerShellConflictReason(token) {
  return `没有执行：这条命令在 bash 里用双引号把脚本交给 PowerShell，bash 会先处理其中的 ${token === '`' ? '反引号（当成命令替换）' : `\`${token}\`（当成 bash 变量展开）`}，PowerShell 收到的已经不是原脚本。` +
    '请改用单引号包住 -Command 的脚本（脚本里的单引号写成 \'\\\'\'），或先把脚本写进 .ps1 文件再用 -File 运行；确实要在双引号里写，就把 PowerShell 的 $ 和反引号写成 \\$、\\`。'
}
