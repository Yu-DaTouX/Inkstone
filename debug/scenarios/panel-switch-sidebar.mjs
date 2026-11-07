import { useRealWindow } from '../lib/perf-probes.mjs'

export const meta = { description: '切换会话时右栏开合不应让左栏播放动画：会话 A 右栏展开、会话 B 收起，来回切换并逐帧记录左栏宽度、位移与根节点属性，不调用真实模型' }

const SAMPLER = `(() => {
  window.__ps = { frames: [], stop: false, start: performance.now() };
  const root = document.querySelector('.v3-root');
  const side = document.querySelector('.v3-side');
  const sample = () => {
    const inner = side?.firstElementChild;
    const rect = side?.getBoundingClientRect();
    const cs = side ? getComputedStyle(side) : null;
    window.__ps.frames.push({
      t: Math.round(performance.now() - window.__ps.start),
      w: rect ? Math.round(rect.width) : null,
      x: rect ? Math.round(rect.left) : null,
      op: cs?.opacity ?? null,
      tf: cs?.transform ?? null,
      innerTf: inner ? getComputedStyle(inner).transform : null,
      innerX: inner ? Math.round(inner.getBoundingClientRect().left) : null,
      side: root?.dataset.side ?? null,
      narrow: root?.dataset.narrow ?? null,
      panel: root?.dataset.panel ?? null,
      preview: root?.dataset.sidebarPreview ?? null,
      hole: root ? (() => { const a = getComputedStyle(root, '::after'); return a.width + '|' + a.backgroundColor + '|' + a.boxShadow.slice(0, 30) })() : null,
      top: (() => { const el = document.elementFromPoint(60, innerHeight - 160); return el ? (el.className || el.tagName).toString().slice(0, 50) : null })(),
      sideBg: side ? getComputedStyle(side).backgroundColor : null,
      listId: (() => { const el = side?.querySelector('.v3-swap-fade'); if (!el) return 0; el.__psId = el.__psId || (window.__psSeq = (window.__psSeq || 0) + 1); return el.__psId })(),
      overflow: [document.documentElement, document.body, document.getElementById('root'), root, document.querySelector('.v3-main'), document.querySelector('.v3-body')].map((el) => el ? el.scrollWidth - el.clientWidth : null).join(','),
      rootX: root ? Math.round(root.getBoundingClientRect().left) : null,
      scrolled: [document.scrollingElement, document.body, ...document.querySelectorAll('.v3-root, .v3-root *')].filter((el) => el && el.scrollLeft > 0 && !el.closest('pre, table, .v3-code, [data-hscroll]')).slice(0, 5).map((el) => (el.className || el.tagName).toString().slice(0, 60) + ':' + Math.round(el.scrollLeft)),
      anims: side ? side.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').map((a) => (a.transitionProperty || a.animationName || 'anim') + '@' + (a.effect?.target?.className || '')).slice(0, 6) : []
    });
    if (!window.__ps.stop) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
})()`

export default async function run({ cdp, box, waitFor, check, report, sleep, shot, autoApprove, newSession, turn }) {
  const ev = (expr) => cdp.evaluate(expr)
  report.viewport = await useRealWindow(cdp, sleep, { maximize: true })
  await autoApprove()
  const sideWidth = Number(process.env.PANEL_SWITCH_SIDEBAR ?? 200)
  await ev(`localStorage.setItem('inkstone.v3.sidebarWidth', '${sideWidth}'); location.reload()`).catch(() => {})
  await sleep(4000)
  await waitFor('!!s.settings', 30000)
  report.sidebarWidth = sideWidth
  const files = []
  for (const tag of ['A', 'B', 'C']) {
    await newSession(box.project)
    await turn(`FLOW SHORT ${tag} 看看项目`)
    files.push(await ev('window.__yanStore.getState().session?.sessionFile'))
  }
  await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(files[0])})`)
  await waitFor(`s.session?.sessionFile === ${JSON.stringify(files[0])}`, 30000)
  await ev(`window.__yanStore.getState().send('SUBAGENTS2-LOOK 先派子代理，再继续')`)
  await waitFor(`(s.subagents ?? []).filter((a) => a.status === 'running').length >= 1`, 60000)
  await sleep(1500)
  await ev(`document.querySelector('[data-testid="v3-subagent-tile"], [data-testid="v3-subagent-row"]')?.click()`)
  await sleep(1500)
  report.panelSurface = await ev(`window.__yanRightPanel.getState().byKey[window.__yanRightPanel.getState().key]?.active ?? null`)
  await sleep(800)
  await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(files[1])})`)
  await waitFor(`s.session?.sessionFile === ${JSON.stringify(files[1])}`, 30000)
  await sleep(800)
  report.before = await ev(`({ panel: document.querySelector('.v3-root')?.dataset.panel, side: document.querySelector('.v3-root')?.dataset.side })`)

  for (const [label, target] of [['toOpen', files[0]], ['toClosed', files[1]], ['closedToClosed', files[2]]]) {
    await ev(SAMPLER)
    const clicked = await ev(`(() => { const rows = [...document.querySelectorAll('.v3-side [data-session-file], .v3-side [data-session-path]')]; const row = rows.find((el) => (el.dataset.sessionFile || el.dataset.sessionPath) === ${JSON.stringify(target)}); if (!row) return false; row.click(); return true })()`)
    if (!clicked) await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(target)})`)
    if (label === 'toOpen') {
      report.provoke = await ev(`new Promise((done) => {
        const root = document.querySelector('.v3-root')
        let tries = 0, maxOverflow = 0, maxScroll = 0
        const poke = () => {
          maxOverflow = Math.max(maxOverflow, root.scrollWidth - root.clientWidth)
          const target = document.querySelector('.t3-rp textarea, .t3-rp input, .t3-rp [tabindex], .t3-rp button')
          target?.focus()
          root.scrollLeft = 400
          maxScroll = Math.max(maxScroll, root.scrollLeft)
          if (++tries < 30) requestAnimationFrame(poke)
          else done({ maxOverflow, maxScroll, focused: !!target })
        }
        requestAnimationFrame(poke)
      })`)
    }
    report[label + 'Clicked'] = clicked
    await waitFor(`s.session?.sessionFile === ${JSON.stringify(target)}`, 30000)
    await sleep(1500)
    const frames = await ev('(() => { window.__ps.stop = true; return window.__ps.frames })()')
    const changes = frames.filter((f, i) => i === 0 || ['w', 'x', 'op', 'tf', 'innerTf', 'innerX', 'side', 'narrow', 'panel', 'preview', 'rootX', 'hole', 'top', 'sideBg'].some((k) => f[k] !== frames[i - 1][k]) || f.scrolled.length)
    report[label] = { frames: frames.length, changes: changes.slice(0, 40) }
    const widths = new Set(frames.map((f) => f.w))
    const innerXs = new Set(frames.map((f) => f.innerX))
    const animated = frames.filter((f) => f.anims.length).length
    report[label].holes = [...new Set(frames.map((f) => f.hole))]
    report[label].tops = [...new Set(frames.map((f) => f.top))]
    report[label].sideBgs = [...new Set(frames.map((f) => f.sideBg))]
    const scrolledFrames = frames.filter((f) => f.scrolled.length || f.rootX !== 0)
    report[label].scrolled = scrolledFrames.slice(0, 10)
    report[label].overflows = [...new Set(frames.map((f) => f.overflow))]
    report[label].listIds = [...new Set(frames.map((f) => f.listId))]
    report[label].swapFadeFrames = frames.filter((f) => f.anims.some((a) => a.startsWith('v3-swap-fade@'))).length
    const moving = frames.filter((f) => f.anims.some((a) => !a.startsWith('background-color@') && !a.startsWith('spin@'))).length
    if (label === 'toOpen') check('右栏展开过程中强制聚焦与横向滚动，根节点仍不偏移', report.provoke.maxScroll === 0 && scrolledFrames.length === 0, report.provoke)
    check(`${label}：左栏宽度与内容位置不变、没有位移动画`, widths.size === 1 && innerXs.size === 1 && scrolledFrames.length === 0, { scrolled: scrolledFrames.length, widths: [...widths], innerXs: [...innerXs], moving, material: await ev('document.documentElement.dataset.material ?? null') })
    await shot(`panel-switch-${label}`)
  }
}
