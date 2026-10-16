/**
 * 输入框提交分发（Composer 与命令面板共用）。
 *
 * 为什么单独提出来：命令面板里选中一条斜杠命令，必须和「在输入框里敲出它再回车」
 * 走**完全同一段逻辑** —— 本地命令执行、兼容命令给说明、其余按普通输入发送。
 * 抽成这个不依赖 React / store 的模块后，两边调用同一函数，面板不可能私走 IPC，
 * 也不会退化成「只把命令填进草稿假装执行」。纯逻辑还可以在 Node 里直接验证。
 *
 * 唯一的副作用出口是 `ComposerSubmitPort`：调用方把草稿、附件与 store 动作接进来。
 */

import type { HostT } from './host-actions'
import type { Attachment } from '../../../shared/ipc'

/** 失败恢复必须保留名称、尺寸和预览等完整附件数据。 */
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

/** 命令动作可以返回结果；`ok:false` 视为失败，草稿与附件必须保留。 */
export type ComposerCommandResult = { ok: boolean; error?: string } | void

/**
 * 由主会话实现的原生会话操作，与 pi 的 `/tree`、`/import`、`/reload`、
 * `/scoped-models`、`/trust`、`/share` 以及 JSONL 导出一一对应，
 * 动作名与 `shared/native-session-host.ts` 对齐。未接入时可以省略。
 */
export type NativeSessionAction =
  | 'tree'
  | 'import'
  | 'reload'
  | 'scoped-models'
  | 'trust'
  | 'share'
  | 'export-jsonl'
  | 'new-session'

/** 分发会调用到的正式 store 动作子集。 */
export interface ComposerSendActions {
  /** `!!` 前缀按 pi 原生语义执行，但把输出排除在模型上下文之外。返回成功 / 失败供直执行恢复输入。 */
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
  /** 当前草稿原文（未 trim） */
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
  /** 清空文字（`!` 直执行只清文字，不动附件） */
  clearText: () => void
  /** 清空文字与附件（命令已消费 / 正常发送） */
  clearAll: () => void
  /** 发送失败：把丢掉的那段文字放回草稿 */
  restoreText: (raw: string) => void
  /** 发送失败：把丢掉的附件并回 store */
  restoreAttachments: (saved: ComposerAttachment[]) => void
  /** 取当前附件快照（发送失败恢复用） */
  readAttachments: () => ComposerAttachment[]
  send: (outgoing: string, images: ComposerImage[] | undefined, mode?: 'steer' | 'followUp') => Promise<boolean>
  holdSend: (outgoing: string, images?: ComposerImage[]) => void
  /** 兼容命令反馈后把焦点还给输入框 */
  focusComposer: () => void
}

/** 分发结果：给命令面板判断动作是否被消费（用于决定是否关闭面板）。 */
export type ComposerSubmitOutcome = 'empty' | 'handled' | 'sent' | 'queued'

/**
 * 输入框提交的完整分发。行为与重构前逐行一致，只把「怎么取/写草稿、怎么发送」
 * 变成 port 回调。
 */
export async function submitComposerInput(port: ComposerSubmitPort): Promise<ComposerSubmitOutcome> {
  const raw = port.text.trim()

  /* 文字与附件至少有一个才能提交（只发图片也必须能走） */
  if (!raw && port.attachments.length === 0) return 'empty'

  /* `!` / `!!` 开头的走直接执行，不进模型（图片对它无意义）。
   * `!!` 是 pi 的原生语义：命令仍然执行、结果存进会话，但排除在模型上下文之外。
   * 与旧行为一致：用**未 trim** 的原文判前缀，避免前导空格改变语义。 */
  if (port.text.startsWith('!')) {
    const excludeFromContext = port.text.startsWith('!!')
    const cmd = raw.slice(excludeFromContext ? 2 : 1).trim()
    if (!cmd) return 'empty'
    /* 先记下附件：失败时和命令原文一起放回（成功沿用既有「只清文字」行为）。 */
    const saved = port.readAttachments()
    port.clearText()
    let result: ComposerCommandResult
    try {
      result = await port.actions.runBash(cmd, excludeFromContext ? { excludeFromContext: true } : undefined)
    } catch (error) {
      /* 抛异常也按失败恢复；restoreText 是追加式，不覆盖 await 期间用户新敲的草稿。 */
      port.restoreAttachments(saved)
      port.restoreText(raw)
      port.actions.notify('error', error instanceof Error ? error.message : `!${cmd} 执行失败`)
      return 'handled'
    }
    /* 旧实现 / 未接线返回 void 视为已执行：保持原行为，不把命令塞回草稿。 */
    if (result && result.ok === false) {
      port.restoreAttachments(saved)
      port.restoreText(raw)
    }
    return 'handled'
  }

  const images = port.attachments
    .filter((a) => a.kind !== 'file')
    .map((a) => ({ data: a.data, mimeType: a.mimeType }))
  /* 文件引用不拼内容，只把路径交给模型让它自己 read */
  const fileRefs = port.attachments.filter((a) => a.kind === 'file' && a.path)
  const outgoing = fileRefs.length
    ? `${raw ? raw + '\n\n' : ''}${port.t('composer.fileRefs', {
        list: fileRefs.map((a) => `- ${a.path}`).join('\n')
      })}`
    : raw

  /*
   * `/login` 不能当普通消息发给模型：pi 的订阅制登录是交互式的（OAuth 开浏览器、
   * 回调回连 localhost），RPC 里没有 login。路由到「设置 → 模型」。
   */
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

  /*
   * 兼容命令在桌面端没有可执行动作：草稿与附件原样保留，只推说明，
   * 不静默清空、也不当消息发给模型。
   */
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

  /* 运行中默认加入 follow-up 队列；压缩维护期间先保留，结束后再投递。 */
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

/**
 * 运行中包含会话替换 / 资源重载的命令：明确拒绝而不是丢草稿。
 * `/tree` 只打开浏览，`/scoped-models`、`/trust`、`/share` 不动当前回合，
 * 因此只拦下会替换会话（import）或重载资源（reload）的两条。
 *
 * 下面的提示暂用原文（store 的本地通知也是同样做法）；
 * 主会话接入 i18n 时可换成 `composer.commandRunning` / `composer.commandUnavailable` /
 * `composer.commandFailed` 三个键。
 */
const SESSION_MUTATING_COMMANDS = new Set(['import', 'reload'])

/** 走主会话原生会话接口的新增命令。 */
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

/**
 * 执行一个桌面端本地命令。
 *
 * 顺序很重要：会返回结果的命令**先执行、成功后才清空**草稿；失败时草稿与附件
 * 留在输入框并报告 pi / 主进程给的原文，不会出现「清了草稿才发现命令没跑成」。
 * 纯 UI 命令（browser / settings …）没有结果可判，沿用既有顺序。
 */
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
    /* 主会话尚未接入时不能假装成功：保留草稿并给出说明，不制造无效果按钮。 */
    port.actions.notify('info', `/${name} 在当前版本尚未接入`)
    port.focusComposer()
    return 'handled'
  }
  return runResultCommand(port, () => native(action, args || undefined), name)
}

/** 桌面端承接的 pi 内置命令（不含已单独路由的 model / new / compact / browser / login）。 */
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
