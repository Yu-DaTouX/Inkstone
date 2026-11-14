import type { Lang } from '../../i18n'
import type { RailSectionId } from './rail-sections'
import { singularizeOne } from '../../../../shared/ui-lang'

export interface RailText {
  railLabel: string
  sections: Record<RailSectionId, string>
  show: string
  sectionEmpty: string
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
  outputFiles: (n: number) => string
  changesNone: string
  tasksRunning: (n: number) => string
  tasksEnded: (n: number) => string
  extensionsCount: (n: number) => string
  more: (n: number) => string
  showLess: string
  removeOutput: (name: string) => string
  branchUnknown: string
  gitReadFailed: string
  peakTip: string
  cacheHit: string
  hitShort: string
  linesChanged: (added: number, removed: number) => string
  uncommitted: (n: number) => string
  uncommittedFiles: (n: number) => string
  staged: (n: number) => string
  synced: string
  localOnly: string
  upstream: (name: string) => string
  worktree: string
  worktreeTip: string
  compactLeft: string
  windowLeft: string
  compactReached: string
  compactAt: (pct: number) => string
  quotaTimeLeft: (pct: number) => string
  quotaUsed: string
}

const ZH: RailText = {
  railLabel: '会话详情',
  sections: {
    environment: '环境',
    stats: '会话统计',
    context: '上下文',
    usage: '用量',
    connectors: 'MCP',
    outputs: '产出',
    changes: '本会话改动',
    backgroundTasks: '后台任务',
    extensions: '扩展'
  },
  show: '显示',
  sectionEmpty: '暂无',
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
  resizeTiles: '调整会话栏宽度',
  outputFiles: (n) => `${n} 个文件`,
  changesNone: '无更改',
  tasksRunning: (n) => `${n} 运行中`,
  tasksEnded: (n) => `${n} 已结束`,
  extensionsCount: (n) => `${n} 项`,
  more: (n) => `更多（${n}）`,
  showLess: '收起',
  removeOutput: (name) => `从列表移除「${name}」`,
  branchUnknown: '分支未知',
  gitReadFailed: 'Git 状态读取失败，稍后自动重试',
  peakTip: 'DeepSeek 高峰时段，按峰价计费',
  cacheHit: '缓存命中率',
  hitShort: '命中',
  linesChanged: (added, removed) => `新增 ${added} 行，删除 ${removed} 行`,
  uncommitted: (n) => `${n} 未提交`,
  uncommittedFiles: (n) => `${n} 个文件未提交`,
  staged: (n) => `已暂存 ${n}`,
  synced: '已同步',
  localOnly: '仅本地',
  upstream: (name) => `上游 ${name}`,
  worktree: '工作树',
  worktreeTip: '这个文件夹是主仓库的一个工作树',
  compactLeft: '离自动压缩',
  windowLeft: '剩余',
  compactReached: '已到自动压缩线',
  compactAt: (pct) => `自动压缩在 ${pct}%`,
  quotaTimeLeft: (pct) => `窗口时间还剩 ${pct}%`,
  quotaUsed: '已用'
}

const EN: RailText = {
  railLabel: 'Session details',
  sections: {
    environment: 'Environment',
    stats: 'Session stats',
    context: 'Context',
    usage: 'Usage',
    connectors: 'MCP',
    outputs: 'Outputs',
    changes: 'Session edits',
    backgroundTasks: 'Background tasks',
    extensions: 'Extensions'
  },
  show: 'Show',
  sectionEmpty: 'Nothing yet',
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
  resizeTiles: 'Resize session bar',
  outputFiles: (n) => (n === 1 ? '1 file' : `${n} files`),
  changesNone: 'No changes',
  tasksRunning: (n) => `${n} running`,
  tasksEnded: (n) => `${n} finished`,
  extensionsCount: (n) => (n === 1 ? '1 item' : `${n} items`),
  more: (n) => `${n} more`,
  showLess: 'Show less',
  removeOutput: (name) => `Remove ${name} from the list`,
  branchUnknown: 'Branch unknown',
  gitReadFailed: 'Could not read Git status; retrying shortly',
  peakTip: 'DeepSeek peak hours: billed at peak rates',
  cacheHit: 'Cache hit rate',
  hitShort: 'Hit',
  linesChanged: (added, removed) => singularizeOne(`${added} lines added, ${removed} lines removed`),
  uncommitted: (n) => `${n} uncommitted`,
  uncommittedFiles: (n) => (n === 1 ? '1 uncommitted file' : `${n} uncommitted files`),
  staged: (n) => `${n} staged`,
  synced: 'Up to date',
  localOnly: 'Local only',
  upstream: (name) => `Upstream ${name}`,
  worktree: 'Worktree',
  worktreeTip: 'This folder is a worktree of the main repository',
  compactLeft: 'Until auto-compact',
  windowLeft: 'Free',
  compactReached: 'At auto-compact line',
  compactAt: (pct) => `Auto-compacts at ${pct}%`,
  quotaTimeLeft: (pct) => `${pct}% of the window left`,
  quotaUsed: 'used'
}

export function railText(lang: Lang): RailText {
  return lang === 'en-US' ? EN : ZH
}
