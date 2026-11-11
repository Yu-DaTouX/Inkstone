import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const meta = { description: '思考翻译：切换服务、目标语言、模型和自动语言；隔离缓存夹具，不调用翻译服务或模型' }

export default async function run({ cdp, box, fake, newSession, waitFor, sleep, check, shot, report }) {
  const text = 'Inspect the input and preserve `fixture.ts` before continuing.'
  const cases = [
    { service: 'bing', target: 'ja', model: '', result: 'Bing 日本語 · 入力を確認する。' },
    { service: 'bing', target: 'zh-Hans', model: '', result: 'Bing 中文 · 检查输入。' },
    { service: 'google', target: 'zh-Hans', model: '', result: 'Google 中文 · 检查输入。' },
    { service: 'model', target: 'zh-Hans', model: 'fake/fake-model', result: '模型一 · 检查输入。' },
    { service: 'model', target: 'zh-Hans', model: 'fake/fake-reasoning', result: '模型二 · 检查输入。' },
    { service: 'bing', target: 'en', model: '', result: 'Bing English · Inspect the input.' }
  ]
  const cache = Object.fromEntries(cases.map(({ service, target, model, result }) => [createHash('sha256').update(`${service}\n${model}\n${target}\n${text}`).digest('hex'), result]))
  await writeFile(join(box.dataDir, 'translation-cache.json'), JSON.stringify(cache))
  await newSession()
  const ev = (script) => cdp.evaluate(script)
  const patch = (settings) => ev(`window.__yanStore.getState().patchSettings(${JSON.stringify(settings)})`)
  await patch({ theme: 'dark', lang: 'zh-CN', rightPanelOpen: false, promptSuggestions: false, reduceMotion: true })
  const messages = [
    { id: 'translation-user', role: 'user', text: '思考翻译设置回归' },
    { id: 'translation-assistant', role: 'assistant', thinking: text, text: '翻译测试只读取隔离缓存，不发送到外部服务。', timestamp: Date.now() }
  ]
  await ev(`(() => { const s=window.__yanStore.getState(); window.__yanStore.setState({messages:${JSON.stringify(messages)},session:{...s.session,isAgentRunning:false,isStreaming:false},historyLoading:false,switchLoading:false}) })()`)
  await waitFor(`!!document.querySelector('[data-testid="v3-process-toggle"]')`)
  await ev(`document.querySelector('[data-testid="v3-process-toggle"]').click()`)
  await waitFor(`!!document.querySelector('[data-testid="v3-thinking-toggle"]')`)
  await ev(`(() => { const button=document.querySelector('[data-testid="v3-thinking-toggle"]'); if (button.getAttribute('aria-expanded')!=='true') button.click() })()`)
  await waitFor(`!!document.querySelector('[data-testid="v3-thinking-body"]')`)
  const body = () => ev(`document.querySelector('[data-testid="v3-thinking-body"]')?.textContent`)
  const clickTranslate = async (result) => {
    await ev(`document.querySelector('[data-testid="v3-thinking-translate"]').click()`)
    await waitFor(`document.querySelector('[data-testid="v3-thinking-body"]')?.textContent===${JSON.stringify(result)}`)
  }
  const before = fake.requests.length
  for (const entry of cases) {
    await patch({ translateService: entry.service, translateTarget: entry.target, translateModel: entry.model })
    await sleep(100)
    check(`${entry.service}/${entry.target}/${entry.model}: 设置变化立即回到原文`, await body() === text)
    await clickTranslate(entry.result)
    check(`${entry.service}/${entry.target}/${entry.model}: 只显示匹配的缓存译文`, await body() === entry.result)
  }
  await patch({ translateService: 'bing', translateTarget: 'auto', translateModel: '', lang: 'zh-CN' })
  await clickTranslate(cases[1].result)
  check('自动目标使用中文界面语言', await body() === cases[1].result)
  await shot('translation-dark-zh')
  await patch({ lang: 'en-US', theme: 'light' })
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 720, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(200)
  check('自动目标随界面语言改变并清除旧显示', await body() === text)
  await clickTranslate(cases[5].result)
  check('自动目标切到英文', await body() === cases[5].result)
  await ev(`document.querySelector('[data-testid="v3-thinking-translate"]').focus()`)
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await sleep(100)
  check('键盘可切回原文', await body() === text)
  await clickTranslate(cases[5].result)
  check('浅色窄窗不横向溢出', await ev(`document.documentElement.scrollWidth<=innerWidth+1 && document.querySelector('.v3-stream').scrollWidth<=document.querySelector('.v3-stream').clientWidth+1`))
  await shot('translation-light-en-narrow')
  check('没有触发模型请求', fake.requests.length === before)
  report.translation = { source: 'isolated pre-seeded cache', cases: cases.length, modelRequests: fake.requests.length - before }
}
