import { dialog, type BrowserWindow } from 'electron'
import { pick } from '../shared/ui-lang'
import { BACKUP_PART_LABELS, type BackupPartId, type BackupTooLarge } from '../shared/data-backup'

function size(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MiB`
}

export async function askSkipLargeParts(win: BrowserWindow | null, info: BackupTooLarge, context: 'backup' | 'update'): Promise<BackupPartId[] | null> {
  const { parts, suggested, maxFiles, maxBytes } = info
  const lines = parts.map((item) => {
    const label = pick(BACKUP_PART_LABELS[item.part].zh, BACKUP_PART_LABELS[item.part].en)
    const mark = suggested.includes(item.part) ? pick('（将跳过）', ' - will be skipped') : ''
    return pick(`${label}：${item.files.toLocaleString('zh-CN')} 个文件，${size(item.bytes)}${mark}`, `${label}: ${item.files.toLocaleString('en-US')} files, ${size(item.bytes)}${mark}`)
  }).join('\n')
  const limit = pick(`${maxFiles.toLocaleString('zh-CN')} 个文件 / ${size(maxBytes)}`, `${maxFiles.toLocaleString('en-US')} files / ${size(maxBytes)}`)
  const question = context === 'update'
    ? pick('是否跳过标注的部分，备份其余内容后继续安装更新？跳过的部分不在这份备份里，出问题时无法用它恢复。', 'Skip the marked parts, back up the rest and continue installing the update? Skipped parts are not in this backup and cannot be recovered from it.')
    : pick('是否跳过标注的部分，备份其余内容？备份结果里会写明跳过了什么；当前数据不会被改动。', 'Skip the marked parts and back up everything else? The backup result will list what was skipped. Nothing is deleted from your current data.')
  const options = {
    type: 'warning' as const,
    title: context === 'update' ? pick('更新前备份太大', 'The pre-update backup is too large') : pick('备份内容太大', 'Backup is too large'),
    message: pick(`数据超过备份上限（${limit}）。`, `The data exceeds the backup limit (${limit}).`),
    detail: `${lines}\n\n${question}`,
    buttons: [pick('跳过并继续', 'Skip and continue'), pick('取消', 'Cancel')],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }
  const answer = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  return answer.response === 0 ? suggested : null
}
