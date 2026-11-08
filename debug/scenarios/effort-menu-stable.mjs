export const meta = { description: '切换思考档位时模型按钮与档位菜单的位置不随档位文字长短变化（假推理模型，逐档量位置，菜单关/开两种状态）' }

export default async function run({ cdp, check, waitFor, sleep, shot }) {
  const ev = (expr) => cdp.evaluate(expr)
  await waitFor('s.conn === "ready"')
  await ev('window.__yanStore.getState().patchSettings({ theme: "dark", lang: "zh-CN" })')
  await ev('window.__yanStore.getState().setModel("fake", "fake-reasoning")')
  await waitFor('s.session.availableThinkingLevels.length > 1')
  const levels = await ev('window.__yanStore.getState().session.availableThinkingLevels')
  const picker = '[data-chat-provider-model-picker]'
  const trigger = '[data-composer-effort-trigger="true"]'
  const panel = '[data-composer-effort-panel="true"]'
  const rect = (selector) => ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x * 10) / 10, w: Math.round(r.width * 10) / 10 } })()`)
  const setLevel = async (level) => {
    await ev(`window.__yanStore.getState().setThinking(${JSON.stringify(level)})`)
    await waitFor(`s.session.thinkingLevel === ${JSON.stringify(level)}`)
    await sleep(500)
  }
  const closed = []
  for (const level of levels) {
    await setLevel(level)
    closed.push({ level, picker: await rect(picker), trigger: await rect(trigger) })
  }
  const pickerXs = new Set(closed.map((item) => item.picker?.x))
  const triggerWs = new Set(closed.map((item) => item.trigger?.w))
  console.log('CLOSED', JSON.stringify(closed))
  check('菜单关闭时各档位下模型按钮位置相同', pickerXs.size === 1, [...pickerXs].join(','))
  check('菜单关闭时档位按钮宽度相同', triggerWs.size === 1, [...triggerWs].join(','))
  await setLevel(levels[0])
  await ev(`document.querySelector(${JSON.stringify(trigger)}).click()`)
  await waitFor(`!!document.querySelector(${JSON.stringify(panel)})`)
  await sleep(300)
  const opened = []
  for (const level of levels) {
    await ev(`window.__yanStore.getState().setThinking(${JSON.stringify(level)})`)
    await waitFor(`s.session.thinkingLevel === ${JSON.stringify(level)}`)
    await sleep(400)
    opened.push({ level, picker: await rect(picker), panel: await rect(panel) })
  }
  console.log('OPEN', JSON.stringify(opened))
  await shot('effort-menu-stable-open')
  check('菜单打开时各档位下模型按钮位置相同', new Set(opened.map((item) => item.picker?.x)).size === 1)
  check('菜单打开时档位菜单位置相同', new Set(opened.map((item) => item.panel?.x)).size === 1, opened.map((item) => item.panel?.x).join(','))
}
