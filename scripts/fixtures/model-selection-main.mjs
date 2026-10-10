/** Isolated Electron test entry: synthetic model IPC, real settings IPC, no inference. */
import { ipcMain } from 'electron'
const handle=ipcMain.handle.bind(ipcMain)
let selections=0,searches=0
ipcMain.handle=(channel,listener)=>handle(channel,async(event,...args)=>{
 if(channel==='yan:setModel'){
  const [provider,id]=args
  if(provider!=='fixture-b'||id!=='model-40')throw Error('Unexpected synthetic model selection')
  if(++selections===1)return{ok:false,error:'Synthetic provider denied model selection'}
  await event.sender.executeJavaScript(`(() => { const s=window.__yanStore; const model=s.getState().models.find(m=>m.provider==='fixture-b'&&m.id==='model-40'); s.setState({session:{...s.getState().session,model}}) })()`)
  return{ok:true}
 }
 if(channel==='yan:searchSessions'&&++searches===1)throw Error('Synthetic search failure')
 return listener(event,...args)
})
await import('../../out/main/index.js')
