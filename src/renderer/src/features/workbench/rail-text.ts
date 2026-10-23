import type { Lang } from '../../i18n'
import type { RailSectionId } from './rail-sections'

export interface RailText {
  railLabel: string
  sections: Record<RailSectionId, string>
  show: string
  reset: string
  sectionsMenu: string
  reorder: (name: string) => string
  pickedUp: (name: string, position: number, count: number) => string
  movedTo: (name: string, position: number, count: number) => string
  dropped: (name: string, position: number, count: number) => string
  cancelled: (name: string) => string
  reorderHint: string
  local: string
  folderMenu: string
  branchMenu: string
  reveal: string
  copyPath: string
  openFiles: string
  copyBranch: string
  openChanges: string
  resizeTiles: string
  progress: (done: number, total: number) => string
  outputsEmpty: string
  outputCreated: string
  outputModified: string
  outputDeleted: string
  connected: (ready: number, total: number) => string
  outputFiles: (n: number) => string
  changesNone: string
  tasksRunning: (n: number) => string
  tasksEnded: (n: number) => string
  extensionsCount: (n: number) => string
  more: (n: number) => string
  showLess: string
  removeOutput: (name: string) => string
  dirty: string
  cacheHit: string
  linesChanged: (added: number, removed: number) => string
}

const ZH: RailText = {
  railLabel: '会话详情',
  sections: {
    environment: '环境',
    stats: '会话统计',
    context: '上下文',
    usage: '用量',
    connectors: '连接器',
    progress: '进度',
    outputs: '产出',
    changes: '更改',
    backgroundTasks: '后台任务',
    extensions: '扩展'
  },
  show: '显示',
  reset: '恢复默认',
  sectionsMenu: '分区',
  reorder: (name) => `调整「${name}」的位置`,
  pickedUp: (name, position, count) => `已拿起「${name}」，当前第 ${position} / ${count} 个分区`,
  movedTo: (name, position, count) => `「${name}」移到第 ${position} / ${count} 个分区`,
  dropped: (name, position, count) => `「${name}」放在第 ${position} / ${count} 个分区`,
  cancelled: (name) => `已取消移动「${name}」`,
  reorderHint: '按空格或回车拿起分区，用上下方向键移动，再按空格或回车放下，Esc 取消。',
  local: '本机',
  folderMenu: '项目文件夹操作',
  branchMenu: '分支操作',
  reveal: '在文件夹中显示',
  copyPath: '复制路径',
  openFiles: '在文件面板打开',
  copyBranch: '复制分支名',
  openChanges: '在变更面板打开',
  resizeTiles: '调整磁贴宽度',
  progress: (done, total) => `${done} / ${total}`,
  outputsEmpty: '本会话还没有写入文件',
  outputCreated: '新建',
  outputModified: '修改',
  outputDeleted: '删除',
  connected: (ready, total) => `${ready} / ${total} 已连接`,
  outputFiles: (n) => `${n} 个文件`,
  changesNone: '无更改',
  tasksRunning: (n) => `${n} 运行中`,
  tasksEnded: (n) => `${n} 已结束`,
  extensionsCount: (n) => `${n} 项`,
  more: (n) => `更多（${n}）`,
  showLess: '收起',
  removeOutput: (name) => `从列表移除「${name}」`,
  dirty: '工作区有未提交的改动',
  cacheHit: '缓存命中率',
  linesChanged: (added, removed) => `新增 ${added} 行，删除 ${removed} 行`
}

const EN: RailText = {
  railLabel: 'Session details',
  sections: {
    environment: 'Environment',
    stats: 'Session stats',
    context: 'Context',
    usage: 'Usage',
    connectors: 'Connectors',
    progress: 'Progress',
    outputs: 'Outputs',
    changes: 'Changes',
    backgroundTasks: 'Background tasks',
    extensions: 'Extensions'
  },
  show: 'Show',
  reset: 'Reset to defaults',
  sectionsMenu: 'Sections',
  reorder: (name) => `Reorder ${name}`,
  pickedUp: (name, position, count) => `Picked up ${name}. It is section ${position} of ${count}.`,
  movedTo: (name, position, count) => `${name} is now section ${position} of ${count}.`,
  dropped: (name, position, count) => `${name} dropped at section ${position} of ${count}.`,
  cancelled: (name) => `Moving ${name} was cancelled.`,
  reorderHint: 'Press Space or Enter to pick up a section, the arrow keys to move it, Space or Enter to drop it, Escape to cancel.',
  local: 'Local',
  folderMenu: 'Project folder actions',
  branchMenu: 'Branch actions',
  reveal: 'Show in folder',
  copyPath: 'Copy path',
  openFiles: 'Open in Files',
  copyBranch: 'Copy branch name',
  openChanges: 'Open in Changes',
  resizeTiles: 'Resize tiles',
  progress: (done, total) => `${done} / ${total}`,
  outputsEmpty: 'No files written in this session yet',
  outputCreated: 'Created',
  outputModified: 'Modified',
  outputDeleted: 'Deleted',
  connected: (ready, total) => `${ready} / ${total} connected`,
  outputFiles: (n) => (n === 1 ? '1 file' : `${n} files`),
  changesNone: 'No changes',
  tasksRunning: (n) => `${n} running`,
  tasksEnded: (n) => `${n} finished`,
  extensionsCount: (n) => (n === 1 ? '1 item' : `${n} items`),
  more: (n) => `${n} more`,
  showLess: 'Show less',
  removeOutput: (name) => `Remove ${name} from the list`,
  dirty: 'Uncommitted changes in the working tree',
  cacheHit: 'Cache hit rate',
  linesChanged: (added, removed) => `${added} lines added, ${removed} lines removed`
}

export function railText(lang: Lang): RailText {
  return lang === 'en-US' ? EN : ZH
}
