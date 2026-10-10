/** Synthetic render/scroll benchmark, called only inside isolated benchmark windows. */
async function measureLongSession() {
  const store=window.__yanStore, messages=Array.from({length:2000},(_,i)=>({id:`perf-long-${i}`,role:i%2?'assistant':'user',text:`PERF-LONG-${i}\n`+'长会话测量内容。'.repeat(35)}))
  const sleep=ms=>new Promise(r=>setTimeout(r,ms))
  const tasks=[]
  const observer=new PerformanceObserver(list=>tasks.push(...list.getEntries().map(e=>e.duration)))
  observer.observe({entryTypes:['longtask']})
  await sleep(300) // Let initial RPC hydration finish before replacing only the isolated projection.
  const started=performance.now()
  store.getState().applyPush({ch:'sync',payload:messages})
  while(!document.querySelector('.stream-row .msg')?.textContent?.includes('PERF-LONG-')) {
    if(performance.now()-started>10000)throw Error('Long conversation failed to render: '+JSON.stringify({messages:store.getState().messages.length,rows:document.querySelectorAll('.stream-row').length,msgs:document.querySelectorAll('.stream .msg').length,text:document.querySelector('.stream')?.textContent?.slice(0,100)}))
    await sleep(10)
  }
  const firstPaintMs=performance.now()-started, scroller=document.querySelector('.stream')
  if(!scroller)throw Error('Missing scroll container')
  const frames=[];let previous=performance.now()
  for(let i=0;i<120;i++) {
    await new Promise(requestAnimationFrame)
    const now=performance.now();frames.push(now-previous);previous=now
    scroller.scrollTop=(i%60)/59*(scroller.scrollHeight-scroller.clientHeight)
  }
  await sleep(100)
  observer.disconnect()
  const domMessages=document.querySelectorAll('.stream .msg').length
  if(store.getState().messages.length!==2000 || domMessages<1 || domMessages>=2000)throw Error('Long conversation virtualization failed')
  const sorted=[...frames].sort((a,b)=>a-b)
  return {messages:2000,domMessages,firstPaintMs,scrollFrameP95Ms:sorted[Math.ceil(sorted.length*.95)-1],slowFramesOver50ms:frames.filter(v=>v>50).length,measuredFrames:frames.length,longTasks:tasks.length,longTaskTotalMs:tasks.reduce((a,b)=>a+b,0)}
}
