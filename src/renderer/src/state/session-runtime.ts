import type {
  Attachment,
  ExtensionUiRequest,
  MainPush,
  MessagePatch,
  ModelInfo,
  QueueState,
  RuntimeEnvelope,
  SessionState,
  SessionStats,
  SessionTodo,
  SessionTodoSnapshot,
  SlashCommand,
  UIMessage,
  UIToolCall
} from '../../../shared/ipc'
import { applySyncDelta, mergeSyncHistory } from './session-message-merge'

export interface SessionRuntimeSnapshot {
  touchedAt?: number
  runtime: RuntimeEnvelope
  session: SessionState | null
  messages: UIMessage[]
  messagesLoaded: boolean
  stats: SessionStats | null
  queue: QueueState
  todos: SessionTodo[]
  todoHistory: SessionTodoSnapshot[]
  uiRequests: ExtensionUiRequest[]
  statuses: Record<string, string>
  widgets: Record<string, string[]>
  widgetPlacements: Record<string, 'aboveEditor' | 'belowEditor'>
  draft: string
  draftAttachments: Attachment[]
  draftInitialized?: boolean
  draftAttachmentsInitialized?: boolean
  models: ModelInfo[]
  thinkingLevels: string[]
  commands: SlashCommand[]
}

export type SessionRuntimeMap = Record<string, SessionRuntimeSnapshot>
let lastTouched = 0
const touch = (): number => (lastTouched = Math.max(Date.now(), lastTouched + 1))

export function sessionRuntimeKey(runtime: RuntimeEnvelope): string {
  return runtime.sessionId || `run:${runtime.runId}`
}

export function seedRuntimeHistory(
  map: SessionRuntimeMap,
  runtime: RuntimeEnvelope | undefined,
  messages: UIMessage[]
): SessionRuntimeMap {
  if (!runtime) return map
  const key = sessionRuntimeKey(runtime)
  const entry = map[key]
  if (!entry || entry.messagesLoaded) return map
  return { ...map, [key]: { ...entry, messagesLoaded: true, messages } }
}

function emptyRuntime(runtime: RuntimeEnvelope): SessionRuntimeSnapshot {
  return {
    runtime,
    session: null,
    messages: [],
    messagesLoaded: false,
    stats: null,
    queue: { steering: [], followUp: [] },
    todos: [],
    todoHistory: [],
    uiRequests: [],
    statuses: {},
    widgets: {},
    widgetPlacements: {},
    draft: '',
    draftAttachments: [],
    models: [],
    thinkingLevels: [],
    commands: []
  }
}

export type SessionRuntimeDataPatch = Partial<
  Pick<SessionRuntimeSnapshot, 'draft' | 'draftAttachments' | 'models' | 'thinkingLevels' | 'commands' | 'uiRequests'>
>

function draftInitialization(patch: SessionRuntimeDataPatch): Partial<SessionRuntimeSnapshot> {
  return {
    ...('draft' in patch ? { draftInitialized: true } : {}),
    ...('draftAttachments' in patch ? { draftAttachmentsInitialized: true } : {})
  }
}

export function updateSessionRuntime(
  map: SessionRuntimeMap,
  runtime: RuntimeEnvelope,
  patch: SessionRuntimeDataPatch
): SessionRuntimeMap {
  const key = sessionRuntimeKey(runtime)
  const previous = map[key]
  if (previous && runtime.generation < previous.runtime.generation) return map
  const base = previous ? { ...previous, runtime } : emptyRuntime(runtime)
  return { ...map, [key]: { ...base, ...patch, ...draftInitialization(patch), touchedAt: touch() } }
}

export function updateSessionRuntimeAt(
  map: SessionRuntimeMap,
  key: string,
  patch: SessionRuntimeDataPatch,
  seed: RuntimeEnvelope
): SessionRuntimeMap {
  if (!key) return map
  const previous = map[key]
  if (previous && seed.generation < previous.runtime.generation) return map
  const base = previous ? { ...previous, runtime: previous.runtime } : emptyRuntime(seed)
  return { ...map, [key]: { ...base, ...patch, ...draftInitialization(patch), touchedAt: touch() } }
}

function mergeMigratedRuntime(
  target: SessionRuntimeSnapshot | undefined,
  source: SessionRuntimeSnapshot,
  runtime: RuntimeEnvelope
): SessionRuntimeSnapshot {
  if (!target) return { ...source, runtime }
  return {
    ...target,
    runtime: target.runtime.generation >= runtime.generation ? target.runtime : runtime,
    draft: target.draft || source.draft,
    draftAttachments: (target.draftAttachments ?? []).length ? target.draftAttachments : source.draftAttachments ?? [],
    models: target.models.length ? target.models : source.models,
    thinkingLevels: target.thinkingLevels.length ? target.thinkingLevels : source.thinkingLevels,
    commands: target.commands.length ? target.commands : source.commands
  }
}

export function migrateSessionRuntime(
  map: SessionRuntimeMap,
  runtime: RuntimeEnvelope
): SessionRuntimeMap {
  if (!runtime.sessionId) return map
  const targetKey = sessionRuntimeKey(runtime)
  let out = map
  const sourceKeys = [`run:${runtime.runId}`, `pending:${runtime.runId}`]
  for (const sourceKey of sourceKeys) {
    if (sourceKey === targetKey) continue
    const source = out[sourceKey]
    if (!source) continue
    if (
      sourceKey.startsWith('pending:') &&
      runtime.generation !== undefined &&
      source.runtime.generation !== undefined &&
      source.runtime.generation !== runtime.generation
    ) {
      continue
    }
    out = { ...out, [targetKey]: mergeMigratedRuntime(out[targetKey], source, runtime) }
  }
  return out
}

function patchMessage(list: UIMessage[], id: string, patch: MessagePatch): UIMessage[] {
  const index = list.findIndex((message) => message.id === id)
  if (index < 0) return list
  const current = list[index]
  const { textDelta, thinkingDelta, ...fields } = patch
  const next: UIMessage = {
    ...current,
    ...fields,
    ...(textDelta === undefined ? {} : { text: current.text + textDelta }),
    ...(thinkingDelta === undefined
      ? {}
      : { thinking: (current.thinking ?? '') + thinkingDelta })
  }
  const out = list.slice()
  out[index] = next
  return out
}

function patchArtifact(list: UIMessage[], messageId: string, artifact: NonNullable<UIMessage['artifacts']>[number]): UIMessage[] {
  const index = list.findIndex((message) => message.id === messageId)
  if (index < 0) return list
  const current = list[index]
  if (current.artifacts?.some((item) => item.id === artifact.id)) return list
  const out = list.slice()
  out[index] = { ...current, artifacts: [...(current.artifacts ?? []), artifact] }
  return out
}

function patchTool(list: UIMessage[], msgId: string, call: UIToolCall, outputDelta?: string): UIMessage[] {
  const index = list.findIndex((message) => message.id === msgId)
  if (index < 0) return list
  const current = list[index]
  const calls = (current.toolCalls ?? []).slice()
  const callIndex = calls.findIndex((item) => item.id === call.id)
  if (callIndex < 0) {
    calls.push(outputDelta === undefined ? call : { ...call, output: outputDelta })
  } else {
    const old = calls[callIndex]
    calls[callIndex] = {
      ...old,
      ...call,
      ...(outputDelta === undefined ? {} : { output: (old.output ?? '') + outputDelta })
    }
  }
  const out = list.slice()
  out[index] = { ...current, toolCalls: calls }
  return out
}

export function reduceSessionRuntime(
  map: SessionRuntimeMap,
  runtime: RuntimeEnvelope,
  message: MainPush
): SessionRuntimeMap {
  const key = sessionRuntimeKey(runtime)
  const previous = map[key]
  if (previous && runtime.generation < previous.runtime.generation) {
    return map
  }

  let next = previous ? { ...previous, runtime } : emptyRuntime(runtime)
  switch (message.ch) {
    case 'sync': {
      const protectedTailId = previous?.session?.isStreaming ? previous.messages.at(-1)?.id : undefined
      next = { ...next, messagesLoaded: true, messages: mergeSyncHistory(message.payload, next.messages, protectedTailId) }
      break
    }
    case 'sync-delta': {
      const protectedTailId = previous?.session?.isStreaming ? previous.messages.at(-1)?.id : undefined
      const merged = applySyncDelta(next.messages, message.payload, protectedTailId)
      next = merged ? { ...next, messagesLoaded: true, messages: merged } : { ...next, messagesLoaded: false }
      break
    }
    case 'msg-add':
      next = { ...next, messagesLoaded: true, messages: [...next.messages, message.payload] }
      break
    case 'msg-update':
      next = { ...next, messages: patchMessage(next.messages, message.payload.id, message.payload.patch) }
      break
    case 'artifact':
      next = { ...next, messages: patchArtifact(next.messages, message.payload.messageId, message.payload.artifact) }
      break
    case 'tool':
      next = {
        ...next,
        messages: patchTool(next.messages, message.payload.msgId, message.payload.call, message.payload.outputDelta)
      }
      break
    case 'state':
      next = {
        ...next,
        session: message.payload,
        thinkingLevels: message.payload.availableThinkingLevels
      }
      break
    case 'stats':
      next = { ...next, stats: message.payload }
      break
    case 'queue':
      next = { ...next, queue: message.payload }
      break
    case 'todos':
      next = { ...next, todos: message.payload }
      break
    case 'todo-history':
      next = { ...next, todoHistory: message.payload }
      break
    case 'ui-request': {
      const existing = next.uiRequests.findIndex((item) => item.id === message.payload.id)
      next = {
        ...next,
        uiRequests:
          existing < 0
            ? [...next.uiRequests, message.payload]
            : next.uiRequests.map((item, index) => (index === existing ? message.payload : item))
      }
      break
    }
    case 'ui-deadline':
      next = {
        ...next,
        uiRequests: next.uiRequests.map((item) => item.id === message.payload.id
          ? { ...item, timeout: message.payload.timeout, deadline: message.payload.deadline }
          : item)
      }
      break
    case 'ui-resolved': {
      next = { ...next, uiRequests: next.uiRequests.filter((item) => item.id !== message.payload.id) }
      break
    }
    case 'status': {
      const statuses = { ...next.statuses }
      if (message.payload.text === undefined) delete statuses[message.payload.key]
      else statuses[message.payload.key] = message.payload.text
      next = { ...next, statuses }
      break
    }
    case 'widget': {
      const widgets = { ...next.widgets }
      const widgetPlacements = { ...next.widgetPlacements }
      if (!message.payload.lines?.length) {
        delete widgets[message.payload.key]
        delete widgetPlacements[message.payload.key]
      } else {
        widgets[message.payload.key] = message.payload.lines
        widgetPlacements[message.payload.key] = message.payload.placement === 'belowEditor' ? 'belowEditor' : 'aboveEditor'
      }
      next = { ...next, widgets, widgetPlacements }
      break
    }
    default:
      break
  }

  return { ...map, [key]: { ...next, touchedAt: touch() } }
}

const messageSizes = new WeakMap<UIMessage[], number>()
const individualSizes = new WeakMap<UIMessage, number>()
function historyBytes(messages: UIMessage[]): number {
  const cached = messageSizes.get(messages)
  if (cached !== undefined) return cached
  let bytes = 0
  for (const message of messages) {
    let size = individualSizes.get(message)
    if (size === undefined) {
      size = 0
      const pending: unknown[] = [message]
      const seen = new Set<object>()
      while (pending.length && size <= 32 * 1024 * 1024) {
        const value = pending.pop()
        if (typeof value === 'string') size += value.length * 2
        else if (value && typeof value === 'object' && !seen.has(value)) {
          seen.add(value)
          size += 64
          for (const item of Object.values(value)) pending.push(item)
        }
      }
      individualSizes.set(message, size)
    }
    bytes += size
    if (bytes > 32 * 1024 * 1024) break
  }
  messageSizes.set(messages, bytes)
  return bytes
}

const normDraftPath = (p?: string): string => (p ?? '').replace(/\\/g, '/').toLowerCase()

export function migratePathDraft(
  map: SessionRuntimeMap,
  sessionFile: string | undefined,
  sessionId: string | undefined
): SessionRuntimeMap {
  if (!sessionFile || !sessionId) return map
  const fromKey = `file:${normDraftPath(sessionFile)}`
  if (fromKey === sessionId) return map
  const from = map[fromKey]
  if (!from) return map
  const target = map[sessionId]
  const seen = new Set((target?.draftAttachments ?? []).map((item) => item.id))
  const incoming = (from.draftAttachments ?? []).filter((item) => !seen.has(item.id))
  const draft = [target?.draft, from.draft].filter(Boolean).join('\n')
  const nextTarget: SessionRuntimeSnapshot = {
    ...(target ?? emptyRuntime(from.runtime)),
    runtime: target?.runtime ?? from.runtime,
    draft,
    draftAttachments: incoming.length ? [...(target?.draftAttachments ?? []), ...incoming] : target?.draftAttachments ?? [],
    touchedAt: touch()
  }
  const out = { ...map, [sessionId]: nextTarget }
  delete out[fromKey]
  return out
}

export function pruneSessionRuntimes(map: SessionRuntimeMap, protectedKeys: ReadonlySet<string>): SessionRuntimeMap {
  const cold = Object.entries(map).filter(([key, value]) => !protectedKeys.has(key) &&
    !value.session?.isAgentRunning && !value.session?.isStreaming && !value.session?.isCompacting &&
    !value.uiRequests.length && !value.queue.steering.length && !value.queue.followUp.length)
    .sort((a, b) => (b[1].touchedAt ?? 0) - (a[1].touchedAt ?? 0))
  let count = 0
  let draftCount = 0
  let bytes = 0
  let out = map
  for (const [key, value] of cold) {
    const size = historyBytes(value.messages)
    if (!(value.draft && value.messages.length === 0) && count < 16 && bytes + size <= 32 * 1024 * 1024) { count += 1; bytes += size; continue }
    if (out === map) out = { ...map }
    if (value.draft && draftCount < 16) {
      draftCount += 1
      out[key] = {
        ...emptyRuntime(value.runtime),
        draft: value.draft,
        draftAttachments: (value.draftAttachments ?? []).slice(0, 20),
        touchedAt: value.touchedAt
      }
    } else delete out[key]
  }
  return out
}
