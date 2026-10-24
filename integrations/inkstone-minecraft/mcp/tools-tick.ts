import { CompanionError } from '../src/core/dev/companion.ts'
import { isUserControlError } from '../src/core/dev/interact.ts'
import type { DevProject } from '../src/core/dev/runner.ts'
import { failure, text, type ToolDefinition } from './protocol.ts'
import { USER_IN_CONTROL, type McpContext } from './tools.ts'

export const TICK_RATE_MIN = 1
export const TICK_RATE_MAX = 10000
export const TICK_RATE_DEFAULT = 20
const STEP_MAX = 100_000
const SPRINT_MAX = 1_000_000

const PROJECT_PROPERTY = { type: 'string', description: 'Fabric mod 项目根目录（含 build.gradle）。省略时用 INKSTONE_MC_PROJECT 或当前目录' }

export const TICK_ACTIONS = ['status', 'rate', 'freeze', 'unfreeze', 'step', 'sprint', 'reset'] as const
export type TickAction = (typeof TICK_ACTIONS)[number]

export interface TickState {
  rate: number | null
  frozen: boolean | null
  tps: number | null
  sprintTicks: number | null
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = typeof args[key] === 'string' ? Number(args[key]) : args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function parseTickOutput(output: string[]): TickState {
  const body = output.join('\n')
  let rate: number | null = null
  for (const pattern of [/(?:tick\s*rate|rate|速率|频率)[^0-9\n]{0,16}([\d.]+)/i, /([\d.]+)\s*(?:per second|\/s\b|每秒)/i]) {
    const match = pattern.exec(body)
    const value = match ? Number(match[1]) : Number.NaN
    if (Number.isFinite(value)) {
      rate = value
      break
    }
  }
  const unfrozen = /解冻|unfroze|unfrozen|not frozen|未冻结|running normally|正常运行/i.test(body)
  const frozen = unfrozen ? false : /冻结|frozen|froze\b|froze the game/i.test(body) ? true : null
  const tpsMatch = /([\d.]+)\s*TPS/i.exec(body)
  const tps = tpsMatch ? Number(tpsMatch[1]) : null
  const sprintMatch = /(?:sprint\w*|冲刺)[^0-9\n]{0,24}([\d.]+)\s*(?:tick|刻)/i.exec(body)
  const sprintTicks = sprintMatch ? Number(sprintMatch[1]) : null
  return {
    rate: rate !== null && Number.isFinite(rate) ? rate : null,
    frozen,
    tps: tps !== null && Number.isFinite(tps) ? tps : null,
    sprintTicks: sprintTicks !== null && Number.isFinite(sprintTicks) ? sprintTicks : null
  }
}

function numberText(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100)
}

export function tickSummary(state: TickState): string {
  const rate = state.rate === null ? '速率未知' : `速率 ${numberText(state.rate)}/秒`
  const frozen = state.frozen === true ? '已冻结（只按 step 推进）' : state.frozen === false ? '运行中' : '冻结状态未知'
  const parts = [rate, frozen]
  if (state.tps !== null) parts.push(`TPS ${numberText(state.tps)}`)
  if (state.sprintTicks !== null) parts.push(`冲刺剩 ${numberText(state.sprintTicks)} tick`)
  return parts.join(' · ')
}

function rateValue(args: Record<string, unknown>): string {
  const rate = num(args, 'rate')
  if (rate === undefined) throw new Error(`action=rate 需要 rate：每秒 tick 数，范围 ${TICK_RATE_MIN}–${TICK_RATE_MAX}，标准速度 ${TICK_RATE_DEFAULT}`)
  if (rate < TICK_RATE_MIN || rate > TICK_RATE_MAX) throw new Error(`rate 要在 ${TICK_RATE_MIN}–${TICK_RATE_MAX} 之间，收到 ${rate}`)
  return String(rate)
}

function stepValue(args: Record<string, unknown>): string {
  const ticks = num(args, 'ticks')
  if (ticks === undefined) return '1'
  const value = Math.round(ticks)
  if (value < 1) throw new Error(`step 的 ticks 至少 1，收到 ${ticks}`)
  return String(Math.min(value, STEP_MAX))
}

function sprintValue(args: Record<string, unknown>): string {
  const ticks = num(args, 'ticks')
  if (ticks === undefined) throw new Error('action=sprint 需要 ticks（冲刺多少个 tick），或用 stop=true 停止冲刺')
  const value = Math.round(ticks)
  if (value < 1) throw new Error(`sprint 的 ticks 至少 1，收到 ${ticks}`)
  return String(Math.min(value, SPRINT_MAX))
}

export function tickCommands(args: Record<string, unknown>): string[] {
  const action = str(args, 'action') ?? 'status'
  if (!TICK_ACTIONS.includes(action as TickAction)) throw new Error(`未知 action ${action}：${TICK_ACTIONS.join('、')} 之一`)
  if (action === 'status') return ['tick query']
  if (action === 'freeze') return ['tick freeze']
  if (action === 'unfreeze') return ['tick unfreeze']
  if (action === 'rate') return [`tick rate ${rateValue(args)}`]
  if (action === 'step') return [`tick step ${stepValue(args)}`]
  if (action === 'sprint') return args.stop === true ? ['tick sprint stop'] : [`tick sprint ${sprintValue(args)}`]
  return ['tick unfreeze', `tick rate ${TICK_RATE_DEFAULT}`]
}

interface CommandReply {
  ok: boolean
  output: string[]
}

async function commandReply(project: DevProject, command: string): Promise<CommandReply> {
  const reply = await project.companion('/command', { command })
  const raw = reply && typeof reply === 'object' && !Array.isArray(reply) ? (reply as Record<string, unknown>) : {}
  return { ok: raw.ok !== false, output: Array.isArray(raw.output) ? raw.output.map((line) => String(line)) : [] }
}

function errorText(error: unknown): string {
  if (isUserControlError(error)) return USER_IN_CONTROL
  if (error instanceof CompanionError) {
    const detail = error.message.includes(`HTTP ${error.status}`) ? '' : `：${error.message}`
    const hint = error.status === 404 ? '（伴随 mod 可能还是旧版本，没有这个路由）' : error.status === 503 ? '（还没进入世界）' : ''
    return `伴随 mod 返回 HTTP ${error.status}${detail}${hint}`
  }
  const message = error instanceof Error ? error.message : String(error)
  return `伴随 mod 请求失败：${message}${/fetch failed|ECONNREFUSED/i.test(message) ? '（开发客户端没在运行，或伴随 mod 未连接）' : ''}`
}

export async function readTickState(project: DevProject): Promise<TickState | null> {
  try {
    const reply = await commandReply(project, 'tick query')
    return parseTickOutput(reply.output)
  } catch {
    return null
  }
}

export async function tickStatusLine(project: DevProject): Promise<string | null> {
  const state = await readTickState(project)
  return state ? `tick：${tickSummary(state)}` : null
}

export async function tickResetReminder(project: DevProject): Promise<string | null> {
  const state = await readTickState(project)
  if (!state) return null
  const abnormal = state.frozen === true || (state.rate !== null && state.rate !== TICK_RATE_DEFAULT)
  if (!abnormal) return null
  return `tick 还没恢复：${tickSummary(state)} —— 开发会话结束前先用 mc_tick action=reset（解除冻结并把速率调回 ${TICK_RATE_DEFAULT}）`
}

const TICK_DESCRIPTION =
  `放慢、冻结、单步推进游戏的 tick：status 读当前速率与冻结状态；rate 设目标速率；freeze/unfreeze 冻结或解冻游戏逻辑；step 冻结后推进 n tick 再停下；sprint 用高速跑 n tick（stop=true 提前停止）；reset 解除冻结并把速率调回 ${TICK_RATE_DEFAULT}。走原版 /tick 命令（1.20.3+），每次返回第一行是解析后的结论（速率、是否冻结），后面是执行的命令与游戏回显。rate 范围 ${TICK_RATE_MIN}–${TICK_RATE_MAX}（标准速度 ${TICK_RATE_DEFAULT}）；step 只在冻结时生效。tick 只影响游戏逻辑（实体、方块、红石、模组 tick 逻辑），不影响渲染帧率，也不影响按真实时间计时的界面动画（toast、部分 HUD 动画），这类短暂界面改用 mc_wait 等 + mc_script 截图，不要指望冻结能停住它们。冻结与调低的速率会一直生效：开发会话结束前执行 action=reset 恢复。`

export function createTickTools(context: McpContext): ToolDefinition[] {
  return [
    {
      name: 'mc_tick',
      title: '调游戏 tick 速度与单步',
      description: TICK_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT_PROPERTY,
          action: {
            type: 'string',
            enum: [...TICK_ACTIONS],
            description: 'status 读状态、rate 设速率、freeze 冻结、unfreeze 解冻、step 单步推进、sprint 高速跑一段时间、reset 解除冻结并调回 20'
          },
          rate: { type: 'number', description: `action=rate 的目标速率：每秒 tick 数，${TICK_RATE_MIN}–${TICK_RATE_MAX}，标准速度 ${TICK_RATE_DEFAULT}` },
          ticks: { type: 'number', description: 'action=step 推进多少 tick（默认 1）；action=sprint 冲刺多少 tick' },
          stop: { type: 'boolean', description: 'action=sprint：停止正在进行的冲刺（等价于 /tick sprint stop）' }
        },
        required: ['action']
      },
      annotations: { title: '调游戏 tick 速度与单步', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      run: async (args) => {
        const project = context.project(args)
        let commands: string[]
        try {
          commands = tickCommands(args)
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error))
        }
        const action = str(args, 'action') ?? 'status'
        const echoes: string[] = []
        let failed: { command: string; output: string[] } | null = null
        for (const command of commands) {
          let reply: CommandReply
          try {
            reply = await commandReply(project, command)
          } catch (error) {
            const message = errorText(error)
            return failure(echoes.length ? [message, ...echoes].join('\n') : message)
          }
          echoes.push(`/${command}`, ...(reply.output.length ? reply.output : ['（没有输出）']))
          if (!reply.ok && !failed) failed = { command, output: reply.output }
        }
        const executed = parseTickOutput(echoes)
        const queried = action === 'status' ? null : await readTickState(project)
        const state: TickState = {
          rate: queried?.rate ?? executed.rate,
          frozen: queried?.frozen ?? executed.frozen,
          tps: queried?.tps ?? executed.tps,
          sprintTicks: executed.sprintTicks
        }
        const lines: string[] = []
        if (failed) lines.push(`命令失败：/${failed.command} → ${failed.output[0] ?? '没有回显'}`)
        lines.push(`tick：${tickSummary(state)}`)
        if (action !== 'status') lines.push(`已执行：${commands.map((command) => `/${command}`).join('、')}`)
        lines.push('回显：', ...echoes)
        const hints: string[] = []
        if (failed && action === 'step') hints.push('step 只在冻结时推进 tick：先 action=freeze 再 step')
        if (action !== 'status' && (state.frozen === true || (state.rate !== null && state.rate !== TICK_RATE_DEFAULT))) hints.push(`测完用 action=reset 恢复（解除冻结并把速率调回 ${TICK_RATE_DEFAULT}）`)
        if (hints.length) lines.push(`提示：${hints.join('；')}`)
        return failed ? { content: [{ type: 'text', text: lines.join('\n') }], isError: true } : text(lines.join('\n'))
      }
    }
  ]
}
