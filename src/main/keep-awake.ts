import { powerMonitor, powerSaveBlocker } from 'electron'
import { KEEP_AWAKE_RELEASE_MS, shouldKeepAwake } from '../shared/keep-awake'

let blockerId: number | null = null
let releaseTimer: NodeJS.Timeout | null = null
let last = { working: false, whileWorking: undefined as boolean | undefined, onBatteryAllowed: undefined as boolean | undefined }

function acquire(): void {
  if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) return
  blockerId = powerSaveBlocker.start('prevent-app-suspension')
}

function release(): void {
  if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null }
  if (blockerId !== null) {
    try { powerSaveBlocker.stop(blockerId) } catch { }
    blockerId = null
  }
}

function onBattery(): boolean {
  try { return powerMonitor.isOnBatteryPower() } catch { return false }
}

export function updateKeepAwake(next: { working: boolean; whileWorking?: boolean; onBatteryAllowed?: boolean }): void {
  last = { working: next.working, whileWorking: next.whileWorking, onBatteryAllowed: next.onBatteryAllowed }
  const keep = shouldKeepAwake({ ...last, onBattery: onBattery() })
  if (keep) {
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null }
    acquire()
    return
  }
  if (next.whileWorking === false || onBattery() && next.onBatteryAllowed === false) { release(); return }
  if (blockerId === null || releaseTimer) return
  releaseTimer = setTimeout(release, KEEP_AWAKE_RELEASE_MS)
}

export function watchPowerSource(): void {
  const again = (): void => updateKeepAwake(last)
  powerMonitor.on('on-battery', again)
  powerMonitor.on('on-ac', again)
}

export function disposeKeepAwake(): void {
  release()
}
