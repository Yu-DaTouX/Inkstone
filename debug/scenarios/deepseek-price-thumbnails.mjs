import { mkdirSync } from 'node:fs'
import { evidenceDir } from '../lib/env.mjs'
import toolImagePreviews from './tool-image-previews.mjs'

export const meta = { description: 'DeepSeek 用量位峰谷价、UTC 边界和节假日、模型切换，以及无滚动滑块的工具缩略图；模拟时钟，不调用真实模型' }

export default async function run(ctx) {
  const { cdp, newSession, check, waitFor, sleep } = ctx
  const output = evidenceDir('2026-11-11-deepseek-price-thumbnails')
  mkdirSync(output, { recursive: true })
  const prefix = String(Date.now())
  const ev = (code) => cdp.evaluate(code)
  const shot = (name) => cdp.shot(`${prefix}-${name}`, output)
  await newSession()
  await ev(`window.__yanStore.getState().patchSettings({theme:'light',lang:'zh-CN',workspaceTiles:true,promptSuggestions:false,reduceMotion:true})`)
  await ev(`(() => {
    window.__deepseekRealNow = Date.now
    window.__deepseekPriceNow = Date.parse('2026-11-11T01:00:00Z')
    Date.now = () => window.__deepseekPriceNow
    const state = window.__yanStore.getState()
    window.__yanStore.setState({ authProviders: [], messages: [
      {id:'price-user',role:'user',text:'查看 DeepSeek 峰谷价和用量。',timestamp:Date.now()-1000},
      {id:'price-answer',role:'assistant',text:'这是隔离验收数据，不发起真实模型请求。',timestamp:Date.now()}
    ], session: {...state.session,isAgentRunning:false,isStreaming:false},historyLoading:false,switchLoading:false })
  })()`)
  const setCase = async (time, id = 'deepseek/deepseek-v4.1-flash', provider = 'commandcode') => {
    await ev(`(() => {
      const at = Date.parse(${JSON.stringify(time)})
      window.__deepseekPriceNow = at
      window.__yanLiveQuota.setState({ entries: { commandcode: { fetchedAt: at, loading: false, snapshot: {provider:'commandcode',supported:true,checkedAt:at,windows:[{id:'weekly',label:'本周',used:56,total:100,durationMs:604800000,resetAt:at+86400000}]} } } })
      const s = window.__yanStore.getState()
      window.__yanStore.setState({session:{...s.session,model:{id:${JSON.stringify(id)},name:${JSON.stringify(id)},provider:${JSON.stringify(provider)},reasoning:true,contextWindow:1000000}}})
      window.dispatchEvent(new Event('focus'))
    })()`)
    await sleep(200)
  }
  const title = () => ev(`document.querySelector('[data-testid="wb-rail-usage"] .wb-tile-title')?.textContent ?? ''`)
  try {
    await setCase('2026-11-11T01:00:00Z')
    await waitFor(`document.querySelector('[data-testid="wb-rail-usage"] .wb-tile-title')?.textContent === '用量 峰价'`)
    check('DeepSeek 放在其他供应商下也只显示简短峰价', (await title()) === '用量 峰价')
    check('峰价提示不替换原用量数字', await ev(`document.querySelector('[data-testid="wb-rail-usage"] .wb-tile-summary')?.textContent.includes('56%')`))
    for (const theme of ['light', 'dark']) {
      await ev(`window.__yanStore.getState().patchSettings({theme:'${theme}'})`)
      await sleep(200)
      await shot(`deepseek-peak-${theme}`)
    }
    for (const [time, expected] of [
      ['2026-11-11T04:00:00Z', '谷价'],
      ['2026-11-11T06:00:00Z', '峰价'],
      ['2026-11-11T10:00:00Z', '谷价'],
      ['2026-02-23T02:00:00Z', '谷价'],
      ['2026-02-28T02:00:00Z', '谷价'],
      ['2027-06-09T02:00:00Z', '谷价']
    ]) {
      await setCase(time)
      check(`${time} → ${expected === '峰价' ? '显示峰价' : '不显示价格提示'}`, (await title()) === (expected === '峰价' ? '用量 峰价' : '用量'), await title())
    }
    await shot('deepseek-holiday-off-peak')
    await setCase('2026-11-11T02:00:00Z', 'deepseek-flash', 'deepseek')
    check('没有额度卡时仍能显示峰价', (await title()) === '用量 峰价')
    await setCase('2026-11-11T02:00:00Z', 'deepseek-ai/DeepSeek-V4', 'openai')
    check('OpenAI 兼容接入仍按当前模型识别 DeepSeek', (await title()) === '用量 峰价')
    await setCase('2026-11-11T02:00:00Z', 'gpt-6', 'commandcode')
    check('同供应商换到非 DeepSeek 后提示立即消失', (await title()) === '用量')
    await setCase('2026-11-11T02:00:00Z')
    check('切回 DeepSeek 不用重开会话就恢复提示', (await title()) === '用量 峰价')
    await ev(`document.querySelector('[data-testid="wb-rail-usage"] .wb-tile-toggle').click()`)
    await sleep(150)
    check('展开用量后仍只显示简短峰价', (await title()) === '用量 峰价')
    await ev(`document.querySelector('[data-testid="wb-rail-usage"] .wb-tile-toggle').click()`)
    await setCase('2028-01-03T02:00:00Z')
    check('未知时段也不额外占用标题空间', (await title()) === '用量')
    await setCase('2026-11-11T02:00:00Z')
    await ev(`window.__yanStore.getState().patchSettings({lang:'en-US'})`)
    await sleep(200)
    check('英文也使用简短峰价提示', (await title()).endsWith(' Peak'))
    await shot('deepseek-peak-en')
    await ev(`window.__yanStore.getState().patchSettings({lang:'zh-CN'})`)
    await ev(`document.querySelector('.v3-chat').style.setProperty('--size-tiles','260px')`)
    await sleep(300)
    const header = await ev(`(() => {const el=document.querySelector('[data-testid="wb-rail-usage"] .wb-tile-head'),r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    await cdp.call('Input.dispatchMouseEvent', {type:'mouseMoved',...header})
    await sleep(200)
    const narrow = await ev(`(() => {const root=document.querySelector('[data-testid="wb-rail-usage"]'),title=root.querySelector('.wb-tile-title'),value=root.querySelector('.ui-rail-value__num');return {width:document.querySelector('.v3-sessionbar').getBoundingClientRect().width,title:title.textContent,titleFits:title.scrollWidth<=title.clientWidth+1,value:value.textContent,valueFits:value.scrollWidth<=value.clientWidth+1}})()`)
    check('最窄260px用量栏在悬停时也完整显示峰价与用量', Math.abs(narrow.width-260)<1&&narrow.title==='用量 峰价'&&narrow.titleFits&&narrow.value.includes('56%')&&narrow.valueFits, narrow)
    await shot('deepseek-peak-narrow')
  } finally {
    await ev(`Date.now = window.__deepseekRealNow; delete window.__deepseekRealNow; delete window.__deepseekPriceNow`)
  }
  await toolImagePreviews({ ...ctx, shot })
}
