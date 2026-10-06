/**
 * 权限与批准卡片的共用契约（主进程 / 渲染端 / 单测）。
 *
 * 两件事：
 *   · 权限档位 `PermissionMode`：全局设置，决定写文件与跑命令前要不要先问；
 *   · 批准请求 `ApprovalRequest`：宿主把「要问用户」的事推给界面，界面以输入框上方的
 *     内嵌卡片呈现，答复经 `yan:approvalAnswer` 回到宿主。
 *
 * 档位只有两个，「只读」由工作模式里的「计划」承担（工具表里直接拿掉写入口），
 * 不在这里重复做一套。
 */

export const PERMISSION_MODES = ['ask', 'full'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** 缺省 / 脏值都回到「完全放行」：保持升级前的行为，高危护栏照旧生效。 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'full'

export function normalizePermissionMode(value: unknown): PermissionMode {
  return value === 'ask' ? 'ask' : 'full'
}

/**
 * 请求来源：
 *   · `permission` 询问档下的写文件 / 跑命令；
 *   · `delete`     日常模式下的删除文件（任何档位都问，不提供「记住」）；
 *   · `danger`     高危命令（任何档位都问，每次都问）；
 *   · `outside`    写入项目之外的位置（可记住目录）；
 *   · `consent`    普通工具的同意记录（多次同意后自动放行）。
 */
export type ApprovalKind = 'permission' | 'delete' | 'danger' | 'outside' | 'consent'

/** 用户的答复：拒绝 / 允许这一次 / 允许并记住（记住什么由 kind 决定） */
export type ApprovalChoice = 'deny' | 'once' | 'remember'

export interface ApprovalRequest {
  id: string
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
