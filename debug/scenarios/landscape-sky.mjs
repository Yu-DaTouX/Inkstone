import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { evidenceDir } from '../lib/env.mjs'

export const meta = { description: '新会话山水日月：本地时钟位置、真实日期月相、跨午夜、唤醒、减少动态、主题与窄窗；仅隔离数据' }

export default async function run({ cdp, newSession, box, runDir, fake, check, waitFor, sleep }) {
  assert.ok(resolve(box.sessionsDir).startsWith(resolve(runDir)))
  const output = evidenceDir('2026-11-11-landscape-sky')
  mkdirSync(output, { recursive: true })
  const prefix = String(Date.now())
  const rows = [{ type: 'session', version: 3, id: 'sky-usage-fixture', timestamp: new Date().toISOString(), cwd: box.project }]
  for (let i = 0; i < 42; i++) {
    const day = new Date()
    day.setDate(day.getDate() - 41 + i)
    rows.push({ type: 'usage', timestamp: day.toISOString(), provider: 'fixture', model: 'sky', usage: { totalTokens: ((i * 7) % 13 + 1) * 500_000 } })
  }
  writeFileSync(join(box.sessionsDir, 'sky-usage-fixture.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const ev = (code) => cdp.evaluate(code)
  const shot = (name) => cdp.shot(`${prefix}-${name}`, output)
  const mode = async (value) => {
    await ev(`localStorage.setItem('yan:home-background',JSON.stringify({mode:${JSON.stringify(value)}}));window.dispatchEvent(new StorageEvent('storage',{key:'yan:home-background'}))`)
  }
  await ev('window.__skyReloadPending = true')
  await cdp.call('Page.reload')
  await waitFor('!window.__skyReloadPending && s.conn === "ready"')
  await cdp.call('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' })
  await ev(`(() => {
    const p=CanvasRenderingContext2D.prototype
    const f=window.__skyFixture={now:Date.parse('2026-11-11T01:00:00Z'),realNow:Date.now,arc:p.arc,ellipse:p.ellipse,fill:p.fill,setInterval:window.setInterval,clearInterval:window.clearInterval,timers:[],draws:0,last:null}
    Date.now=()=>f.now
    const isSky=ctx=>ctx.canvas===document.querySelector('[data-testid="v3-ascii-field"] canvas')
    p.arc=function(...args){if(isSky(this))f.last={arc:args,ellipse:null};return f.arc.apply(this,args)}
    p.ellipse=function(...args){if(isSky(this)&&f.last)f.last.ellipse=args;return f.ellipse.apply(this,args)}
    p.fill=function(...args){const result=f.fill.apply(this,args);if(isSky(this)&&f.last){f.draws++;const [x,y,r]=f.last.arc;f.last.leftLit=this.isPointInPath(x-r*0.9,y);f.last.rightLit=this.isPointInPath(x+r*0.9,y)}return result}
    window.setInterval=function(fn,ms,...args){const id=f.setInterval.call(window,fn,ms,...args);if(ms===60000)f.timers.push({id,fn,active:true});return id}
    window.clearInterval=function(id){for(const timer of f.timers)if(timer.id===id)timer.active=false;return f.clearInterval.call(window,id)}
    window.__yanStore.getState().patchSettings({theme:'dark',lang:'zh-CN',asciiBackground:true,reduceMotion:true,promptSuggestions:false,workspaceTiles:false})
  })()`)
  try {
    await mode('none')
    await waitFor(`!document.querySelector('[data-testid="v3-ascii-field"]')`)
    await newSession()
    await mode('ascii')
    await waitFor(`document.querySelector('[data-testid="v3-ascii-field"] canvas')?.width>200 && window.__skyFixture.draws>0`)
    await sleep(500)
    const snapshot = () => ev(`(() => {const f=window.__skyFixture,c=document.querySelector('[data-testid="v3-ascii-field"] canvas');return {...f.last,draws:f.draws,width:c?.width,height:c?.height,timers:f.timers.filter(t=>t.active).length,kind:f.last?.arc[4]-f.last?.arc[3]>6?'sun':'moon'}})()`)
    const time = async (value, trigger = 'focus') => {
      await ev(`window.__skyFixture.now=Date.parse(${JSON.stringify(value)});${trigger === 'timer' ? 'window.__skyFixture.timers.filter(t=>t.active).forEach(t=>t.fn())' : "window.dispatchEvent(new Event('focus'))"}`)
      await sleep(100)
      return snapshot()
    }
    const morning = await time('2026-11-11T01:00:00Z')
    const noon = await time('2026-11-11T04:00:00Z')
    const afternoon = await time('2026-11-11T07:00:00Z')
    check('本地早、午、晚均显示太阳，减少动态不影响时钟更新', [morning,noon,afternoon].every(s=>s.kind==='sun'&&!s.ellipse))
    check('太阳位置随时间向右移动，正午最高，不跟山峰固定', morning.arc[0]<noon.arc[0]&&noon.arc[0]<afternoon.arc[0]&&noon.arc[1]<morning.arc[1]&&noon.arc[1]<afternoon.arc[1], {morning:morning.arc.slice(0,2),noon:noon.arc.slice(0,2),afternoon:afternoon.arc.slice(0,2)})
    check('正午位于轨迹中央', Math.abs(noon.arc[0]-noon.width*0.5)<1)
    await shot('sun-afternoon-dark')
    await time('2026-11-11T04:00:00Z')
    await shot('sun-noon-dark')
    await ev(`window.__yanStore.getState().patchSettings({theme:'light'})`)
    await sleep(200)
    check('浅色主题不会把白天太阳换成月亮', (await snapshot()).kind==='sun')
    await shot('sun-noon-light')
    const dusk = await time('2026-11-11T09:59:59Z')
    const night = await time('2026-11-11T10:00:00Z')
    const dawn = await time('2026-11-11T22:00:00Z')
    check('本地18点切月亮，次日6点切太阳', dusk.kind==='sun'&&night.kind==='moon'&&dawn.kind==='sun')
    const beforeMidnight = await time('2026-11-11T15:59:59Z')
    const midnight = await time('2026-11-11T16:00:00Z')
    check('月亮跨午夜连续移动，不回到起点', beforeMidnight.kind==='moon'&&midnight.kind==='moon'&&Math.abs(beforeMidnight.arc[0]-midnight.arc[0])<0.1)
    const evening = await time('2026-11-11T13:00:00Z')
    const late = await time('2026-11-11T19:00:00Z')
    check('月亮晚间、午夜、凌晨位置随时间前进且午夜最高', evening.arc[0]<midnight.arc[0]&&midnight.arc[0]<late.arc[0]&&midnight.arc[1]<evening.arc[1]&&midnight.arc[1]<late.arc[1])

    for (const theme of ['light','dark']) {
      await ev(`window.__yanStore.getState().patchSettings({theme:${JSON.stringify(theme)}})`)
      for (const [label, date, side] of [
        ['new','2026-11-09T15:00:00Z','none'],
        ['crescent','2026-11-13T15:00:00Z','right'],
        ['first-quarter','2026-11-17T15:00:00Z','right'],
        ['full','2026-11-24T15:00:00Z','both'],
        ['last-quarter','2026-12-01T15:00:00Z','left']
      ]) {
        const s = await time(date)
        const lit = side==='none' ? !s.leftLit&&!s.rightLit : side==='both' ? s.leftLit&&s.rightLit : side==='right' ? !s.leftLit&&s.rightLit : s.leftLit&&!s.rightLit
        check(`${theme}/${label} 夜间月相的实际绘制路径亮面正确`, s.kind==='moon'&&!!s.ellipse&&lit, {left:s.leftLit,right:s.rightLit,terminator:s.ellipse?.[2]/s.arc[2]})
        await shot(`moon-${label}-${theme}`)
      }
    }
    await time('2026-11-17T15:00:00Z')
    await cdp.call('Emulation.setDeviceMetricsOverride', {width:900,height:800,deviceScaleFactor:1,mobile:false})
    await sleep(250)
    const narrow = await snapshot()
    check('窄窗日月仍在背景边界内，不产生横向溢出', narrow.arc[0]-narrow.arc[2]>0&&narrow.arc[0]+narrow.arc[2]<narrow.width&&await ev('document.documentElement.scrollWidth<=innerWidth+1'))
    await shot('moon-narrow-dark')
    await cdp.call('Emulation.clearDeviceMetricsOverride')

    await time('2026-11-11T01:00:00Z')
    const tick = await time('2026-11-11T04:00:00Z','timer')
    check('分钟定时刷新会更新位置，无需重开标签或切焦点', tick.kind==='sun'&&Math.abs(tick.arc[0]-tick.width*0.5)<1)
    await ev(`Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'))`)
    const hidden = await snapshot()
    await time('2026-11-17T15:00:00Z','timer')
    check('隐藏页面的时钟更新不额外绘制背景', (await snapshot()).draws===hidden.draws)
    await ev(`delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'))`)
    check('恢复可见后立即读取当前时间和月相', (await snapshot()).kind==='moon')
    await time('2026-11-11T02:00:00Z')
    check('同一时刻在上海是白天', (await snapshot()).kind==='sun')
    await cdp.call('Emulation.setTimezoneOverride', {timezoneId:'UTC'})
    await ev(`window.dispatchEvent(new Event('focus'))`)
    check('电脑时区改变后按新的本地时刻显示月亮', (await snapshot()).kind==='moon')
    await cdp.call('Emulation.setTimezoneOverride', {timezoneId:'Asia/Shanghai'})
    await ev(`window.__yanStore.getState().patchSettings({reduceMotion:false})`)
    await time('2026-11-11T04:00:00Z')
    await sleep(1200)
    check('恢复动态时背景仍正常绘制太阳', (await snapshot()).kind==='sun')
    const baselineTimers = (await snapshot()).timers
    await mode('none')
    await waitFor(`!document.querySelector('[data-testid="v3-ascii-field"]')`)
    check('关闭背景时释放自己的分钟时钟', (await snapshot()).timers===baselineTimers-1)
    await mode('ascii')
    await waitFor(`!!document.querySelector('[data-testid="v3-ascii-field"]')`)
    await sleep(250)
    check('重新打开背景不累积分钟时钟', (await snapshot()).timers===baselineTimers)
    check('未向真实或假模型发起请求', fake.requests.length===0)
  } finally {
    await ev(`(() => {const f=window.__skyFixture;if(!f)return;Date.now=f.realNow;CanvasRenderingContext2D.prototype.arc=f.arc;CanvasRenderingContext2D.prototype.ellipse=f.ellipse;CanvasRenderingContext2D.prototype.fill=f.fill;window.setInterval=f.setInterval;window.clearInterval=f.clearInterval;delete document.visibilityState;delete window.__skyFixture})()`)
    await cdp.call('Emulation.setTimezoneOverride', {timezoneId:''})
    await cdp.call('Emulation.clearDeviceMetricsOverride')
  }
}
