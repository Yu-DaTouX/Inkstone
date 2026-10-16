import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'

const source = await readFile(new URL('../src/main/native-session-guard.ts', import.meta.url), 'utf8')
const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' })
const { validateNativeSessionRequest: check } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
const state = { sessionId: 'a', isAgentRunning: false, isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
let count = 0
const verify = (input, stateValue, expected, busy = false) => { assert.equal(check(input, stateValue, busy).ok, expected); count++ }
const request = (action, extra = {}) => ({ action, expectedSessionId: 'a', ...extra })
for (const action of ['tree','entries','scoped-models','trust','import','export-jsonl','share','reload','new-session']) verify(request(action), state, true)
for (const input of [null, [], {}, request('unknown'), { action:'tree',expectedSessionId:'b' }, request('tree',{args:42}), request('tree',{args:'x'.repeat(32769)})]) verify(input,state,false)
verify(request('tree'),null,false)
verify(request('navigate'),state,false)
verify(request('navigate',{entryId:'e'}),state,true)
verify(request('set-trust',{trusted:true}),state,true)
verify(request('set-trust',{trusted:'true'}),state,false)
verify(request('set-scoped-models',{modelIds:[]}),state,true)
verify(request('set-scoped-models',{modelIds:['p/m']}),state,true)
verify(request('set-scoped-models',{modelIds:['']}),state,false)
verify(request('set-scoped-models',{modelIds:[42]}),state,false)
for(const key of ['isAgentRunning','isStreaming','isCompacting']) verify(request('reload'),{...state,[key]:true},false)
verify(request('reload'),{...state,pendingMessageCount:1},false)
verify(request('reload'),state,false,true)
verify(request('tree'),{...state,isAgentRunning:true},true)
console.log(`native session guard: ${count} passed`)
