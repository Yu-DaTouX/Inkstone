import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const entry = new URL('../src/renderer/src/features/settings/models/review2-settings-guards.ts', import.meta.url)
const built = await build({ entryPoints: [fileURLToPath(entry)], bundle: true, format: 'esm', platform: 'node', write: false })
const guards = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const { canReplaceDraft, isCurrentGeneration, mergeDiscoveredModels } = guards

assert.equal(canReplaceDraft({ port: 8080 }, { port: 8080 }), true)
assert.equal(canReplaceDraft({ port: 9090 }, { port: 8080 }), false, 'unsaved form values must survive saved-setting refresh')
assert.equal(isCurrentGeneration(4, 3), false, 'an older load response must not commit')
assert.equal(isCurrentGeneration(4, 4), true)
assert.deepEqual(mergeDiscoveredModels([{ id: 'a', name: 'typed' }], [{ id: 'a', protocol: 'chat' }, { id: 'b' }], (draft, found) => ({ ...found, ...draft })), [
  { id: 'a', protocol: 'chat', name: 'typed' }, { id: 'b' }
])
let generation = 0
let committed = null
const issue = () => ++generation
const resolve = (ticket, value) => { if (isCurrentGeneration(generation, ticket)) committed = value }
const older = issue()
const newer = issue()
resolve(newer, 'fresh')
resolve(older, 'stale')
assert.equal(committed, 'fresh')
console.log('settings-forms behavior: 8 assertions passed')
