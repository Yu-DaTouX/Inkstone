import { runSuite } from './lib/test-suite.mjs'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'

await runSuite(import.meta.url, async (ok, compile) => {
  const { useSidebarSearch } = await compile('src/renderer/src/t3/adapters/sidebar/search.ts', {
    packages: 'external',
    plugins: [{ name: 'sidebar-search-store', setup(b) {
      b.onResolve({ filter: /^\.\.\/\.\.\/\.\.\/state\/store$/ }, () => ({ path: 'store', namespace: 'search-fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'search-fixture' }, () => ({ contents: 'const state = { sessions: [], titles: {}, manualTitles: {} }; export const useStore = select => select(state)' }))
    } }]
  })
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>')
  const saved = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  const calls = []
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
  window.yan = { searchSessions: query => new Promise((resolve, reject) => calls.push({ query, resolve, reject })) }
  const root = createRoot(document.getElementById('root'))
  const sections = { pinned: [], active: [{ title: '错误回归', path: 'fixture' }], working: [], snoozed: [], settled: [] }
  let view
  const Probe = ({ query }) => { view = useSidebarSearch(query, sections); return null }
  const render = query => act(async () => root.render(React.createElement(Probe, { query })))
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 190)) })
  try {
    await render('错误回归')
    ok(view.pending && !view.failed, '全文请求待处理时不报无结果或失败')
    await settle()
    await act(async () => calls[0].reject(new Error('fixture read failed')))
    ok(view.failed && !view.pending && view.threads.length === 1, '全文失败单独呈现，仍保留标题匹配')
    await render('过时查询')
    ok(view.pending && !view.failed, '切换查询立即清掉旧失败状态')
    await settle()
    await render('当前查询')
    await settle()
    await act(async () => calls[2].resolve({ hits: [] }))
    await act(async () => calls[1].reject(new Error('late failure')))
    ok(calls[2].query === '当前查询' && !view.failed && !view.pending && view.matches.length === 0, '新查询无结果不被迟到错误覆盖')
    await render('')
    ok(!view.failed && !view.pending && view.threads.length === 0, '清空查询恢复普通列表状态')
  } finally {
    await act(async () => root.unmount())
    delete window.yan
    Object.assign(globalThis, saved)
  }
})
