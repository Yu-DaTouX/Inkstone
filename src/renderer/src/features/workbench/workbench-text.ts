import type { Lang } from '../../i18n'
import type { WorkbenchTabId } from './types'
import { singularizeOne } from '../../../../shared/ui-lang'

export interface OverviewText {
  openFull: string
  tiles: {
    env: string
    context: string
    todos: string
    tasks: string
    ext: string
    mcp: string
    changes: string
    quota: string
  }
  noBranch: string
  detached: string
  branchLabel: string
  contextUsed: string
  stopTask: string
  stopFailed: string
  runningSection: (n: number) => string
  finishedSection: (n: number) => string
  showOutput: string
  hideOutput: string
  earlierOutput: string
  taskGone: string
  terminalJobState: Record<import('../../../../shared/terminal-jobs').TerminalJobState, string>
  endedState: Record<'stopped' | 'failed' | 'exited' | 'timeout', string>
  quotaFailed: string
  quotaExpired: string
  balance: string
  mcpStatus: Record<'ready' | 'connecting' | 'disconnected' | 'needs-auth' | 'error', string>
  changesFiles: (n: number) => string
  changesStaged: string
  changesUnstaged: string
  changesUntracked: string
}

export interface WorkbenchText {
  activateHint: string
  activate: string
  activateFailed: string
  notWired: string
  notWiredHint: string
  paneMenu: (name: string) => string
  moveSide: Record<'left' | 'right' | 'up' | 'down', string>
  moveSideHint: Record<'left' | 'right' | 'up' | 'down', string>
  tabs: Record<WorkbenchTabId, string>
  overview: OverviewText
}

const ZH: WorkbenchText = {
  activateHint: '这个页签需要先在当前会话激活。',
  activate: '激活会话',
  activateFailed: '激活会话失败',
  notWired: '尚未接入',
  notWiredHint: '这个页签的界面还在接入中。',
  paneMenu: (name) => `${name}设置`,
  moveSide: { left: '移到左侧', right: '移到右侧', up: '移到上方', down: '移到下方' },
  moveSideHint: {
    left: '按回车移到左侧，Esc 取消。',
    right: '按回车移到右侧，Esc 取消。',
    up: '按回车移到上方，Esc 取消。',
    down: '按回车移到下方，Esc 取消。'
  },
  tabs: {
    changes: '更改',
    terminal: '终端',
    files: '文件',
    browser: '浏览器',
    preview: '预览',
    context: '上下文',
    branch: '分支',
    logs: '日志',
    quota: '额度',
    device: '设备',
    pullRequests: 'PR'
  },
  overview: {
    openFull: '打开',
    tiles: {
      env: '环境',
      context: '上下文',
      todos: '待办',
      tasks: '任务',
      ext: '扩展',
      mcp: 'MCP',
      changes: '改动',
      quota: '额度'
    },
    noBranch: '未知分支',
    detached: '游离 HEAD',
    branchLabel: '分支',
    contextUsed: '已用',
    stopTask: '停止任务',
    stopFailed: '停止任务失败',
    runningSection: (n) => `运行中 ${n}`,
    finishedSection: (n) => `已结束 ${n}`,
    showOutput: '展开输出',
    hideOutput: '收起输出',
    earlierOutput: '（更早的输出未显示）',
    taskGone: '任务已经结束，无需停止',
    terminalJobState: { running: '终端运行中', stopping: '正在停止', completed: '已结束', matched: '已就绪', exited: '终端已退出', timeout: '超过时限，仍在运行', stopped: '已停止' },
    endedState: { stopped: '已停止', failed: '失败', exited: '已退出', timeout: '超时' },
    quotaFailed: '额度查询失败',
    quotaExpired: '登录已过期',
    balance: '余额',
    mcpStatus: { ready: '已连接', connecting: '连接中', disconnected: '未连接', 'needs-auth': '需授权', error: '出错' },
    changesFiles: (n) => `${n} 个文件`,
    changesStaged: '已暂存',
    changesUnstaged: '未暂存',
    changesUntracked: '未跟踪'
  }
}

const EN: WorkbenchText = {
  activateHint: 'This tab requires the session to be active first.',
  activate: 'Activate session',
  activateFailed: 'Could not activate the session',
  notWired: 'Not wired yet',
  notWiredHint: 'This tab is still being integrated.',
  paneMenu: (name) => `${name} settings`,
  moveSide: { left: 'Move left', right: 'Move right', up: 'Move up', down: 'Move down' },
  moveSideHint: {
    left: 'Press Enter to move left, or Escape to cancel.',
    right: 'Press Enter to move right, or Escape to cancel.',
    up: 'Press Enter to move up, or Escape to cancel.',
    down: 'Press Enter to move down, or Escape to cancel.'
  },
  tabs: {
    changes: 'Changes',
    terminal: 'Terminal',
    files: 'Files',
    browser: 'Browser',
    preview: 'Preview',
    context: 'Context',
    branch: 'Branches',
    logs: 'Logs',
    quota: 'Quota',
    device: 'Device',
    pullRequests: 'Pull requests'
  },
  overview: {
    openFull: 'Open',
    tiles: {
      env: 'Environment',
      context: 'Context',
      todos: 'Todos',
      tasks: 'Tasks',
      ext: 'Extensions',
      mcp: 'MCP',
      changes: 'Changes',
      quota: 'Quota'
    },
    noBranch: 'Unknown branch',
    detached: 'Detached HEAD',
    branchLabel: 'Branch',
    contextUsed: 'Used',
    stopTask: 'Stop task',
    stopFailed: 'Could not stop the task',
    runningSection: (n) => `Running ${n}`,
    finishedSection: (n) => `Finished ${n}`,
    showOutput: 'Show output',
    hideOutput: 'Hide output',
    earlierOutput: '(Earlier output not shown)',
    taskGone: 'The task already ended; nothing to stop',
    terminalJobState: { running: 'Running in terminal', stopping: 'Stopping', completed: 'Finished', matched: 'Ready', exited: 'Terminal exited', timeout: 'Past time limit, still running', stopped: 'Stopped' },
    endedState: { stopped: 'Stopped', failed: 'Failed', exited: 'Exited', timeout: 'Timed out' },
    quotaFailed: 'Quota check failed',
    quotaExpired: 'Sign-in expired',
    balance: 'Balance',
    mcpStatus: { ready: 'Connected', connecting: 'Connecting', disconnected: 'Disconnected', 'needs-auth': 'Needs auth', error: 'Error' },
    changesFiles: (n) => singularizeOne(`${n} files`),
    changesStaged: 'Staged',
    changesUnstaged: 'Unstaged',
    changesUntracked: 'Untracked'
  }
}

export function workbenchText(lang: Lang): WorkbenchText {
  return lang === 'en-US' ? EN : ZH
}
