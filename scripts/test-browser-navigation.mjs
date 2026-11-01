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

  ok(m.addressTarget('localhost:5173') === 'http://localhost:5173', '本机端口走 http，不被当成协议名')
  ok(m.addressTarget('example.com/a') === 'https://example.com/a', '域名补 https')
  ok(m.addressTarget('https://x.dev') === 'https://x.dev', '完整网址原样')
  ok(m.addressTarget('electron 文档') === 'https://www.bing.com/search?q=electron%20%E6%96%87%E6%A1%A3', '带空格的输入默认走 Bing 搜索')
  ok(m.addressTarget('hello', 'baidu') === 'https://www.baidu.com/s?wd=hello', '预设引擎按 id 生效')
  ok(m.addressTarget('hi', 'https://s.example/?k=%s') === 'https://s.example/?k=hi', '自定义模板替换 %s')
  ok(m.normalizeSearchEngine('bing') === undefined && m.normalizeSearchEngine('google') === 'google', '默认引擎不落盘，其它预设保留')
  ok(m.normalizeSearchEngine('javascript:%s') === undefined && m.normalizeSearchEngine('https://x/?q=') === undefined, '非 http(s) 或缺 %s 的模板丢弃')
}
