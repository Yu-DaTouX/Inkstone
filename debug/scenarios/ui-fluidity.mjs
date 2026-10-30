export const meta = { description: '合成会话：测输入、布局变化的渲染与主线程开销，检查模型菜单、思考档和窄屏，不调用模型' }

export default async function run({ cdp, waitFor, check, report, sleep, shot }) {
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__uiRenders = null;
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      inject() { return 1 },
      onCommitFiberUnmount() {},
      onCommitFiberRoot(id, root) {
        if (!window.__uiRenders) return;
        const walk = (fiber) => {
          if (!fiber) return;
          if (fiber.flags & 1) {
            const type = fiber.type;
            const name = type?.displayName || type?.name || type?.render?.name;
            if (name) window.__uiRenders[name] = (window.__uiRenders[name] || 0) + 1;
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
  await waitFor('!!window.__yanStore && !!document.querySelector(".ProseMirror")', 30000)
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1672, height: 1000, deviceScaleFactor: 1, mobile: false })
  await cdp.evaluate(`(() => {
    const now = Date.now();
    const messages = Array.from({ length: 60 }, (_, i) => [
      { id: 'fluid-user-' + i, role: 'user', text: '第 ' + i + ' 轮：检查界面的滚动和输入。', timestamp: now + i * 2 },
      { id: 'fluid-answer-' + i, role: 'assistant', text: '### 检查结果 ' + i + '\\n\\n' + '保持正文、代码与列表的正常布局。'.repeat(15), timestamp: now + i * 2 + 1 }
    ]).flat();
    window.__yanStore.setState((s) => ({ messages, settings: { ...s.settings, workspaceTiles: false } }));
  })()`)
  await sleep(1800)
  await cdp.call('Performance.enable')
  const metrics = async () => Object.fromEntries((await cdp.call('Performance.getMetrics')).result.metrics.map((m) => [m.name, m.value]))
  const measure = async (name, action) => {
    await cdp.evaluate(`(() => {
      window.__uiRenders = {};
      window.__uiPerf = { frames: [], tasks: [] };
      window.__uiObserver = new PerformanceObserver(list => window.__uiPerf.tasks.push(...list.getEntries().map(e => e.duration)));
      window.__uiObserver.observe({ type: 'longtask' });
      let last = performance.now();
      const tick = now => { window.__uiPerf.frames.push(now - last); last = now; window.__uiFrame = requestAnimationFrame(tick) };
      window.__uiFrame = requestAnimationFrame(tick);
    })()`)
    const before = await metrics()
    await action()
    await sleep(180)
    const after = await metrics()
    const result = await cdp.evaluate(`(() => {
      cancelAnimationFrame(window.__uiFrame);
      window.__uiObserver.disconnect();
      const { frames, tasks } = window.__uiPerf;
      const renders = window.__uiRenders;
      window.__uiRenders = null;
      return { renders, frames: frames.length, over50: frames.filter(n => n > 50).length, maxFrameMs: Math.max(0, ...frames), longTasks: tasks.length };
    })()`)
    for (const key of ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount']) {
      result[key] = (after[key] - before[key]) * (key.endsWith('Duration') ? 1000 : 1)
    }
    report.timings[name] = result
    const tracked = ['ComposerV3', 'ComposerControlsBar', 'ProviderModelPicker2', 'TraitsPicker2', 'SessionView', 'ShellV3', 'T3SidebarShell2'];
    console.log(name, JSON.stringify({ ...result, renders: Object.fromEntries(tracked.map(key => [key, result.renders[key] ?? 0])) }))
    return result
  }
  const typing = await measure('typing', async () => {
    await cdp.evaluate(`document.querySelector('.ProseMirror').focus()`)
    for (let i = 0; i < 40; i++) {
      await cdp.call('Input.insertText', { text: '流畅输入' })
      await sleep(20)
    }
  })
  check('输入正文完整保留', await cdp.evaluate(`document.querySelector('.ProseMirror').textContent === '流畅输入'.repeat(40)`))
  check('输入时采集到正文组件提交', (typing.renders.ComposerV3 ?? 0) >= 40)
  check('输入不再重渲染模型与思考控件', Object.entries(typing.renders).every(([name, count]) => !/^(ComposerControlsBar|ProviderModelPicker|TraitsPicker)\d*$/.test(name) || count === 0))
  await measure('sidebarResize', async () => {
    const bounds = await cdp.evaluate(`(() => { const r = document.querySelector('[data-testid="v3-sidebar-resizer"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...bounds })
    for (let i = 0; i < 40; i++) {
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 1, x: bounds.x + Math.sin(i / 8) * 65, y: bounds.y })
      await sleep(16)
    }
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...bounds })
  })
  check('调整布局后输入内容仍在', await cdp.evaluate(`document.querySelector('.ProseMirror').textContent === '流畅输入'.repeat(40)`))
  await cdp.evaluate(`window.__yanStore.setState(s => ({
    models: s.models.map(m => ({ ...m, name: 'Fluidity Model Updated' })),
    session: { ...s.session, thinkingLevelsStatus: 'known', availableThinkingLevels: ['off', 'low', 'medium', 'high'], thinkingLevel: 'medium' }
  }))`)
  await waitFor(`document.querySelector('[data-chat-provider-model-picker]')?.textContent.includes('Fluidity Model Updated')`, 10000)
  check('模型信息变化时控件仍即时更新', true)
  await waitFor(`document.querySelector('[data-composer-effort-trigger]')?.getAttribute('aria-disabled') !== 'true'`, 10000)
  check('思考档变化时控件仍即时更新', await cdp.evaluate(`document.querySelector('[data-composer-effort-trigger]')?.textContent.trim().length > 0`))
  await cdp.evaluate(`document.querySelector('[data-chat-provider-model-picker]').click()`)
  await waitFor(`!!document.querySelector('[data-chat-composer-floating-layer] input')`, 10000)
  await sleep(200)
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(350)
  check('模型菜单关闭后焦点回到输入框', await cdp.evaluate(`document.activeElement?.classList.contains('ProseMirror')`))
  await cdp.evaluate(`window.__yanStore.setState(s => ({ stats: {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 8000 }, cost: 0, toolCalls: 0, userMessages: 60, assistantMessages: 60,
    contextUsage: { tokens: 8000, contextWindow: 400000, percent: 2 }
  } }))`)
  await waitFor(`!!document.querySelector('[data-testid="composer-context-meter"]')`, 10000)
  check('上下文统计更新后仪表仍显示正确比例', await cdp.evaluate(`document.querySelector('[data-testid="composer-context-meter"]').getAttribute('aria-label').includes('2%')`))
  await cdp.evaluate(`document.querySelector('[data-composer-effort-trigger]').click()`)
  await waitFor(`!!document.querySelector('[data-composer-effort-slider]')`, 10000)
  check('思考档菜单显示当前档位', await cdp.evaluate(`document.querySelector('[data-composer-effort-slider]').getAttribute('aria-valuenow') === '2'`))
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(350)
  await shot('ui-fluidity')
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 760, height: 850, deviceScaleFactor: 1, mobile: false })
  await cdp.evaluate(`window.__yanStore.setState(s => ({ settings: { ...s.settings, theme: 'light' } }))`)
  await sleep(600)
  const layout = await cdp.evaluate(`(() => {
    const footer = document.querySelector('[data-chat-composer-footer]').getBoundingClientRect();
    const buttons = [...document.querySelectorAll('[data-chat-composer-footer] button')].filter(el => el.offsetWidth && el.getBoundingClientRect().width && getComputedStyle(el).visibility !== 'hidden');
    return { width: innerWidth, footer: { left: footer.left, right: footer.right }, fits: buttons.every(el => { const r = el.getBoundingClientRect(); return r.left >= footer.left - 1 && r.right <= footer.right + 1 }) };
  })()`)
  check('浅色窄屏输入框控件没有超出边界', layout.fits && layout.footer.left >= 0 && layout.footer.right <= layout.width, layout)
  await shot('ui-fluidity-light-narrow')
}
