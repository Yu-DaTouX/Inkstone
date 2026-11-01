import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { description: '流动思考滑块与运行中模型切换：实际 pi、假模型、翻页、待切换提示、下一轮请求' }

export default async function run({ cdp, fake, box, check, waitFor, sleep, shot }) {
  const requests = []
  const capture = (req) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => { try { requests.push(JSON.parse(body)) } catch {} })
  }
  fake.server.prependListener('request', capture)
  const configFile = join(box.piDir, 'models.json')
  const config = JSON.parse(readFileSync(configFile, 'utf8'))
  config.providers.fake.models[0].reasoning = true
  config.providers.fake.models.push({ ...config.providers.fake.models[0], id: 'fake-next', name: 'Fake Next' })
  writeFileSync(configFile, JSON.stringify(config))
  const reloaded = await cdp.evaluate('window.yan.nativeSession({ action: "reload", expectedSessionId: window.__yanStore.getState().session.sessionId })')
  if (!reloaded.ok) throw new Error(reloaded.error)
  await cdp.evaluate('window.__yanStore.getState().reloadModels()')
  await cdp.evaluate('window.__yanStore.getState().setModel("fake", "fake-next")')
  await cdp.evaluate('window.__yanStore.getState().setModel("fake", "fake-model")')
  await waitFor('s.session.availableThinkingLevels.length > 1')
  const levels = await cdp.evaluate('window.__yanStore.getState().session.availableThinkingLevels')
  const middle = Math.min(levels.length - 2, Math.max(1, Math.floor(levels.length / 2)))
  const setLevel = async (level) => {
    await cdp.evaluate(`window.__yanStore.getState().setThinking(${JSON.stringify(level)})`)
    await waitFor(`s.session.thinkingLevel === ${JSON.stringify(level)}`)
  }
  const trigger = '[data-composer-effort-trigger="true"]'
  const panel = '[data-composer-effort-panel="true"]'
  const input = `${panel} input[type="range"]`
  const rect = (selector) => cdp.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  const mouse = (type, x, y, extra = {}) => cdp.call('Input.dispatchMouseEvent', { type, x, y, ...extra })
  const key = async (key) => {
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key })
    await sleep(220)
  }
  const wheel = async (selector, deltaY) => {
    const r = await rect(selector)
    await mouse('mouseMoved', r.x + r.width / 2, r.y + r.height / 2)
    await mouse('mouseWheel', r.x + r.width / 2, r.y + r.height / 2, { deltaX: 0, deltaY })
    await sleep(220)
  }
  const open = async () => {
    if (!await cdp.evaluate(`!!document.querySelector(${JSON.stringify(panel)})`)) await cdp.evaluate(`document.querySelector(${JSON.stringify(trigger)}).click()`)
    await waitFor(`!!document.querySelector(${JSON.stringify(input)})`)
    await sleep(250)
  }
  await cdp.evaluate('window.__yanStore.getState().patchSettings({ theme: "dark", lang: "zh-CN" })')
  await setLevel(levels[middle])
  await wheel(trigger, -100)
  check('悬浮滚轮通过真实 IPC 调高一档', await cdp.evaluate(`window.__yanStore.getState().session.thinkingLevel === ${JSON.stringify(levels[middle + 1])}`))
  await sleep(600)
  await open()
  check('显示当前档位、每档刻度与说明', await cdp.evaluate(`!!document.querySelector('.ui-fluid-effort__value') && document.querySelectorAll('.ui-fluid-effort__stop').length === ${levels.length} && !!document.querySelector('[data-testid="effort-description"]')`))
  const stop = await rect('.ui-fluid-effort__stop[data-level="' + levels[0] + '"]')
  await mouse('mouseMoved', stop.x + stop.width / 2, stop.y + stop.height / 2)
  await sleep(200)
  check('悬停刻度预览档位名称', await cdp.evaluate(`document.querySelector('.ui-fluid-effort__value').textContent.includes(${JSON.stringify(levels[0] === 'off' ? 'Off' : '')})`))
  await mouse('mouseMoved', 5, 5)
  check('点阵轨道保留五行高度', (await rect('[data-composer-effort-slider="true"]')).height >= 26)
  const animation = await cdp.evaluate(`(async () => { const input = document.querySelector(${JSON.stringify(input)}); input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', bubbles: true })); for (let i = 0; i < 60; i++) { await new Promise(resolve => setTimeout(resolve, 16)); const count = document.querySelector('.ui-fluid-effort__value')?.getAnimations({ subtree: true }).length ?? 0; if (count) return count } return 0 })()`)
  check('当前档位切换时有翻页动画', animation > 0)
  await sleep(300)
  await open()
  const track = await rect('[data-composer-effort-slider="true"]')
  const before = await cdp.evaluate('window.__yanStore.getState().session.thinkingLevel')
  await mouse('mouseMoved', track.x + track.width / 2, track.y + track.height / 2)
  await mouse('mousePressed', track.x + track.width / 2, track.y + track.height / 2, { button: 'left', clickCount: 1 })
  await mouse('mouseMoved', track.x + track.width, track.y + track.height / 2, { buttons: 1 })
  await sleep(120)
  check('拖动中只预览不提前提交', await cdp.evaluate(`window.__yanStore.getState().session.thinkingLevel === ${JSON.stringify(before)} && document.querySelector(${JSON.stringify(input)}).value === ${JSON.stringify(String(levels.length - 1))}`))
  await mouse('mouseReleased', track.x + track.width, track.y + track.height / 2, { button: 'left', clickCount: 1 })
  await waitFor(`s.session.thinkingLevel === ${JSON.stringify(levels.at(-1))}`)
  check('拖动松手经真实 IPC 保存档位', true)
  await wheel(panel, -100)
  check('弹层滚轮首尾循环', await cdp.evaluate(`window.__yanStore.getState().session.thinkingLevel === ${JSON.stringify(levels[0])}`))
  await cdp.evaluate(`document.querySelector(${JSON.stringify(input)}).focus()`)
  await key('Escape')
  check('Escape 关闭并恢复触发器焦点', await cdp.evaluate(`!document.querySelector(${JSON.stringify(panel)}) && document.activeElement.matches(${JSON.stringify(trigger)})`))

  await setLevel('low')
  const send = cdp.evaluate('window.__yanStore.getState().send("FLOW SHORT switch-model-runtime")')
  await waitFor('s.session.isAgentRunning && s.messages.some(message => message.role === "assistant" && message.thinkingLive)')
  await wheel(trigger, -100)
  await waitFor('s.session.thinkingLevel === "medium"')
  check('运行中滚轮允许切换思考档位并出现提示', await cdp.evaluate('!!window.__yanStore.getState().session.pendingModelChange && !!document.querySelector("[data-testid=pending-model-change]")'))
  await cdp.evaluate('window.__yanStore.getState().setModel("fake", "fake-next")')
  await waitFor('s.session.model.id === "fake-next"')
  check('运行中允许切换模型，提示保留原模型', await cdp.evaluate('window.__yanStore.getState().session.pendingModelChange?.previousModel?.id === "fake-model"'))
  await shot('runtime-model-pending-dark')
  await open()
  check('运行中的滑块面板仍可打开', await cdp.evaluate(`!!document.querySelector(${JSON.stringify(input)})`))
  await shot('effort-current-only-dark')
  await key('Escape')
  await send
  await waitFor('!s.session.isAgentRunning && !s.session.isStreaming', 45000)
  const flow = requests.filter((request) => request.tools?.length && JSON.stringify(request.input).includes('switch-model-runtime'))
  check('当前请求保持原模型与原档位', flow[0]?.model === 'fake-model' && flow[0]?.reasoning?.effort === 'low', { model: flow[0]?.model, reasoning: flow[0]?.reasoning })
  check('下一次请求使用新模型和新档位', flow.slice(1).some((request) => request.model === 'fake-next' && request.reasoning?.effort === 'medium'), flow.map(request => ({ model: request.model, reasoning: request.reasoning })))
  check('新一轮开始后待切换提示清除', await cdp.evaluate('!window.__yanStore.getState().session.pendingModelChange && !document.querySelector("[data-testid=pending-model-change]")'))

  await cdp.evaluate('window.__yanStore.getState().patchSettings({ theme: "light" })')
  await open()
  await shot('effort-current-only-light')
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 780, height: 820, deviceScaleFactor: 1, mobile: false })
  await sleep(250)
  await open()
  check('780px 窄屏弹层不越界', await cdp.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(panel)}).getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight })()`))
  await shot('effort-current-only-narrow')
  await cdp.call('Emulation.clearDeviceMetricsOverride')
  await cdp.evaluate('window.__yanStore.getState().patchSettings({ theme: "dark" })')
  await sleep(250)
  await open()
  fake.server.removeListener('request', capture)
}
