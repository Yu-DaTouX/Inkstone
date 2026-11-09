export const meta = { description: '切换思考档位时输入框右侧控件整组靠右：档位按钮右缘与后面控件的间距不随档位文字长短变化，也不留白（假推理模型，逐档量位置）' }

export default async function run({ cdp, check, waitFor, sleep, shot }) {
  const ev = (expr) => cdp.evaluate(expr)
  await waitFor('s.conn === "ready"')
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  await ev('window.__yanStore.getState().patchSettings({ theme: "dark", lang: "zh-CN" })')
  await ev('window.__yanStore.getState().setModel("fake", "fake-reasoning")')
  await waitFor('s.session.availableThinkingLevels.length > 1')
  const levels = await ev('window.__yanStore.getState().session.availableThinkingLevels')
  const trigger = '[data-composer-effort-trigger="true"]'
  const panel = '[data-composer-effort-panel="true"]'
  const rect = (selector) => ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x * 10) / 10, r: Math.round(r.right * 10) / 10, w: Math.round(r.width * 10) / 10 } })()`)
  const nextControlLeft = () => ev(`(() => { const t = document.querySelector(${JSON.stringify(trigger)}); const block = t.closest('[data-resting-block]'); let n = block?.nextElementSibling; while (n && (n.getBoundingClientRect().width === 0 || n.classList.contains('t3-controls-bar__block--hidden'))) n = n.nextElementSibling; return n ? Math.round(n.getBoundingClientRect().left * 10) / 10 : null })()`)
  const setLevel = async (level) => {
    await ev(`window.__yanStore.getState().setThinking(${JSON.stringify(level)})`)
    await waitFor(`s.session.thinkingLevel === ${JSON.stringify(level)}`)
    await sleep(500)
  }
  for (const mode of ['danger', 'all']) {
    await ev(`window.__yanStore.getState().patchSettings({ permissionMode: ${JSON.stringify(mode)} })`)
    await sleep(500)
    const rows = []
    for (const level of levels) {
      await setLevel(level)
      const t = await rect(trigger)
      const next = await nextControlLeft()
      rows.push({ level, trigger: t, gap: next === null || !t ? null : Math.round((next - t.r) * 10) / 10 })
    }
    console.log('ROWS', mode, JSON.stringify(rows))
    check(`${mode}：各档位下档位按钮右缘位置相同（整组靠右）`, new Set(rows.map((row) => row.trigger?.r)).size === 1, rows.map((row) => row.trigger?.r).join(','))
    const gaps = rows.map((row) => row.gap).filter((gap) => gap !== null)
    check(`${mode}：有后续控件时间距相同且不超过 24px（不留白）`, gaps.length === 0 || (new Set(gaps).size === 1 && gaps[0] <= 24), gaps.join(','))
    check(`${mode}：档位按钮宽度随文字变化`, new Set(rows.map((row) => row.trigger?.w)).size > 1, rows.map((row) => row.trigger?.w).join(','))
  }
  await ev('window.__yanStore.getState().patchSettings({ permissionMode: "danger" })')
  await setLevel(levels[0])
  await shot('effort-closed')
  await ev(`document.querySelector(${JSON.stringify(trigger)}).click()`)
  await waitFor(`!!document.querySelector(${JSON.stringify(panel)})`)
  await sleep(300)
  const opened = []
  for (const level of levels) {
    await ev(`window.__yanStore.getState().setThinking(${JSON.stringify(level)})`)
    await waitFor(`s.session.thinkingLevel === ${JSON.stringify(level)}`)
    await sleep(400)
    opened.push({ level, trigger: await rect(trigger), panel: await rect(panel) })
  }
  console.log('OPEN', JSON.stringify(opened))
  await shot('effort-menu-open')
  check('菜单打开时档位菜单始终存在且不超出窗口', opened.every((item) => item.panel && item.panel.x >= 0 && item.panel.r <= 1400))
}
