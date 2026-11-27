export const meta = { description: '量末条消息到悬浮输入框的可见间距，覆盖不足一屏、普通列表和虚拟列表；仅合成消息' }

export default async function run({ cdp, newSession, sleep, check, shot, report }) {
  await newSession()
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({promptSuggestions:false,reduceMotion:true})`)
  report.gaps = {}
  for (const [label, pairs] of [['short', 1], ['overflow', 18], ['virtual', 48]]) {
    const messages = Array.from({ length: pairs }, (_, i) => [
      { id: `gap-u${i}`, role: 'user', text: `Question ${i}` },
      { id: `gap-a${i}`, role: 'assistant', text: `Answer ${i}` }
    ]).flat()
    await cdp.evaluate(`window.__yanStore.setState({messages:${JSON.stringify(messages)},historyLoading:false,switchLoading:false})`)
    await sleep(850)
    const metrics = await cdp.evaluate(`(() => {
      const stream = document.querySelector('.v3-stream')
      const tail = stream.querySelector('[data-turn-id="gap-a${pairs - 1}"]')
      const composer = document.querySelector('.v3-composer')
      return { gap: tail ? composer.getBoundingClientRect().top - tail.getBoundingClientRect().bottom : null,
        distance: stream.scrollHeight - stream.clientHeight - stream.scrollTop, virtual: !stream.querySelector('.v3-stream-inner') }
    })()`)
    report.gaps[label] = metrics
    await shot(`tail-gap-${label}`)
    check(`${label}: 末条可见、已滚到底且与输入框间距不超过 20px`, metrics.gap !== null && metrics.gap >= 0 && metrics.gap <= 20 && Math.abs(metrics.distance) <= 1 && metrics.virtual === (label === 'virtual'), metrics)
  }
}
