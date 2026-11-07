import { createServer } from 'node:http'

export const meta = { description: '内置浏览器标签按会话归属：A、B 两个会话各开页面互不串；切回后各自标签还在；agent 跑一轮时它的标签保持在焦点，用户看另一会话时看到的是自己的页面；不调用真实模型' }

function page(title) {
  return createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>${title}</title><body style="font:32px sans-serif;background:#eef">${title}</body>`)
  })
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

export default async function run({ cdp, box, waitFor, check, sleep, shot, log, newSession, turn }) {
  const ev = (expr) => cdp.evaluate(expr)
  const alpha = page('alpha-page')
  const beta = page('beta-page')
  const gamma = page('gamma-page')
  const portA = await listen(alpha)
  const portB = await listen(beta)
  const portC = await listen(gamma)
  const urlA = `http://127.0.0.1:${portA}/`
  const urlB = `http://127.0.0.1:${portB}/`
  const urlC = `http://127.0.0.1:${portC}/`
  try {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })
    await ev(`window.__yanStore.getState().patchSettings({ theme: 'dark', lang: 'zh-CN', rightPanelOpen: true })`)
    const sid = () => ev(`window.__yanStore.getState().session?.sessionId ?? null`)
    const tabsOf = (id) => ev(`window.yan.browser.getState(${JSON.stringify(id)}).then((st) => ({ open: st.open, urls: st.tabs.map((t) => t.url), active: st.activeTabId, agent: st.agentSessionId ?? null }))`)

    await newSession(box.project)
    const a = await sid()
    await ev(`window.__yanStore.getState().openBrowser(${JSON.stringify(urlA)})`)
    await waitFor(`s.browserState.open`, 15000)
    await sleep(800)
    const a1 = await tabsOf(a)
    log('A 打开后', a, a1)
    check('A 会话有一个标签指向 alpha', a1.open && a1.urls.length === 1 && a1.urls[0].startsWith(urlA), a1)
    await shot('a-open')

    const aFile = await ev(`window.__yanStore.getState().session?.sessionFile ?? null`)
    await turn('先落盘 A')
    const aFile2 = await ev(`window.__yanStore.getState().session?.sessionFile ?? null`)

    await newSession(box.project)
    const b = await sid()
    check('B 是另一个会话', b && b !== a, { a, b })
    await sleep(600)
    const bEmpty = await tabsOf(b)
    check('B 刚建时没有标签，不串 A 的页面', !bEmpty.open && bEmpty.urls.length === 0, bEmpty)
    await shot('b-empty')
    await ev(`window.__yanStore.getState().openBrowser(${JSON.stringify(urlB)})`)
    await waitFor(`s.browserState.open`, 15000)
    await sleep(800)
    const b1 = await tabsOf(b)
    const a2 = await tabsOf(a)
    check('B 的标签只有 beta，A 仍只有 alpha', b1.urls.length === 1 && b1.urls[0].startsWith(urlB) && a2.urls.length === 1 && a2.urls[0].startsWith(urlA), { a2, b1 })
    await shot('b-open')

    await ev(`window.__mix = []; window.__mixOff = window.__yanStore.subscribe((st) => { const b = st.browserState; if (b.open && b.sessionId && st.session?.sessionId && b.sessionId !== st.session.sessionId) window.__mix.push({ t: Math.round(performance.now()), view: st.session.sessionId.slice(-4), page: b.sessionId.slice(-4), url: b.url }); else if (window.__mix.length && !window.__mixEnd && b.sessionId === st.session?.sessionId) window.__mixEnd = Math.round(performance.now()) })`)
    await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(aFile2 || aFile)})`)
    await waitFor(`s.session?.sessionId === ${JSON.stringify(a)} && !s.switchLoading`, 15000)
    await sleep(800)
    const mix = await ev(`window.__mixOff(), window.__mix`)
    log('错位采样', { count: mix.length, first: mix[0]?.t, end: await ev('window.__mixEnd'), last: mix.at(-1)?.t })
    check('切会话的整个过程中，右栏状态从未短暂显示另一个会话的页面', mix.length === 0, mix.slice(0, 3))
    const viewA = await ev(`({ open: window.__yanStore.getState().browserState.open, url: window.__yanStore.getState().browserState.url, sid: window.__yanStore.getState().browserState.sessionId })`)
    check('切回 A 后浏览器状态是 A 的页面', viewA.open && viewA.url.startsWith(urlA) && viewA.sid === a, viewA)
    await shot('back-to-a')

    await newSession(box.project)
    const c = await sid()
    await ev(`window.__yanStore.getState().openBrowser(${JSON.stringify(urlC)})`)
    await waitFor(`s.browserState.open`, 15000)
    await sleep(600)
    await turn('占位，让 C 落盘')
    const cFile = await ev(`window.__yanStore.getState().session?.sessionFile ?? null`)

    await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(aFile2 || aFile)})`)
    await waitFor(`s.session?.sessionId === ${JSON.stringify(a)} && !s.switchLoading`, 15000)
    const urlA2 = urlA + 'second'
    const urlA3 = urlA + 'third'
    let hammer = true
    const hammering = (async () => {
      let n = 0
      while (hammer) {
        await ev(`window.yan.browser.reload(${JSON.stringify(c)})`).catch(() => undefined)
        await ev(`window.yan.browser.navigate(${JSON.stringify(urlC + 'u' + n++)}, ${JSON.stringify(c)})`).catch(() => undefined)
        await sleep(10)
      }
    })()
    await turn(`BROWSERLOOP BROWSERURL1=${urlA2} BROWSERURL2=${urlA3} BROWSERSTEPS10`, { timeout: 90000 })
    hammer = false
    await hammering
    await sleep(500)
    const aAfter = await tabsOf(a)
    const cAfter = await tabsOf(c)
    const bAfter = await tabsOf(b)
    log('agent 一轮后', { aAfter, bAfter, cAfter })
    check('agent 在 A 里导航，A 的标签落在 A 的地址上', aAfter.urls.every((u) => u.startsWith(urlA)) && aAfter.urls.some((u) => u.includes('third') || u.includes('second')), aAfter)
    check('用户同时在 C 里操作，C 的标签没有跑到 agent 的地址', cAfter.urls.length >= 1 && cAfter.urls.every((u) => u.startsWith(urlC)), cAfter)
    check('B 完全没被波及', bAfter.urls.length === 1 && bAfter.urls[0].startsWith(urlB), bAfter)
    await shot('after-loop')
    return { a, b, c }
  } finally {
    alpha.close(); beta.close(); gamma.close()
  }
}
