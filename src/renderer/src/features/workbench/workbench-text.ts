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
    mcp: string
    changes: string
    quota: string
  }
  noBranch: string
  detached: string
  branchLabel: string
  permissionLabel: string
  contextUsed: string
  moreTools: string
  quotaFailed: string
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
  notWired: string
  notWiredHint: string
  inactiveTitle: string
  split: string
  unsplit: string
  focus: string
  unfocus: string
  popout: string
  unmigrated: string
  secondaryPane: string
  tabs: Record<WorkbenchTabId, string>
  overview: OverviewText
}

const ZH: WorkbenchText = {
  title: '工作区',
  close: '收起工作区',
  open: '打开工作区',
  activateHint: '这个页签需要先在当前会话激活。',
  activate: '激活会话',
  notWired: '尚未接入',
  notWiredHint: '这个页签的界面还在接入中。',
  inactiveTitle: '会话未激活',
  split: '上下拆分',
  unsplit: '取消拆分',
  focus: '专注',
  unfocus: '退出专注',
  popout: '弹出为独立窗口',
  unmigrated: '未迁移',
  secondaryPane: '下半格页签',
  tabs: {
    changes: '改动',
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
      mcp: 'MCP',
      changes: '更改',
      quota: '额度'
    },
    noBranch: '未知分支',
    detached: '游离 HEAD',
    branchLabel: '分支',
    permissionLabel: '权限',
    contextUsed: '已用',
    moreTools: '更多工具',
    quotaFailed: '额度查询失败',
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
  notWired: 'Not wired yet',
  notWiredHint: 'This tab is still being integrated.',
  inactiveTitle: 'Session not active',
  split: 'Split top and bottom',
  unsplit: 'Remove split',
  focus: 'Focus',
  unfocus: 'Exit focus',
  popout: 'Pop out into a window',
  unmigrated: 'Not migrated',
  secondaryPane: 'Lower pane tab',
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
      mcp: 'MCP',
      changes: 'Changes',
      quota: 'Quota'
    },
    noBranch: 'Unknown branch',
    detached: 'Detached HEAD',
    branchLabel: 'Branch',
    permissionLabel: 'Permission',
    contextUsed: 'Used',
    moreTools: 'More tools',
    quotaFailed: 'Quota check failed',
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
