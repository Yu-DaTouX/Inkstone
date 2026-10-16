/**
 * 托盘菜单模型（v3 WP-12）。
 *
 * Electron 的 Tray 菜单不是 DOM，主进程在这里只构造一个与 Electron 无关的
 * 纯数据模型；`src/main/index.ts` 负责把它翻成 `Menu.buildFromTemplate`。
 * 这样菜单内容（尤其是「等你处理」一行）可以在不启动 Electron 的单测里直接断言。
 *
 * 菜单结构沿用迁移前的行为：显示砚 / 新建会话 / 运行中的会话 / 退出砚；
 * 额外在运行子菜单顶部加一行注册表派生的「等你处理 N 项」，仅当有注意项时出现。
 */
import { basename } from 'node:path'
import type { AttentionSummary } from './summary'

/** 运行实例在托盘菜单里需要的最小字段（结构兼容 `RunnerStatus`）。 */
export interface TraySessionStatus {
  id: string
  sessionFile?: string
  sessionId?: string
  projectId?: string
  cwd: string
  running: boolean
  waiting: boolean
  conn: 'starting' | 'ready' | 'exited' | 'error'
  isActive: boolean
}

export interface TraySelectTarget {
  sessionFile?: string
  sessionId?: string
  projectId?: string
  cwd: string
}

export type AttentionMenuNode =
  | { type: 'item'; label: string; enabled?: boolean; click?: () => void }
  | { type: 'submenu'; label: string; items: AttentionMenuNode[] }
  | { type: 'separator' }

export interface AttentionMenuCallbacks {
  show(): void
  newSession(): void
  selectSession(target: TraySelectTarget): void
  quit(): void
}

export interface AttentionMenuInput {
  zh: boolean
  statuses: TraySessionStatus[]
  summary: AttentionSummary
  callbacks: AttentionMenuCallbacks
}

/** 运行中的会话行；状态词与迁移前逐字一致。 */
function liveItems(zh: boolean, statuses: TraySessionStatus[], callbacks: AttentionMenuCallbacks): AttentionMenuNode[] {
  const live = statuses.filter((status) => status.running || status.waiting || status.conn === 'starting')
  if (live.length === 0) {
    return [{ type: 'item', label: zh ? '暂无运行中的会话' : 'No running sessions', enabled: false }]
  }
  return live.map((status) => {
    const name = status.sessionFile ? basename(status.sessionFile) : status.sessionId || status.id
    const state = status.waiting
      ? (zh ? '等待回答' : 'Waiting')
      : status.running
        ? (zh ? '运行中' : 'Running')
        : (zh ? '启动中' : 'Starting')
    return {
      type: 'item',
      label: `${status.isActive ? '● ' : ''}${name} · ${state}`,
      click: () =>
        callbacks.selectSession({
          ...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
          ...(status.sessionId ? { sessionId: status.sessionId } : {}),
          ...(status.projectId ? { projectId: status.projectId } : {}),
          cwd: status.cwd
        })
    }
  })
}

export function buildAttentionMenu(input: AttentionMenuInput): AttentionMenuNode[] {
  const { zh, summary, callbacks } = input
  const submenu: AttentionMenuNode[] = []
  if (summary.attentionCount > 0) {
    submenu.push({
      type: 'item',
      label: zh ? `等你处理 ${summary.attentionCount} 项` : `${summary.attentionCount} need attention`,
      enabled: false
    })
    submenu.push({ type: 'separator' })
  }
  submenu.push(...liveItems(zh, input.statuses, callbacks))

  return [
    { type: 'item', label: zh ? '显示砚' : 'Show Yan', click: callbacks.show },
    { type: 'item', label: zh ? '新建会话' : 'New session', click: callbacks.newSession },
    { type: 'submenu', label: zh ? '运行中的会话' : 'Running sessions', items: submenu },
    { type: 'separator' },
    { type: 'item', label: zh ? '退出砚' : 'Quit Yan', click: callbacks.quit }
  ]
}
