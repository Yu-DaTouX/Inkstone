import { app, BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here=dirname(fileURLToPath(import.meta.url))
async function main(){
await app.whenReady()
const evidence=resolve(here,'../../../.local-docs/evidence/2026-10-01-side-workspace-design',String(Date.now()))
await mkdir(evidence,{recursive:true})
const win=new BrowserWindow({width:1440,height:900,show:false,webPreferences:{sandbox:true,backgroundThrottling:false}})
win.webContents.on('console-message',(_e,_l,m)=>console.log(m))
await win.loadFile(resolve(here,'index.html'))
for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript('window.previewReady===true'))break;await new Promise(r=>setTimeout(r,100))}
if(!await win.webContents.executeJavaScript('window.previewReady===true'))throw new Error('Prototype terminal did not initialize')
const checks=[]
async function capture(name){await new Promise(r=>setTimeout(r,400));await writeFile(resolve(evidence,name+'.png'),(await win.webContents.capturePage()).toPNG());const info=await win.webContents.executeJavaScript(`({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,theme:document.documentElement.dataset.theme,canvases:document.querySelectorAll('.terminal-host canvas').length})`);if(info.overflow)throw new Error('Page overflow: '+name);checks.push({name,...info})}
await capture('dark-wide')
await win.webContents.executeJavaScript("terminalTab('codex')")
await capture('codex-tab')
await win.webContents.executeJavaScript("terminalTab('claude');theme()")
await capture('light-wide')
await win.webContents.executeJavaScript("theme();expand('terminal-pane')")
await capture('terminal-expanded')
await win.webContents.executeJavaScript("expand('terminal-pane');toggle('term')")
await capture('terminal-hidden')
await win.webContents.executeJavaScript("toggle('term')")
win.setSize(940,700)
await capture('dark-narrow')
await writeFile(resolve(evidence,'checks.json'),JSON.stringify(checks,null,2))
console.log(JSON.stringify({evidence,checks}))
win.destroy();app.quit()
}
main().catch(error=>{console.error(error);app.exit(1)})
