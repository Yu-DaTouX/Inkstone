/** 原生网页显隐协调（实施-11 H-9a）：纯判定 + overlay blocker 计数。 */
export async function runBrowserVisibilityTests(ok) {
  const { OverlayBlockers, shouldShowBrowser } = await import('../out/test/browser-visibility.mjs')

  console.log('\n--- H-9a 原生网页显隐协调 ---')
  const base = { browserOpen: true, rightPanelOpen: true, activeBrowserSurface: true, overlayBlockers: 0 }
  ok(shouldShowBrowser(base) === true, '四条件都满足时才显示原生网页')
  ok(shouldShowBrowser({ ...base, browserOpen: false }) === false, '没有打开的网页不显示')
  ok(shouldShowBrowser({ ...base, rightPanelOpen: false }) === false, '右栏收起时原生区域一起不可见')
  ok(shouldShowBrowser({ ...base, activeBrowserSurface: false }) === false, '活动页不是浏览器时不显示')
  ok(shouldShowBrowser({ ...base, overlayBlockers: 1 }) === false, '有 overlay blocker 时隐藏')

  const blockers = new OverlayBlockers()
  ok(blockers.size === 0, '初始没有 blocker')
  blockers.acquire('settings')
  ok(blockers.size === 1 && blockers.has('settings'), '领取 blocker 计数 +1')
  blockers.acquire('settings')
  ok(blockers.size === 1, '同一 token 重复领取只算一个（嵌套）')
  blockers.release('settings')
  ok(blockers.size === 1 && blockers.has('settings'), '嵌套领取只释放一次不会提前解除')
  blockers.release('settings')
  ok(blockers.size === 0 && !blockers.has('settings'), '全部释放后解除')
  blockers.release('settings')
  ok(blockers.size === 0, '重复释放是 no-op')

  blockers.acquire('a')
  blockers.acquire('b')
  blockers.release('a')
  ok(blockers.has('b') && !blockers.has('a'), '释放自己的 token 不影响别人的')
  blockers.clear()
  ok(blockers.size === 0, 'clear 清空全部')
}
