/**
 * 按活动配置模型的 IPC 适配（`yan:activity:*`）。
 *
 * 只读写「哪个活动用哪个模型」与解析结果；切模型本身仍走既有的模型选择链路。
 */
import type { IpcRegistrar } from './registrar'
import { getSettings, patchSettings } from '../settings'
import { activityModelRows, activityModelText, emptyActivityModelConfig, resolveActivityModel, sanitizeActivityModelConfig, setActivityModel } from '../../shared/activity-model'
import { normalizeAgentActivity } from '../../shared/agent-profile'
import type { AgentActivity } from '../../shared/agent-profile'

export function registerActivityModelIpc(ipc: IpcRegistrar): void {
  const { handle } = ipc
  /*
   * 按活动配置模型（实施-25 P18）。
   *
   * 这里只读写「哪个活动用哪个模型」与解析结果 —— **切模型本身不在这里**：
   * 仍然走既有的模型选择链路。`current` 由界面传（会话当前模型只有会话侧知道）。
   */
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
        /* 给了可用清单才会做可用性检查（并可能发生回退） */
        ...(Array.isArray(input?.available) ? { available: input.available.map((item) => String(item)) } : {})
      })
      return { ...resolution, text: activityModelText(resolution) }
    }
  )
  handle(
    'yan:activity:modelSet',
    async (input: { activity?: string; model?: string | null; defaultModel?: string | null; clear?: boolean }) => {
      const current = (await getSettings()).activityModels
      const next = input?.clear
        ? emptyActivityModelConfig()
        : (() => {
            let base = current
            if (input && 'defaultModel' in input) {
              base = { ...sanitizeActivityModelConfig(base), defaultModel: input.defaultModel ?? null }
            }
            if (input?.activity) {
              base = setActivityModel(base, normalizeAgentActivity(input.activity), input.model ?? null)
            }
            return base
          })()
      await patchSettings({ activityModels: next })
      const settings = await getSettings()
      const rows = activityModelRows({ config: settings.activityModels })
      return { ok: true as const, rows }
    }
  )
}
