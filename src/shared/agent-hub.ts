export type HubAgent = 'pi' | 'codex' | 'claude' | 'gemini' | 'grok' | 'antigravity'
export const HUB_CLI_PACKAGES: Record<Exclude<HubAgent, 'pi'>, string> = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code', gemini: '@google/gemini-cli', grok: '@xai-official/grok', antigravity: '' }
export const HUB_CLI_BINARY: Partial<Record<HubAgent, string>> = { antigravity: 'agy' }
export const HUB_CLI_INSTALL_URL: Partial<Record<HubAgent, string>> = { antigravity: 'https://antigravity.google/cli' }
export const HUB_LEGACY_AGENTS: readonly HubAgent[] = ['gemini']
export type HubMode = 'managed' | 'terminal'
export type HubStatus = 'queued' | 'preparing' | 'running' | 'waiting_input' | 'needs_review' | 'completed' | 'failed' | 'cancelled' | 'uncertain'
export interface HubActivity {
  id: string
  at: number
  kind: 'say' | 'tool' | 'patch' | 'approval' | 'note'
  title?: string
  text: string
  detail?: string
  status?: 'running' | 'done' | 'failed'
}
export interface HubAttachment { name: string; path: string; image: boolean }
export interface HubAttachmentInput { name: string; data: string; mime?: string }
export type HubOrigin = 'desktop' | 'phone' | 'session' | 'run'
export interface HubTask {
  id: string
  createdBy?: HubOrigin
  parentTaskId?: string
  parentSessionId?: string
  title: string
  prompt: string
  agent: HubAgent
  mode: HubMode
  projectId: string
  status: HubStatus
  createdAt: number
  updatedAt: number
  runId?: string
  externalSessionId?: string
  terminalId?: string
  baseline?: string
  workspace?: string
  reviewOf?: string
  artifact?: { patchPath: string; sha256: string; tree: string; reportPath: string }
  includeWorkingChanges?: boolean
  startArtifact?: { patchPath: string; sha256: string; tree: string; reportPath: string; files: number }
  startTree?: string
  inPlace?: boolean
  workspaceRemoved?: boolean
  terminalStarted?: boolean
  terminalState?: 'working' | 'idle'
  dismissed?: boolean
  attachments?: HubAttachment[]
  report?: string
  error?: string
  model?: string
  reasoningEffort?: 'low' | 'medium' | 'high'
  timeoutMinutes: number
  inputOwner?: string
  inputEpoch?: number
  inputExpiresAt?: number
  activity?: HubActivity[]
  toolCoverage: 'managed-entrypoints' | 'uncoordinated'
}
export interface HubApproval {
  id: string
  taskId: string
  runId: string
  kind: 'command' | 'file' | 'question'
  title: string
  detail: string
  expiresAt: number
  status: 'pending' | 'sent' | 'resolved' | 'expired' | 'uncertain'
  answer?: 'accept' | 'decline'
  questions?: Array<{ id: string; question: string; options?: string[] }>
  answers?: Record<string, string>
}
export interface HubRun {
  id: string
  taskId: string
  startedAt: number
  finishedAt?: number
  status: HubStatus
  agent: HubAgent
  mode: HubMode
  model?: string
  reasoningEffort?: 'low' | 'medium' | 'high'
  externalSessionId?: string
  baseline?: string
  artifact?: HubTask['artifact']
  report?: string
  error?: string
}
export type HubCapability = 'lifecycle' | 'handoff' | 'terminal' | 'screenState'
export interface HubPacket {
  id: string
  fromTaskId?: string
  toTaskId: string
  projectId: string
  basis?: { baseline?: string; workspace?: string; artifact?: HubTask['artifact'] }
  summary: string
  request?: string
  context?: string
  createdAt: number
}
export interface HubMessage {
  id: string
  taskId: string
  fromTaskId?: string
  fromRunId?: string
  toRunId?: string
  parentSessionId?: string
  requestKey?: string
  kind: 'packet' | 'note' | 'system'
  packet?: HubPacket
  text: string
  delivery: 'queued' | 'injected' | 'typed' | 'failed'
  createdAt: number
  attachments?: HubAttachment[]
}
export interface HubSnapshot {
  tasks: HubTask[]
  runs?: HubRun[]
  templates?: HubTemplate[]
  approvals: HubApproval[]
  resources: Array<{ resourceId: string; owner: string | null; operationId: string | null; epoch: number; uncertain: boolean; paused: boolean; waiting: number }>
  projects: Array<{ id: string; name: string }>
  adapters: Array<{ agent: HubAgent; available: boolean; version?: string; modes: HubMode[]; capabilities?: HubCapability[]; error?: string }>
  messages?: HubMessage[]
}
export interface HubCreate {
  parentSessionId?: string
  agent: HubAgent
  mode: HubMode
  projectId: string
  prompt: string
  title?: string
  model?: string
  reasoningEffort?: 'low' | 'medium' | 'high'
  reviewOf?: string
  timeoutMinutes?: number
  requestId: string
  includeWorkingChanges?: boolean
  attachments?: HubAttachmentInput[]
}
export interface HubTemplate {
  id: string
  name: string
  agent: HubAgent
  mode: HubMode
  prompt: string
  model?: string
  reasoningEffort?: 'low' | 'medium' | 'high'
}
export type HubCommand =
  | { action: 'create'; request: HubCreate }
  | { action: 'save-template'; template: HubTemplate }
  | { action: 'delete-template'; id: string }
  | { action: 'cancel'; taskId: string }
  | { action: 'accept'; taskId: string }
  | { action: 'answer'; approvalId: string; answer: 'accept' | 'decline'; answers?: Record<string, string> }
  | { action: 'recover-resource'; resourceId: string; epoch: number }
  | { action: 'claim-input'; taskId: string; epoch: number }
  | { action: 'input'; taskId: string; epoch: number; data: string }
  | { action: 'resize'; taskId: string; epoch: number; cols: number; rows: number }
  | { action: 'resume'; taskId: string; fresh?: boolean }
  | { action: 'last-screen'; taskId: string }
  | { action: 'inspect'; taskId: string; sinceSeq?: number }
  | { action: 'link-session'; taskId: string; sessionId: string }
  | { action: 'deliver-message'; messageId: string; epoch: number }
  | { action: 'send-packet'; requestId: string; toTaskId: string; summary: string; request?: string; context?: string; attachments?: HubAttachmentInput[] }
  | { action: 'workspace-status'; projectId: string }
  | { action: 'remove-workspace'; taskId: string }
  | { action: 'resolve'; taskId: string; outcome: 'executed' | 'dismiss' }
  | { action: 'dismiss'; taskId: string }
export const HUB_ACTIVE: readonly HubStatus[] = ['preparing', 'running', 'waiting_input']
export interface HubAttentionItem { id: string; taskId?: string; resourceId?: string }
export function hubAttention(tasks: readonly HubTask[], approvals: readonly HubApproval[], resources: HubSnapshot['resources']): HubAttentionItem[] {
  const items: HubAttentionItem[] = tasks.filter((t) => !t.dismissed && ['waiting_input', 'needs_review', 'failed', 'uncertain'].includes(t.status)).map((t) => ({
    id: `task:${t.id}:${t.runId ?? 'none'}:${t.status}:${approvals.filter((a) => a.taskId === t.id && a.status === 'pending').map((a) => a.id).sort().join(',')}`,
    taskId: t.id
  }))
  for (const r of resources) if (r.uncertain) items.push({ id: `resource:${r.resourceId}:${r.epoch}`, resourceId: r.resourceId })
  return items
}
