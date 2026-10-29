export const meta = { description: '网站图标与来源卡片动效：合成消息，匿名读取公开站点图标，不调用模型或搜索服务' }

export default async function run({ cdp, newSession, check, sleep, shot, report }) {
  await newSession()
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', reduceMotion: false, rightPanelOpen: false })`)
  const sources = [
    { title: 'Readability：提取网页正文的开源实现', url: 'https://github.com/mozilla/readability', snippet: '正文解析与结构提取', published: '2026-10-29', readState: 'discovered' },
    { title: 'MDN：文档结构与网页内容', url: 'https://developer.mozilla.org/en-US/docs/Web/HTML', snippet: 'HTML 文档结构参考', published: '2026-10-28', readState: 'read' },
    { title: 'React：构建交互界面的官方文档', url: 'https://react.dev/learn', snippet: '界面与状态管理', readState: 'discovered', cached: true },
    { title: 'Wikipedia：信息检索与来源核对', url: 'https://en.wikipedia.org/wiki/Information_retrieval', snippet: '信息检索概览', readState: 'discovered' },
    { title: '没有图标的网站仍可正常使用', url: 'https://missing-icon.invalid/article', snippet: '图标失败降级', readState: 'discovered' }
  ]
  const messages = [
    { id: 'card-user', role: 'user', text: '查找网页正文提取的官方资料与开源实现。', timestamp: Date.now() - 5000 },
    { id: 'card-tools', role: 'assistant', text: '', toolCalls: [
      { id: 'card-search', name: 'web_search', args: { query: '网页正文提取 官方文档与开源实现' }, status: 'ok', details: { search: { action: 'query', query: '网页正文提取 官方文档与开源实现', items: sources } } },
      { id: 'card-fetch', name: 'web_fetch', args: { url: sources[0].url }, status: 'ok', details: { search: { action: 'fetch', url: sources[0].url, title: sources[0].title, readState: 'partial', cached: true, fetchedAt: '2026-10-29T00:00:00Z', truncated: true } } }
    ] },
    { id: 'card-answer', role: 'assistant', text: '先从官方文档与原始实现核对。[Readability](https://github.com/mozilla/readability) 支持提取正文，长页面可以继续定位和读取。', timestamp: Date.now() }
  ]
  await cdp.evaluate(`window.__yanStore.setState({ messages: ${JSON.stringify(messages)}, historyLoading: false, switchLoading: false })`)
  await sleep(400)
  await cdp.evaluate(`document.querySelector('[data-testid=v3-process-toggle]')?.click()`)
  const deadline = Date.now() + 12000
  let icons = []
  while (Date.now() < deadline) {
    icons = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-testid=ws-sources] .ui-source-card:not(.ws-more)')).slice(0,3).map(card => ({ domain: card.querySelector('.ui-source-card__domain')?.textContent, loaded: card.querySelector('.ui-site-icon')?.dataset.loaded === 'true' }))`)
    if (icons.filter((item) => item.loaded).length === 3) break
    await sleep(200)
  }
  report.icons = icons
  check('GitHub、MDN、React 图标经主进程加载并实际解码显示', icons.length === 3 && icons.every((item) => item.loaded), icons)
  check('超过预览数量显示更多来源卡片', await cdp.evaluate(`!!document.querySelector('[data-testid=ws-more]')`))
  await cdp.evaluate(`document.querySelector('[data-testid=ws-more]')?.click()`)
  await sleep(650)
  check('展开更多来源后保留无图标站点的首字母', await cdp.evaluate(`(() => { const card = Array.from(document.querySelectorAll('.ui-source-card')).find(c => c.textContent.includes('没有图标的网站')); return !!card && card.querySelector('.ui-site-icon')?.dataset.loaded === 'false' && card.querySelector('.ui-site-icon__fallback')?.textContent === 'M'; })()`))
  await cdp.evaluate(`document.querySelector('.ws-less')?.click()`)
  await sleep(500)
  await cdp.evaluate(`document.querySelector('[data-testid=ws-capsule]')?.click()`)
  await sleep(350)
  check('收起后来源不可聚焦且不占高度', await cdp.evaluate(`(() => { const panel = document.querySelector('.ui-source-reveal'); return panel.inert && panel.getBoundingClientRect().height < 1; })()`))
  await cdp.evaluate(`document.querySelector('[data-testid=ws-capsule]')?.click()`)
  await sleep(70)
  const motion = await cdp.evaluate(`(() => { const p = document.querySelector('.ui-source-reveal'); const cards = Array.from(p.querySelectorAll('.ui-source-card')); return { height: p.getBoundingClientRect().height, animations: cards.flatMap(c => c.getAnimations().map(a => ({ name: a.animationName, state: a.playState, delay: a.effect.getTiming().delay }))) }; })()`)
  check('展开时按来源顺序播放进场动画', motion.animations.length >= 4 && motion.animations.some((item) => item.delay > 0), motion)
  await sleep(750)
  await cdp.evaluate(`(() => { const cap = document.querySelectorAll('[data-testid=ws-capsule]')[1]; cap.focus(); cap.click(); })()`)
  await sleep(600)
  check('键盘焦点与部分原文状态可见', await cdp.evaluate(`document.activeElement?.matches('[data-testid=ws-capsule]') && document.body.innerText.includes('部分原文')`))
  const first = await cdp.evaluate(`(() => { const c = document.querySelector('.ui-source-card'); const r = c.getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2 }; })()`)
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...first })
  await sleep(400)
  check('悬停卡片抬升并移动打开箭头', await cdp.evaluate(`(() => { const c = document.querySelector('.ui-source-card'); return getComputedStyle(c).translate !== 'none' && getComputedStyle(c.querySelector('.ui-source-card__arrow')).translate !== 'none'; })()`))
  await shot('cards-hover-dark-zh-CN')
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10 })
  check('深色主题下黑色站点图标保留浅底对比', await cdp.evaluate(`getComputedStyle(document.querySelector('.ui-site-icon[data-loaded=true]')).backgroundColor === 'rgb(255, 255, 255)'`))
  const width = await cdp.evaluate('innerWidth')
  for (const [theme, lang] of [['dark', 'zh-CN'], ['light', 'zh-CN'], ['dark', 'en-US'], ['light', 'en-US']]) {
    await cdp.evaluate(`window.__yanStore.getState().patchSettings(${JSON.stringify({ theme, lang })})`)
    await sleep(450)
    const layout = await cdp.evaluate(`({ overflow: document.documentElement.scrollWidth > innerWidth + 1, broken: Array.from(document.querySelectorAll('.ui-site-icon img')).some(img => img.complete && !img.naturalWidth), icons: document.querySelectorAll('.ui-site-icon[data-loaded=true]').length })`)
    check(`${theme}/${lang}/${width} 图标完整且无横向溢出`, !layout.overflow && !layout.broken && layout.icons >= 4, layout)
    await shot(`cards-${theme}-${lang}-${width}`)
  }
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ reduceMotion: true })`)
  await sleep(100)
  check('应用减少动态效果设置关闭卡片动画与位移', await cdp.evaluate(`(() => { const card = document.querySelector('.ui-source-card'); return getComputedStyle(card).animationName === 'none' && getComputedStyle(card).translate === 'none'; })()`))
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ reduceMotion: false })`)
  await cdp.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  check('系统减少动态效果同样生效', await cdp.evaluate(`getComputedStyle(document.querySelector('.ui-source-card')).animationName === 'none'`))
  await cdp.call('Emulation.setEmulatedMedia', { features: [] })
}
