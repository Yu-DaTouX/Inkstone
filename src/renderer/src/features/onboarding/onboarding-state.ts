/**
 * 首次引导的「看过」标记（v3 侧，与主区 `components/settings/onboarding-state.ts` 同键）。
 *
 * key 沿用 `yan.onboarded`：v2 首启向导、主区验收探针里
 * `localStorage.setItem('yan.onboarded', '1')` 与新模块互相认得，切外壳不会重复弹窗。
 *
 * 这里只管「看过没有」，不记录走到第几步，也不改任何设置：设置由向导每一步
 * 直接调用现有 `patchSettings` 落盘，中途关掉窗口已改的部分保留。
 */

export const ONBOARDED_STORAGE_KEY = 'yan.onboarded'

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    /* 隐私模式 / file:// 下取不到 —— 当作没有存储 */
    return null
  }
}

export function hasSeenOnboarding(): boolean {
  try {
    return storage()?.getItem(ONBOARDED_STORAGE_KEY) === '1'
  } catch {
    /* 读不到就当作没看过，宁可多提示一次 */
    return false
  }
}

export function markOnboarded(): void {
  try {
    storage()?.setItem(ONBOARDED_STORAGE_KEY, '1')
  } catch {
    /* 忽略：存不了就只在本次会话生效 */
  }
}

/**
 * 首次启动是否自动打开配置向导。
 *
 * 与主区一致：不看环境有没有问题，只看有没有看过。环境正常的用户同样需要
 * 把外观 / 提醒 / 接入 / 上下文过一遍；随时可以「跳过」退出，退出即标记看过。
 */
export function shouldAutoWizard(): boolean {
  return !hasSeenOnboarding()
}

/** 仅供「重新查看引导」与本地测试：清掉标记，让下次判断重新自动打开。 */
export function resetOnboarded(): void {
  try {
    storage()?.removeItem(ONBOARDED_STORAGE_KEY)
  } catch {
    /* 忽略 */
  }
}
