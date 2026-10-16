/**
 * 评审 Agent 的薄适配（§10.2 / WP-50）。
 *
 * ── 这个模块**不启动**任何进程 ──
 * 它只做三件事，全部是可单测的编排：
 *   1. 用正式编号存储分配 R 编号（`SessionCodeStore.assign(scopeId, 'review')`）；
 *   2. 用 `shared/review.buildReviewPrompt` 组装只读评审任务；
 *   3. 交给宿主注入的 `ReviewAgentPort` —— 宿主复用既有 `SubagentService` /
 *      运行注册表的正式入口执行，**不在这里复制 pi 循环**。
 *
 * 没有注入 port 时返回 `requiredWiring`，明确告诉调用方「还差哪根线」，
 * 绝不返回假 runId 或假装已经跑起来。
 */
import { buildAnnotationInstruction, buildReviewPrompt, type ReviewAnnotation, type ReviewChangeSet, type ReviewPromptPatch, type ReviewRun } from '../../shared/review'

/** 启动一次只读评审需要的全部输入；host 据此调既有子代理 / host 入口。 */
export interface ReviewAgentRunInput {
  /** 正式编号（R04 这类），由编号存储发出 */
  code: string
  changeSetId: string
  scopeKey: string
  cwd: string
  prompt: string
  /** 用户选择的模型标签（provider/id）；缺省沿用宿主默认 */
  model?: string
  sessionId?: string
  sessionPath?: string
  projectId?: string
}

/**
 * 宿主注入的评审执行端口。
 *
 * 宿主接线的三条硬约束（补丁里列明）：
 *   · 用**只读**子运行（`subagentPiArgs` 的 `readOnly` 路径：`--tools read,grep,find,ls`）；
 *   · 评审任务文本经 `--append-system-prompt` 传入（只读路径带 `--no-skills`，
 *     所以随包 `resources/skills/review/SKILL.md` 由宿主读入后追加，而不是当技能加载）；
 *   · 运行以 `kind: 'review'` 登记到运行注册表，编号就是这里发出的 R 号。
 */
export interface ReviewAgentPort {
  startReview(input: ReviewAgentRunInput): Promise<{ ok: boolean; runId?: string; error?: string }>
}

export interface ReviewAgentCoordinatorDeps {
  /** 缺省无：没有宿主接线时返回 requiredWiring，不假成功 */
  port?: ReviewAgentPort
  /** 正式编号存储的写入口；缺省没有时同样不登记 */
  assignCode?: (scopeId: string, createdAt?: number) => Promise<string>
}

export class ReviewAgentCoordinator {
  constructor(private readonly deps: ReviewAgentCoordinatorDeps) {}

  async start(input: {
    changeSet: ReviewChangeSet
    annotations?: ReviewAnnotation[]
    /** 宿主在启动前经同一只读 diff 通道取到的有界补丁；缺省时不附数据段 */
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

/** 「让 Agent 按批注修改」：只组装消息，发送由调用方走既有会话入口。 */
export function buildAnnotationTask(changeSet: ReviewChangeSet, annotations: ReviewAnnotation[]) {
  return buildAnnotationInstruction({ changeSetId: changeSet.id, scopeKey: changeSet.scopeKey, annotations })
}
