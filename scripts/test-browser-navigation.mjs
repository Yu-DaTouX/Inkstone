export async function runBrowserNavigationTests(ok) {
  const m = await import('../out/test/browser-navigation.mjs')

  ok(m.shouldSurfaceLoadError(-105, true) === true, '主框架加载失败要显示给用户')
  ok(m.shouldSurfaceLoadError(-105, false) === false, '子框架失败（广告 iframe）不打扰用户')
  ok(m.shouldSurfaceLoadError(m.ERR_ABORTED, true) === false, '被取消 / 被新导航取代不算失败')
  ok(m.shouldSurfaceLoadError(-2, true) === true, '其它 net error 一律显示')

  ok(m.nextAddressInput('https://a/', '正在输入', true) === '正在输入', '正在编辑时保留草稿')
  ok(m.nextAddressInput('https://a/', '正在输入', false) === 'https://a/', '没在编辑时跟随已提交地址')
  ok(m.nextAddressInput('', '', false) === '', '空地址不炸')

  ok(m.failureUrl('https://x', 'https://y') === 'https://x', '优先用 Chromium 报的地址')
  ok(m.failureUrl('', 'https://y') === 'https://y', '没报地址时退回当前地址')
  ok(m.failureUrl(undefined, 'https://y') === 'https://y', 'undefined 也退回当前地址')
  ok(m.failureUrl('   ', 'https://y') === 'https://y', '空白地址同样退回')

  ok(m.sameCommittedUrl('https://a/', 'https://a') === true, '末尾斜杠不算差别')
  ok(m.sameCommittedUrl('https://a', 'https://b') === false, '不同地址不相同')
}
