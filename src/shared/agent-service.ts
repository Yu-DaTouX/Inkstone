/** Host-neutral contracts; persistent facts belong to the runtime service. */
export type ServiceTaskStatus = 'ready' | 'running' | 'waiting_approval' | 'completed' | 'cancelled' | 'failed' | 'uncertain'
export interface TaskAuthority {
  readRoots: string[]
  writeRoots: string[]
  network: string[]
  programs: string[]
  credentials: string[]
  subagents: boolean
}
export interface TaskBudget { maxTimeMs: number; maxModelCalls: number; maxToolCalls: number }
export interface TaskInput { source: string; name: string; sha256: string; bytes: number }
export interface TaskOutput { name: string; sha256: string; bytes: number }
export interface TaskApplyItem { output: string; destination: string; expectedSha256: string | null; outputSha256: string }
export interface TaskApplyResult { applied: string[]; conflicts: string[]; pending: string[]; error?: string }
export interface ServiceTask {
  id: string
  title: string
  parentId?: string
  status: ServiceTaskStatus
  generation: number
  createdAt: number
  updatedAt: number
  workspace: string
  inputs: TaskInput[]
  outputs: TaskOutput[]
  authority: TaskAuthority
  budget: TaskBudget
  usage: { elapsedMs: number; modelCalls: number; toolCalls: number }
  sessionFile?: string
  error?: string
  applyResult?: TaskApplyResult
}
export interface ServiceApproval {
  id: string
  taskId: string
  generation: number
  kind: 'tool' | 'apply'
  detail: string
  status: 'pending' | 'approved' | 'declined' | 'expired'
  createdAt: number
}
export interface ServiceReceipt {
  id: string
  taskId: string
  generation: number
  requestId: string
  operation: string
  digest: string
  state: 'started' | 'completed' | 'uncertain' | 'failed'
  result?: unknown
}
export interface ServiceCapability {
  id: string
  implemented: boolean
  configured: boolean
  available: boolean
  authorized: boolean
  reason?: string
}
export interface ServiceSnapshot { tasks: ServiceTask[]; approvals: ServiceApproval[]; capabilities: ServiceCapability[] }
export interface CreateServiceTask { title: string; files: string[]; parentId?: string; budget?: Partial<TaskBudget> }
export interface ServiceBridge {
  snapshot(): Promise<ServiceSnapshot>
  create(request: CreateServiceTask): Promise<ServiceTask>
  run(taskId: string, prompt: string): Promise<ServiceTask>
  cancel(taskId: string): Promise<void>
  outputs(taskId: string): Promise<TaskOutput[]>
  preview(taskId: string, name: string): Promise<{ text: string; truncated: boolean }>
  planApply(taskId: string, items: Array<{ output: string; destination: string }>): Promise<{ approval: ServiceApproval; items: TaskApplyItem[] }>
  approve(id: string, generation: number, approved: boolean): Promise<void>
  apply(taskId: string, approvalId: string, requestId: string): Promise<TaskApplyResult>
  chooseInputs(): Promise<string[]>
  configureModel(): Promise<boolean>
  reconcile(taskId: string): Promise<void>
  chooseDestination(name: string): Promise<string | null>
  openOutput(taskId: string, name: string): Promise<void>
}
