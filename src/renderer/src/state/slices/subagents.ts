import { uiText } from '../../i18n/ui-text'
import { useSubagentStopping } from '../subagent-stopping'
import type { Store } from '../store'
import { sessionActionTarget } from './runtime'
import { pushNotice, type SliceContext } from './shared'

export type SubagentsSlice = Pick<Store, 'subagents' | 'loadSubagents' | 'startSubagent' | 'askSideQuestion' | 'stopSubagent'>

export function createSubagentsSlice({ set, get }: SliceContext): SubagentsSlice {
  return {
  subagents: [],
  loadSubagents: async () => {
    try {
      const runs = await window.yan.subagents.list()
      set({ subagents: runs })
      useSubagentStopping.getState().prune(runs.filter((r) => r.status === 'starting' || r.status === 'running').map((r) => r.id))
    } catch {
    }
  },
  startSubagent: async (task, model, isolation) => {
    const target = await sessionActionTarget(get)
    if (!target) {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.sessionNotActivated')) })
      return
    }
    const res = await window.yan.subagents.start(task, model, isolation, target.expected)
    if (!res.ok) {
      set({
        notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.subagentStartFailed'))
      })
      return
    }
    if (res.run) {
      const run = res.run
      const idx = get().subagents.findIndex((r) => r.id === run.id)
      set({
        subagents: idx >= 0 ? get().subagents.map((r) => (r.id === run.id ? run : r)) : [...get().subagents, run]
      })
    }
  },
  askSideQuestion: async (question) => {
    const target = await sessionActionTarget(get)
    if (!target) return { ok: false, error: uiText('state.error.sessionNotActivated') }
    const res = await window.yan.subagents.askSideQuestion(question, target.expected)
    if (!res.ok) return { ok: false, error: res.error ?? uiText('state.error.subagentStartFailed') }
    if (res.run) {
      const run = res.run
      const idx = get().subagents.findIndex((r) => r.id === run.id)
      set({ subagents: idx >= 0 ? get().subagents.map((r) => (r.id === run.id ? run : r)) : [...get().subagents, run] })
    }
    return { ok: true }
  },
  stopSubagent: async (id) => {
    useSubagentStopping.getState().mark(id)
    const res = await window.yan.subagents.stop(id).catch((): { ok: false; error?: string } => ({ ok: false }))
    if (!res.ok) {
      useSubagentStopping.getState().clear(id)
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.subagentStopFailed')) })
    }
  },
  }
}
