;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  if (!store) return 'no-store'

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 30; i++) {
    const card = q('.ob-card')
    if (!card) break
    const btn = [...card.querySelectorAll('button')].find((b) => /开始使用|完成/.test(b.textContent))
    if (btn) btn.click()
    await sleep(250)
  }

  store.getState().setRailPinned(true)
  store.getState().closeSettings?.()

  for (let i = 0; i < 60; i++) {
    if (store.getState().conn === 'ready') break
    await sleep(500)
  }
  await sleep(600)

  const fake = []
  for (let i = 1; i <= 40; i++) {
    fake.push({
      id: 'shot-u' + i,
      role: 'user',
      text: '第 ' + i + ' 轮：导航轨贴会话区左缘，正文让出避让槽'
    })
    fake.push({
      id: 'shot-a' + i,
      role: 'assistant',
      text:
        '第 ' + i + ' 轮回答：命中区不能压到正文的链接与按钮，长轨要能滚到末项。' +
        '这一句用来把正文撑宽，好看清避让槽的实际位置。'.repeat(6)
    })
  }
  store.getState().applyPush({ ch: 'sync', payload: fake })
  await sleep(1600)

  const hits = [...document.querySelectorAll('[data-testid="outline-tick"]')]
  if (hits.length > 4) {
    hits[3].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await sleep(700)
  }
  return hits.length ? 'ok:' + hits.length : 'no-outline'
})()
