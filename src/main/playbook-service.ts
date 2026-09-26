/**
 * 办事模板的服务层（实施-25 P14）。
 *
 * ── 这个服务**不执行**任何模板 ──
 * 它只做四件事：列出、保存、改、删，以及 **`plan`（复用前把「将要做什么」摊开）**。
 * 真正动手的是模型，而模型动手之前要经过用户确认 —— 所以「跑模板」在这里
 * 不存在，只有一个返回说明文本的 `plan`。这是 P14 验收（复用前看到作用范围、
 * 不静默动文件）最直接的落点：宿主根本没有「静默跑」的能力。
 *
 * ── 谁负责给作用范围 ──
 * 起步模板的写步骤用占位写法（`<要整理的目录>`），`plan` 时由调用方逐条给出真实范围。
 * 数量对不上就报错，不猜、不自动补 —— 「少填一个范围」若被容忍，
 * 就等于允许一次范围不明的写操作。
 */

import type { PlaybookStore } from './playbook-store'
import {
  applyPlaybookPatch,
  confirmationPoints,
  confirmationText,
  createPlaybook,
  effectNeedsConfirmation,
  emptyPlaybookDocument,
  needsConfirmation,
  playbookStepsText,
  scopeSummary,
  stepScopeUnfilled,
  validatePlaybookInput,
  type Playbook,
  type PlaybookErrorCode,
  type PlaybookInput,
  type PlaybookStep,
  type ScopeSummary
} from '../shared/playbook'

export interface PlaybookServiceOptions {
  store: PlaybookStore
  /** 注入 id 生成器，便于单测；默认随机。 */
  idFactory?: () => string
  now?: () => number
}

/** 复用前的说明（T14-3）。**没有副作用**，也不代表已经执行。 */
export interface PlaybookPlan {
  playbook: Playbook
  /** 需要用户点头才能继续。 */
  needsConfirmation: boolean
  summary: ScopeSummary
  /** 需要确认的步骤（顺序与 `scopes` 参数一致）。 */
  points: PlaybookStep[]
  /** 还没写清范围的步骤数（> 0 时界面必须先让用户填完）。 */
  unansweredScope: number
  confirmationText: string
  /** 一段可直接发出去的执行说明。 */
  text: string
}

export type PlaybookPlanResult =
  | ({ ok: true } & PlaybookPlan)
  | { ok: false; code: PlaybookErrorCode; error: string }

export type PlaybookSaveResult =
  | { ok: true; playbook: Playbook }
  | { ok: false; code: PlaybookErrorCode; error: string }

export class PlaybookService {
  private readonly store: PlaybookStore
  private readonly now: () => number
  private readonly idFactory: () => string

  constructor(options: PlaybookServiceOptions) {
    this.store = options.store
    this.now = options.now ?? (() => Date.now())
    this.idFactory = options.idFactory ?? defaultPlaybookId
  }

  async list(spaceId?: string | null): Promise<Playbook[]> {
    await this.store.load()
    return this.store.list(spaceId, this.now())
  }

  async find(id: string): Promise<Playbook | null> {
    await this.store.load()
    return this.store.find(id, this.now())
  }

  /** 保存一份模板（新存或按 id 覆盖）。 */
  async save(input: PlaybookInput & { id?: unknown }): Promise<PlaybookSaveResult> {
    await this.store.load()
    const valid = validatePlaybookInput(input)
    if (!valid.ok) return { ok: false, code: valid.code, error: valid.message }
    const now = this.now()

    const existingId = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : ''
    const existing = existingId ? this.store.find(existingId, now) : null
    if (existingId && !existing) return { ok: false, code: 'not_found', error: '找不到要改的模板' }
    if (!existing) {
      const playbook = createPlaybook(valid.value, { id: this.nextId(), now })
      await this.store.save(playbook)
      return { ok: true, playbook }
    }
    /* 覆盖已有模板：保留 id / 计数与创建时间（runs 不是内容） */
    /* 它一旦被改过就不再是「内置起步模板」，而是用户自己的一份：去掉 seeded 才能删。 */
    const { seeded: _seeded, ...rest } = existing
    const playbook: Playbook = {
      ...rest,
      ...valid.value,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: now,
      runs: existing.runs,
      ...(existing.lastRunAt ? { lastRunAt: existing.lastRunAt } : {})
    }
    await this.store.save(playbook)
    return { ok: true, playbook }
  }

  /** 改一份模板的标题 / 目标 / 步骤 / 输入输出。 */
  async update(
    id: string,
    patch: { title?: unknown; goal?: unknown; steps?: unknown; io?: unknown; kind?: unknown }
  ): Promise<PlaybookSaveResult> {
    await this.store.load()
    const prev = this.store.find(id, this.now())
    if (!prev) return { ok: false, code: 'not_found', error: '找不到这个模板' }
    const patched = applyPlaybookPatch(prev, patch, this.now())
    if (!patched.ok) return { ok: false, code: patched.code, error: patched.message }
    await this.store.save(patched.playbook)
    return { ok: true, playbook: patched.playbook }
  }

  async remove(id: string): Promise<{ ok: boolean; error?: string }> {
    await this.store.load()
    const removed = await this.store.remove(id)
    return removed ? { ok: true } : { ok: false, error: '找不到这个模板' }
  }

  /** 空间被删时带走它的模板。 */
  async removeSpace(spaceId: string): Promise<number> {
    await this.store.load()
    return this.store.removeSpace(spaceId)
  }

  /**
   * 复用前的说明（T14-3）。
   *
   * `scopes`：按**需要确认的步骤**顺序给出的作用范围（只读步骤不用给）。
   * 给的组数必须与需要确认的步骤数一致 —— 少给就报错，不替用户猜。
   */
  async plan(id: string, options: { scopes?: string[][] } = {}): Promise<PlaybookPlanResult> {
    await this.store.load()
    const found = this.store.find(id, this.now())
    if (!found) return { ok: false, code: 'not_found', error: '找不到这个模板' }

    let steps: PlaybookStep[] = found.steps
    if (options.scopes) {
      const points = confirmationPoints(found.steps)
      if (options.scopes.length !== points.length) {
        return {
          ok: false,
          code: 'bad_scope',
          error: `这个模板有 ${points.length} 个需要确认的步骤，请给出同样多的作用范围（收到 ${options.scopes.length} 组）`
        }
      }
      let cursor = 0
      steps = found.steps.map((step) => {
        if (!effectNeedsConfirmation(step.effect)) return step
        const scope = (options.scopes?.[cursor] ?? []).map((s) => String(s).trim()).filter(Boolean)
        cursor += 1
        /* 空数组 = 用户还没填：保留原占位，如实报 unansweredScope */
        return scope.length > 0 ? { ...step, scope } : { ...step, scope: step.scope }
      })
    }

    const effective: Playbook = { ...found, steps }
    const points = confirmationPoints(steps)
    const unanswered = points.filter((step) => stepScopeUnfilled(step)).length
    return {
      ok: true,
      playbook: effective,
      needsConfirmation: needsConfirmation(steps),
      summary: scopeSummary(steps),
      points,
      unansweredScope: unanswered,
      confirmationText: confirmationText(effective),
      text: playbookStepsText(effective)
    }
  }

  /**
   * 记一次「开始用」。
   *
   * 记的是**开始用了几次**，不是成功率 —— 宿主不知道模型后来做得怎么样，
   * 所以界面上也只写「用过 N 次」。起步模板没落盘，第一次用时才落盘。
   */
  async recordRun(id: string): Promise<PlaybookSaveResult> {
    await this.store.load()
    const found = this.store.find(id, this.now())
    if (!found) return { ok: false, code: 'not_found', error: '找不到这个模板' }
    const now = this.now()
    /* 用过一次的起步模板要落盘（计数得留住），落盘后它就不再是「内置」的了。 */
    const { seeded: _seeded, ...rest } = found
    const next: Playbook = {
      ...rest,
      runs: found.runs + 1,
      lastRunAt: now,
      updatedAt: now
    }
    await this.store.save(next)
    return { ok: true, playbook: next }
  }

  /** 空文档（诊断 / 单测用）。 */
  static empty() {
    return emptyPlaybookDocument()
  }

  /**
   * id 显式查重：存储按 id 替换，随机 id 撞车会**静默覆盖**别人的模板。
   */
  private nextId(): string {
    const taken = new Set(this.store.snapshot().playbooks.map((p) => p.id))
    for (let i = 0; i < 50; i += 1) {
      const id = this.idFactory()
      if (!taken.has(id)) return id
    }
    return `pb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  }
}

function defaultPlaybookId(): string {
  return `pb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}
