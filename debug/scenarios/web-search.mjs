export const meta = { description: '搜索来源与原文状态：深浅主题、中英文、窄屏、键盘展开与失败可见性；只用合成消息，不调用搜索服务' }

export default async function run({ cdp, newSession, check, sleep, shot }) {
  await newSession()
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', rightPanelOpen: false })`)
  const sources = [
    { title: 'Official documentation: structured page content and long article navigation', url: 'https://docs.example.com/guide', snippet: '候选摘要，不表示已读取原文。', published: '2026-10-29', readState: 'discovered' },
    { title: 'Original research with a retained publication date', url: 'https://research.example.org/paper', snippet: 'Research excerpt', published: '2026-10-28', readState: 'discovered' },
    { title: 'A cached source page', url: 'https://example.net/article', snippet: 'Cached snippet', readState: 'discovered' }
  ]
  const messages = [
    { id: 'web-user', role: 'user', text: '查找原始资料，并定位长文章中的例外条件。', timestamp: Date.now() - 5000 },
    { id: 'web-tools', role: 'assistant', text: '', toolCalls: [
      { id: 'web-search-fixture', name: 'web_search', args: { queries: ['original documentation', 'research exception clause'] }, status: 'ok', output: 'Search candidate links', details: { search: { action: 'query', query: 'original documentation', items: sources } } },
      { id: 'web-fetch-fixture', name: 'web_fetch', args: { url: sources[0].url }, status: 'ok', output: 'Partial original page; continue with offset=12000', details: { search: { action: 'fetch', url: sources[0].url, title: sources[0].title, readState: 'partial', cached: true, fetchedAt: '2026-10-29T00:00:00Z', truncated: true } } },
      { id: 'web-error-fixture', name: 'web_fetch', args: { url: 'https://blocked.example.com/' }, status: 'error', output: 'web_fetch failed: 网页返回了验证页面，未取得正文' }
    ] },
    { id: 'web-answer', role: 'assistant', text: '搜索结果提供了候选资料；长文仍需续读后核对例外条件。[查看原文](https://docs.example.com/guide)', timestamp: Date.now() }
  ]
  await cdp.evaluate(`window.__yanStore.setState({ messages: ${JSON.stringify(messages)}, historyLoading: false, switchLoading: false })`)
  await sleep(700)
  await cdp.evaluate(`document.querySelector('[data-testid=v3-process-toggle]')?.click()`)
  await sleep(250)
  check('批量查询和来源卡片出现', await cdp.evaluate(`document.querySelectorAll('[data-testid=ws-capsule]').length === 2 && document.body.innerText.includes('搜索命中')`))
  await cdp.evaluate(`document.querySelector('[data-testid=v3-step]')?.click()`)
  await sleep(150)
  check('失败原因保持可见', await cdp.evaluate(`document.body.innerText.includes('验证页面')`))
  await cdp.evaluate(`(() => { const cap = document.querySelectorAll('[data-testid=ws-capsule]')[1]; cap.focus(); cap.click(); })()`)
  await sleep(150)
  check('部分原文与缓存状态显示', await cdp.evaluate(`document.body.innerText.includes('部分原文') && document.body.innerText.includes('缓存')`))
  check('展开控件可聚焦', await cdp.evaluate(`document.activeElement?.matches('[data-testid=ws-capsule]')`))
  const width = await cdp.evaluate('innerWidth')
  for (const [theme, lang] of [['dark', 'zh-CN'], ['light', 'zh-CN'], ['dark', 'en-US'], ['light', 'en-US']]) {
    await cdp.evaluate(`window.__yanStore.getState().patchSettings(${JSON.stringify({ theme, lang })})`)
    await sleep(350)
    const state = await cdp.evaluate(`({ overflow: document.documentElement.scrollWidth > innerWidth + 1, candidates: document.body.innerText.includes(${JSON.stringify(lang === 'en-US' ? 'Search result' : '搜索命中')}), partial: document.body.innerText.includes(${JSON.stringify(lang === 'en-US' ? 'Partial text' : '部分原文')}) })`)
    check(`${theme}/${lang}/${width} 状态完整且无横向溢出`, !state.overflow && state.candidates && state.partial, state)
    await Promise.race([shot(`web-search-${theme}-${lang}-${width}`), sleep(5000).then(() => { throw new Error(`截图超时：${theme}/${lang}/${width}`) })])
  }
}
