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
const PS_VARIABLE = /^\$(?:_(?![A-Za-z0-9_])|PSItem\b|PSVersionTable\b|PSScriptRoot\b|LASTEXITCODE\b|env:[A-Za-z_]|true\b|false\b|null\b|args\b|input\b|Matches\b|Error\b|host\b|[A-Za-z_][A-Za-z0-9_]*\s*=(?!=))/

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

export function powerShellConflictReason(token) {
  return `没有执行：这条命令在 bash 里用双引号把脚本交给 PowerShell，bash 会先处理其中的 ${token === '`' ? '反引号（当成命令替换）' : `\`${token}\`（当成 bash 变量展开）`}，PowerShell 收到的已经不是原脚本。` +
    '请改用单引号包住 -Command 的脚本（脚本里的单引号写成 \'\\\'\'），或先把脚本写进 .ps1 文件再用 -File 运行；确实要在双引号里写，就把 PowerShell 的 $ 和反引号写成 \\$、\\`。'
}
