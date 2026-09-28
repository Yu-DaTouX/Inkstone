/**
 * 子代理服务：主进程级的生命周期服务，界面（`yan:subagents:*`）与模型（`yan subagent …`）
 * 共用同一个 SubagentController —— 模型启动的任务也会经 `onChange` 推到界面列表，
 * 而不是变成后台黑盒。
 *
 * 控制器第一次用到时才建（要读设置里的 cwd 与 piBin）。
 */
import { SubagentController } from './subagents'
import { getSettings } from './settings'
import { CapabilityCommandError } from './capability-server'
import { resolveActivityModel } from '../shared/activity-model'
import type { SubagentCommandHost } from './agent'
import type { SubagentRun } from '../shared/ipc'
import type { AgentProfileState } from '../shared/agent-profile'

/**
 * 子代理的系统提示（方案 8.3）。
 * 子代理不该反过来问用户问题 —— 它拿不到桌面端的提问通道，
 * 而且它的职责就是把一件事做完并汇报。
 */
const SUBAGENT_SYSTEM_PROMPT = [
  'You are a subagent working on one focused task inside a larger project.',
  '- Work autonomously: do not ask the user questions; make reasonable assumptions and state them.',
  '- Keep the scope to the task you were given.',
  '- Finish with a concise report: what you changed or found, and how you verified it.'
].join('\n')

export interface SubagentServiceDeps {
  onChange(run: SubagentRun): void
  onRemove(id: string): void
  /** 父会话的活动档案（按活动配置模型时用） */
  resolveAgentProfile(id: string): Promise<AgentProfileState>
}

export class SubagentService {
  private controller: SubagentController | null = null

  constructor(private readonly deps: SubagentServiceDeps) {}

  /** 已经建好的控制器（退出时停掉子代理用；没建过就是 null） */
  current(): SubagentController | null {
    return this.controller
  }

  async get(): Promise<SubagentController> {
    if (this.controller) return this.controller
    const s = await getSettings()
    this.controller = new SubagentController({
      cwd: s.cwd,
      piBin: s.piBin,
      appendSystemPrompt: SUBAGENT_SYSTEM_PROMPT,
      onChange: (run) => this.deps.onChange(run),
      onRemove: (id) => this.deps.onRemove(id)
    })
    return this.controller
  }

  /*
   * 模型调用与 UI 调用必须共用同一个控制器：这样模型启动的任务也会
   * 通过 `onChange` 推到输入区上方的列表和右侧详情，而不是变成“后台黑盒”。
   * 这里不暴露 merge/discard —— worktree 结果仍由用户在详情面板审阅。
   */
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
      const model = typeof params.model === 'string' && params.model.length <= 200 ? params.model : undefined
      const readOnly = params.readOnly === true || params['read-only'] === true
      /*
       * 模型没显式给时，按**父会话的活动**取「按活动配置模型」里的那一档
       * （实施-25 P18 的真实生效点）。解析结果里带理由与是否发生回退，
       * 但这里只需要最终值。
       */
      let effectiveModel = model
      if (!effectiveModel) {
        try {
          const profile = await this.deps.resolveAgentProfile(context.parentSessionId ?? context.parentRunId ?? '')
          const settings = await getSettings()
          effectiveModel = resolveActivityModel({
            config: settings.activityModels,
            activity: profile.activity
          }).model ?? undefined
        } catch {
          /* 取不到配置就当没配：不因为一个设置读盘失败而挡住子代理 */
        }
      }
      /*
       * 任务输入（实施-25 P15 T15-1）：目标 / 交付物 / 来源 / 边界。
       * 读不通就在**占用并发槽之前**失败（服务里同一个顺序）。
       */
      const result = await ctrl.start(task, effectiveModel, readOnly ? 'controlled-cwd' : 'worktree', params.brief)
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
