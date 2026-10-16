/**
 * 工作区面板自己的短文案（v3 未定稿，不写进两份共享 i18n JSON）。
 * 与 `app/v3-text.ts` 同样的理由：外壳定稿后再统一并入 i18n。
 */
import type { Lang } from '../../i18n'
import type { WorkbenchTabId } from './types'

/** 概览磁贴与头部的文案。 */
export interface OverviewText {
  title: string
  back: string
  backLabel: string
  openFull: string
  tiles: {
    env: string
    context: string
    quota: string
    tasks: string
    todos: string
  }
  noBranch: string
  detached: string
  projectLabel: string
  pathLabel: string
  branchLabel: string
  permissionLabel: string
  contextUsed: string
  stopTask: string
  taskDetail: string
  moreTools: string
  quotaChecking: string
  quotaFailed: string
  noTasks: string
  noTodos: string
  runningCount: (n: number) => string
  doneCount: (n: number) => string
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
      quota: '额度',
      tasks: '后台任务',
      todos: '待办'
    },
    noBranch: '未知分支',
    detached: '游离 HEAD',
    projectLabel: '项目',
    pathLabel: '路径',
    branchLabel: '分支',
    permissionLabel: '权限',
    contextUsed: '已用',
    stopTask: '停止',
    taskDetail: '查看详情',
    moreTools: '更多工具',
    quotaChecking: '正在查询额度…',
    quotaFailed: '额度查询失败',
    noTasks: '暂无后台任务',
    noTodos: '暂无待办',
    runningCount: (n) => `运行中 ${n}`,
    doneCount: (n) => `${n} 项已结束`
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
      quota: 'Quota',
      tasks: 'Background tasks',
      todos: 'Todos'
    },
    noBranch: 'Unknown branch',
    detached: 'Detached HEAD',
    projectLabel: 'Project',
    pathLabel: 'Path',
    branchLabel: 'Branch',
    permissionLabel: 'Permission',
    contextUsed: 'Used',
    stopTask: 'Stop',
    taskDetail: 'View details',
    moreTools: 'More tools',
    quotaChecking: 'Checking quota…',
    quotaFailed: 'Quota check failed',
    noTasks: 'No background tasks',
    noTodos: 'No todos',
    runningCount: (n) => `${n} running`,
    doneCount: (n) => `${n} done`
  }
}

export function workbenchText(lang: Lang): WorkbenchText {
  return lang === 'en-US' ? EN : ZH
}
