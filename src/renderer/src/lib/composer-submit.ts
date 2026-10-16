import type { HostT } from './host-actions'
import type { Attachment } from '../../../shared/ipc'

export type ComposerAttachment = Attachment

export interface ComposerCommand {
  name: string
  source: 'yan' | 'pi' | 'extension' | 'skill' | 'prompt' | 'compatibility'
  executable: boolean
  description?: string
  availability?: string
}

export interface ComposerImage {
  data: string
  mimeType: string
}

export interface ComposerSessionInfo {
  sessionName?: string
  sessionId?: string
  messageCount?: number
  sessionFile?: string
  thinkingLevel?: string
}

export type ComposerCommandResult = { ok: boolean; error?: string } | void

export type NativeSessionAction =
  | 'tree'
  | 'import'
  | 'reload'
  | 'scoped-models'
  | 'trust'
  | 'share'
  | 'export-jsonl'
  | 'new-session'

export interface ComposerSendActions {
  runBash(command: string, options?: { excludeFromContext?: boolean }): ComposerCommandResult | Promise<ComposerCommandResult>
  openSettings(tab?: string): void
  newSession(): void | Promise<unknown>
  compact(customInstructions?: string): ComposerCommandResult | Promise<ComposerCommandResult>
  openBrowser(url?: string): void | Promise<void>
  setModel(provider: string, id: string): void | Promise<unknown>
  exportHtml(outputPath?: string): ComposerCommandResult | Promise<ComposerCommandResult>
  copyLastReply(): void | Promise<void>
  clone(): void | Promise<void>
  setManualTitle(id: string, title: string): void | Promise<void>
  setThinking(level: string): void | Promise<void>
  nativeSession?(action: NativeSessionAction, args?: string): Promise<ComposerCommandResult>
  notify(level: 'info' | 'error', text: string): void
}

export interface ComposerSubmitPort {
  text: string
  attachments: ComposerAttachment[]
  commands: ComposerCommand[]
  models: { provider: string; id: string; name: string }[]
  t: HostT
  actions: ComposerSendActions
  session: ComposerSessionInfo | null
  thinkingLevels: string[]
  roundRunning: boolean
  isCompacting: boolean
  clearText: () => void
  clearAll: () => void
  restoreText: (raw: string) => void
  restoreAttachments: (saved: ComposerAttachment[]) => void
  readAttachments: () => ComposerAttachment[]
  send: (outgoing: string, images: ComposerImage[] | undefined, mode?: 'steer' | 'followUp') => Promise<boolean>
  holdSend: (outgoing: string, images?: ComposerImage[]) => void
  focusComposer: () => void
}

export type ComposerSubmitOutcome = 'empty' | 'handled' | 'sent' | 'queued'

export async function submitComposerInput(port: ComposerSubmitPort): Promise<ComposerSubmitOutcome> {
  const raw = port.text.trim()

  if (!raw && port.attachments.length === 0) return 'empty'

  if (port.text.startsWith('!')) {
    const excludeFromContext = port.text.startsWith('!!')
    const cmd = raw.slice(excludeFromContext ? 2 : 1).trim()
    if (!cmd) return 'empty'
    const saved = port.readAttachments()
    port.clearText()
    let result: ComposerCommandResult
    try {
      result = await port.actions.runBash(cmd, excludeFromContext ? { excludeFromContext: true } : undefined)
    } catch (error) {
      port.restoreAttachments(saved)
      port.restoreText(raw)
      port.actions.notify('error', error instanceof Error ? error.message : `!${cmd} 执行失败`)
      return 'handled'
    }
    if (result && result.ok === false) {
      port.restoreAttachments(saved)
      port.restoreText(raw)
    }
    return 'handled'
  }

  const images = port.attachments
    .filter((a) => a.kind !== 'file')
    .map((a) => ({ data: a.data, mimeType: a.mimeType }))
  const fileRefs = port.attachments.filter((a) => a.kind === 'file' && a.path)
  const outgoing = fileRefs.length
    ? `${raw ? raw + '\n\n' : ''}${port.t('composer.fileRefs', {
        list: fileRefs.map((a) => `- ${a.path}`).join('\n')
      })}`
    : raw

  if (raw === '/login' || raw.startsWith('/login ')) {
    port.clearAll()
    port.actions.openSettings('auth')
    return 'handled'
  }

  const localMatch = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(raw)
  const localName = localMatch?.[1]?.toLowerCase()
  const localArgs = localMatch?.[2]?.trim() ?? ''
  const localCommand = localName
    ? port.commands.find((command) => command.source === 'yan' && command.name.toLowerCase() === localName)
    : undefined
  const compatibilityCommand = localName
    ? port.commands.find((command) => command.source === 'compatibility' && command.name.toLowerCase() === localName)
    : undefined

  if (compatibilityCommand || (localCommand && !localCommand.executable)) {
    const command = compatibilityCommand ?? localCommand
    port.actions.notify('info', port.t('composer.compatCommand', { cmd: `/${command?.name ?? localName ?? ''}` }))
    const note = command?.availability ?? command?.description
    if (note) port.actions.notify('info', note)
    port.focusComposer()
    return 'handled'
  }

  if (localCommand) {
    return runLocalCommand(port, localName ?? '', localArgs)
  }

  if (port.roundRunning) {
    if (port.isCompacting) {
      port.holdSend(outgoing, images.length ? images : undefined)
      port.clearAll()
      return 'queued'
    }
    const saved = port.readAttachments()
    port.clearAll()
    const sent = await port.send(outgoing, images.length ? images : undefined, 'followUp')
    if (!sent) {
      port.restoreAttachments(saved)
      port.restoreText(raw)
    }
    return 'queued'
  }

  const saved = port.readAttachments()
  port.clearAll()
  const sent = await port.send(outgoing, images.length ? images : undefined)
  if (!sent) {
    port.restoreAttachments(saved)
    port.restoreText(raw)
  }
  return 'sent'
}

const SESSION_MUTATING_COMMANDS = new Set(['import', 'reload'])

const NATIVE_SESSION_ACTIONS: Record<string, NativeSessionAction> = {
  tree: 'tree',
  import: 'import',
  reload: 'reload',
  'scoped-models': 'scoped-models',
  trust: 'trust',
  share: 'share'
}

function isCommandFailure(result: ComposerCommandResult): result is { ok: false; error?: string } {
  return !!result && typeof result === 'object' && result.ok === false
}

async function runLocalCommand(port: ComposerSubmitPort, name: string, args: string): Promise<ComposerSubmitOutcome> {
  const { actions: a } = port

  if (name === 'model') {
    const spec = args.toLowerCase()
    const selected = spec
      ? port.models.find((model) => {
          const full = `${model.provider}/${model.id}`.toLowerCase()
          return full === spec || model.id.toLowerCase() === spec || model.name.toLowerCase() === spec
        })
      : undefined
    if (!selected) {
      a.openSettings('status')
      return 'handled'
    }
    port.clearAll()
    await a.setModel(selected.provider, selected.id)
    return 'handled'
  }

  if (port.roundRunning && SESSION_MUTATING_COMMANDS.has(name)) {
    a.notify('info', `/${name} 本轮运行中不可用，先停止当前回合再执行`)
    port.focusComposer()
    return 'handled'
  }

  if (name === 'new' && args) return runNativeSessionCommand(port, 'new-session', args, name)
  if (name === 'compact') {
    return runResultCommand(port, () => a.compact(args || undefined), name)
  }
  if (name === 'export') {
    const path = args.length > 1 && ((args.startsWith('"') && args.endsWith('"')) || (args.startsWith("'") && args.endsWith("'"))) ? args.slice(1, -1) : args
    if (/\.jsonl$/i.test(path)) return runNativeSessionCommand(port, 'export-jsonl', path, name)
    return runResultCommand(port, () => a.exportHtml(path || undefined), name)
  }
  const action = NATIVE_SESSION_ACTIONS[name]
  if (action) return runNativeSessionCommand(port, action, args, name)

  port.clearAll()
  if (name === 'new') await a.newSession()
  else if (name === 'browser') await a.openBrowser(args || undefined)
  else await runYanBuiltin(port, name, args)
  return 'handled'
}

async function runResultCommand(
  port: ComposerSubmitPort,
  run: () => ComposerCommandResult | Promise<ComposerCommandResult>,
  name: string
): Promise<ComposerSubmitOutcome> {
  const result = await run()
  if (isCommandFailure(result)) {
    port.actions.notify('error', result.error || `/${name} 执行失败`)
    port.focusComposer()
    return 'handled'
  }
  port.clearAll()
  return 'handled'
}

async function runNativeSessionCommand(
  port: ComposerSubmitPort,
  action: NativeSessionAction,
  args: string,
  name: string
): Promise<ComposerSubmitOutcome> {
  const native = port.actions.nativeSession
  if (!native) {
    port.actions.notify('info', `/${name} 在当前版本尚未接入`)
    port.focusComposer()
    return 'handled'
  }
  return runResultCommand(port, () => native(action, args || undefined), name)
}

export async function runYanBuiltin(port: ComposerSubmitPort, name: string, args: string): Promise<void> {
  const { actions: a, t } = port
  if (name === 'settings') a.openSettings()
  else if (name === 'export') await a.exportHtml(args || undefined)
  else if (name === 'copy') await a.copyLastReply()
  else if (name === 'clone') await a.clone()
  else if (name === 'name') {
    if (args) await a.setManualTitle('', args)
    else a.notify('info', t('composer.nameUsage'))
  } else if (name === 'thinking') {
    const levels = port.thinkingLevels
    const level = args.toLowerCase()
    if (!level) a.notify('info', t('composer.thinkingCurrent', { level: port.session?.thinkingLevel ?? 'off', levels: levels.join(' / ') || t('composer.thinkingUnsupported') }))
    else if (levels.includes(level)) await a.setThinking(level)
    else a.notify('error', t('composer.thinkingMissing', { level: args, levels: levels.join(' / ') || t('composer.none') }))
  } else if (name === 'session') {
    const info = port.session
    const lines = [
      info?.sessionName || info?.sessionId || t('composer.sessionNotStarted'),
      info ? t('composer.messageCount', { n: info.messageCount ?? 0 }) : '',
      info?.sessionFile ?? ''
    ].filter(Boolean)
    a.notify('info', lines.join(' · '))
  }
}
