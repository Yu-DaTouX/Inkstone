import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { observation: true, description: '窄格里的 Mermaid、宽代码块、KaTeX 块公式、表格：是否被裁、是否可横向滚动，输出每项宽度与截图（NARROW_DIR）' }

const MEASURE = `(() => {
  const out = {};
  const probe = (name, sel) => {
    const els = [...document.querySelectorAll(sel)].filter((el) => el.getBoundingClientRect().width > 0);
    out[name] = els.slice(0, 1).map((el) => {
      const r = el.getBoundingClientRect();
      const inner = el.querySelector('code, table, .katex, svg');
      const cs = getComputedStyle(el);
      const tile = el.closest('[data-tile-key]');
      const tr = tile ? tile.getBoundingClientRect() : { right: innerWidth };
      return { w: Math.round(r.width), right: Math.round(r.right), tileRight: Math.round(tr.right), overflowX: cs.overflowX, scrollW: el.scrollWidth, clientW: el.clientWidth, innerW: inner ? Math.round(inner.getBoundingClientRect().width) : null };
    });
  };
  probe('mermaid', '.v3-visual-mermaid');
  probe('katex', '.katex-display');
  probe('table', '.v3-md-table-wrap');
  probe('code', '.v3-msg pre');
  return out;
})()`

export default async function run({ cdp, box, sleep, waitFor, report, log, autoApprove, newSession, state, running }) {
  const ev = (x) => cdp.evaluate(x)
  const dir = process.env.NARROW_DIR ?? '.'
  mkdirSync(dir, { recursive: true })
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: Number(process.env.NARROW_W ?? 1422), height: 800, deviceScaleFactor: 1, mobile: false })
  await autoApprove()
  await ev(`window.__yanStore.getState().patchSettings({ theme: '${process.env.NARROW_THEME ?? 'dark'}' })`)
  const refs = []
  for (let i = 0; i < 3; i += 1) {
    await newSession(box.project)
    await ev(`window.__yanStore.getState().send('MDSHOW CHUNK8 GAP10 n${i}')`)
    await waitFor(`${running}`, 20000, 10)
    await waitFor(`!(${running})`, 120000, 50)
    refs.push({ sessionId: await state('s.session.sessionId'), path: await state('s.session.sessionFile') })
  }
  await ev(`window.__yanSplit.getState().apply({ tiles: ${JSON.stringify(refs)}, live: 2 })`)
  await sleep(2500)
  await ev(`document.querySelectorAll('.v3-stream').forEach((el) => { el.scrollTop = 0 })`)
  const shotOf = async (name, sel) => {
    await ev(`(() => { const el = [...document.querySelectorAll('${sel}')].find((x) => x.getBoundingClientRect().width > 0); if (!el) return; const st = el.closest('.v3-stream'); const d = el.getBoundingClientRect().top - st.getBoundingClientRect().top - 120; st.scrollTop += d })()`)
    await sleep(500)
    const res = await cdp.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(dir, `${name}.png`), Buffer.from(res.result.data, 'base64'))
  }
  for (const [name, sel] of [['code', '.v3-msg pre'], ['table', '.v3-md-table-wrap'], ['katex', '.katex-display'], ['mermaid', '.v3-visual-mermaid']]) await shotOf(name, sel)
  report.wide = await ev(`(() => {
    const out = {};
    const clone = (sel, edit) => {
      const el = [...document.querySelectorAll(sel)].find((x) => x.getBoundingClientRect().width > 0);
      if (!el) return;
      const copy = el.cloneNode(true);
      edit(copy);
      el.after(copy);
      const cs = getComputedStyle(copy);
      out[sel] = { overflowX: cs.overflowX, clientW: copy.clientWidth, scrollW: copy.scrollWidth, scrolls: copy.scrollWidth > copy.clientWidth + 1, insideTile: copy.getBoundingClientRect().right <= copy.closest('[data-tile-key]').getBoundingClientRect().right };
    };
    clone('.v3-msg pre', (c) => { const code = c.querySelector('code'); code.textContent = 'x'.repeat(400); code.style.whiteSpace = 'pre'; });
    clone('.katex-display', (c) => { c.querySelector('.katex').style.width = 'max-content'; c.querySelector('.katex').style.paddingRight = '600px'; });
    clone('.v3-md-table-wrap', (c) => { const t = c.querySelector('table'); t.style.minWidth = '900px'; });
    return out;
  })()`)
  report.measure = await ev(MEASURE)
  log('narrow', report.measure)
  log('wide', report.wide)
}
