/** Synthetic layout and keyboard contract; no inference. */
;(async()=>{
 const out=[],store=window.__yanStore,q=s=>document.querySelector(s),qa=s=>[...document.querySelectorAll(s)],sleep=ms=>new Promise(r=>setTimeout(r,ms)),ok=(v,s)=>out.push('  '+(v?'✓':'✗')+' '+s)
 try{
  for(let i=0;i<60&&!store.getState().settings;i++)await sleep(100)
  const models=Array.from({length:24},(_,i)=>({provider:['anthropic','openai','google'][i%3],id:'probe-'+i,name:'Probe '+String(i).padStart(2,'0')+' 一个偏长的模型名',reasoning:true}))
  let calls=0
  store.setState({models,session:{...store.getState().session,model:models[16]},setModel:async()=>{calls++;return{ok:true}}})
  q('[data-testid="model-picker"]').click();await sleep(300)
  const r=q('[data-testid="model-menu"]').getBoundingClientRect()
  ok(r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1,'菜单完整位于窗口内')
  ok(!!q('[data-testid="model-option"][data-current="1"]'),'打开定位当前模型')
  const provider=q('[data-testid="models-provider"]');provider.value='';provider.dispatchEvent(new Event('change',{bubbles:true}));await sleep(150)
  ok(qa('[data-testid="model-option"]').length<=8&&!!q('[data-testid="models-next"]'),'模型按页展示')
  q('[data-testid="models-next"]').click();await sleep(100)
  ok(q('[data-testid="models-page"]').textContent.startsWith('2')&&calls===0,'翻页不切换模型')
  const input=q('[data-testid="model-search"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Probe 23');input.dispatchEvent(new Event('input',{bubbles:true}));await sleep(150)
  ok(qa('[data-testid="model-option"]').length===1&&!q('[data-testid="models-next"]'),'搜索跨页并重置页码')
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await sleep(150)
  ok(calls===1&&!q('[data-testid="model-menu"]'),'Enter选择后关闭菜单')
 }catch(e){out.push('  ✗ Model menu: '+String(e))}
 return out.join('\n')
})()