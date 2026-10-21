import { SubagentController, type SubagentApprovalOrigin } from './subagents'
import { getSettings } from './settings'
import { CapabilityCommandError } from './capability-server'
import type { SubagentCommandContext, SubagentCommandHost } from './agent'
import type { ModelLabelResolution } from './subagents/model-label'
import type { SubagentRun } from '../shared/ipc'

const SUBAGENT_SYSTEM_PROMPT = [
  'You are a subagent working on one focused task inside a larger project.',
  'Search only the supplied source paths and workspace. Avoid filesystem-root searches; set a finite timeout on shell commands that may take a long time.',
  '- Work autonomously: do not ask the user questions; make reasonable assumptions and state them.',
  '- Keep the scope to the task you were given.',
  '- Decide how many tool calls the task needs; stop when you have enough evidence to report.',
  '- Finish with a concise report: what you changed or found, and how you verified it.'
].join('\n')

export interface SubagentServiceDeps {
  codemodeExtension?(): string | undefined
  providerExtensions?(): string[]
  guardExtension?(): string | undefined
  shellExtension?(): string | undefined
  resolveModelApi?(label: string, origin: { sessionId?: string; runId?: string }): Promise<string | undefined>
  resolveModelLabel?(requested: string, context: SubagentCommandContext): Promise<ModelLabelResolution>
  confirmDanger?(params: Record<string, unknown>, cwd: string, origin?: SubagentApprovalOrigin): Promise<boolean>
  onChange(run: SubagentRun): void
  onPatch?(payload: { id: string; run: SubagentRun; transcriptFrom: number }): void
  onRemove(id: string): void
  onFinished?(run: SubagentRun): void
  onEvent?(runId: string, evt: Record<string, unknown>, run: SubagentRun): void
}

export class SubagentService {
  private controller: SubagentController | null = null
  private loading?: Promise<SubagentController>

  constructor(private readonly deps: SubagentServiceDeps) {}

  current(): SubagentController | null {
    return this.controller
  }

  async get(): Promise<SubagentController> {
    if (this.loading) return this.loading
    if (this.controller) return this.controller
    this.loading = this.createController()
    try { return await this.loading } finally { this.loading = undefined }
  }

  private async createController(): Promise<SubagentController> {
    const s = await getSettings()
    this.controller = new SubagentController({
      cwd: s.cwd,
      piBin: s.piBin,
      extensions: [this.deps.codemodeExtension?.(), this.deps.shellExtension?.(), this.deps.guardExtension?.(), ...(this.deps.providerExtensions?.() ?? [])].filter((path): path is string => !!path),
      appendSystemPrompt: SUBAGENT_SYSTEM_PROMPT,
      confirmDanger: (params, cwd, origin) => this.deps.confirmDanger?.(params, cwd, origin) ?? Promise.resolve(false),
      ...(this.deps.resolveModelApi ? { resolveModelApi: (label, origin) => this.deps.resolveModelApi!(label, origin) } : {}),
      onChange: (run) => this.deps.onChange(run),
      ...(this.deps.onPatch ? { onPatch: (payload) => this.deps.onPatch?.(payload) } : {}),
      onRemove: (id) => this.deps.onRemove(id),
      onFinished: (run) => this.deps.onFinished?.(run),
      ...(this.deps.onEvent ? { onEvent: (runId, evt, run) => this.deps.onEvent?.(runId, evt, run) } : {})
    })
    await this.controller.loadHistory()
    return this.controller
  }

  readonly capabilityHost: SubagentCommandHost = {
    run: (command, params, context) => this.run(command, params, context)
  }

  private async run(...[command, params, context]: Parameters<SubagentCommandHost['run']>): ReturnType<SubagentCommandHost['run']> {
    const ctrl = await this.get()
    ctrl.setContext(context)

    if (command === 'subagent.start') {
      const task = typeof params.task === 'string' ? params.task.trim() : ''
      if (!task) {
        throw new CapabilityCommandError(
          'subagent_task_required',
          'subagent start 需要 task'
        )
      }
      if (task.length > 12_000) {
        throw new CapabilityCommandError(
          'subagent_task_too_long',
          '子代理任务不能超过 12000 个字符'
        )
      }
      const requested = typeof params.model === 'string' && params.model.trim() && params.model.length <= 200 ? params.model.trim() : undefined
      let model = requested
      if (this.deps.resolveModelLabel) {
        const resolved = await this.deps.resolveModelLabel(requested ?? '', context)
        if (!resolved.ok) throw new CapabilityCommandError('subagent_model_ambiguous', resolved.error)
        model = resolved.label || undefined
      }
      const readOnly = params.readOnly === true || params['read-only'] === true
      const title = typeof params.title === 'string' ? params.title : undefined
      const briefInput = title && (!params.brief || typeof params.brief === 'object') ? { ...(params.brief as Record<string, unknown> | undefined), title } : params.brief
      const result = await ctrl.start(task, model ?? context.model, readOnly ? 'controlled-cwd' : params.isolation === 'worktree' ? 'worktree' : 'shared-cwd', briefInput)
      if (!result.ok || !result.run) {
        throw new CapabilityCommandError(
          'subagent_start_failed',
          result.error ?? '子代理启动失败'
        )
      }
      const run = result.run
      return {
        data: run,
        summary: {
          kind: 'subagent',
          action: 'start',
          id: run.id,
          status: run.status,
          isolation: run.isolation,
          task: run.task,
          latestActivity: run.latestActivity,
          deliverables: run.brief?.deliverables.length ?? 0,
          sources: run.brief?.sources.length ?? 0
        }
      }
    }

    if (command === 'subagent.list') {
      const runs = ctrl.list()
      const active = runs.filter((run) => run.status === 'running' || run.status === 'starting')
      return {
        data: runs,
        summary: {
          kind: 'subagent',
          action: 'list',
          count: runs.length,
          active: active.length,
          ids: runs.map((run) => run.id)
        }
      }
    }

    const id = typeof params.id === 'string' ? params.id.trim() : ''
    if (!/^sub-[0-9a-f]+$/.test(id)) {
      throw new CapabilityCommandError(
        'subagent_id_required',
        '该子代理动作需要合法的 id（例如 sub-a1b2c3d4）'
      )
    }

    if (command === 'subagent.get') {
      const run = ctrl.get(id)
      if (!run) {
        throw new CapabilityCommandError(
          'subagent_not_found',
          `找不到子代理：${id}`
        )
      }
      return {
        data: run,
        summary: {
          kind: 'subagent',
          action: 'get',
          id: run.id,
          status: run.status,
          latestActivity: run.latestActivity,
          transcript: run.transcript.length,
          review: run.review
        }
      }
    }

    if (command === 'subagent.send') {
      const message = typeof params.message === 'string' ? params.message.trim() : ''
      if (!message) {
        throw new CapabilityCommandError('subagent_message_required', 'subagent send 需要 message')
      }
      if (message.length > 12_000) {
        throw new CapabilityCommandError('subagent_message_too_long', '追加信息不能超过 12000 个字符')
      }
      const rawMode = typeof params.mode === 'string' ? params.mode.trim().toLowerCase() : ''
      if (rawMode && rawMode !== 'steer' && rawMode !== 'follow-up' && rawMode !== 'followup') {
        throw new CapabilityCommandError('subagent_mode_invalid', 'mode 只能是 steer 或 follow-up')
      }
      const mode = rawMode === 'follow-up' || rawMode === 'followup' ? 'followUp' : 'steer'
      const result = await ctrl.send(id, message, mode, { parentSessionId: context.parentSessionId, from: 'parent' })
      if (!result.ok || !result.run) {
        throw new CapabilityCommandError('subagent_send_failed', result.error ?? `追加信息失败：${id}`)
      }
      return {
        data: result.run,
        summary: {
          kind: 'subagent',
          action: 'send',
          id,
          mode: result.delivery === 'resumed' ? 'resume' : mode === 'followUp' ? 'follow-up' : 'steer',
          delivery: result.delivery,
          status: result.run.status,
          latestActivity: result.run.latestActivity
        }
      }
    }

    if (command === 'subagent.stop') {
      const result = await ctrl.stop(id)
      if (!result.ok) {
        throw new CapabilityCommandError(
          'subagent_stop_failed',
          result.error ?? `停止子代理失败：${id}`
        )
      }
      const run = ctrl.get(id)
      return {
        data: run,
        summary: {
          kind: 'subagent',
          action: 'stop',
          id,
          status: run?.status ?? 'stopped'
        }
      }
    }

    throw new CapabilityCommandError(
      'not_implemented',
      `命令已登记但尚未实现：${command}`
    )
  }
}
