/**
 * 权限与批准卡片的共用契约（主进程 / 渲染端 / 单测）。
 *
 * 两件事：
 *   · 权限档位 `PermissionMode`：全局设置，决定哪些操作执行前要先问；
 *   · 批准请求 `ApprovalRequest`：宿主把「要问用户」的事推给界面，界面以输入框上方的
 *     内嵌卡片呈现，答复经 `yan:approvalAnswer` 回到宿主。
 *
 * 档位只有两个：danger 在明确危险操作前确认；all 保留原生工具行为。
 * 原生模式不再把删除命令改写为回收站操作；用户主动选择回收站仍可使用该工具。
 */

export const PERMISSION_MODES = ['danger', 'all'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** 缺省 / 脏值 / 旧档位（ask、full）都回到「危险批准」：高危护栏照旧生效。 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'danger'

export function normalizePermissionMode(value: unknown): PermissionMode {
  return value === 'all' ? 'all' : 'danger'
}

/**
 * 设置里存的还是旧档位（0.7.2 及以前的 ask / full，或更早没有这个字段）。
 * 旧版加载设置时会把「写入项目之外要确认」强制存成 true；迁到新档位时一并关掉，
 * 否则「危险批准」仍会为每次写项目外弹卡片。迁移后档位是新值，不会再迁第二次。
 */
export function isLegacyPermissionMode(value: unknown): boolean {
  return value !== 'danger' && value !== 'all'
}

/**
 * 请求来源：
 *   · `permission` 旧询问档下的写文件 / 跑命令（现行档位不再产生，保留给旧薄层）；
 *   · `delete`     旧版日常模式下的删除确认（现行改为移到回收站，保留给旧薄层）；
 *   · `danger`     高危命令（「危险批准」档每次都问）；
 *   · `outside`    写入项目之外的位置（可记住目录）；
 *   · `consent`    普通工具的同意记录（多次同意后自动放行）；
 *   · `move`       Agent 请求把会话移到另一个文件夹（`yan session move`，本轮结束后切换）。
 */
export type ApprovalKind = 'permission' | 'delete' | 'danger' | 'outside' | 'consent' | 'move'

/** 用户的答复：拒绝 / 允许这一次 / 允许并记住（记住什么由 kind 决定） */
export type ApprovalChoice = 'deny' | 'once' | 'remember'

export interface ApprovalRequest {
  id: string
  /** Origin captured when the operation asks; never inferred from the focused conversation. */
  sessionId?: string
  runId?: string
  subagentId?: string
  kind: ApprovalKind
  /** 工具名：bash / write / edit …；consent 是能力名 */
  tool: string
  /** 一句话标题（界面直接显示） */
  title: string
  /** 命令、文件路径或资源 */
  detail: string
  /** 为什么要问 / 风险点 */
  reasons: string[]
  cwd: string
  /** `remember` 的含义：permission=切到完全放行；outside=记住这些目录；其余没有 */
  rememberDirs?: string[]
  /** 这类请求是否提供「允许并记住」 */
  canRemember: boolean
  createdAt: number
}

export function isApprovalChoice(value: unknown): value is ApprovalChoice {
  return value === 'deny' || value === 'once' || value === 'remember'
}
