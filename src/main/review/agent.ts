import { buildAnnotationInstruction, buildReviewPrompt, type ReviewAnnotation, type ReviewChangeSet, type ReviewPromptPatch, type ReviewRun } from '../../shared/review'

export interface ReviewAgentRunInput {
  code: string
  changeSetId: string
  scopeKey: string
  cwd: string
  prompt: string
  model?: string
  sessionId?: string
  sessionPath?: string
  projectId?: string
}

export interface ReviewAgentPort {
  startReview(input: ReviewAgentRunInput): Promise<{ ok: boolean; runId?: string; error?: string }>
}

export interface ReviewAgentCoordinatorDeps {
  port?: ReviewAgentPort
  assignCode?: (scopeId: string, createdAt?: number) => Promise<string>
}

export class ReviewAgentCoordinator {
  constructor(private readonly deps: ReviewAgentCoordinatorDeps) {}

  async start(input: {
    changeSet: ReviewChangeSet
    annotations?: ReviewAnnotation[]
    patches?: ReviewPromptPatch[]
    model?: string
    sessionId?: string
    sessionPath?: string
    projectId?: string
  }): Promise<ReviewRun> {
    const changeSet = input.changeSet
    const missing: string[] = []
    if (!this.deps.port) missing.push('ReviewAgentPort（复用 SubagentService 的只读子运行入口）')
    if (!this.deps.assignCode) missing.push('SessionCodeStore.assign(scopeId, "review")（R 编号）')
    if (missing.length) {
      return { ok: false, changeSetId: changeSet.id, error: '评审运行尚未接线', requiredWiring: missing }
    }
    if (!changeSet.ok) return { ok: false, changeSetId: changeSet.id, error: changeSet.error ?? '变更集不可用' }

    const scopeId = `review:${changeSet.scopeKey}`
    let code: string
    try {
      code = await this.deps.assignCode!(scopeId)
    } catch (error) {
      return { ok: false, changeSetId: changeSet.id, error: `R 编号分配失败：${error instanceof Error ? error.message : String(error)}` }
    }
    if (!code) return { ok: false, changeSetId: changeSet.id, error: 'R 编号分配失败' }

    const prompt = buildReviewPrompt({
      code,
      changeSet,
      ...(input.annotations ? { annotations: input.annotations } : {}),
      ...(input.patches ? { patches: input.patches } : {})
    })
    try {
      const result = await this.deps.port!.startReview({
        code,
        changeSetId: changeSet.id,
        scopeKey: changeSet.scopeKey,
        cwd: changeSet.cwd,
        prompt,
        ...(input.model ? { model: input.model } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {})
      })
      if (!result.ok) return { ok: false, changeSetId: changeSet.id, code, error: result.error ?? '评审运行启动失败' }
      return { ok: true, changeSetId: changeSet.id, code, ...(result.runId ? { runId: result.runId } : {}), status: 'started' }
    } catch (error) {
      return { ok: false, changeSetId: changeSet.id, code, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

export function buildAnnotationTask(changeSet: ReviewChangeSet, annotations: ReviewAnnotation[]) {
  return buildAnnotationInstruction({ changeSetId: changeSet.id, scopeKey: changeSet.scopeKey, annotations })
}
