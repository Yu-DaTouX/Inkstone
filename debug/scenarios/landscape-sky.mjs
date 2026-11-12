import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { evidenceDir } from '../lib/env.mjs'

export const meta = { description: '新会话山水太阳：按电脑时区所在地的真实日出日落与位置、夜里不画日月、唤醒、减少动态、主题与窄窗；仅隔离数据' }

export default async function run({ cdp, newSession, box, runDir, fake, check, waitFor, sleep }) {
  assert.ok(resolve(box.sessionsDir).startsWith(resolve(runDir)))
  const output = evidenceDir('2026-11-12-landscape-composer')
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
    const f=window.__skyFixture={now:Date.parse('2026-11-11T01:00:00Z'),realNow:Date.now,arc:p.arc,ellipse:p.ellipse,fill:p.fill,clearRect:p.clearRect,drawImage:p.drawImage,layers:[],setInterval:window.setInterval,clearInterval:window.clearInterval,timers:[],draws:0,last:null}
    Date.now=()=>f.now
    const isSky=ctx=>ctx.canvas===document.querySelector('[data-testid="v3-ascii-field"] canvas')
    p.clearRect=function(...args){if(isSky(this)&&args[0]===0&&args[1]===0)f.layers=[];return f.clearRect.apply(this,args)}
    p.drawImage=function(...args){if(isSky(this)&&args.length===3)f.layers.push([args[1],args[2],args[0].width,args[0].height]);return f.drawImage.apply(this,args)}
    p.arc=function(...args){if(isSky(this))f.last={arc:args,ellipse:null};return f.arc.apply(this,args)}
    p.ellipse=function(...args){if(isSky(this)&&f.last)f.last.ellipse=args;return f.ellipse.apply(this,args)}
    p.fill=function(...args){const result=f.fill.apply(this,args);if(isSky(this)&&f.last){f.draws++;const [x,y,r,a0]=f.last.arc;const tilt=a0+Math.PI/2;f.last.tilt=tilt;f.last.toward=this.isPointInPath(x+r*0.9*Math.cos(tilt),y+r*0.9*Math.sin(tilt));f.last.away=this.isPointInPath(x-r*0.9*Math.cos(tilt),y-r*0.9*Math.sin(tilt))}return result}
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
      await ev(`window.__skyFixture.last=null;window.__skyFixture.now=Date.parse(${JSON.stringify(value)});${trigger === 'timer' ? 'window.__skyFixture.timers.filter(t=>t.active).forEach(t=>t.fn())' : "window.dispatchEvent(new Event('focus'))"}`)
      await sleep(100)
      return snapshot()
    }
    const background = () => ev(`(() => {const host=document.querySelector('[data-testid="v3-ascii-field"]'),canvas=host.querySelector('canvas'),rect=host.getBoundingClientRect(),editor=document.querySelector('.ProseMirror'),ground=document.querySelector('[data-landscape-floor]');return {layers:window.__skyFixture.layers,height:rect.height,editor:editor.getBoundingClientRect().height,ground:ground.getBoundingClientRect().top,disc:window.__skyFixture.last.arc.slice(0,3)}})()`)
    const sameBackground = (a,b) => a.layers.length===6&&JSON.stringify(a.layers)===JSON.stringify(b.layers)&&JSON.stringify(a.disc)===JSON.stringify(b.disc)&&a.height===b.height
    const settleBackground = async () => {
      await ev(`window.__yanStore.getState().patchSettings({reduceMotion:false});window.dispatchEvent(new Event('focus'))`)
      await sleep(2400)
      await ev(`window.__yanStore.getState().patchSettings({reduceMotion:true})`)
      await sleep(100)
    }
    const clearEditor = async () => {
      await ev(`document.querySelector('.ProseMirror').focus()`)
      await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65})
      await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65})
      await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8})
      await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8})
      await sleep(650)
    }
    for (const theme of ['dark','light']) {
      await ev(`window.__yanStore.getState().patchSettings({theme:${JSON.stringify(theme)}})`)
      await settleBackground()
      const short = await background()
      await shot(`composer-short-${theme}`)
      await ev(`document.querySelector('.ProseMirror').focus()`)
      await cdp.call('Input.insertText',{text:Array.from({length:18},(_,i)=>`第${i+1}行：输入框增高时背景不应移动`).join('\n')})
      await settleBackground()
      const tall = await background()
      check(`${theme} 多行输入确实增高输入框并抬起项目栏`,tall.editor>short.editor+80&&tall.ground<short.ground-80,{short:short.editor,tall:tall.editor,groundShift:tall.ground-short.ground})
      check(`${theme} 输入框增高不改变山水层位置尺寸和日月坐标`,sameBackground(short,tall),{short:short.disc,tall:tall.disc})
      await shot(`composer-tall-${theme}`)
      await clearEditor()
      await settleBackground()
      check(`${theme} 清空输入恢复高度且背景保持原位`,sameBackground(short,await background())&&Math.abs((await background()).editor-short.editor)<2)
      await ev(`window.__yanStore.getState().patchSettings({composerHeight:320})`)
      await settleBackground()
      check(`${theme} 手动加高输入框也不推动背景`,sameBackground(short,await background())&&(await background()).editor>short.editor+80)
      await mode('none')
      await waitFor(`!document.querySelector('[data-testid="v3-ascii-field"]')`)
      await mode('ascii')
      await settleBackground()
      check(`${theme} 高输入框下重开背景仍使用同一页面锚点`,sameBackground(short,await background()))
      await ev(`window.__yanStore.getState().patchSettings({composerHeight:undefined})`)
      await settleBackground()
    }
    await ev(`window.__yanStore.getState().patchSettings({theme:'dark'})`)
    const morning = await time('2026-11-11T01:00:00Z')
    const noon = await time('2026-11-11T04:00:00Z')
    const afternoon = await time('2026-11-11T07:00:00Z')
    check('本地早、午、晚均显示太阳，减少动态不影响时钟更新', [morning,noon,afternoon].every(s=>s.kind==='sun'&&!s.ellipse))
    check('太阳位置随时间向右移动，正午最高，不跟山峰固定', morning.arc[0]<noon.arc[0]&&noon.arc[0]<afternoon.arc[0]&&noon.arc[1]<morning.arc[1]&&noon.arc[1]<afternoon.arc[1], {morning:morning.arc.slice(0,2),noon:noon.arc.slice(0,2),afternoon:afternoon.arc.slice(0,2)})
    const solarNoon = await time('2026-11-11T03:38:00Z')
    check('当地太阳正午（上海约 11:38）位于轨迹中央', Math.abs(solarNoon.arc[0]-solarNoon.width*0.5)<solarNoon.width*0.03, solarNoon.arc.slice(0,2))
    await shot('sun-afternoon-dark')
    await time('2026-11-11T04:00:00Z')
    await shot('sun-noon-dark')
    await ev(`window.__yanStore.getState().patchSettings({theme:'light'})`)
    await sleep(200)
    check('浅色主题白天仍画太阳', (await snapshot()).kind==='sun')
    await shot('sun-noon-light')
    const dusk = await time('2026-11-11T08:30:00Z')
    const night = await time('2026-11-11T09:30:00Z')
    const predawn = await time('2026-11-11T21:30:00Z')
    const dawn = await time('2026-11-11T23:00:00Z')
    check('按上海真实日出日落：16:30 有太阳，17:30 日落后天上不画东西，次日 5:30 仍未日出，7:00 太阳已升', dusk.kind==='sun'&&!night.arc&&!predawn.arc&&dawn.kind==='sun', {dusk:dusk.kind,night:!!night.arc,predawn:!!predawn.arc,dawn:dawn.kind})

    for (const theme of ['light','dark']) {
      await ev(`window.__yanStore.getState().patchSettings({theme:${JSON.stringify(theme)}})`)
      for (const [label, date] of [['crescent','2026-11-13T10:30:00Z'], ['full','2026-11-24T16:00:00Z']]) {
        const s = await time(date)
        const layers = await ev('window.__skyFixture.layers.length')
        check(`${theme}/${label} 夜里有月亮时也不画月亮，山水照常绘制`, !s.arc&&layers===6, {arc:!!s.arc,layers})
      }
      await shot(`night-full-${theme}`)
      const day = await time('2026-11-17T06:00:00Z')
      check(`${theme} 白天月亮在天上时只画太阳`, day.kind==='sun'&&!day.ellipse)
    }
    await time('2026-11-11T04:00:00Z')
    const wide = await snapshot()
    await cdp.call('Emulation.setDeviceMetricsOverride', {width:900,height:800,deviceScaleFactor:1,mobile:false})
    await sleep(250)
    const narrow = await snapshot()
    check('窄窗日月仍在背景边界内，不产生横向溢出', narrow.arc[0]-narrow.arc[2]>0&&narrow.arc[0]+narrow.arc[2]<narrow.width&&await ev('document.documentElement.scrollWidth<=innerWidth+1'))
    check('实际窗口缩小时背景仍随页面尺寸自适应',narrow.width<wide.width&&narrow.height<wide.height)
    await shot('sun-narrow-dark')
    const narrowShort = await background()
    await ev(`document.querySelector('.ProseMirror').focus()`)
    await cdp.call('Input.insertText',{text:Array.from({length:18},(_,i)=>`窄窗第${i+1}行`).join('\n')})
    await settleBackground()
    const narrowTall = await background()
    check('窄窗输入框增高仍不推动山水和太阳',narrowTall.editor>narrowShort.editor+80&&sameBackground(narrowShort,narrowTall))
    await shot('composer-tall-narrow-dark')
    await clearEditor()
    await settleBackground()
    check('窄窗清空输入后背景不跳动',sameBackground(narrowShort,await background()))
    await cdp.call('Emulation.clearDeviceMetricsOverride')

    await time('2026-11-11T01:00:00Z')
    const tick = await time('2026-11-11T03:38:00Z','timer')
    check('分钟定时刷新会更新位置，无需重开标签或切焦点', tick.kind==='sun'&&Math.abs(tick.arc[0]-tick.width*0.5)<tick.width*0.03)
    await ev(`Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'))`)
    const hidden = await snapshot()
    await time('2026-11-11T07:00:00Z','timer')
    check('隐藏页面的时钟更新不额外绘制背景', (await snapshot()).draws===hidden.draws)
    await ev(`delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'))`)
    await sleep(100)
    const shown = await snapshot()
    check('恢复可见后立即按当前时间重画太阳', shown.kind==='sun'&&shown.arc[0]>tick.arc[0], shown.arc?.slice(0,2))
    await time('2026-11-11T02:00:00Z')
    check('同一时刻在上海是白天', (await snapshot()).kind==='sun')
    await cdp.call('Emulation.setTimezoneOverride', {timezoneId:'UTC'})
    await ev(`window.__skyFixture.last=null;window.dispatchEvent(new Event('focus'))`)
    await sleep(100)
    const utc = await snapshot()
    check('电脑时区改为 UTC 后按新的所在地判断：同一时刻已是夜里，不再画太阳', !utc.arc)
    await cdp.call('Emulation.setTimezoneOverride', {timezoneId:'Australia/Sydney'})
    await ev(`window.__yanStore.getState().patchSettings({theme:'light'})`)
    const sydneyDusk = await time('2026-11-12T08:05:20Z')
    check('悉尼 11/12 19:05（日落 19:33 前）仍显示低悬右侧的太阳', sydneyDusk.kind==='sun'&&sydneyDusk.arc[0]>sydneyDusk.width*0.7, sydneyDusk.arc?.slice(0,2))
    await shot('sydney-1905-light')
    const sydneyNight = await time('2026-11-12T10:00:00Z')
    check('悉尼 21:00 日落后不画太阳，也不画天上的娥眉月', !sydneyNight.arc)
    await shot('sydney-2100-light')
    await ev(`window.__yanStore.getState().patchSettings({theme:'dark'})`)
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
    await ev(`(() => {const f=window.__skyFixture;if(!f)return;Date.now=f.realNow;CanvasRenderingContext2D.prototype.arc=f.arc;CanvasRenderingContext2D.prototype.ellipse=f.ellipse;CanvasRenderingContext2D.prototype.fill=f.fill;CanvasRenderingContext2D.prototype.clearRect=f.clearRect;CanvasRenderingContext2D.prototype.drawImage=f.drawImage;window.setInterval=f.setInterval;window.clearInterval=f.clearInterval;delete document.visibilityState;delete window.__skyFixture})()`)
    await cdp.call('Emulation.setTimezoneOverride', {timezoneId:''})
    await cdp.call('Emulation.clearDeviceMetricsOverride')
  }
}
