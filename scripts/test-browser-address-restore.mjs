import './lib/test-isolate.mjs'
import { readFile } from 'node:fs/promises'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const m = await compile('src/shared/browser-navigation.ts', { platform: 'neutral' })
  const empty = { requested: null, restored: null }
  const step = (memory, view) => m.nextAddressMemory(memory, { loading: false, shownUrl: '', tabId: 'a', failed: false, ...view })
  const slow = 'http://127.0.0.1:5423/slow-first-load'
  const dead = 'http://127.0.0.1:5424/'

  let memory = step(empty, { loading: true, shownUrl: slow })
  ok(memory.requested?.url === slow && memory.restored === null, '加载中记下请求的网址')
  memory = step(memory, { shownUrl: slow })
  ok(memory.requested?.url === slow, '加载结束但网址还没被清空时继续保留记录')
  memory = step(memory, { shownUrl: '' })
  ok(memory.restored?.url === slow && memory.requested === null, '停止首次加载后补回请求的网址')
  ok(m.addressShown('', memory, 'a') === slow, '地址栏显示补回的网址')
  ok(m.nextAddressInput(m.addressShown('', memory, 'a'), '', false) === slow, '补回不需要标成已编辑')

  const afterDead = step(memory, { loading: true, shownUrl: dead })
  ok(afterDead.restored === null, '任何新的加载开始时清掉补回的网址')
  ok(m.addressShown(dead, afterDead, 'a') === dead, '新的加载（本机服务、智能体导航、链接）由已提交网址驱动地址栏')
  const failed = step(afterDead, { shownUrl: '', failed: true })
  ok(failed.restored === null && m.addressShown('', failed, 'a') === '', '加载失败不补回旧网址')

  ok(m.addressShown('', memory, 'b') === '', '切到别的标签不显示这个标签补回的网址')
  ok(step(memory, { tabId: 'b' }).restored === null, '切换标签后补回记录作废')
  ok(step(memory, { shownUrl: 'https://example.com/' }).restored === null, '有了已提交网址就不再用补回的网址')

  const otherTab = step(step(empty, { loading: true, shownUrl: slow }), { tabId: 'b' })
  ok(otherTab.restored === null && otherTab.requested === null, '加载结束时已换到别的标签，不补回')
  const committed = step(step(empty, { loading: true, shownUrl: slow }), { shownUrl: 'https://redirected.example/' })
  ok(committed.requested === null && committed.restored === null, '加载落到别的网址时丢掉记录')
  ok(step(empty, { loading: true, shownUrl: '' }).requested === null, '空白页加载不记录')

  const pane = await readFile('src/renderer/src/features/browser/BrowserPane.tsx', 'utf8')
  const effect = pane.slice(pane.indexOf('nextAddressMemory(memoryRef.current'), pane.indexOf('nextAddressMemory(memoryRef.current') + 400)
  ok(!/setDirty\(true\)/.test(effect), '补回网址的副作用里不设 dirty')
  ok(/nextAddressInput\(addressUrl, prev, dirty\)/.test(pane), '地址栏跟随「已提交网址或补回网址」')
})
