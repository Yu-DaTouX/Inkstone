const POWERSHELL = /\b(?:powershell|pwsh)(?:\.exe)?\b/gi
const PS_VARIABLE = /^\$(?:_(?![A-Za-z0-9_])|PSItem\b|PSVersionTable\b|PSScriptRoot\b|LASTEXITCODE\b|env:[A-Za-z_]|true\b|false\b|null\b|args\b|input\b|Matches\b|Error\b|host\b|[A-Za-z_][A-Za-z0-9_]*\s*=(?!=))/

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

const CMDLET = /^(?:Get|Set|New|Remove|Select|Where|ForEach|Measure|Write|Out|Test|Invoke|Join|Split|Sort|Format|Import|Export|Start|Stop|Copy|Move|Add|Clear|ConvertTo|ConvertFrom)-[A-Z][A-Za-z]+$/
const COMMAND_POSITION = /(?:^|[;&|(\n])[ \t]*([A-Za-z]+-[A-Za-z]+)(?![\w-])/g

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

const LEGACY_POWERSHELL = /(?:^|[;&|(\n])[ \t]*(?:[^\s;&|()]*[\\/])?powershell(?:\.exe)?(?=\s|$)/i

export function findLegacyPowerShell(command) {
  if (typeof command !== 'string') return false
  const text = unquoted(command)
  return text !== null && LEGACY_POWERSHELL.test(text)
}

export function legacyPowerShellReason() {
  return '没有执行：这台设备已装 PowerShell 7，请把命令里的 `powershell` / `powershell.exe` 改成 `pwsh`。系统自带的 5.1 按系统代码页读取无 BOM 的 .ps1，含中文的脚本会乱码或解析失败；pwsh 默认按 UTF-8 读取，参数写法不变。'
}
