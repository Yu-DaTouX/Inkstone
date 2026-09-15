/**
 * 按会话保存后台运行时状态。
 *
 * 这层是渲染端的“事实缓存”，不是第二套 UI：App 仍然把活动会话投影到
 * store 顶层字段，后台会话则在这里持续接收增量。切回会话时，主进程仍会
 * 发权威 sync；因此缓存既能让后台状态不丢，也不会把旧快照当成最终真相。
 */
import type {
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
  SubagentRun,
  UIMessage,
  UIToolCall
} from '../../../shared/ipc'

export interface SessionRuntimeSnapshot {
  runtime: RuntimeEnvelope
  session: SessionState | null
  messages: UIMessage[]
  stats: SessionStats | null
  queue: QueueState
  todos: SessionTodo[]
  todoHistory: SessionTodoSnapshot[]
  uiRequests: ExtensionUiRequest[]
  statuses: Record<string, string>
  widgets: Record<string, string[]>
  subagents: SubagentRun[]
  /** 输入框草稿；图片二进制不进缓存，避免把大块数据挂在会话状态上。 */
  draft: string
  /** 当前会话最近一次成功拉到的能力/命令快照。 */
  models: ModelInfo[]
  thinkingLevels: string[]
  commands: SlashCommand[]
}

export type SessionRuntimeMap = Record<string, SessionRuntimeSnapshot>

/** sessionId 是主键；启动早期还没有 sessionId 时用 runId 临时占位。 */
export function sessionRuntimeKey(runtime: RuntimeEnvelope): string {
  return runtime.sessionId || `run:${runtime.runId}`
}

function emptyRuntime(runtime: RuntimeEnvelope): SessionRuntimeSnapshot {
  return {
    runtime,
    session: null,
    messages: [],
    stats: null,
    queue: { steering: [], followUp: [] },
    todos: [],
    todoHistory: [],
    uiRequests: [],
    statuses: {},
    widgets: {},
    subagents: [],
    draft: '',
    models: [],
    thinkingLevels: [],
    commands: []
  }
}

export type SessionRuntimeDataPatch = Partial<
  Pick<SessionRuntimeSnapshot, 'draft' | 'models' | 'thinkingLevels' | 'commands'>
>

/**
 * 写入不由 MainPush 直接携带的会话数据（草稿、能力列表、命令列表）。
 *
 * 这些写入同样经过 generation 闸门：快速切换/复用运行实例时，迟到的
 * 旧请求不能把新会话的列表或草稿覆盖掉。返回新 map，不修改调用方对象。
 */
export function updateSessionRuntime(
  map: SessionRuntimeMap,
  runtime: RuntimeEnvelope,
  patch: SessionRuntimeDataPatch
): SessionRuntimeMap {
  const key = sessionRuntimeKey(runtime)
  const previous = map[key]
  if (previous && runtime.generation < previous.runtime.generation) return map
  const base = previous ? { ...previous, runtime } : emptyRuntime(runtime)
  return { ...map, [key]: { ...base, ...patch } }
}

/**
 * 启动早期的 runtime 可能暂时只有 `run:${runId}` 这个 key；pi 首次 state
 * 到达后才会给出稳定 sessionId。把尚未投影的数据迁移过去，避免草稿/能力
 * 列表在 Composer 切换 key 的瞬间消失。旧 key 暂不删除，防止仍在飞行的
 * 早期事件失去落点；运行实例回收时再统一清理。
 */
export function migrateSessionRuntime(
  map: SessionRuntimeMap,
  runtime: RuntimeEnvelope
): SessionRuntimeMap {
  if (!runtime.sessionId) return map
  const pendingKey = `run:${runtime.runId}`
  const targetKey = sessionRuntimeKey(runtime)
  const pending = map[pendingKey]
  if (!pending || pendingKey === targetKey) return map
  const target = map[targetKey]
  const merged: SessionRuntimeSnapshot = target
    ? {
        ...target,
        runtime: target.runtime.generation >= runtime.generation ? target.runtime : runtime,
        draft: target.draft || pending.draft,
        models: target.models.length ? target.models : pending.models,
        thinkingLevels: target.thinkingLevels.length ? target.thinkingLevels : pending.thinkingLevels,
        commands: target.commands.length ? target.commands : pending.commands
      }
    : { ...pending, runtime }
  return { ...map, [targetKey]: merged }
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

/**
 * 把一条带身份的主进程事件归并到对应会话。
 * 旧代次只会返回原 map；这条规则是后台切换不串线的第二道闸门。
 */
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
    case 'sync':
      next = { ...next, messages: message.payload }
      break
    case 'msg-add':
      next = { ...next, messages: [...next.messages, message.payload] }
      break
    case 'msg-update':
      next = { ...next, messages: patchMessage(next.messages, message.payload.id, message.payload.patch) }
      break
    case 'msg-remove':
      next = { ...next, messages: next.messages.filter((item) => item.id !== message.payload) }
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
    case 'status': {
      const statuses = { ...next.statuses }
      if (message.payload.text === undefined) delete statuses[message.payload.key]
      else statuses[message.payload.key] = message.payload.text
      next = { ...next, statuses }
      break
    }
    case 'widget': {
      const widgets = { ...next.widgets }
      if (!message.payload.lines?.length) delete widgets[message.payload.key]
      else widgets[message.payload.key] = message.payload.lines
      next = { ...next, widgets }
      break
    }
    case 'subagent': {
      const index = next.subagents.findIndex((item) => item.id === message.payload.id)
      next = {
        ...next,
        subagents:
          index < 0
            ? [...next.subagents, message.payload]
            : next.subagents.map((item, i) => (i === index ? message.payload : item))
      }
      break
    }
    case 'subagent-remove':
      next = { ...next, subagents: next.subagents.filter((item) => item.id !== message.payload) }
      break
    default:
      /* 全局推送，或只影响标题/日志的事件，不写入会话缓存。 */
      break
  }

  return { ...map, [key]: next }
}
