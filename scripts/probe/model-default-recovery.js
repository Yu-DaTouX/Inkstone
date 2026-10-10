/** Cold start with an unavailable saved model; explicit recovery, no model requests. */
;(async()=>{
 const out=[],store=window.__yanStore,sleep=ms=>new Promise(r=>setTimeout(r,ms)),q=s=>document.querySelector(s),ok=(v,s)=>out.push('  '+(v?'✓':'✗')+' '+s)
 try{
  for(let i=0;i<80&&!store.getState().settings;i++)await sleep(100)
  ok((await window.yan.getSettings()).lastMainModel?.provider==='retired-fixture','Unavailable choice retained on failed initialization')
  q('[data-testid="model-picker"]').click()
  for(let i=0;i<50&&!q('[data-testid="models-reset-default"]');i++)await sleep(100)
  ok(!!q('[data-testid="models-reset-default"]'),'Failed initialization offers explicit recovery in model menu')
  q('[data-testid="models-reset-default"]').click()
  for(let i=0;i<80&&store.getState().conn!=='ready';i++)await sleep(100)
  ok(store.getState().conn==='ready','Explicit reset starts native pi successfully')
  ok(!(await window.yan.getSettings()).lastMainModel,'Invalid default cleared only after user action')
  ok(!store.getState().session?.isAgentRunning&&store.getState().messages.length===0,'Recovery sends no inference or conversation content')
 }catch(e){out.push('  ✗ Recovery probe: '+String(e))}
 return out.join('\n')
})()
