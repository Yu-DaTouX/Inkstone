import { lstatSync } from 'node:fs'
import { delimiter, join } from 'node:path'

const PWSH_TTL_MS = 60 * 1000
let pwshProbe

export function hasPwsh(env = process.env, { fresh = false, now = Date.now, ttlMs = PWSH_TTL_MS } = {}) {
  const searchPath = env.PATH ?? env.Path ?? ''
  const at = now()
  if (!fresh && pwshProbe?.searchPath === searchPath && at >= pwshProbe.at && at - pwshProbe.at < ttlMs) return pwshProbe.found
  const found = searchPath.split(delimiter).some((dir) => {
    try { return !!dir && !!lstatSync(join(dir, 'pwsh.exe')) } catch { return false }
  })
  pwshProbe = { searchPath, found, at }
  return found
}

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
  const plain = unquoted(command)
  for (const match of command.matchAll(POWERSHELL)) {
    if (plain !== null && plain.slice(match.index, match.index + match[0].length) !== match[0]) continue
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

export function powerShellInBashReason(name, exe = 'pwsh') {
  return `Not run: this is the bash tool and \`${name}\` is a PowerShell command that bash does not have. Use the bash equivalent (such as \`wc -l\`, \`cat\`, \`grep\`, \`rg\`); if you really need PowerShell, run \`${exe} -NoProfile -Command '...'\` from bash with the script in single quotes.`
}

export function powerShellConflictReason(token) {
  return `Not run: this command passes a double-quoted script from bash to PowerShell, and bash expands ${token === '`' ? 'the backtick (as command substitution)' : `\`${token}\` (as a bash variable)`} first, so PowerShell would not receive the original script. ` +
    'Wrap the -Command script in single quotes (write a single quote inside it as \'\\\'\'), or write the script to a .ps1 file and run it with -File; if it must stay in double quotes, escape PowerShell\'s $ and backtick as \\$ and \\`.'
}

const LEGACY_POWERSHELL = /(?:^|[;&|(\n])[ \t]*(?:[^\s;&|()]*[\\/])?powershell(?:\.exe)?(?=\s|$)/i

export function findLegacyPowerShell(command) {
  if (typeof command !== 'string') return false
  const text = unquoted(command)
  return text !== null && LEGACY_POWERSHELL.test(text)
}

export function legacyPowerShellReason() {
  return 'Not run: PowerShell 7 is installed here, so replace `powershell` / `powershell.exe` with `pwsh` and keep the other arguments. The built-in 5.1 garbles BOM-less scripts with non-ASCII text.'
}
