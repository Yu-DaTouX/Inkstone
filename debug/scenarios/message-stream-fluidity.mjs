export const meta = { description: '合成消息流：尾部增量时历史回合渲染、滚动锚点、上翻不抢读、宽度变化与最终文本，不调用模型' }

export default async function run({ cdp, waitFor, check, report, sleep, shot }) {
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__streamProbe = null;
    window.__streamResizeWarnings = [];
    window.addEventListener('error', event => {
      if (event.message.includes('ResizeObserver')) window.__streamResizeWarnings.push(event.message);
    });
    const originalRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function(...args) {
      if (window.__streamProbe && this.matches('.v3-msg[data-turn-id]')) window.__streamProbe.rowReads++;
      return originalRect.apply(this, args);
    };
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, inject() { return 1 }, onCommitFiberUnmount() {},
      onCommitFiberRoot(id, root) {
        if (!window.__streamProbe) return;
        const walk = fiber => {
          if (!fiber) return;
          if (fiber.flags & 1) {
            const name = fiber.type?.displayName || fiber.type?.name || fiber.type?.render?.name || '';
            if (/^TurnView[0-9]*$/.test(name)) {
              const id = fiber.memoizedProps.turn.id;
              window.__streamProbe.turns[id] = (window.__streamProbe.turns[id] || 0) + 1;
            }
          }
          if (fiber.child !== fiber.alternate?.child) walk(fiber.child);
          walk(fiber.sibling);
        };
        walk(root.current);
      }
    };
  ` })
  await cdp.call('Page.reload')
  await sleep(500)
  await waitFor('!!window.__yanStore && !!s.session && !!document.querySelector(".v3-stream")', 30000)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 920, deviceScaleFactor: 1, mobile: false })
  await cdp.evaluate(`(() => {
    const now = Date.now();
    window.__streamHistory = Array.from({ length: 32 }, (_, i) => [
      { id: 'stream-user-' + i, role: 'user', text: '消息流检查第 ' + i + ' 轮', timestamp: now - (64 - i * 2) * 1000 },
      { id: 'stream-answer-' + i, role: 'assistant', text: '### 检查结果 ' + i + '\\n\\n' + '历史正文应保持稳定，不随新输出反复渲染。'.repeat(8), timestamp: now - (63 - i * 2) * 1000 }
    ]).flat();
    window.__streamExpected = '## 流式回答\\n\\n';
    window.__yanStore.setState(s => ({
      messages: [...window.__streamHistory, { id: 'stream-live-user', role: 'user', text: '继续输出', timestamp: now }, { id: 'stream-live', role: 'assistant', text: window.__streamExpected, timestamp: now + 1 }],
      session: { ...s.session, isStreaming: true, isAgentRunning: true }, runTail: null,
      settings: { ...s.settings, workspaceTiles: false, wrapUpCard: false }
    }));
  })()`)
  await sleep(1100)
  await cdp.call('Performance.enable')
  const metrics = async () => Object.fromEntries((await cdp.call('Performance.getMetrics')).result.metrics.map(m => [m.name, m.value]))
  const measure = async (name, action) => {
    await cdp.evaluate(`window.__streamProbe = { turns: {}, rowReads: 0 }`)
    const before = await metrics()
    await action()
    await sleep(120)
    const after = await metrics()
    const result = await cdp.evaluate(`(() => { const result = window.__streamProbe; window.__streamProbe = null; return result })()`)
    for (const key of ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount']) result[key] = (after[key] - before[key]) * (key.endsWith('Duration') ? 1000 : 1)
    result.historyRenders = Object.entries(result.turns).filter(([id]) => id.startsWith('stream-answer-') || id.startsWith('virtual-answer-')).reduce((sum, [, count]) => sum + count, 0)
    report.timings[name] = result
    console.log(name, JSON.stringify({ historyRenders: result.historyRenders, liveRenders: result.turns['stream-live'] ?? 0, rowReads: result.rowReads, scriptMs: result.ScriptDuration }))
    return result
  }
  const append = (i) => cdp.evaluate(`(() => {
    window.__streamExpected += '第 ${i} 段输出，保持中文和 emoji 🖋️ 完整。\\n\\n';
    window.__yanStore.setState(s => ({ messages: [...s.messages.slice(0, -1), { ...s.messages.at(-1), text: window.__streamExpected }] }));
  })()`)
  const streaming = await measure('streamAtBottom', async () => {
    for (let i = 0; i < 30; i++) { await append(i); await sleep(30) }
  })
  check('尾部增量确实进入消息流渲染', (streaming.turns['stream-live'] ?? 0) >= 20)
  check('尾部增量不再触发未变化的历史回答重渲染', streaming.historyRenders === 0, streaming.historyRenders)
  const bottom = () => cdp.evaluate(`(() => { const el = document.querySelector('.v3-stream'); return el.scrollHeight - el.clientHeight - el.scrollTop })()`)
  await sleep(700)
  check('流式输出时保持贴底', (await bottom()) <= 2, await bottom())
  await cdp.evaluate(`(() => {
    const el = document.querySelector('.v3-stream');
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true }));
    el.scrollTop = Math.round(el.scrollHeight * 0.35);
  })()`)
  await sleep(250)
  const anchor = await cdp.evaluate(`(() => {
    const box = document.querySelector('.v3-stream'); const base = box.getBoundingClientRect().top;
    const row = [...box.querySelectorAll('.v3-msg[data-turn-id]')].find(el => el.getBoundingClientRect().bottom > base);
    return { id: row.dataset.turnId, y: row.getBoundingClientRect().top - base };
  })()`)
  await measure('streamWhileReading', async () => {
    for (let i = 30; i < 45; i++) { await append(i); await sleep(30) }
  })
  const shift = await cdp.evaluate(`(() => {
    const box = document.querySelector('.v3-stream'); const row = box.querySelector('[data-turn-id="${anchor.id}"]');
    return row ? row.getBoundingClientRect().top - box.getBoundingClientRect().top - ${anchor.y} : null;
  })()`)
  check('上翻阅读时新输出不抢回底部', shift !== null && Math.abs(shift) <= 2, shift)
  await measure('readingScroll', async () => {
    for (let i = 0; i < 20; i++) {
      await cdp.evaluate(`(() => { const el = document.querySelector('.v3-stream'); el.scrollTop += ${i < 10 ? 35 : -35} })()`)
      await sleep(20)
    }
  })
  await cdp.evaluate(`window.__yanStore.setState(s => ({ session: { ...s.session, isStreaming: false, isAgentRunning: false } }))`)
  await sleep(650)
  check('流式结束后权威文本完整', await cdp.evaluate(`window.__yanStore.getState().messages.at(-1).text === window.__streamExpected`))
  await cdp.evaluate(`document.querySelector('[data-testid="v3-jump"]')?.click()`)
  await sleep(1000)
  check('回到最新后贴底', (await bottom()) <= 2, await bottom())
  check('最终文本和 emoji 已完整显示', await cdp.evaluate(`(() => { const text = document.querySelector('[data-turn-id="stream-live"]').textContent; return text.includes('第 44 段输出') && text.includes('🖋️') })()`))
  await shot('message-stream-final')
  await cdp.evaluate(`(() => {
    const now = Date.now();
    const history = Array.from({ length: 120 }, (_, i) => [
      { id: 'virtual-user-' + i, role: 'user', text: '长历史第 ' + i + ' 轮', timestamp: now - (240 - i * 2) * 1000 },
      { id: 'virtual-answer-' + i, role: 'assistant', text: '历史内容和工具结果必须保持稳定。'.repeat(10), timestamp: now - (239 - i * 2) * 1000 }
    ]).flat();
    window.__streamExpected = '## 虚拟列表输出\\n\\n';
    window.__yanStore.setState(s => ({ messages: [...history, { id: 'stream-live-user', role: 'user', text: '继续长历史', timestamp: now }, { id: 'stream-live', role: 'assistant', text: window.__streamExpected, timestamp: now + 1 }], session: { ...s.session, isStreaming: true, isAgentRunning: true } }));
  })()`)
  await sleep(900)
  check('长历史启用虚拟列表且尾部可见', await cdp.evaluate(`!document.querySelector('.v3-stream-inner') && document.querySelectorAll('.v3-msg[data-turn-id]').length < 242 && !!document.querySelector('[data-turn-id="stream-live"]')`))
  await measure('virtualStream', async () => {
    for (let i = 0; i < 15; i++) { await append(i); await sleep(30) }
  })
  await sleep(500)
  check('虚拟列表流式输出保持贴底', (await bottom()) <= 2, await bottom())
  await cdp.evaluate(`(() => {
    window.__virtualResizeGaps = [];
    const tick = () => {
      const el = document.querySelector('.v3-stream');
      window.__virtualResizeGaps.push(Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop));
      window.__virtualResizeFrame = requestAnimationFrame(tick);
    };
    window.__virtualResizeFrame = requestAnimationFrame(tick);
  })()`)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1040, height: 920, deviceScaleFactor: 1, mobile: false })
  await sleep(650)
  report.timings.virtualResize = await cdp.evaluate(`(() => { cancelAnimationFrame(window.__virtualResizeFrame); return { maxGapPx: Math.max(0, ...window.__virtualResizeGaps), frames: window.__virtualResizeGaps.length } })()`)
  console.log('virtualResize', JSON.stringify(report.timings.virtualResize))
  check('虚拟列表变窄时逐帧离底不超过 2px', report.timings.virtualResize.maxGapPx <= 2, report.timings.virtualResize)
  check('虚拟列表宽度变化后仍贴底', (await bottom()) <= 2, await bottom())
  await cdp.evaluate(`(() => { const el = document.querySelector('.v3-stream'); el.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true })); el.scrollTop = Math.round(el.scrollHeight * 0.4) })()`)
  await sleep(350)
  const virtualAnchor = await cdp.evaluate(`(() => {
    const box = document.querySelector('.v3-stream'); const base = box.getBoundingClientRect().top;
    const row = [...box.querySelectorAll('.v3-msg[data-turn-id]')].find(el => el.getBoundingClientRect().bottom > base);
    return { id: row.dataset.turnId, y: row.getBoundingClientRect().top - base };
  })()`)
  for (let i = 15; i < 20; i++) { await append(i); await sleep(30) }
  await sleep(300)
  const virtualShift = await cdp.evaluate(`(() => {
    const box = document.querySelector('.v3-stream'); const row = box.querySelector('[data-turn-id="${virtualAnchor.id}"]');
    return row ? row.getBoundingClientRect().top - box.getBoundingClientRect().top - ${virtualAnchor.y} : null;
  })()`)
  check('虚拟列表上翻阅读时尾部增量不抢读', virtualShift !== null && Math.abs(virtualShift) <= 2, virtualShift)
  await cdp.evaluate(`window.__yanStore.setState(s => ({ session: { ...s.session, isStreaming: false, isAgentRunning: false } }))`)
  await sleep(300)
  await cdp.evaluate(`document.querySelector('[data-testid="v3-jump"]')?.click()`)
  await sleep(1100)
  check('虚拟列表回到最新后尾部完整可见', (await bottom()) <= 2 && await cdp.evaluate(`document.querySelector('[data-turn-id="stream-live"]')?.textContent.includes('第 19 段输出')`), await bottom())
  await shot('message-stream-virtual-final')
  report.resizeWarnings = await cdp.evaluate('window.__streamResizeWarnings')
  console.log('ResizeObserver warnings', report.resizeWarnings.length)
}
