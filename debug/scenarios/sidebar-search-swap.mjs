import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { demo: true, description: '左栏搜索结果与普通列表互换：逐帧记录行数、首行位置、内容区不透明度与滚动高度，并连续截帧' }

const PROBE = `(() => {
  const box = document.querySelector('[data-slot="sidebar-content"]');
  const t0 = performance.now();
  window.__swap = { frames: [], done: false };
  const tick = (now) => {
    const rows = [...box.querySelectorAll('[data-sidebar-row]')];
    const first = rows[0]?.getBoundingClientRect();
    const fade = [...box.querySelectorAll('.v3-fade, .v3-swap-fade')].map((el) => +getComputedStyle(el).opacity);
    window.__swap.frames.push({ t: Math.round(now - t0), rows: rows.length, firstTop: first ? Math.round(first.top) : null, sh: box.scrollHeight, fade: fade.length ? Math.round(Math.min(...fade) * 100) / 100 : null });
    if (now - t0 < 700) requestAnimationFrame(tick); else window.__swap.done = true;
  };
  requestAnimationFrame(tick);
})()`

export default async function run({ cdp, sleep, waitFor, log, report, shot }) {
  const ev = (x) => cdp.evaluate(x)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await ev(`window.__yanStore.getState().patchSettings({lang:'zh-CN',theme:'dark',reduceMotion:false})`)
  await sleep(2500)
  const input = `document.querySelector('[data-testid="t3-sidebar-thread-header"] input')`
  const grab = async (name) => {
    for (let i = 0; i < 6; i += 1) {
      const res = await cdp.call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 420, height: 800, scale: 1 } })
      writeFileSync(join(process.env.SWAP_DIR ?? '.', `${name}-${i}.png`), Buffer.from(res.result.data, 'base64'))
      await sleep(30)
    }
  }
  const runPhase = async (name, act) => {
    await ev(PROBE)
    await act()
    if (process.env.SWAP_DIR) await grab(name)
    await waitFor('window.__swap.done', 5000, 30)
    const frames = await ev('window.__swap.frames')
    const changes = frames.filter((f, i) => i === 0 || f.rows !== frames[i - 1].rows || f.firstTop !== frames[i - 1].firstTop || f.fade !== frames[i - 1].fade)
    report[name] = changes
    log(name, changes.slice(0, 14))
  }
  await runPhase('enter-search', async () => {
    await ev(`${input}.focus()`)
    await cdp.call('Input.insertText', { text: 'a' })
  })
  await sleep(800)
  await runPhase('leave-search', async () => {
    await ev(`(() => { const i = ${input}; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  })
}
