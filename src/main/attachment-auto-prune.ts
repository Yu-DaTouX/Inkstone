import { existsSync } from 'node:fs'
import {
  listSessionFiles,
  referencedAttachmentNames,
  referencedQueueImages,
  sessionFilesFingerprint,
  trashStaleAttachments
} from './attachments'

const DAY_MS = 24 * 60 * 60 * 1000
export const ATTACHMENT_AUTO_MAX_AGE_MS = 30 * DAY_MS

export interface AttachmentAutoPruneDeps {
  attachmentsDir: string
  sessionDirs: string[]
  queueDir: string
  isBusy: () => boolean
  trash: (file: string) => Promise<void>
  now?: () => number
  maxAgeMs?: number
  log?: (line: string) => void
  afterPrune?: () => void
}

export type AttachmentAutoPruneOutcome =
  | { status: 'empty' | 'busy' | 'changed' }
  | { status: 'done'; removed: number; bytes: number; kept: number; failed: number; stopped: boolean }

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

export async function autoPruneAttachments(deps: AttachmentAutoPruneDeps): Promise<AttachmentAutoPruneOutcome> {
  const log = deps.log ?? ((line: string) => console.log(line))
  if (!existsSync(deps.attachmentsDir)) return { status: 'empty' }
  if (deps.isBusy()) return { status: 'busy' }
  const before = (deps.now?.() ?? Date.now()) - (deps.maxAgeMs ?? ATTACHMENT_AUTO_MAX_AGE_MS)
  const listAll = (): string[] => deps.sessionDirs.flatMap((dir) => listSessionFiles(dir))
  const files = listAll()
  const initial = await sessionFilesFingerprint(files)
  const referenced = await referencedAttachmentNames(files, { skipHarmlessCorruptLines: true })
  for (const name of await referencedQueueImages(deps.queueDir)) referenced.add(name)
  if (deps.isBusy()) return { status: 'busy' }
  if (initial !== (await sessionFilesFingerprint(listAll()))) return { status: 'changed' }
  const result = await trashStaleAttachments(deps.attachmentsDir, referenced, { before, trash: deps.trash, stillIdle: () => !deps.isBusy(), log })
  if (result.removed || result.failed) {
    log(`[attachments] auto cleanup moved ${result.removed} unreferenced attachments older than 30 days to the Recycle Bin, freed ${mb(result.bytes)}; ${result.failed} failed and were skipped${result.stopped ? '; paused because a turn started' : ''}`)
  }
  if (result.removed) deps.afterPrune?.()
  return { status: 'done', ...result }
}
