;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  if (!store) return 'no-store'

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const card = q('.ob-card')
    if (!card) break
    const btn = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (btn) {
      click(btn)
      await sleep(250)
    } else await sleep(120)
  }

  for (let i = 0; i < 100; i++) {
    if (store.getState().session?.model) break
    await sleep(300)
  }
  if (!store.getState().session?.model) return 'pi-not-ready'

  for (let i = 0; i < 8; i++) {
    const level = store.getState().session?.thinkingLevel
    if (level && level !== 'off') break
    try {
      await window.yan.cycleThinking()
    } catch {
    }
    await sleep(400)
  }
  const level = store.getState().session?.thinkingLevel

  const text =
    '不要调用任何工具。思考过程请用中文，专业术语（如 grapheme cluster / surrogate / code unit）保留英文原文，' +
    '形成中英混排的推理。分 8 步详细推理这个问题：为什么流式渲染里推理文本要按字素（grapheme）' +
    '而不是按 UTF-16 code unit 切分。每一步先写两到三句中文分析，紧接着写一句英文小结（English summary），' +
    '最后给出 5 行结论。'
  try {
    await store.getState().send(text)
  } catch (error) {
    return 'send-failed: ' + String(error?.message ?? error)
  }

  const deadline = Date.now() + 90_000
  let best = 0
  let liveSeen = false
  let liveLength = 0
  let tick = 0
  while (Date.now() < deadline) {
    const msgs = store.getState().messages ?? []
    const last = [...msgs].reverse().find((m) => m.role === 'assistant')
    const len = (last?.thinking ?? '').length
    if (len > best) best = len
    if (tick % 12 === 0) {
      console.error(
        '[n04-tick] ' +
          JSON.stringify({
            n: msgs.length,
            roles: msgs.map((m) => m.role),
            th: msgs.filter((m) => m.role === 'assistant').map((m) => (m.thinking ?? '').length),
            live: msgs.filter((m) => m.role === 'assistant').map((m) => m.thinkingLive === true),
            runner: store.getState().activeRunnerId,
            conn: store.getState().conn
          })
      )
    }
    tick += 1
    if ((last?.thinkingLive || last?.thinkingMs) && len >= 900) {
      liveSeen = true
      liveLength = len
      break
    }
    await sleep(400)
  }

  const body = q('.reason-body')
  const open = !!body && !body.hasAttribute('hidden') && body.getBoundingClientRect().height > 20
  const summary = [
    'thinkingLevel=' + String(level),
    'thinkingLen=' + String(best),
    'streamingAtCapture=' + String(liveSeen),
    'captureLen=' + String(liveLength),
    'reasonOpen=' + String(open)
  ].join(' ')
  console.error('[n04-setup] ' + summary)
  return summary
})()
