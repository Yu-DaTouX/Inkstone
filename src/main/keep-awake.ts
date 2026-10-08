/**
 * 工作时保持电脑不睡眠：有会话在跑就申请「阻止应用挂起」，停下 30 秒后释放。
 *
 * 只阻止空闲睡眠，不阻止合盖睡眠，也不点亮屏幕。申请与释放都在这里，
 * 判定规则在 `shared/keep-awake.ts`。
 */
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
    try { powerSaveBlocker.stop(blockerId) } catch { /* 已经释放 */ }
    blockerId = null
  }
}

function onBattery(): boolean {
  try { return powerMonitor.isOnBatteryPower() } catch { return false }
}

/** 运行实例状态或相关设置变化后调用；重复调用是安全的。 */
export function updateKeepAwake(next: { working: boolean; whileWorking?: boolean; onBatteryAllowed?: boolean }): void {
  last = { working: next.working, whileWorking: next.whileWorking, onBatteryAllowed: next.onBatteryAllowed }
  const keep = shouldKeepAwake({ ...last, onBattery: onBattery() })
  if (keep) {
    if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null }
    acquire()
    return
  }
  if (blockerId === null || releaseTimer) return
  /* 设置被关掉要立刻放；只是工作停了才延迟放 */
  if (next.whileWorking === false || !next.working && onBattery() && next.onBatteryAllowed === false) { release(); return }
  releaseTimer = setTimeout(release, KEEP_AWAKE_RELEASE_MS)
}

/** 插拔电源时按最近一次的输入重算。 */
export function watchPowerSource(): void {
  const again = (): void => updateKeepAwake(last)
  powerMonitor.on('on-battery', again)
  powerMonitor.on('on-ac', again)
}

export function disposeKeepAwake(): void {
  release()
}
