/**
 * 「工作时保持电脑不睡眠」的判定。纯函数；真正申请与释放系统锁在 `main/keep-awake.ts`。
 */
export interface KeepAwakeInput {
  /** 有会话正在跑（回合进行中）。 */
  working: boolean
  /** 当前靠电池供电。 */
  onBattery: boolean
  /** 设置：工作时保持唤醒；缺省 = 开。 */
  whileWorking?: boolean
  /** 设置：用电池时也保持；缺省 = 开。 */
  onBatteryAllowed?: boolean
}

export function shouldKeepAwake(input: KeepAwakeInput): boolean {
  if (!input.working) return false
  if (input.whileWorking === false) return false
  if (input.onBattery && input.onBatteryAllowed === false) return false
  return true
}

/** 工作结束后再多撑一会儿再放锁，回合之间的短暂空档不会让系统趁机睡下去。 */
export const KEEP_AWAKE_RELEASE_MS = 30_000
