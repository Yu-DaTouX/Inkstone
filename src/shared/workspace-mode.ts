/**
 * 左栏的工作区外观 / 入口模式。
 *
 * 这不是 AgentMode（standard / clarify / autonomous）。工作区只决定
 * 左栏快捷入口呈现为「编码」还是「日常」，两者可以和任意 AgentMode 组合。
 */
export const WORKSPACE_MODES = ['coding', 'daily'] as const

export type WorkspaceMode = (typeof WORKSPACE_MODES)[number]

export function nextWorkspaceMode(mode: WorkspaceMode): WorkspaceMode {
  return mode === 'coding' ? 'daily' : 'coding'
}

export function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return value === 'coding' || value === 'daily'
}
