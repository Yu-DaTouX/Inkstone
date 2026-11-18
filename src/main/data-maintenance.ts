import { join } from 'node:path'
import { autoPruneAttachments } from './attachment-auto-prune'
import { pruneCheckpoints } from './checkpoints'
import { scheduleIdleTask } from './idle-schedule'
import { YAN_DIR } from './paths'
import { QUEUE_RECOVERY_DIR } from './queue-persistence'
import { clearSessionReadCache } from './session-reader'
import { ATTACHMENT_SESSION_DIRS } from './sessions'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

export interface DataMaintenanceDeps {
  isBusy: () => boolean
  trash: (file: string) => Promise<void>
}

export function startDataMaintenance(deps: DataMaintenanceDeps): () => void {
  const stopCheckpoints = scheduleIdleTask({
    name: 'checkpoint prune',
    firstDelayMs: MINUTE_MS,
    intervalMs: 8 * HOUR_MS,
    retryMs: 10 * MINUTE_MS,
    isBusy: deps.isBusy,
    run: () => pruneCheckpoints()
  })
  const stopAttachments = scheduleIdleTask({
    name: 'attachment prune',
    firstDelayMs: 3 * MINUTE_MS,
    intervalMs: 24 * HOUR_MS,
    retryMs: 10 * MINUTE_MS,
    backoffMs: [10 * MINUTE_MS, HOUR_MS, 6 * HOUR_MS],
    isBusy: deps.isBusy,
    run: async () => {
      const outcome = await autoPruneAttachments({
        attachmentsDir: join(YAN_DIR, 'attachments'),
        sessionDirs: ATTACHMENT_SESSION_DIRS,
        queueDir: QUEUE_RECOVERY_DIR,
        isBusy: deps.isBusy,
        trash: deps.trash,
        afterPrune: clearSessionReadCache
      })
      if (outcome.status === 'busy' || (outcome.status === 'done' && outcome.stopped)) return 'busy'
      return outcome.status !== 'changed'
    }
  })
  return () => {
    stopCheckpoints()
    stopAttachments()
  }
}
