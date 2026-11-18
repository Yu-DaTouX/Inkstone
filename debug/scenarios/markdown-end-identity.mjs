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

  const open = '````ts\nconst value = 1\n```\nconst next = 2\n'
  await cdp.evaluate(`(() => {
    const now = Date.now()
    window.__yanStore.setState(s => ({ messages: [...s.messages,
      {id:'fence-user',role:'user',text:'代码',timestamp:now},
      {id:'fence-answer',role:'assistant',text:${JSON.stringify(open)},timestamp:now}],
      session: {...s.session,isStreaming:true,isAgentRunning:true},runTail:null
    }))
  })()`)
  const pre = `${prose('fence-answer')}?.querySelector('pre')`
  await waitFor(`${pre}?.textContent.includes('const next = 2')`, 8000)
  check('内层短围栏不提前触发高亮', await cdp.evaluate(`!${pre}?.querySelector('[class^="hljs-"]')`))
  await cdp.evaluate(`window.__yanStore.setState(s => ({ messages: [...s.messages.slice(0,-1), {...s.messages.at(-1),text:${JSON.stringify(open + '````\n')}}] }))`)
  await waitFor(`!!${pre}?.querySelector('[class^="hljs-"]')`, 8000)
  check('同类等长围栏闭合后恢复高亮', await cdp.evaluate(`!!${pre}?.querySelector('[class^="hljs-"]')`))

  const label = '前一段。\n\n**结论**'
  await cdp.evaluate(`(() => {
    const now = Date.now()
    window.__yanStore.setState(s => ({ messages: [...s.messages,
      {id:'lead-user',role:'user',text:'结论',timestamp:now},
      {id:'lead-answer',role:'assistant',text:${JSON.stringify(label)},timestamp:now}],
      session: {...s.session,isStreaming:true,isAgentRunning:true},runTail:null
    }))
  })()`)
  const paragraph = `${prose('lead-answer')}?.lastElementChild`
  await waitFor(`${paragraph}?.textContent.includes('结论') && !!${paragraph}?.querySelector('.v3-caret')`, 8000)
  const font = () => cdp.evaluate(`(() => {
    const p = ${paragraph}
    return { paragraph: getComputedStyle(p).fontSize, prose: getComputedStyle(p.parentElement).fontSize }
  })()`)
  const streamingFont = await font()
  check('未写完的加粗段仍按正文排版', streamingFont.paragraph === streamingFont.prose, streamingFont)
  await cdp.evaluate(`window.__yanStore.setState(s => ({ session: {...s.session,isStreaming:false,isAgentRunning:false} }))`)
  await waitFor(`!!${paragraph} && !${paragraph}.querySelector('.v3-caret')`, 8000)
  const finishedFont = await font()
  check('已写完的纯加粗标题保留标题样式', parseFloat(finishedFont.paragraph) > parseFloat(finishedFont.prose), finishedFont)

  const longCode = '```ts\n' + 'const streamFixture = "long code block"\n'.repeat(140) + '// 末行标记\n```\n'
  await cdp.evaluate(`(() => {
    const now = Date.now()
    window.__yanStore.setState(s => ({ messages: [...s.messages,
      {id:'long-user',role:'user',text:'长代码',timestamp:now},
      {id:'long-answer',role:'assistant',text:${JSON.stringify(longCode)},timestamp:now}],
      session: {...s.session,isStreaming:true,isAgentRunning:true},runTail:null
    }))
  })()`)
  const longPre = `${prose('long-answer')}?.querySelector('pre')`
  const longTokens = `${longPre}?.querySelector('[class^="hljs-"]')`
  await waitFor(`${longPre}?.textContent.includes('// 末行标记') && !!${prose('long-answer')}?.lastElementChild?.querySelector('.v3-code-head')`, 16000)
  check('长代码在流式回合内不提前着色', await cdp.evaluate(`!${longTokens}`))
  await cdp.evaluate(`window.__yanStore.setState(s => ({ session: {...s.session,isStreaming:false,isAgentRunning:false} }))`)
  await waitFor(`!!${longTokens}`, 8000)
  check('长代码收尾后按原限制正常着色', await cdp.evaluate(`!!${longTokens}`))
}
