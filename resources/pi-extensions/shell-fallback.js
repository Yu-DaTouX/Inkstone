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

function toolName(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object' && typeof entry.name === 'string') return entry.name
  return ''
}

export const COMMAND_DESCRIPTION = 'What this command is for, in a few words of the user\'s language (shown to the user as the step title instead of the raw command), e.g. "查看构建日志" or "Run the unit tests".'

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
      operations: fileTransportOperations(core.createLocalBashOperations({ shellPath }), { preamble: UTF8_CONSOLE })
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
