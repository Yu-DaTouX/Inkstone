export const RENDER_HOOK = `
  window.__uiRenders = null;
  window.__uiRegions = null;
  window.__uiCauses = null;
  window.__pendingKeys = new Set();
  const TRACK = new Set(['SubagentRow', 'SubagentLine', 'TurnProcess', 'ApprovalCard', 'LiveRunNotice', 'ShellV3', 'Header', 'OverviewPane', 'T3SidebarShell', 'SessionView', 'PeerPane', 'SidebarThreadRow', 'ChatMain']);
  const AREAS = new Set(['T3SidebarShell', 'SessionView', 'PeerPane', 'RightPanelT3', 'WorkbenchRail', 'ComposerV3', 'Header', 'RunAttentionToasts', 'SettingsPage', 'UsagePage']);
  const PARTS = new Set(['TurnView', 'AssistantTurnView', 'TurnProcess', 'SubagentRow', 'SubagentLine', 'SubagentCard', 'LiveRunNotice', 'SidebarThreadRow', 'BackgroundTasks', 'RailStats', 'OverviewPane', 'ChangesCard', 'TurnChanges', 'Markdown', 'ComposerControlsBar', 'ApprovalCard', 'WebSearchTurnProvider']);
  const nameOf = (fiber) => {
    const type = fiber.type;
    return type?.displayName || type?.name || type?.render?.name || type?.type?.name || '';
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    inject() { return 1 },
    onCommitFiberUnmount() {},
    onCommitFiberRoot(id, root) {
      if (!window.__uiRenders) { window.__pendingKeys.clear(); return }
      const renderedNow = new Set();
      const walk = (fiber, area, part) => {
        for (let f = fiber; f; f = f.sibling) {
          const name = nameOf(f);
          const base = name.replace(/\\d+$/, '').replace(/\\$\\d+$/, '');
          const nextArea = AREAS.has(base) ? base : area;
          const nextPart = AREAS.has(base) ? '-' : PARTS.has(base) ? base : part;
          if (f.flags & 1 && name) {
            if (TRACK.has(base)) renderedNow.add(base);
            window.__uiRenders[name] = (window.__uiRenders[name] || 0) + 1;
            if (window.__uiRegions) { const key = nextArea + ' > ' + nextPart; window.__uiRegions[key] = (window.__uiRegions[key] || 0) + 1 }
          }
          if (f.child !== f.alternate?.child) walk(f.child, nextArea, nextPart);
        }
      };
      walk(root.current, 'ShellV3', '-');
      if (window.__uiCauses) {
        const keys = window.__pendingKeys.size ? [...window.__pendingKeys] : ['(none)'];
        for (const name of renderedNow) {
          const slot = window.__uiCauses[name] ??= { commits: 0 };
          slot.commits++;
          for (const key of keys) slot[key] = (slot[key] || 0) + 1;
        }
      }
      window.__pendingKeys.clear();
    }
  };
`

export const RENDER_START = `(() => { window.__uiRenders = {}; window.__uiRegions = {}; window.__uiCauses = {} })()`

export const RENDER_TAKE = `(() => {
  const top = (o, n) => Object.fromEntries(Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, n));
  const causes = Object.fromEntries(Object.entries(window.__uiCauses || {}).map(([name, slot]) => [name, top(slot, 8)]));
  const out = { renders: top(window.__uiRenders, 10), regions: top(window.__uiRegions, 14), causes };
  window.__uiRenders = null;
  window.__uiRegions = null;
  window.__uiCauses = null;
  return out;
})()`

export const PROBES = `(() => {
  if (window.__pa) return;
  const pa = window.__pa = { phase: 'boot', rtt: [], tasks: [], frames: {}, updates: {}, runUpdates: {} };
  pa.keys = {};
  window.__yanStore?.subscribe((next, prev) => {
    pa.updates[pa.phase] = (pa.updates[pa.phase] ?? 0) + 1;
    const bucket = pa.keys[pa.phase] ??= {};
    for (const key in next) if (next[key] !== prev?.[key] && typeof next[key] !== 'function') { bucket[key] = (bucket[key] ?? 0) + 1; window.__pendingKeys?.add(key) }
  });
  window.__yanRuns?.subscribe(() => { pa.runUpdates[pa.phase] = (pa.runUpdates[pa.phase] ?? 0) + 1; window.__pendingKeys?.add('runs-v3') });
  new PerformanceObserver((list) => { for (const e of list.getEntries()) pa.tasks.push({ p: pa.phase, s: e.startTime, d: e.duration }) }).observe({ type: 'longtask', buffered: true });
  let last = performance.now();
  const tick = (now) => { const f = pa.frames[pa.phase] ??= { n: 0, over33: 0, over50: 0, max: 0 }; const gap = now - last; f.n++; if (gap > 33) f.over33++; if (gap > 50) f.over50++; if (gap > f.max) f.max = Math.round(gap); last = now; requestAnimationFrame(tick) };
  requestAnimationFrame(tick);
  (async () => {
    while (!pa.stop) {
      const s = performance.now();
      const p = pa.phase;
      try { await window.yan.agentStatus() } catch {}
      pa.rtt.push({ p, s, e: performance.now() });
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
})()`

export const SUMMARY = (phase) => `(() => {
  const pa = window.__pa;
  const phase = ${JSON.stringify(phase)};
  const tasks = pa.tasks.filter((t) => t.p === phase);
  const rtts = pa.rtt.filter((r) => r.p === phase);
  const all = rtts.map((r) => r.e - r.s).sort((a, b) => a - b);
  const clean = rtts.filter((r) => !pa.tasks.some((t) => t.s < r.e && t.s + t.d > r.s)).map((r) => r.e - r.s).sort((a, b) => a - b);
  const q = (xs, f) => xs.length ? Math.round(xs[Math.min(xs.length - 1, Math.floor(xs.length * f))]) : null;
  return {
    longTasks: tasks.length,
    longTaskMs: Math.round(tasks.reduce((a, t) => a + t.d, 0)),
    longTaskMax: Math.round(Math.max(0, ...tasks.map((t) => t.d))),
    frames: pa.frames[phase] ?? { n: 0, over33: 0, over50: 0, max: 0 },
    storeUpdates: pa.updates[phase] ?? 0,
    changedKeys: Object.fromEntries(Object.entries(pa.keys?.[phase] ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 12)),
    runUpdates: pa.runUpdates[phase] ?? 0,
    ipc: { n: all.length, p50: q(all, 0.5), p95: q(all, 0.95), max: q(all, 1), cleanP95: q(clean, 0.95), cleanMax: q(clean, 1), cleanN: clean.length }
  };
})()`

export async function useRealWindow(cdp, sleep, { maximize = false } = {}) {
  await cdp.call('Emulation.clearDeviceMetricsOverride').catch(() => {})
  if (maximize && await cdp.evaluate('window.innerWidth < screen.availWidth - 40')) {
    await cdp.evaluate('window.yan.win.maximize()')
    await sleep(1200)
  }
  return cdp.evaluate('({ width: window.innerWidth, height: window.innerHeight, dpr: devicePixelRatio })')
}
