import type { Lang } from '../../i18n'
import type { WorkbenchTabId } from './types'

export interface OverviewText {
  title: string
  back: string
  backLabel: string
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
  permissionLabel: string
  contextUsed: string
  lastCompaction: string
  stopTask: string
  stopFailed: string
  taskDetail: string
  runningCount: (n: number) => string
  doneCount: (n: number) => string
  runningSection: (n: number) => string
  finishedSection: (n: number) => string
  showOutput: string
  hideOutput: string
  earlierOutput: string
  taskGone: string
  scheduledKind: string
  moreTools: string
  quotaFailed: string
  quotaExpired: string
  balance: string
  mcpFailed: string
  mcpConnected: (ready: number, total: number) => string
  mcpTools: (n: number) => string
  mcpStatus: Record<'ready' | 'connecting' | 'disconnected' | 'needs-auth' | 'error', string>
  changesNone: string
  changesFiles: (n: number) => string
  changesStaged: string
  changesUnstaged: string
  changesUntracked: string
}

export interface WorkbenchText {
  title: string
  close: string
  open: string
  activateHint: string
  activate: string
  activateFailed: string
  notWired: string
  notWiredHint: string
  inactiveTitle: string
  chatName: string
  split: string
  unsplit: string
  focus: string
  unfocus: string
  popout: string
  unmigrated: string
  secondaryPane: string
  expand: string
  collapse: string
  closePane: string
  paneMenu: (name: string) => string
  moveBesideChat: string
  viewOptions: string
  changesScope: string
  move: string
  moveInstructions: string
  movedTo: (name: string, position: number, count: number) => string
  moveCancelled: (name: string) => string
  moveSide: Record<'left' | 'right' | 'up' | 'down', string>
  moveSideHint: Record<'left' | 'right' | 'up' | 'down', string>
  resize: (before: string, after: string) => string
  tabs: Record<WorkbenchTabId, string>
  overview: OverviewText
}

const ZH: WorkbenchText = {
  title: '工作区',
  close: '收起工作区',
  open: '打开工作区',
  activateHint: '这个页签需要先在当前会话激活。',
  activate: '激活会话',
  activateFailed: '激活会话失败',
  notWired: '尚未接入',
  notWiredHint: '这个页签的界面还在接入中。',
  inactiveTitle: '会话未激活',
  chatName: '聊天',
  split: '上下拆分',
  unsplit: '取消拆分',
  focus: '专注',
  unfocus: '退出专注',
  popout: '弹出为独立窗口',
  unmigrated: '未迁移',
  secondaryPane: '下半格页签',
  expand: '展开',
  collapse: '收起',
  closePane: '关闭面板',
  paneMenu: (name) => `${name}设置`,
  moveBesideChat: '移到对话旁',
  viewOptions: '视图选项',
  changesScope: '工作区',
  move: '移动',
  moveInstructions: '用方向键调整面板位置：沿排列方向换位，垂直方向先预览再按回车移过去，Esc 取消。拖动时拖出面板左侧可移到对话旁，按 Esc 还原。',
  movedTo: (name, position, count) => `「${name}」移到第 ${position} / ${count} 个位置`,
  moveCancelled: (name) => `已取消移动「${name}」`,
  moveSide: { left: '移到左侧', right: '移到右侧', up: '移到上方', down: '移到下方' },
  moveSideHint: {
    left: '按回车移到左侧，Esc 取消。',
    right: '按回车移到右侧，Esc 取消。',
    up: '按回车移到上方，Esc 取消。',
    down: '按回车移到下方，Esc 取消。'
  },
  resize: (before, after) => `调整「${before}」和「${after}」的大小`,
  tabs: {
    changes: '更改',
    terminal: '终端',
    files: '文件',
    browser: '浏览器',
    preview: '预览',
    context: '上下文',
    branch: '分支',
    logs: '日志',
    quota: '额度'
  },
  overview: {
    title: '概览',
    back: '概览',
    backLabel: '返回概览',
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
    permissionLabel: '权限',
    contextUsed: '已用',
    lastCompaction: '上次压缩',
    stopTask: '停止任务',
    stopFailed: '停止任务失败',
    taskDetail: '查看详情',
    runningCount: (n) => `运行中 ${n}`,
    doneCount: (n) => `${n} 项已结束`,
    runningSection: (n) => `运行中 ${n}`,
    finishedSection: (n) => `已结束 ${n}`,
    showOutput: '展开输出',
    hideOutput: '收起输出',
    earlierOutput: '（更早的输出未显示）',
    taskGone: '任务已经结束，无需停止',
    scheduledKind: '定时',
    moreTools: '更多工具',
    quotaFailed: '额度查询失败',
    quotaExpired: '登录已过期',
    balance: '余额',
    mcpFailed: 'MCP 状态读取失败',
    mcpConnected: (ready, total) => `已连接 ${ready}/${total}`,
    mcpTools: (n) => `${n} 个工具`,
    mcpStatus: { ready: '已连接', connecting: '连接中', disconnected: '未连接', 'needs-auth': '需授权', error: '出错' },
    changesNone: '无改动',
    changesFiles: (n) => `${n} 个文件`,
    changesStaged: '已暂存',
    changesUnstaged: '未暂存',
    changesUntracked: '未跟踪'
  }
}

const EN: WorkbenchText = {
  title: 'Workspace',
  close: 'Close workspace',
  open: 'Open workspace',
  activateHint: 'This tab requires the session to be active first.',
  activate: 'Activate session',
  activateFailed: 'Could not activate the session',
  notWired: 'Not wired yet',
  notWiredHint: 'This tab is still being integrated.',
  inactiveTitle: 'Session not active',
  chatName: 'Chat',
  split: 'Split top and bottom',
  unsplit: 'Remove split',
  focus: 'Focus',
  unfocus: 'Exit focus',
  popout: 'Pop out into a window',
  unmigrated: 'Not migrated',
  secondaryPane: 'Lower pane tab',
  expand: 'Expand',
  collapse: 'Collapse',
  closePane: 'Close panel',
  paneMenu: (name) => `${name} settings`,
  moveBesideChat: 'Move beside chat',
  viewOptions: 'View options',
  changesScope: 'Working tree',
  move: 'Move',
  moveInstructions: 'Use the arrow keys to move the panel: along its row or column to reorder, across it to preview a move, then Enter. Escape cancels. While dragging, drop left of the panel to move it beside the chat; Escape restores it.',
  movedTo: (name, position, count) => `${name} is now in position ${position} of ${count}.`,
  moveCancelled: (name) => `Moving ${name} was cancelled.`,
  moveSide: { left: 'Move left', right: 'Move right', up: 'Move up', down: 'Move down' },
  moveSideHint: {
    left: 'Press Enter to move left, or Escape to cancel.',
    right: 'Press Enter to move right, or Escape to cancel.',
    up: 'Press Enter to move up, or Escape to cancel.',
    down: 'Press Enter to move down, or Escape to cancel.'
  },
  resize: (before, after) => `Resize ${before} and ${after}`,
  tabs: {
    changes: 'Changes',
    terminal: 'Terminal',
    files: 'Files',
    browser: 'Browser',
    preview: 'Preview',
    context: 'Context',
    branch: 'Branches',
    logs: 'Logs',
    quota: 'Quota'
  },
  overview: {
    title: 'Overview',
    back: 'Overview',
    backLabel: 'Back to overview',
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
    permissionLabel: 'Permission',
    contextUsed: 'Used',
    lastCompaction: 'Last compaction',
    stopTask: 'Stop task',
    stopFailed: 'Could not stop the task',
    taskDetail: 'View details',
    runningCount: (n) => `${n} running`,
    doneCount: (n) => `${n} finished`,
    runningSection: (n) => `Running ${n}`,
    finishedSection: (n) => `Finished ${n}`,
    showOutput: 'Show output',
    hideOutput: 'Hide output',
    earlierOutput: '(Earlier output not shown)',
    taskGone: 'The task already ended; nothing to stop',
    scheduledKind: 'Scheduled',
    moreTools: 'More tools',
    quotaFailed: 'Quota check failed',
    quotaExpired: 'Sign-in expired',
    balance: 'Balance',
    mcpFailed: 'Could not read MCP status',
    mcpConnected: (ready, total) => `${ready}/${total} connected`,
    mcpTools: (n) => `${n} tools`,
    mcpStatus: { ready: 'Connected', connecting: 'Connecting', disconnected: 'Disconnected', 'needs-auth': 'Needs auth', error: 'Error' },
    changesNone: 'No changes',
    changesFiles: (n) => `${n} files`,
    changesStaged: 'Staged',
    changesUnstaged: 'Unstaged',
    changesUntracked: 'Untracked'
  }
}

export function workbenchText(lang: Lang): WorkbenchText {
  return lang === 'en-US' ? EN : ZH
}
