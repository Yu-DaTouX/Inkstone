import type { ModelChoice } from '../shared/model-selection'

export async function applyRememberedModel(agent: {
  getState(): { model?: Pick<ModelChoice, 'provider' | 'id'> | null } | null
  listModels(): Promise<Array<Pick<ModelChoice, 'provider' | 'id'>>>
  setModel(provider: string, id: string): Promise<{ ok: boolean; error?: string }>
}, model?: ModelChoice): Promise<{ ok: boolean; error?: string }> {
  if (!model) return { ok: true }
  const models = await agent.listModels()
  if (!models.some(m => m.provider === model.provider && m.id === model.id)) {
    return { ok: false, error: `上次使用的模型 ${model.provider}/${model.id} 当前不可用，请重新选择模型后新建会话。` }
  }
  const current = agent.getState()?.model
  if (current?.provider === model.provider && current.id === model.id) return { ok: true }
  return agent.setModel(model.provider, model.id)
}
