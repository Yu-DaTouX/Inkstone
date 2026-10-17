export const WORKSPACE_MODES = ['coding', 'daily'] as const

export type WorkspaceMode = (typeof WORKSPACE_MODES)[number]

export function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return value === 'coding' || value === 'daily'
}
