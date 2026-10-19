import type { GitFileStatus } from '../../../shared/git'

const LABELS: Record<'zh' | 'en', Record<GitFileStatus, string>> = {
  zh: { added: '新增', modified: '修改', deleted: '删除', renamed: '重命名', untracked: '未跟踪', unmerged: '冲突' },
  en: { added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed', untracked: 'Untracked', unmerged: 'Conflict' }
}

export function porcelainFileStatus(code: string): GitFileStatus {
  if (code === '??') return 'untracked'
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'unmerged'
  if (code.includes('D')) return 'deleted'
  if (code.includes('R') || code.includes('C')) return 'renamed'
  if (code.includes('A')) return 'added'
  return 'modified'
}

export function fileStatusLabel(status: GitFileStatus, lang: string | undefined): string {
  return LABELS[lang?.startsWith('en') ? 'en' : 'zh'][status]
}
