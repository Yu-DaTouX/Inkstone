/**
 * 回合页脚的模型名：与模型菜单显示同一个 `ModelInfo.name`。
 *
 * 实时回合记的是「提供方/模型 id」；回放历史时 pi 只给出模型 id，没有提供方前缀。
 * 两种都先按目录查显示名，找不到才退回原始标识，不猜测、不拼凑提供方。
 */
export interface TurnModelCatalogEntry {
  provider: string
  id: string
  name?: string
}

export interface TurnModelLabel {
  label: string
  identity: string
}

export function turnModelLabel(identity: string, catalog: readonly TurnModelCatalogEntry[]): TurnModelLabel {
  // 模型 id 本身可能含斜杠（如 `deepseek/deepseek-v4.1-flash`），先整串当 id 查，再按「提供方/id」拆。
  const separator = identity.indexOf('/')
  const provider = separator > 0 ? identity.slice(0, separator) : null
  const id = separator > 0 ? identity.slice(separator + 1) : identity
  const model = catalog.find((item) => `${item.provider}/${item.id}` === identity)
    ?? catalog.find((item) => item.id === identity)
    ?? (provider !== null ? catalog.find((item) => item.provider === provider && item.id === id) : undefined)
    ?? catalog.find((item) => item.id === id)
  return { label: model?.name || id, identity }
}
