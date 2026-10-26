import { spawn } from 'node:child_process'
import { existsSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileTransportOperations } from './shell-transport.js'
import { createPythonEnvFixer } from './windows-python.js'
import { findLegacyPowerShell, findPowerShellInBash, legacyPowerShellReason, findPowerShellQuotingConflict, powerShellConflictReason, powerShellInBashReason } from './windows-powershell.js'

function hasPwsh() {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => {
    try { return !!dir && !!lstatSync(join(dir, 'pwsh.exe')) } catch { return false }
  })
}

const UTF8_CONSOLE ='chcp.com 65001 >/dev/null 2>&1'

const UTF8_CONSOLE_WHITELIST = new Set(('git rg grep egrep fgrep sed awk gawk cat head tail ls find wc sort uniq cut tr diff cmp comm paste join ' +
  'echo printf cd pwd mkdir rmdir rm cp mv touch ln chmod stat du df file basename dirname realpath readlink cygpath tee ' +
  'date sleep true false test [ jq tar gzip gunzip unzip sha1sum sha256sum md5sum base64 od xxd nl column which type export set gh curl ' +
  'unset pushd popd local return exit read shopt wait kill alias yan').split(' '))

const WRAPPER_ARGS = {
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  xargs: new Set(['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a']),
  nohup: new Set(),
  time: new Set(),
  command: new Set(),
  nice: new Set(['-n'])
}

function simpleCommands(script) {
  const commands = []
  let current = ''
  let quote = ''
  let atWordStart = true
  for (let i = 0; i < script.length; i++) {
    const c = script[i]
    if (quote === "'") {
      current += c
      if (c === "'") quote = ''
      atWordStart = false
      continue
    }
    if (c === '\\') {
      current += c + (script[i + 1] ?? '')
      i++
      atWordStart = false
      continue
    }
    if (c === '`') return null
    if (c === '$' && script[i + 1] === '(') return null
    if (quote === '"') {
      current += c
      if (c === '"') quote = ''
      atWordStart = false
      continue
    }
    if (c === '#' && atWordStart) {
      while (i < script.length && script[i] !== '\n') i++
      i--
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      current += c
      atWordStart = false
      continue
    }
    if (c === '(' || c === ')') return null
    if (c === '<' && script[i + 1] === '<') return null
    if (c === '&' && (script[i - 1] === '>' || script[i - 1] === '<' || script[i + 1] === '>')) {
      current += c
      atWordStart = false
      continue
    }
    if (c === '|' || c === '&' || c === ';' || c === '\n') {
      commands.push(current)
      current = ''
      atWordStart = true
      continue
    }
    if (c === ' ' || c === '\t') {
      current += c
      atWordStart = true
      continue
    }
    current += c
    atWordStart = false
  }
  if (quote) return null
  commands.push(current)
  return commands.map((s) => s.trim()).filter(Boolean)
}

function wrappedPrograms(command) {
  const words = command.split(/\s+/).filter(Boolean)
  let i = 0
  for (;;) {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++
    const wrapper = WRAPPER_ARGS[words[i]]
    if (!wrapper) break
    const name = words[i++]
    while (i < words.length && words[i].startsWith('-')) i += wrapper.has(words[i]) ? 2 : 1
    if (name === 'timeout') i++
  }
  const program = words[i]
  const programs = [program]
  if (program === 'find') {
    for (let j = i + 1; j < words.length; j++) {
      if (words[j] === '-exec' || words[j] === '-execdir' || words[j] === '-ok' || words[j] === '-okdir') {
        programs.push(words[j + 1])
        break
      }
    }
  }
  return programs
}

export function needsUtf8Console(command) {
  const script = typeof command === 'string' ? command : ''
  const commands = simpleCommands(script)
  if (commands === null) return true
  for (const simple of commands) {
    for (const program of wrappedPrograms(simple)) {
      if (program === undefined) continue
      if (!UTF8_CONSOLE_WHITELIST.has(program)) return true
    }
  }
  return false
}

function defaultQueryUtf8CodePage() {
  return new Promise((resolve) => {
    try {
      const child = spawn('chcp.com', [], { windowsHide: true })
      let out = ''
      child.stdout?.on('data', (chunk) => { out += chunk.toString() })
      child.on('error', () => resolve(false))
      child.on('close', () => resolve(/65001/.test(out)))
    } catch {
      resolve(false)
    }
  })
}

export function createUtf8ConsolePreamble({ queryUtf8CodePage = defaultQueryUtf8CodePage, env = process.env } = {}) {
  let cachedUtf8CodePage
  let pendingQuery
  function isUtf8CodePage() {
    if (cachedUtf8CodePage !== undefined) return Promise.resolve(cachedUtf8CodePage)
    if (!pendingQuery) {
      pendingQuery = Promise.resolve().then(queryUtf8CodePage).catch(() => false).then((result) => {
        cachedUtf8CodePage = !!result
        return cachedUtf8CodePage
      })
    }
    return pendingQuery
  }
  return async function utf8ConsolePreamble(command) {
    if (env.YAN_BASH_UTF8_CONSOLE === 'always') return UTF8_CONSOLE
    if (await isUtf8CodePage()) return ''
    return needsUtf8Console(command) ? UTF8_CONSOLE : ''
  }
}

const utf8ConsolePreamble = createUtf8ConsolePreamble()

function toolName(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object' && typeof entry.name === 'string') return entry.name
  return ''
}

const COMMAND_DESCRIPTION = 'What this command is for, in a few words of the user\'s language (shown to the user as the step title instead of the raw command), e.g. "查看构建日志" or "Run the unit tests".'

export function withDescriptionParameter(parameters) {
  const plain = JSON.parse(JSON.stringify(parameters ?? { type: 'object', properties: {} }))
  return {
    ...plain,
    properties: { ...(plain.properties ?? {}), description: { type: 'string', description: COMMAND_DESCRIPTION } }
  }
}

export function registerBashFileTransport(pi, core, { fixEnv = createPythonEnvFixer({ shimDir: join(tmpdir(), 'yan-python-shim') }) } = {}) {
  const spawnHook = (context) => ({ ...context, env: fixEnv(context.env) })
  const bashTool = (cwd) => {
    const settings = core.SettingsManager.create(cwd)
    const shellPath = settings.getShellPath()
    return core.createBashToolDefinition(cwd, {
      shellPath,
      commandPrefix: settings.getShellCommandPrefix(),
      spawnHook,
      operations: fileTransportOperations(core.createLocalBashOperations({ shellPath }), { preamble: utf8ConsolePreamble })
    })
  }
  const template = core.createBashToolDefinition(process.cwd())
  pi.registerTool({
    ...template,
    parameters: withDescriptionParameter(template.parameters),
    execute: (toolCallId, params, signal, onUpdate, ctx) => {
      const { description: _description, ...rest } = params ?? {}
      return bashTool(ctx?.cwd ?? process.cwd()).execute(toolCallId, rest, signal, onUpdate, ctx)
    }
  })
}

async function loadPiCore() {
  try {
    return await import('@earendil-works/pi-coding-agent')
  } catch (error) {
    const index = process.argv[1] ? join(dirname(process.argv[1]), 'index.js') : ''
    if (!index || !existsSync(index)) throw error
    return await import(pathToFileURL(index).href)
  }
}

export default async function shellFallback(pi) {
  if (process.env.YAN_SHELL === 'powershell') {
    pi.on('before_agent_start', () => {
      try {
        const names = (pi.getActiveTools?.() ?? []).map(toolName).filter(Boolean)
        if (names.includes('powershell') && !names.includes('bash')) return
        const next = names.filter((name) => name !== 'bash')
        if (!next.includes('powershell')) next.push('powershell')
        pi.setActiveTools?.(next)
      } catch {
      }
    })
    return
  }
  if (process.platform !== 'win32') return
  try {
    registerBashFileTransport(pi, await loadPiCore())
  } catch {
  }
  pi.on('tool_call', (event) => {
    if (event?.toolName !== 'bash') return undefined
    const command = event.input?.command
    const token = findPowerShellQuotingConflict(command)
    if (token) return { block: true, reason: powerShellConflictReason(token) }
    const cmdlet = findPowerShellInBash(command)
    if (cmdlet) return { block: true, reason: powerShellInBashReason(cmdlet) }
    return findLegacyPowerShell(command) && hasPwsh() ? { block: true, reason: legacyPowerShellReason() } : undefined
  })
}
