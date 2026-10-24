import type { Account, InstanceInfo, LaunchState, TaskInfo, TaskProgress, TaskState } from '../../shared/api.ts'
import type { BadgeTone } from '@yan/ui/Badge'
import type { StatusDotKind } from '@yan/ui/StatusDot'

export const LOADER_LABEL: Record<InstanceInfo['loader'], string> = {
  vanilla: '原版',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
  unknown: '未知'
}

export const STATE_LABEL: Record<LaunchState, string> = {
  idle: '未运行',
  starting: '正在启动',
  running: '运行中',
  exited: '已退出',
  failed: '启动失败'
}

export const STATE_DOT: Record<LaunchState, StatusDotKind> = {
  idle: 'idle',
  starting: 'pending',
  running: 'running',
  exited: 'idle',
  failed: 'fail'
}

export function accountKindLabel(account: Account): string {
  if (account.kind === 'offline') return '离线'
  if (account.kind === 'microsoft') return '正版'
  return account.serverName || '第三方'
}

export function accountKindTone(account: Account): BadgeTone {
  if (account.kind === 'offline') return 'neutral'
  if (account.kind === 'microsoft') return 'ok'
  return 'accent'
}

export function canLaunchWith(account: Account | null | undefined): boolean {
  return account?.kind === 'offline'
}

export function accountStatus(account: Account): string {
  if (account.kind === 'offline') return '可直接启动'
  if (account.signedIn) return '已登录'
  return account.source === 'pcl' ? '来自 PCL，需要重新登录' : '需要重新登录'
}

export function instanceMeta(instance: InstanceInfo): string {
  const parts = [`${LOADER_LABEL[instance.loader]}${instance.loaderVersion ? ` ${instance.loaderVersion}` : ''}`, `MC ${instance.minecraftVersion ?? '?'}`]
  if (instance.modCount > 0) parts.push(`${instance.modCount} 个 mod`)
  if (instance.javaMajor) parts.push(`Java ${instance.javaMajor}`)
  return parts.join(' · ')
}

export function memoryLabel(mb: number): string {
  return mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
}

export const TASK_STATE_LABEL: Record<TaskState, string> = {
  queued: '排队中',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消'
}

const TASK_UNIT_LABEL: Record<TaskProgress['unit'], string> = {
  files: '个文件',
  bytes: '字节',
  steps: '步'
}

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export function taskPercent(task: TaskInfo): number | null {
  return task.progress && task.progress.total > 0 ? Math.min(100, Math.round((task.progress.done / task.progress.total) * 100)) : null
}

export function taskProgressLabel(task: TaskInfo): string {
  const progress = task.progress
  if (!progress || progress.total <= 0) return task.state === 'queued' ? '等待开始' : ''
  const percent = taskPercent(task)
  const counts = progress.unit === 'bytes' ? `${sizeLabel(progress.done)} / ${sizeLabel(progress.total)}` : `${progress.done} / ${progress.total} ${TASK_UNIT_LABEL[progress.unit]}`
  return percent === null ? counts : `${counts} · ${percent}%`
}
