// Isolated UI review. No agent process, credentials, or production settings.
import { app, BrowserWindow, ipcMain } from 'electron'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
app.setPath('userData', join(app.getPath('temp'), 'yan-ui-review-v2'))
let win
for (const channel of ['agentStatus','getSettings','listSessions','getState','getMessages','getStats','refreshTodos','cachedTitles','manualTitles','piInfo','browser:getState','compactionInfo','patchSettings','abort']) {
  ipcMain.handle('yan:' + channel, () => channel === 'agentStatus' ? {state:'ready'} : channel === 'listSessions' ? [] : null)
}
ipcMain.handle('yan:listDir', () => ({path:'',abs:root,entries:[{name:'src',dir:true},{name:'docs',dir:true},{name:'scripts',dir:true},{name:'package.json',dir:false}],skipped:['node_modules','.git'],rootName:'pi-desktop'}))
ipcMain.handle('yan:providerQuota', () => ({supported:false}))
async function main() {
  await app.whenReady()
  win = new BrowserWindow({width:1440,height:900,title:'砚 · UI 审阅模拟（不连接模型）',backgroundColor:'#0a0a0a',webPreferences:{/* .cjs：sandboxed preload 不支持 ESM，写成 .mjs 会白屏 */preload:join(root,'out/preload/index.cjs'),contextIsolation:true,sandbox:false}})
  await win.loadFile(join(root,'out/renderer/index.html'))
  await win.webContents.executeJavaScript(readFileSync(join(root,'scripts/shot-fixture.js'),'utf8'))
  await win.webContents.executeJavaScript(readFileSync(join(root,'scripts/ui-review.js'),'utf8'))
  win.center(); win.show(); win.focus()
  const dir=join(root,'docs/design/preview'); mkdirSync(dir,{recursive:true})
  setTimeout(async()=>{if(!win.isDestroyed()) {writeFileSync(join(dir,'ui-review-v2.png'),(await win.webContents.capturePage()).toPNG());console.log('REVIEW_READY',win.isVisible(),win.getBounds())}},4500)
}
app.on('window-all-closed',()=>app.quit())
main().catch(e=>{console.error(e);app.exit(1)})
