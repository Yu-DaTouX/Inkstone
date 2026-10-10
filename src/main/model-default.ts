import type { ModelChoice } from '../shared/model-selection'

/** Apply an explicit desktop choice only to a new conversation, without a model fallback. */
export async function applyRememberedModel(agent: {
  listModels(): Promise<Array<Pick<ModelChoice, 'provider' | 'id'>>>
  setModel(provider: string, id: string): Promise<{ ok: boolean; error?: string }>
}, model?: ModelChoice): Promise<{ ok: boolean; error?: string }> {
  if (!model) return { ok: true }
  const models = await agent.listModels()
  if (!models.some(m => m.provider === model.provider && m.id === model.id)) {
    return { ok: false, error: `上次使用的模型 ${model.provider}/${model.id} 当前不可用，请重新选择模型后新建会话。` }
  }
  return agent.setModel(model.provider, model.id)
}
