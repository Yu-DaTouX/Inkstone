import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build, transform } from 'esbuild'
import { fileURLToPath } from 'node:url'

const entry = new URL('../src/renderer/src/components/settings/review2-settings-guards.ts', import.meta.url)
const result = await build({ entryPoints: [fileURLToPath(entry)], bundle: true, format: 'esm', platform: 'node', write: false })
const source = result.outputFiles[0].text
const { peerBrowseBelongsTo, mergeDiscoveredModels, boundedPending } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

assert.equal(peerBrowseBelongsTo({ peerId: 'peer-a' }, 'peer-a'), true)
assert.equal(peerBrowseBelongsTo({ peerId: 'peer-a' }, 'peer-b'), false)
assert.equal(peerBrowseBelongsTo(null, 'peer-a'), false)

const fetched = mergeDiscoveredModels(
  [{ id: 'model-a', name: 'edited while fetching', context: 128 }, { id: '  ' }],
  [{ id: 'model-a', name: 'server name', protocol: 'chat' }, { id: 'model-b', name: 'new' }],
  (current, discovered) => ({ ...discovered, ...current, protocol: discovered.protocol })
)
assert.deepEqual(fetched, [
  { id: 'model-a', name: 'edited while fetching', context: 128, protocol: 'chat' },
  { id: 'model-b', name: 'new' }
])

assert.deepEqual(boundedPending([{ seq: 1, data: 'abc' }], { seq: 2, data: 'de' }, 2, 5), [
  { seq: 1, data: 'abc' }, { seq: 2, data: 'de' }
])
assert.equal(boundedPending([{ seq: 1, data: 'abc' }], { seq: 2, data: 'de' }, 1, 5), null)
assert.equal(boundedPending([{ seq: 1, data: 'abc' }], { seq: 2, data: 'def' }, 3, 5), null)
const changed = [
  '../src/renderer/src/components/settings/AuthTab.tsx',
  '../src/renderer/src/components/settings/AppUpdateSection.tsx',
  '../src/renderer/src/components/settings/CustomProviderForm.tsx',
  '../src/renderer/src/components/settings/CapabilitiesTab.tsx',
  '../src/renderer/src/components/settings/KnowledgeTab.tsx',
  '../src/renderer/src/components/settings/NativeContextTab.tsx',
  '../src/renderer/src/components/settings/PeerTab.tsx',
  '../src/renderer/src/components/settings/RemoteTab.tsx',
  '../src/renderer/src/components/settings/Settings.tsx',
  '../src/renderer/src/components/settings/StorageSection.tsx',
  '../src/renderer/src/components/settings/VoiceTab.tsx',
  '../src/renderer/src/components/browser/BrowserSurface.tsx',
  '../src/renderer/src/components/terminal/TerminalSurface.tsx'
]
for (const relative of changed) {
  const file = new URL(relative, import.meta.url)
  await transform(await readFile(file, 'utf8'), { loader: 'tsx', sourcefile: file.pathname })
}
console.log(`settings-ui behavior: 9 assertions passed; esbuild syntax-transformed ${changed.length} changed TSX modules`)
