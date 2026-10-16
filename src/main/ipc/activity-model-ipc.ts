import type { IpcRegistrar } from './registrar'
import { getSettings, updateSettings } from '../settings'
import { activityModelRows, activityModelText, emptyActivityModelConfig, resolveActivityModel, sanitizeActivityModelConfig, setActivityModel } from '../../shared/activity-model'
import { normalizeAgentActivity } from '../../shared/agent-profile'
import type { AgentActivity } from '../../shared/agent-profile'

export function registerActivityModelIpc(ipc: IpcRegistrar): void {
  const { handle } = ipc
  handle('yan:activity:modelRows', async (input?: { current?: string | null }) => {
    const settings = await getSettings()
    return activityModelRows({
      config: settings.activityModels,
      current: typeof input?.current === 'string' ? input.current : null
    })
  })
  handle(
    'yan:activity:model',
    async (input: { activity: AgentActivity; current?: string | null; available?: string[] }) => {
      const settings = await getSettings()
      const activity = normalizeAgentActivity(input?.activity)
      const resolution = resolveActivityModel({
        config: settings.activityModels,
        activity,
        current: typeof input?.current === 'string' ? input.current : null,
        ...(Array.isArray(input?.available) ? { available: input.available.map((item) => String(item)) } : {})
      })
      return { ...resolution, text: activityModelText(resolution) }
    }
  )
  handle(
    'yan:activity:modelSet',
    async (input: { activity?: string; model?: string | null; defaultModel?: string | null; clear?: boolean }) => {
      await updateSettings((settings) => {
        const current = settings.activityModels
        const next = input?.clear
          ? emptyActivityModelConfig()
          : (() => {
              let base = current
              if (input && 'defaultModel' in input) base = { ...sanitizeActivityModelConfig(base), defaultModel: input.defaultModel ?? null }
              if (input?.activity) base = setActivityModel(base, normalizeAgentActivity(input.activity), input.model ?? null)
              return base
            })()
        return { activityModels: next }
      })
      const settings = await getSettings()
      const rows = activityModelRows({ config: settings.activityModels })
      return { ok: true as const, rows }
    }
  )
}
