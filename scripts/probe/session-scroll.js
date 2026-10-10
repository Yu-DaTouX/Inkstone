/** Isolated stored histories, real session switching; no model calls. */
;(async () => {
  const lines = []
  const check = (value, label) => { lines.push(`${value ? '✓' : '✗'} ${label}`); if (!value) throw Error(label) }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const store = window.__yanStore
  const wait = async predicate => { const end = Date.now() + 10000; while (!predicate()) { if (Date.now() > end) throw Error('wait timed out'); await sleep(40) } }
  const stream = () => document.querySelector('.center:not(.split-peer) .stream')
  const bottom = () => { const el = stream(); return el && el.scrollHeight - el.scrollTop - el.clientHeight < 45 }
  const position = () => stream()?.scrollTop ?? -1
  try {
    await wait(() => store.getState().conn === 'ready')
    store.getState().setRailPinned(true)
    await store.getState().refreshSessions()
    const [a, b, c] = ['A', 'B', 'C'].map(label => store.getState().sessions.find(s => s.path.replaceAll('\\', '/').endsWith(`/${label}.jsonl`)))
    check(a && b && c, '短/长会话隔离历史就绪')
    const row = session => [...document.querySelectorAll('[data-testid="rail-session"]')].find(el => el.title.includes(session.path))
    const select = async session => {
      await wait(() => !!row(session))
      row(session).click()
      await wait(() => (store.getState().peekedPath || store.getState().session?.sessionFile) === session.path && store.getState().messages.length >= (session === a ? 40 : 240))
      await sleep(800)
    }
    const middle = async () => { const el = stream(); el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * .4); await sleep(250); return position() }
    await select(a)
    check(bottom(), '首次进入短会话显示最新消息')
    const aTop = await middle()
    check(aTop > 200, '短会话向上阅读')
    await select(b)
    check(!!stream()?.querySelector('.stream-row'), '长会话实际使用虚拟列表')
    check(bottom(), '从向上阅读的短会话切入长会话仍显示最新消息')
    await select(a)
    check(Math.abs(position() - aTop) < 5, '返回短会话恢复阅读位置')
    await select(b)
    check(bottom(), '返回长会话仍停在底部')
    const bTop = await middle()
    check(bTop > 200, '虚拟长会话向上阅读')
    await select(c)
    check(bottom(), '从长会话中部切入另一条长会话显示底部')
    await select(b)
    check(Math.abs(position() - bTop) < 80, '返回虚拟长会话恢复阅读位置')
    for (let n = 0; n < 3; n++) { await select(a); await select(b) }
    check(Math.abs(position() - bTop) < 80, '反复切换不覆盖虚拟长会话阅读位置')
    row(a).click(); await sleep(20); row(c).click(); await sleep(20); row(b).click()
    await sleep(1000)
    check((store.getState().peekedPath || store.getState().session?.sessionFile) === b.path && Math.abs(position() - bTop) < 80, '快速连续切换后最终会话与阅读位置正确')
    row(a).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    await wait(() => document.querySelectorAll('[data-split-column]').length === 2)
    await sleep(800)
    await select(a)
    check(position() > 200 && !bottom(), '分屏换焦点保留短会话阅读位置')
    await select(b)
    check(position() > 200 && !bottom(), '分屏换回长会话保留向上阅读状态')
    const el = stream(); el.scrollTop = el.scrollHeight
    await sleep(350)
    await select(a); await select(b)
    check(bottom(), '分屏底部状态在换焦点后保留')
  } catch (error) { lines.push('✗ ' + String(error)) }
  return lines.join('\n')
})()
