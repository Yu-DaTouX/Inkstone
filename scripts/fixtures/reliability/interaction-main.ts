import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { rename, writeFile, unlink } from 'node:fs/promises'
import { createIpcRegistrar } from '../../../src/main/ipc/registrar'
import { registerWorkspaceDataIpc } from '../../../src/main/ipc/workspace-data-ipc'

app.setPath('userData', process.env.YAN_USER_DATA!)
app.disableHardwareAcceleration()
let win: BrowserWindow | null = null
let checks = 0
const check = (condition: unknown, label: string) => { assert.ok(condition, label); checks++ }
const equal = (actual: unknown, expected: unknown, label: string) => { assert.deepEqual(actual, expected, label); checks++ }
const run = (code: string) => win!.webContents.executeJavaScript(code)
const wait = async (code: string) => {
  const end = Date.now() + 15000
  while (Date.now() < end) { if (await run(code)) return; await new Promise(done => setTimeout(done, 20)) }
  throw new Error('Timed out waiting for renderer: ' + code)
}
const observe = () => run('({ready:window.observedInteraction.ready,error:window.observedInteraction.error,values:window.observedInteraction.values,session:window.observedInteraction.session})')
const save = (key: string, value: string) => run(`window.observedInteraction.save(${JSON.stringify(key)},${JSON.stringify(value)})`)

void app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
  registerWorkspaceDataIpc(createIpcRegistrar(event => event.sender === win?.webContents && event.senderFrame === win.webContents.mainFrame), () => win)
  await win.loadFile(join(__dirname, 'index.html'))
  await wait('window.observedInteraction?.ready === true')
  check(await run('typeof window.yan.interactions.get === "function" && typeof window.yan.interactions.set === "function"'), 'formal preload exposes interaction API')
  const phase = process.env.INTERACTION_TEST_PHASE
  if (phase === 'write') {
    await save('bookmark:m1', '1')
    await save('widget:fixture', JSON.stringify({ fields: [{ id: 'name', name: '', type: 'text', value: 'persisted', checked: false }, { id: 'choices', name: '', type: 'select-multiple', value: 'one', selected: ['one', 'two'] }], custom: { count: 7 } }))
    await wait('window.observedInteraction.values["bookmark:m1"] === "1"')
    equal((await observe()).values['bookmark:m1'], '1', 'hook publishes successful IPC writes')
    await run('window.selectInteractionSession("B")')
    await wait('window.observedInteraction?.session === "B" && window.observedInteraction.ready')
    equal((await observe()).values, {}, 'same key does not leak into another session')
    await save('bookmark:m1', 'B-value')
    await run('window.selectInteractionSession("A")')
    await wait('window.observedInteraction.session === "A"')
    equal((await observe()).values['bookmark:m1'], '1', 'session switch retains its own snapshot')

    const interactionRoot = join(process.env.YAN_DATA_DIR!, 'interaction-state')
    const preservedRoot = interactionRoot + '.preserved'
    await rename(interactionRoot, preservedRoot)
    await writeFile(interactionRoot, 'blocked-directory')
    try {
      const error = await run('window.observedInteraction.save("bookmark:failed", "1").then(()=>null,e=>String(e))')
      check(typeof error === 'string' && error.length > 0, 'host write error rejects through formal preload and hook')
      check(!('bookmark:failed' in (await observe()).values), 'failed save is not published as persisted')
      equal((await observe()).values['bookmark:m1'], '1', 'failed save retains previous successful values')
    } finally {
      await unlink(interactionRoot)
      await rename(preservedRoot, interactionRoot)
    }
    await writeFile(join(interactionRoot, createHash('sha256').update('C').digest('hex') + '.json'), '{broken')
    await run('window.selectInteractionSession("C")')
    await wait('window.observedInteraction?.session === "C" && !!window.observedInteraction.error')
    check(!(await observe()).ready, 'failed initial read is not marked ready')
    const other = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true } })
    try {
      await other.loadFile(join(__dirname, 'index.html'))
      const rejected = await other.webContents.executeJavaScript('window.yan.interactions.set("A","bookmark:untrusted","1").then(()=>false,()=>true)')
      check(rejected, 'nontrusted renderer is rejected by real IPC registrar')
    } finally { other.destroy() }
  } else {
    equal((await observe()).values['bookmark:m1'], '1', 'bookmark survives a full Electron process restart')
    const widget = (await observe()).values['widget:fixture']
    check(typeof widget === 'string', 'saved widget state survives process restart')
    await run('window.selectInteractionSession("B")')
    await wait('window.observedInteraction?.session === "B" && window.observedInteraction.ready')
    equal((await observe()).values['bookmark:m1'], 'B-value', 'second session survives process restart without leakage')
    await run('window.selectInteractionSession("A")')
    await wait('window.observedInteraction.session === "A"')
    await run('window.mountBridge()')
    const frame = win.webContents.mainFrame.frames.find(frame => frame.url === 'about:srcdoc')!
    check(!!frame, 'real sandbox iframe mounted')
    check(await frame.executeJavaScript('typeof window.yan === "undefined"'), 'sandbox iframe has no host API')
    const restored = await run(`window.restoreBridge(${widget})`)
    equal(restored.value, 'persisted', 'real DOM bridge restores text input')
    equal(restored.selected, ['one', 'two'], 'real DOM bridge restores multiple selection')
    equal(restored.custom, { count: 7 }, 'real DOM bridge emits custom restore event')
    await frame.executeJavaScript('window.postMessage({yanWidgetState:1,type:"restore",state:{fields:[{id:"name",name:"",type:"text",value:"untrusted"}]}},"*")')
    await new Promise(done => setTimeout(done, 30))
    equal(await frame.executeJavaScript('document.querySelector("#name").value'), 'persisted', 'bridge ignores restore messages not sent by its parent')
    const captured = JSON.parse(await run('window.captureBridge("current-request")'))
    equal(captured.fields.length, 2, 'capture excludes password input')
    equal(captured.fields[0].value, 'persisted', 'real iframe captures restored values')
    equal(captured.custom, { count: 7 }, 'capture includes restored custom state')
    await run('window.mountBridge()')
    const reloaded = await run(`window.restoreBridge(${widget})`)
    equal(reloaded.value, 'persisted', 'saved state restores after iframe recreation')
  }
  console.log(JSON.stringify({ phase, checks, passed: true }))
  win.destroy()
  app.exit(0)
}).catch(error => { console.error(error); win?.destroy(); app.exit(1) })
