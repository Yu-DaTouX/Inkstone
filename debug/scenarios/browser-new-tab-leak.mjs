import { createServer } from 'node:http'

export const meta = { description: '会话 B 的 agent 正在用内置浏览器时，从新标签页新建会话 A：A 的右栏、A 的标签列表都不能出现 B 的页面；不调用真实模型' }

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

export default async function run({ cdp, box, waitFor, check, sleep, shot, log, newSession, turn }) {
  const ev = (expr) => cdp.evaluate(expr)
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>beta-page</title><body>beta-page</body>')
  })
  const port = await listen(server)
  const url = `http://127.0.0.1:${port}/`
  try {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })
    await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', rightPanelOpen: true })`)
    const view = () => ev(`(() => { const s = window.__yanStore.getState(); return { id: s.peekedSessionId ?? s.session?.sessionId ?? null, open: s.browserState.open, stateSession: s.browserState.sessionId ?? null, urls: (s.browserState.tabs ?? []).map((t) => t.url) } })()`)
    const tabsOf = (id) => ev(`window.yan.browser.getState(${JSON.stringify(id)}).then((st) => ({ open: st.open, urls: st.tabs.map((t) => t.url) }))`)

    await newSession(box.project)
    const b = (await view()).id
    await turn('先落盘 B')
    await ev(`window.__yanStore.getState().send(${JSON.stringify(`BROWSERLOOP BROWSERURL1=${url} BROWSERURL2=${url}x BROWSERSTEPS12`)})`)
    await waitFor(`s.browserState.open`, 30000)
    log('B 正在用浏览器', await view())

    await ev(`window.__yanStore.getState().newSession({ scope: 'global' })`)
    const samples = []
    const until = Date.now() + 6000
    while (Date.now() < until) {
      const now = await view()
      if (now.id !== b) samples.push(now)
      await sleep(50)
    }
    const a = samples.at(-1)?.id ?? null
    log('A 采样', { a, count: samples.length, last: samples.at(-1) })
    check('新标签页建出了另一个会话', !!a && a !== b, { a, b })
    check('A 视图的右栏状态从未显示 B 的页面', samples.every((item) => !item.open || (item.stateSession === item.id && !item.urls.some((u) => u.startsWith(url)))), samples.filter((item) => item.open).slice(0, 3))
    const aTabs = a ? await tabsOf(a) : null
    check('A 自己的标签列表是空的', !!aTabs && !aTabs.open && aTabs.urls.length === 0, aTabs)
    const workspace = await tabsOf('workspace')
    check('workspace 伪会话没有标签', !workspace.open && workspace.urls.length === 0, workspace)
    const bTabs = await tabsOf(b)
    check('B 的标签还在 B 里', bTabs.open && bTabs.urls.some((u) => u.startsWith(url)), bTabs)
    await shot('new-tab-while-b-browses')
  } finally {
    server.close()
  }
}
