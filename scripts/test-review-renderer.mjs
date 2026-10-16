import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const store = await source('src/renderer/src/state/store.ts')
const pushes = await source('src/renderer/src/state/push-consumers.ts')

assert.match(store, /newSession: async \(target\) => \{\s+\+\+sessionSwitchGate/)
assert.match(store, /fork: async \(entryId\) => \{\s+\+\+sessionSwitchGate/)
assert.match(store, /clone: async \(\) => \{\s+\+\+sessionSwitchGate/)
assert.match(pushes, /if \(becameReady\) \{\s+const current = ctx\.get\(\)\s+void current\.reloadModels\(\)/)
const sessionSwitch = await import('./test-session-switch.mjs')
let sessionSwitchAssertions = 0
await sessionSwitch.runSessionSwitchTests(() => { sessionSwitchAssertions += 1 })
assert.ok(sessionSwitchAssertions > 0, 'session switch regression suite executed')
console.log(`review-renderer: 4 source assertions and ${sessionSwitchAssertions} isolated session-switch checks passed`)
