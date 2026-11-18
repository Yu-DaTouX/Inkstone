export const meta = { description: '相同 Markdown 已被历史缓存时，流式回复结束仍沿用已显示的正文节点和选区' }

export default async function run({ cdp, newSession, waitFor, sleep, check }) {
  await newSession()
  await waitFor('s.conn === "ready" && !s.switchLoading', 10000)
  await sleep(700)
  const text = '这是已显示的首段。\n\n这是准备收尾的末段。'
  const prose = (id) => `document.querySelector('[data-turn-id="${id}"] .v3-prose')`
  await cdp.evaluate(`(() => {
    const now = Date.now()
    window.__yanStore.setState({ messages: [
      {id:'warm-user',role:'user',text:'历史提问',timestamp:now-5000},
      {id:'warm-answer',role:'assistant',text:${JSON.stringify(text)},timestamp:now-4000}
    ] })
  })()`)
  await waitFor(`${prose('warm-answer')}?.querySelectorAll('p').length === 2`, 8000)
  await cdp.evaluate(`(() => {
    const now = Date.now()
    window.__yanStore.setState(s => ({ messages: [...s.messages,
      {id:'live-user',role:'user',text:'再问一次',timestamp:now},
      {id:'live-answer',role:'assistant',text:${JSON.stringify(text)},timestamp:now}],
      session: {...s.session,isStreaming:true,isAgentRunning:true},runTail:null
    }))
  })()`)
  await waitFor(`${prose('live-answer')}?.lastElementChild?.textContent.includes('这是准备收尾的末段。')`, 8000)
  await cdp.evaluate(`(() => {
    const node = window.__mdFirst = ${prose('live-answer')}.firstElementChild
    const range = document.createRange()
    range.selectNodeContents(node)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    window.__yanStore.setState(s => ({ session: {...s.session,isStreaming:false,isAgentRunning:false} }))
  })()`)
  await sleep(700)
  const result = await cdp.evaluate(`({ same: window.__mdFirst === ${prose('live-answer')}?.firstElementChild,
    selection: getSelection()?.toString(), last: ${prose('live-answer')}?.lastElementChild?.textContent })`)
  check('历史缓存不替换已渲染的首段正文', result.same, result)
  check('结束后选区与完整末段仍在', result.selection === '这是已显示的首段。' && result.last === '这是准备收尾的末段。', result)
}
