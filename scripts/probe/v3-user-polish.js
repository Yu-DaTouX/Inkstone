;(async () => {
  const results = []
  const check = (ok, name) => results.push(`  ${ok ? '✓' : '✗'} ${name}`)
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const q = (id) => document.querySelector(`[data-testid="${id}"]`)

  const openTool = async (tab) => {
    const direct = q(`wb-open-${tab}`)
    if (direct) {
      direct.click()
      await wait(200)
      return
    }
    q('wb-more-tools')?.click()
    const order = ['changes', 'preview', 'logs', 'branch', 'quota']
    const pick = () => document.querySelector(`.wb-more-menu [data-key="${tab}"]`) ?? document.querySelectorAll('.wb-more-menu [role="menuitem"]')[order.indexOf(tab)]
    for (let i = 0; i < 40 && !pick(); i++) await wait(50)
    pick()?.click()
    await wait(200)
  }
  const store = window.__yanStore
  try {
    if (!store) throw new Error('missing probe store')
    store.setState({ messages: [], peekedMessages: null, settings: { ...store.getState().settings, asciiBackground: true } })
    await wait(1000)
    window.__polishStage = 'home'
    check(document.querySelector('.v3-empty-greet')?.textContent.includes('Hello world'), '首页问候 Hello world 已渲染')
    check(!document.querySelector('.v3-empty-hint'), '首页旧标语已移除')
    const firstCanvas = document.querySelector('.v3-ascii-field canvas')
    const beforeSession = store.getState().session
    store.setState({ session: { ...beforeSession, sessionId: 'polish-new-empty-session' } })
    await wait(150)
    check(firstCanvas === document.querySelector('.v3-ascii-field canvas'), '空会话身份变化复用画布，不重建字符图集')
    store.setState({ session: beforeSession })
    const samples = [], costs = [], drawTimes = []
    let draws = 0
    const originalClear = CanvasRenderingContext2D.prototype.clearRect
    CanvasRenderingContext2D.prototype.clearRect = function(...args) {
      if (this.canvas.closest('.v3-ascii-field')) { draws++;drawTimes.push(performance.now()) }
      return originalClear.apply(this,args)
    }
    const original = window.requestAnimationFrame
    window.requestAnimationFrame = (callback) => original((time) => {
      const begin = performance.now()
      const before = draws
      callback(time)
      if (draws > before) costs.push(performance.now() - begin)
    })
    await new Promise((resolve) => {
      let last, start
      const step = (time) => { start ??= time; if (last) samples.push(time-last); last=time; if (time-start < 3000) original(step); else resolve() }
      original(step)
    })
    window.requestAnimationFrame = original
    CanvasRenderingContext2D.prototype.clearRect = originalClear
    samples.sort((a,b)=>a-b); costs.sort((a,b)=>a-b)
    results.push(`  Chromium rAF 间隔 p50=${samples[Math.floor(samples.length*.5)].toFixed(2)}ms p95=${samples[Math.floor(samples.length*.95)].toFixed(2)}ms；实际绘制 ${draws} 帧，画布回调 p95=${(costs[Math.floor(costs.length*.95)] ?? 0).toFixed(2)}ms；rAF >50ms=${samples.filter((x)=>x>50).length}；窗口焦点=${document.hasFocus()}`)
    if (document.hasFocus()) check(costs.length > 0 && costs[Math.floor(costs.length*.95)] < 16.7, '背景画布回调 p95 小于 16.7ms')
    else check(draws === 0, '窗口失焦时背景画布暂停绘制')
    await wait(2200)
    document.querySelector('.start-details-link')?.click()
    await wait(600)
    window.__polishStage = 'usage'
    check(!!q('usage-details'), '点击用量标题进入独立详情')
    check(document.querySelectorAll('.usage-page-heat .start-cell').length > 300, '用量详情显示全年方格热图')
    await wait(2200)
    location.hash = '#/'
    await wait(400)
    const picked = [], patched = []
    const models = [{ id:'one',name:'Alpha',provider:'provider-a',reasoning:true,contextWindow:200000,cost:{input:3,output:15} },{ id:'two',name:'Beta',provider:'provider-b',reasoning:true,contextWindow:100000,cost:{input:4,output:10} }]
    store.setState({ models, thinkingLevels:['off','minimal','low','medium','high','xhigh','max'], session:{...store.getState().session,model:models[0],thinkingLevel:'medium',thinkingLevelsStatus:'known',availableThinkingLevels:['off','minimal','low','medium','high','xhigh','max'],isStreaming:false,isCompacting:false}, setModel: async (provider,id) => { picked.push({provider,id}); return {ok:true} }, patchSettings: async (patch) => { patched.push(patch);store.setState({settings:{...store.getState().settings,...patch}}) } })
    q('thinking-picker')?.click(); await wait(500)
    const marks = [...document.querySelectorAll('.mtp-scale-item')].map((el)=>el.getBoundingClientRect())
    check(marks.length===7 && marks.every((a,i)=>!i || a.left >= marks[i-1].right - 1), '七档思考文字互不重叠')
    if (marks.length!==7) results.push('    诊断：'+JSON.stringify({n:marks.length,pop:!!document.querySelector('.mtp-think-pop'),btn:!!q('thinking-picker'),txt:document.querySelector('.mtp-think-pop')?.textContent?.slice(0,120)}))
    q('thinking-picker')?.click(); await wait(400)
    q('model-picker')?.click(); await wait(500)
    check(!!document.querySelector('.mtp-rail') && !!document.querySelector('.mtp-search-input'), '模型菜单有左侧品牌栏与搜索')
    check(!document.querySelector('.mtp-tag-price'), '模型菜单不显示价格')
    document.querySelector('.mtp-item [data-testid="model-picker-favorite"]')?.click(); await wait(200)
    check(patched.length===1 && picked.length===0 && !!document.querySelector('.mtp-pop'), '逐行收藏不切换模型也不关闭菜单')
    const search = document.querySelector('.mtp-search-input')
    if (search) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search,'Beta'); search.dispatchEvent(new Event('input',{bubbles:true})) }
    await wait(300)
    check([...document.querySelectorAll('.mtp-item-name')].map((el)=>el.textContent).join()==='Beta', '搜索只显示匹配模型')
    window.__polishStage = 'picker'
    await wait(2200)
    document.querySelector('.mtp-item')?.click(); await wait(300)
    check(picked[0]?.provider==='provider-b' && picked[0]?.id==='two', '跨供应商选择携带正确 provider 与 model')
    if (picked[0]?.id!=='two') results.push('    诊断：'+JSON.stringify({picked,pop:!!document.querySelector('.mtp-pop'),items:[...document.querySelectorAll('.mtp-item-name')].map((el)=>el.textContent)}))
    await openTool('files'); await wait(300)
    const filesTile=()=>document.querySelector('.wb-pane-tile[data-tile-id="files"]')
    const resizer=document.querySelector('.wb-pane-sep[data-direction="row"]')
    const before=filesTile()?.getBoundingClientRect().width
    resizer?.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))
    await wait(200)
    check(filesTile()?.getBoundingClientRect().width > before, '右工作区键盘向左扩大宽度')
    check(!!resizer && getComputedStyle(resizer).pointerEvents!=='none', '右工作区边缘提供可命中的拖拽条')
    window.__polishStage = 'resize'
    if (window.__polishDriver) {
      for (let i=0;i<100 && !window.__polishDrag;i++) await wait(50)
      check(window.__polishDrag === true, 'Chromium 真实指针拖拽能够扩大右工作区')
    }
    q('wb-close')?.click()
    const now=Date.now()
    store.setState({messages:Array.from({length:12},(_,i)=>({id:`polish-${i}`,role:i%2?'assistant':'user',text:`${i%2?'答复':'用户轮'} ${i} · ${'示例正文 '.repeat(50)}`,timestamp:now+i, ...(i===1?{thinking:'推理内容 '.repeat(120),thinkingMs:12000,toolCalls:[{id:'polish-tool',name:'bash',args:{command:'long-command '.repeat(30)},status:'error',output:'fixture error',startedAt:now-1000,endedAt:now}]}:{})})),peekedMessages:null})
    await wait(500)
    const rail=q('v3-outline-rail'),tick=q('v3-outline-tick')
    check(!!rail && rail.getBoundingClientRect().left < innerWidth/2, '会话导航轨位于左侧')
    const track=document.querySelector('.v3-rail-track')
    check(track && getComputedStyle(track).pointerEvents==='auto', '会话导航轨无需悬停即可使用')
    tick?.click();await wait(300)
    check((document.querySelector('.v3-stream')?.scrollTop ?? 999) < 100, `点击第一轮回到开头（scrollTop=${Math.round(document.querySelector('.v3-stream')?.scrollTop ?? -1)}）`)
    check(!q('v3-ascii-field'), '发送/出现消息后背景已卸载，不留绘制循环')
    window.__polishStage = 'messages'
    check([...document.querySelectorAll('.v3-think-label,.v3-badge,.v3-step-verb')].every((el)=>getComputedStyle(el).whiteSpace==='nowrap'), '推理与工具短标签不拆行')
    await wait(2200)
    document.documentElement.dataset.theme='light'
    window.__polishStage = 'light'
    await wait(2200)
    results.push('证据范围：单场景 Chromium DOM、合成会话、画布与帧间隔；不代表真实模型或发行包验收。')
  } catch(error) { results.push(`  ✗ ${error.stack ?? error}`) }
  return results.join('\n')
})()
