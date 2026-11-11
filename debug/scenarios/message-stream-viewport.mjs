export const meta = { description: '消息流视口：长输出尾部锚点、键盘和网页手动收起定位、浅色窄窗；仅合成消息' }

export default async function run({cdp,newSession,sleep,check,shot,report}) {
 const ev=s=>cdp.evaluate(s)
 await newSession()
 await ev(`window.__yanStore.getState().patchSettings({theme:'light',lang:'en-US',rightPanelOpen:false,promptSuggestions:false,reduceMotion:false})`)
 await cdp.call('Emulation.setDeviceMetricsOverride',{width:900,height:900,deviceScaleFactor:1,mobile:false})
 const sources=Array.from({length:8},(_,i)=>({title:'Reference '+i,url:'https://example.invalid/'+i,domain:'example.invalid',snippet:'Fixture reference description '.repeat(4),source:''}))
 const calls=Array.from({length:3},(_,i)=>({id:'web-'+i,name:'web_search',args:{query:'search '+i},status:'ok',details:{search:{action:'query',query:'search '+i,items:sources}}}))
 const lines=Array.from({length:200},(_,i)=>'output line '+String(i+1).padStart(3,'0')+' repeated content').join('\n')
 const messages=[{id:'u0',role:'user',text:'Controls fixture'},{id:'a0',role:'assistant',text:Array.from({length:16},(_,i)=>'Paragraph '+i+' before controls.').join('\n\n')},{id:'u1',role:'user',text:'Long output fixture'},{id:'a1',role:'assistant',text:'Output is shown above.',toolCalls:[{id:'command',name:'bash',args:{command:'fixture command'},status:'error',output:'Error fixture\n'+lines}]},{id:'u2',role:'user',text:'Sources fixture'},{id:'a2',role:'assistant',text:'Search complete.',toolCalls:calls},{id:'u3',role:'user',text:'End spacer'},{id:'a3',role:'assistant',text:Array.from({length:26},(_,i)=>'Paragraph '+i+' after controls.').join('\n\n')}]
 await ev(`(()=>{const s=window.__yanStore.getState();window.__yanStore.setState({messages:${JSON.stringify(messages)},session:{...s.session,isAgentRunning:false,isStreaming:false},historyLoading:false,switchLoading:false})})()`)
 await sleep(600)
 const head=id=>`document.querySelector('[data-turn-id="${id}"] [data-testid="v3-process-toggle"]')`
 const click=async sel=>{await ev(`${sel}.click()`);await sleep(350)}
 const place=async(sel,top)=>{await ev(`(()=>{const s=document.querySelector('.v3-stream'),h=${sel};s.dispatchEvent(new WheelEvent('wheel',{deltaY:-1,bubbles:true}));s.scrollTop+=h.getBoundingClientRect().top-s.getBoundingClientRect().top-(${top})})()`);await sleep(350)}
 const top=sel=>ev(`(()=>{const s=document.querySelector('.v3-stream'),h=${sel};return h?h.getBoundingClientRect().top-s.getBoundingClientRect().top:null})()`)
 await click(head('a1'))
 const step=`document.querySelector('[data-turn-id="a1"] [data-testid="v3-step"]')`
 await click(step)
 const output=`document.querySelector('[data-turn-id="a1"] [data-testid="v3-step-output-toggle"]')`
 await place(output,160)
 const before=await ev(`(()=>{const p=document.querySelector('[data-turn-id="a1"] [data-testid="v3-step-output"]');return {scroll:p.scrollTop,height:p.scrollHeight,client:p.clientHeight,top:p.getBoundingClientRect().top}})()`)
 await click(output)
 const after=await ev(`(()=>{const p=document.querySelector('[data-turn-id="a1"] [data-testid="v3-step-output"]');return {scroll:p.scrollTop,height:p.scrollHeight,client:p.clientHeight,top:p.getBoundingClientRect().top}})()`)
 check('Long output expands above content and preserves the tail reading position',after.height>before.height&&Math.abs(after.scroll-Math.min(after.height-after.client,before.scroll+after.height-before.height))<2,{before,after})
 await shot('long-output-expanded-light')
 await place(head('a1'),-160)
 await ev(`${head('a1')}.focus({preventScroll:true})`)
 await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'})
 await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
 await sleep(450)
 const processTop=await top(head('a1'))
 check('Keyboard collapse with process header above viewport reveals its header',processTop!==null&&Math.abs(processTop)<2,processTop)
 const group=`document.querySelector('[data-turn-id="a2"] [data-testid="ws-group"]')`
 check('Search sources open by default with a single main header',await ev(`${group}.getAttribute('aria-expanded')==='true'&&!document.querySelector('[data-turn-id="a2"] [data-testid="ws-capsule"], [data-turn-id="a2"] [data-testid="v3-process-toggle"]')`))
 await place(group,-160)
 await click(group)
 const groupTop=await top(group)
 check('Manual web group collapse above viewport reveals its header',groupTop!==null&&Math.abs(groupTop)<2,groupTop)
 await click(group)
 await place(group,-100)
 await ev(`${group}.focus({preventScroll:true})`)
 await cdp.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'})
 await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
 await sleep(450)
 const capTop=await top(group)
 check('Keyboard source collapse above viewport reveals its header',capTop!==null&&Math.abs(capTop)<2,capTop)
 await cdp.call('Emulation.setDeviceMetricsOverride',{width:720,height:900,deviceScaleFactor:1,mobile:false})
 await sleep(400)
 check('Light narrow controls have no horizontal overflow',await ev(`document.querySelector('.v3-stream').scrollWidth<=document.querySelector('.v3-stream').clientWidth+1&&document.documentElement.scrollWidth<=innerWidth+1`))
 await shot('controls-narrow-light')
 report.interactions={processTop,groupTop,capTop,before,after}
}
