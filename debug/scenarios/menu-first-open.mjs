export const meta = { description: '模型菜单首开帧间隔：点开后 900ms 内的最大帧间隔与超过 20ms 的帧数，再关闭重开作对照' }

const SAMPLE = `new Promise((resolve) => {
  const gaps = [];
  let last = performance.now();
  const start = last;
  const tick = (now) => {
    gaps.push(Math.round((now - last) * 10) / 10);
    last = now;
    if (now - start < 900) requestAnimationFrame(tick);
    else resolve({ frames: gaps.length, max: Math.max(...gaps), over20: gaps.filter((g) => g > 20).length, over33: gaps.filter((g) => g > 33).length, gaps: gaps.slice(0, 14) });
  };
  document.querySelector('[data-chat-provider-model-picker]').click();
  requestAnimationFrame(tick);
})`

export default async function run({ cdp, sleep, log, report, shot }) {
  await sleep(2500)
  if (process.env.MENU_NOBLUR) await cdp.evaluate(`(() => { const st = document.createElement('style'); st.textContent = '.dropdown-glass{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}'; document.head.appendChild(st) })()`)
  if (process.env.MENU_WARM) { await cdp.evaluate(`(() => { const d = document.createElement('div'); d.id='warm'; d.style.cssText = 'position:fixed;left:40%;top:40%;width:360px;height:420px;opacity:.01;pointer-events:none;z-index:-1;backdrop-filter:blur(var(--glass-blur)) saturate(var(--glass-saturation));'; document.body.appendChild(d); })()`); await sleep(1500) }
  const first = await cdp.evaluate(SAMPLE)
  await shot('menu-first-open')
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape' })
  await sleep(800)
  const second = await cdp.evaluate(SAMPLE)
  report.first = first
  report.second = second
  log('menu-first-open', { first, second })
}
