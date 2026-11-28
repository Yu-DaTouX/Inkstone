export const meta = { description: '长会话远跳：小地图跳到开头、回到最新、拖动式大跨度滚动时，每帧视口都有正文或残影文字，不出现空白；仅合成消息' }

export default async function run({ cdp, waitFor, check, report, sleep, shot }) {
  await waitFor('!!window.__yanStore && !!s.session && !!document.querySelector(".v3-stream")', 30000)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 920, deviceScaleFactor: 1, mobile: false })
  await cdp.evaluate(`(() => {
    const now = Date.now();
    const answer = (i) => '### 第 ' + i + ' 轮结论\\n\\n' + ('这一轮讨论了消息流远跳时的渲染方式，正文需要在飞越途中保持可读。'.repeat(3 + (i % 5))) + '\\n\\n- 要点一：同步绘制\\n- 要点二：回收复用\\n\\n' + '\`\`\`ts\\nconst row = ' + i + '\\n\`\`\`';
    const history = Array.from({ length: 300 }, (_, i) => [
      { id: 'far-user-' + i, role: 'user', text: '第 ' + i + ' 轮提问：这一段要怎么改？', timestamp: now - (600 - i * 2) * 1000 },
      { id: 'far-answer-' + i, role: 'assistant', text: answer(i), timestamp: now - (599 - i * 2) * 1000 }
    ]).flat();
    window.__yanStore.setState(s => ({ messages: history, session: { ...s.session, isStreaming: false, isAgentRunning: false }, runTail: null, settings: { ...s.settings, workspaceTiles: false } }));
  })()`)
  await sleep(1200)
  check('长历史启用虚拟列表', await cdp.evaluate(`!document.querySelector('.v3-stream-inner') && !!document.querySelector('.v3-stream-row')`))

  const startProbe = () => cdp.evaluate(`(() => {
    const box = document.querySelector('.v3-stream');
    const host = box.closest('.v3-stream-host');
    const probe = window.__farProbe = { frames: 0, blank: 0, ghostFrames: 0, maxGhosts: 0, frozen: false, running: true };
    const visible = (el, view) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.bottom > view.top + 40 && r.top < view.bottom - 40 };
    const tick = () => {
      if (!probe.running) return;
      const view = box.getBoundingClientRect();
      const real = [...box.querySelectorAll('.v3-msg')].some(el => visible(el, view));
      const ghosts = [...host.querySelectorAll('.v3-flight-ghosts:not([hidden]):not(.far-probe-frozen) .v3-flight-ghost:not([hidden])')].filter(el => visible(el, view));
      probe.frames++;
      if (ghosts.length) {
        probe.ghostFrames++;
        probe.maxGhosts = Math.max(probe.maxGhosts, ghosts.length);
        if (!probe.frozen && !real) {
          probe.frozen = true;
          const layer = host.querySelector('.v3-flight-ghosts').cloneNode(true);
          layer.classList.add('far-probe-frozen');
          layer.style.background = 'var(--bg)';
          layer.style.zIndex = '3';
          host.appendChild(layer);
        }
      }
      if (!real && !ghosts.length) probe.blank++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`)
  const stopProbe = () => cdp.evaluate(`(() => { const p = window.__farProbe; p.running = false; return { frames: p.frames, blank: p.blank, ghostFrames: p.ghostFrames, maxGhosts: p.maxGhosts, frozen: p.frozen } })()`)
  const unfreeze = () => cdp.evaluate(`document.querySelectorAll('.far-probe-frozen').forEach(el => el.remove())`)
  const top = () => cdp.evaluate(`document.querySelector('.v3-stream').scrollTop`)

  await startProbe()
  await cdp.evaluate(`document.querySelector('[data-testid="v3-outline-tick"]')?.click()`)
  await sleep(1200)
  const up = await stopProbe()
  report.timings.outlineToTop = up
  console.log('outlineToTop', JSON.stringify(up))
  check('小地图跳到开头后到达顶部附近', (await top()) < 400, await top())
  check('小地图远跳途中没有空白帧', up.blank === 0, up)
  check('小地图远跳途中出现残影文字', up.ghostFrames > 0 && up.maxGhosts > 0, up)
  check('远跳落地后残影收起', await cdp.evaluate(`!document.querySelector('.v3-flight-ghosts:not([hidden]):not(.far-probe-frozen)')`))
  if (up.frozen) await shot('far-jump-ghosts-up')
  await unfreeze()
  await sleep(300)

  await startProbe()
  await cdp.evaluate(`document.querySelector('[data-testid="v3-jump"]')?.click()`)
  await sleep(1200)
  const down = await stopProbe()
  report.timings.jumpToLatest = down
  console.log('jumpToLatest', JSON.stringify(down))
  check('回到最新后贴底', await cdp.evaluate(`(() => { const el = document.querySelector('.v3-stream'); return el.scrollHeight - el.clientHeight - el.scrollTop <= 2 })()`))
  check('回到最新途中没有空白帧', down.blank === 0, down)
  if (down.frozen) await shot('far-jump-ghosts-down')
  await unfreeze()
  await sleep(300)

  await startProbe()
  await cdp.evaluate(`(() => { const el = document.querySelector('.v3-stream'); el.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true })); el.scrollTop = Math.round(el.scrollHeight * 0.45) })()`)
  await sleep(800)
  const drag = await stopProbe()
  report.timings.manualLeap = drag
  console.log('manualLeap', JSON.stringify(drag))
  check('大跨度手动滚动没有空白帧', drag.blank === 0, drag)
  check('手动滚动停下后残影收起', await cdp.evaluate(`!document.querySelector('.v3-flight-ghosts:not([hidden])')`))
  await unfreeze()
  await shot('far-jump-ghosts-settled')
}
