export const meta = { description: '搜索胶囊的搜索中、无来源与完成三种状态：轮播查询、光束与占位卡片、空结果不可展开；只用合成消息' }

export default async function run({ cdp, newSession, check, sleep, shot }) {
  await newSession()
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', rightPanelOpen: false })`)
  const queries = ['site.aa.usno.navy.mil cal2026 moon phases November 2026', 'site.gml.noaa.gov gradual moon illumination table']
  const sources = [
    { title: 'Phases of the Moon 2026', url: 'https://aa.usno.navy.mil/data/MoonPhases', snippet: '', readState: 'discovered' },
    { title: 'Lunar illumination tables', url: 'https://gml.noaa.gov/grad/moon', snippet: '', readState: 'read' }
  ]
  const stage = async (calls) => {
    const messages = [
      { id: 'ws-user', role: 'user', text: '查 2026 年 11 月的月相。', timestamp: Date.now() - 4000 },
      { id: 'ws-tools', role: 'assistant', text: '', toolCalls: calls }
    ]
    await cdp.evaluate(`window.__yanStore.setState({ messages: ${JSON.stringify(messages)}, historyLoading: false, switchLoading: false })`)
    await sleep(600)
  }
  const cap = `document.querySelector('[data-testid=ws-group], [data-testid=ws-capsule]')`

  await stage([{ id: 'ws-run', name: 'web_search', args: { queries }, status: 'running' }])
  check('搜索中显示光束、轨道点与占位卡片', await cdp.evaluate(`(() => { const c = ${cap}; return c?.dataset.state === 'running' && getComputedStyle(c, '::before').animationName === 'ws-beam' && !!c.querySelector('.ws-orbit') && document.querySelectorAll('[data-testid=ws-sources-pending] .ws-ghost').length === 3 })()`))
  check('胶囊只显示一个查询和 +1，不被挤压', await cdp.evaluate(`(() => { const c = ${cap}; return c.querySelector('.ws-cap-more')?.textContent === '+1' && !c.querySelector('.ws-cap-count') && c.getBoundingClientRect().width <= 561 })()`))
  const before = await cdp.evaluate(`${cap}.querySelector('.ws-tick .ui-shimmer__base').textContent`)
  await shot('web-search-states-running-a')
  await sleep(2600)
  const after = await cdp.evaluate(`${cap}.querySelector('.ws-tick .ui-shimmer__base').textContent`)
  check('搜索中轮播各个查询', before !== after && queries.includes(before) && queries.includes(after), { before, after })
  await shot('web-search-states-running-b')

  await stage([{ id: 'ws-run', name: 'web_search', args: { queries }, status: 'ok', output: 'ok', details: { search: { action: 'query', query: queries[0], items: sources } } }])
  check('完成后显示数量与站点图标，光束停止', await cdp.evaluate(`(() => { const c = ${cap}; return c?.dataset.state === 'done' && getComputedStyle(c, '::before').content === 'none' && c.querySelector('.ws-cap-count')?.textContent === '2' && c.querySelectorAll('.ws-cap-sites .ui-site-icon').length === 2 && document.querySelectorAll('.ui-source-card').length === 2 })()`))
  check('不再出现查询条与摘要', await cdp.evaluate(`!document.querySelector('.ui-source-card__snippet') && document.querySelector('.ws-entry').children.length === 2`))
  await shot('web-search-states-done')

  await stage([{ id: 'ws-empty', name: 'web_search', args: { queries }, status: 'ok', output: 'ok', details: { search: { action: 'query', query: queries[0], items: [] } } }])
  check('无来源时胶囊不可展开，也没有空提示', await cdp.evaluate(`(() => { const c = ${cap}; return c?.tagName === 'DIV' && c.dataset.empty === 'true' && c.querySelector('.ws-cap-count')?.textContent === '0' && !c.querySelector('.ws-cap-chevron') && !document.querySelector('.ui-source-reveal') && !document.body.innerText.includes('没有可显示的来源') })()`))
  await shot('web-search-states-empty')

  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: 'light' })`)
  await stage([{ id: 'ws-run-light', name: 'web_search', args: { queries }, status: 'running' }])
  await shot('web-search-states-running-light')
}
