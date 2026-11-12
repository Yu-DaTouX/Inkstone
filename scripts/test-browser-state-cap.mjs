import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const { withBrowserState } = await compile('src/renderer/src/state/push-consumers.ts', { packages: 'external' })
  const closed = (url) => ({ open: false, url, title: '', loading: false, canGoBack: false, canGoForward: false })
  const opened = (url) => ({ ...closed(url), open: true })
  let states = {}
  states = withBrowserState(states, 'keep-open', opened('a'))
  for (let index = 0; index < 80; index++) states = withBrowserState(states, `s-${index}`, closed(String(index)))
  ok(Object.keys(states).length === 50, '\u4f1a\u8bdd\u6d4f\u89c8\u5668\u72b6\u6001\u6700\u591a\u4fdd\u7559 50 \u6761', String(Object.keys(states).length))
  ok(states['keep-open']?.open === true, '\u6253\u5f00\u7740\u7684\u6d4f\u89c8\u5668\u72b6\u6001\u4e0d\u88ab\u6dd8\u6c70')
  ok(!states['s-0'] && states['s-79']?.url === '79', '\u5148\u6dd8\u6c70\u6700\u65e9\u7684\u5df2\u5173\u95ed\u72b6\u6001')
  states = withBrowserState(states, 's-40', closed('again'))
  ok(Object.keys(states).at(-1) === 's-40', '\u66f4\u65b0\u8fc7\u7684\u4f1a\u8bdd\u6392\u5230\u6700\u65b0')
})
