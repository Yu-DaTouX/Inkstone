import { uiText } from '../../i18n/ui-text'
import { isCapabilityResponseStale } from '../capability-request'
import { keepRef } from '../stable-ref'
import { sessionRuntimeKey, updateSessionRuntime } from '../session-runtime'
import { THINK_LABEL } from '../think-label'
import type { Store } from '../store'
import { runtimeForState, sessionActionTarget } from './runtime'
import { piCall, pushNotice, type SliceContext } from './shared'

function readCommandUse(): Record<string, number> {
  try {
    const raw = localStorage.getItem('yan.cmdUse')
    const j = raw ? (JSON.parse(raw) as unknown) : null
    if (!j || typeof j !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

let capabilityRequestSeq = 0

let commandRequestSeq = 0

function thinkLabelOf(level: string): string {
  const key = THINK_LABEL[level]
  return key ? uiText(key) : level
}

export type ModelSlice = Pick<Store, 'models' | 'thinkingLevels' | 'commands' | 'commandsAt' | 'authProviders' | 'commandUse' | 'autoRetryEnabled' | 'loadAuthProviders' | 'reloadModels' | 'reloadCommands' | 'markCommandUsed' | 'setModel' | 'setThinking' | 'setUltracode' | 'setAutoCompaction' | 'setAutoRetry' | 'setSteeringMode' | 'setFollowUpMode' | 'abortRetry' | 'cycleModel' | 'cycleModelBack' | 'cycleThinking'>

export function createModelSlice({ set, get }: SliceContext): ModelSlice {
  return {
  models: [],
  thinkingLevels: [],
  commands: [],
  commandsAt: 0,
  authProviders: [],
  commandUse: readCommandUse(),
  autoRetryEnabled: true,
  loadAuthProviders: async () => {
    try {
      const list = await window.yan.authProviders()
      set({ authProviders: Array.isArray(list) ? list : [] })
    } catch {
    }
  },
  reloadModels: async () => {
    const request = ++capabilityRequestSeq
    const initial = get()
    const runnerId = initial.activeRunnerId
    const sessionId = initial.session?.sessionId
    const runtime = runtimeForState(initial)
    try {
      const [models, thinkingLevels] = await Promise.all([
        window.yan.listModels(),
        window.yan.listThinkingLevels()
      ])
      const current = get()
      if (request !== capabilityRequestSeq) return
      if (
        isCapabilityResponseStale(
          { runnerId, sessionId },
          { runnerId: current.activeRunnerId, sessionId: current.session?.sessionId }
        )
      ) {
        return
      }
      const currentRuntime = runtimeForState(current) ?? runtime
      const nextModels = keepRef(current.models, models)
      const nextLevels = keepRef(current.thinkingLevels, thinkingLevels)
      const runtimeEntry = currentRuntime ? current.sessionRuntimes[sessionRuntimeKey(currentRuntime)] : undefined
      const stableModels = runtimeEntry ? keepRef(runtimeEntry.models, nextModels) : nextModels
      const stableLevels = runtimeEntry ? keepRef(runtimeEntry.thinkingLevels, nextLevels) : nextLevels
      const runtimeUnchanged =
        !!runtimeEntry &&
        runtimeEntry.models === stableModels &&
        runtimeEntry.thinkingLevels === stableLevels &&
        runtimeEntry.runtime.generation === currentRuntime?.generation
      set({
        models: nextModels,
        thinkingLevels: nextLevels,
        ...(currentRuntime && !runtimeUnchanged
          ? {
              sessionRuntimes: updateSessionRuntime(current.sessionRuntimes, currentRuntime, {
                models: stableModels,
                thinkingLevels: stableLevels
              })
            }
          : {})
      })
    } catch {
    }
  },
  reloadCommands: async () => {
    const request = ++commandRequestSeq
    const initial = get()
    const runnerId = initial.activeRunnerId
    const sessionId = initial.session?.sessionId
    const runtime = runtimeForState(initial)
    try {
      const commands = await window.yan.listCommands()
      const current = get()
      if (request !== commandRequestSeq) return
      if (
        isCapabilityResponseStale(
          { runnerId, sessionId },
          { runnerId: current.activeRunnerId, sessionId: current.session?.sessionId }
        )
      ) {
        return
      }
      const currentRuntime = runtimeForState(current) ?? runtime
      const nextCommands = keepRef(current.commands, commands)
      const runtimeEntry = currentRuntime ? current.sessionRuntimes[sessionRuntimeKey(currentRuntime)] : undefined
      const stableCommands = runtimeEntry ? keepRef(runtimeEntry.commands, nextCommands) : nextCommands
      set({
        commands: nextCommands,
        commandsAt: Date.now(),
        ...(currentRuntime && !(runtimeEntry && runtimeEntry.commands === stableCommands && runtimeEntry.runtime.generation === currentRuntime.generation)
          ? {
              sessionRuntimes: updateSessionRuntime(current.sessionRuntimes, currentRuntime, {
                commands: stableCommands
              })
            }
          : {})
      })
    } catch {
    }
  },
  markCommandUsed: (name) => {
    const next = { ...get().commandUse, [name]: (get().commandUse[name] ?? 0) + 1 }
    set({ commandUse: next })
    try {
      localStorage.setItem('yan.cmdUse', JSON.stringify(next))
    } catch {
    }
  },
  setModel: async (provider, id, quiet = false) => {
    const target = await sessionActionTarget(get)
    if (!target) return { ok: false, error: uiText('state.error.sessionNotActivated') }
    const res = await piCall(() => window.yan.setModel(provider, id, target.expected))
    if (!res.ok) {
      if (!quiet) set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.setModelFailed')) })
      return res
    }
    if (!target.current()) return { ok: false, error: uiText('state.error.sessionSwitchedCommandSkipped') }
    const selected = get().models.find(m => m.provider === provider && m.id === id)
    try { await get().patchSettings({ lastMainModel: { provider, id, name: selected?.name } }) }
    catch (error) { return { ok: false, error: uiText('state.error.modelPrefSaveFailed', { error: String(error) }) } }
    return res
  },
  setThinking: async (level) => {
    try {
      const target = await sessionActionTarget(get)
      if (!target) return
      const res = await window.yan.setThinking(level, target.expected)
      if (!res.ok && target.current()) get().notify('error', res.error ?? uiText('state.error.cannotSwitchThinking'))
    } catch {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.cannotSwitchThinking')) })
    }
  },
  setUltracode: async (on) => {
    const target = await sessionActionTarget(get)
    if (!target) return
    const res = await piCall(() => window.yan.setUltracode(on, target.expected))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.settingFailed')) })
    }
  },
  setAutoCompaction: async (on) => {
    const res = await piCall(() => window.yan.setAutoCompaction(on))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.settingFailed')) })
    }
  },
  setAutoRetry: async (on) => {
    const res = await piCall(() => window.yan.setAutoRetry(on))
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.settingFailed')) })
    } else {
      set({ autoRetryEnabled: on })
    }
  },
  setSteeringMode: async (mode) => {
    const res = await piCall(() => window.yan.setSteeringMode(mode))
    if (!res.ok) set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.settingFailed')) })
  },
  setFollowUpMode: async (mode) => {
    const res = await piCall(() => window.yan.setFollowUpMode(mode))
    if (!res.ok) set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.settingFailed')) })
  },
  abortRetry: async () => {
    const target = await sessionActionTarget(get)
    if (!target) return
    try {
      await window.yan.abortRetry(target.expected)
    } catch {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.commandFailed')) })
    }
  },
  cycleModel: async () => {
    const target = await sessionActionTarget(get)
    if (!target) return
    const res = await piCall(() => window.yan.cycleModel(target.expected))
    if (!target.current()) return
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'info', res.error ?? uiText('state.error.cannotSwitchModel')) })
      return
    }
    if (res.to) {
      set({ notices: pushNotice(get().notices, 'info', uiText('state.model.switched', { model: res.to })) })
    }
  },
  cycleModelBack: async () => {
    const target = await sessionActionTarget(get)
    if (!target) return
    const res = await piCall(() => window.yan.cycleModelBack(target.expected))
    if (!target.current()) return
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'info', res.error ?? uiText('state.error.cannotSwitchModel')) })
      return
    }
    if (res.to) {
      set({ notices: pushNotice(get().notices, 'info', uiText('state.model.switched', { model: res.to })) })
    }
  },
  cycleThinking: async () => {
    const target = await sessionActionTarget(get)
    if (!target) return
    const res = await piCall(() => window.yan.cycleThinking(target.expected))
    if (!target.current()) return
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'info', res.error ?? uiText('state.error.cannotSwitchThinking')) })
      return
    }
    if (res.to) {
      set({ notices: pushNotice(get().notices, 'info', uiText('state.thinking.switched', { level: thinkLabelOf(res.to) })) })
    }
  },
  }
}
