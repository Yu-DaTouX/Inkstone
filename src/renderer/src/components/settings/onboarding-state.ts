/**
 * 首次引导的「看过」标记。
 *
 * key 沿用 `yan.onboarded`（旧版首次引导写的同一个键）：升级后的用户不会被
 * 再拦一次，验收探针里那二十多处 `localStorage.setItem('yan.onboarded', '1')`
 * 也照旧能压住弹窗。
 */

const SEEN_KEY = 'yan.onboarded'

export function hasSeenOnboarding(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    /* file:// 下可能读不到 —— 当成没看过，宁可多提示一次 */
    return false
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    /* 忽略 */
  }
}

/**
 * 首次启动是否自动打开配置向导。
 *
 * 与旧版「只在检测到问题时才弹」不同：向导本身就是配置流程（外观、提醒、
 * 模型接入、上下文），环境正常的用户同样需要走一遍，所以只看有没有看过。
 * 用户随时可以「稍后再说」退出，退出后不再自动出现。
 */
export function shouldAutoWizard(): boolean {
  return !hasSeenOnboarding()
}
