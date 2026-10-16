export async function confirmRegisteredModel(
  rpc: { command(type: string, args?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<{ success: boolean; error?: string; data?: unknown }> },
  label: string,
  options: { readOnly?: boolean; expectedApi?: string } = {}
): Promise<string | undefined> {
  const name = options.readOnly ? '只读子任务' : '子任务'
  const split = label.indexOf('/')
  if (split < 1 || split === label.length - 1) return `${name}未报告完整模型身份，未发送任务。`
  try {
    const result = await rpc.command('set_model', { provider: label.slice(0, split), modelId: label.slice(split + 1) }, { timeoutMs: 2000 })
    if (result.success) {
      if (options.expectedApi) {
        const state = await rpc.command('get_state', undefined, { timeoutMs: 2000 })
        const model = (state.data as { model?: { api?: unknown } } | undefined)?.model
        if (!state.success || model?.api !== options.expectedApi) {
          return `${name}的模型实现与来源会话不一致；虚拟模型所需扩展可能未加载。未发送任务，也未改用其他模型。`
        }
      }
      return undefined
    }
    const hint = options.readOnly ? '需要普通扩展的虚拟模型不支持只读子任务；' : ''
    return `${name}无法确认模型 ${label} 已注册：${result.error ?? '原生模型选择失败'}。${hint}未发送任务，也未改用其他模型。`
  } catch (error) {
    return `${name}核对模型 ${label} 失败：${error instanceof Error ? error.message : String(error)}；未发送任务。`
  }
}
