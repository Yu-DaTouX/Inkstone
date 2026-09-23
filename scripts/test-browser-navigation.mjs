/**
 * 浏览器导航状态判定（H-9 第二阶段）的纯逻辑测试。
 *
 * 为什么值得单独测：这几条判断决定用户**看不看得见**页面为什么打不开，
 * 以及“打字打到一半会不会被后台导航冲掉”。两条都只在真实窗口里才暴露，
 * 但逻辑本身是纯函数 —— 在这里钉住，探针只负责验“真的接到界面上了”。
 */
export async function runBrowserNavigationTests(ok) {
  const m = await import('../out/test/browser-navigation.mjs')

  /* ---- 什么算“打不开” ---- */
  ok(m.shouldSurfaceLoadError(-105, true) === true, '主框架加载失败要显示给用户')
  ok(m.shouldSurfaceLoadError(-105, false) === false, '子框架失败（广告 iframe）不打扰用户')
  ok(m.shouldSurfaceLoadError(m.ERR_ABORTED, true) === false, '被取消 / 被新导航取代不算失败')
  ok(m.shouldSurfaceLoadError(-2, true) === true, '其它 net error 一律显示')

  /* ---- 地址栏：草稿优先 ---- */
  ok(m.nextAddressInput('https://a/', '正在输入', true) === '正在输入', '正在编辑时保留草稿')
  ok(m.nextAddressInput('https://a/', '正在输入', false) === 'https://a/', '没在编辑时跟随已提交地址')
  ok(m.nextAddressInput('', '', false) === '', '空地址不炸')

  /* ---- 出错时保留哪个地址 ---- */
  ok(m.failureUrl('https://x', 'https://y') === 'https://x', '优先用 Chromium 报的地址')
  ok(m.failureUrl('', 'https://y') === 'https://y', '没报地址时退回当前地址')
  ok(m.failureUrl(undefined, 'https://y') === 'https://y', 'undefined 也退回当前地址')
  ok(m.failureUrl('   ', 'https://y') === 'https://y', '空白地址同样退回')

  /* ---- 旧导航结果判定 ---- */
  ok(m.sameCommittedUrl('https://a/', 'https://a') === true, '末尾斜杠不算差别')
  ok(m.sameCommittedUrl('https://a', 'https://b') === false, '不同地址不相同')
}
