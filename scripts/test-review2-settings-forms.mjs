import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build, transform } from 'esbuild'
import { fileURLToPath } from 'node:url'

const entry = new URL('../src/renderer/src/components/settings/review2-settings-guards.ts', import.meta.url)
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
const files = [
  '../src/renderer/src/components/settings/RemoteTab.tsx',
  '../src/renderer/src/components/settings/AppearanceCustomize.tsx',
  '../src/renderer/src/components/settings/Onboarding.tsx',
  '../src/renderer/src/components/settings/PackagesTab.tsx',
  '../src/renderer/src/components/settings/CustomProviderForm.tsx',
  '../src/renderer/src/components/settings/PeerTab.tsx',
  '../src/renderer/src/components/settings/CapabilitiesTab.tsx',
  '../src/renderer/src/components/settings/ComputerUseSection.tsx',
  '../src/renderer/src/components/settings/Settings.tsx',
  '../src/renderer/src/components/settings/ClaudeSubscriptionSection.tsx',
  '../src/renderer/src/components/settings/VoiceTab.tsx',
  '../src/renderer/src/components/settings/AuthTab.tsx',
  '../src/renderer/src/components/settings/RelaySection.tsx'
]
for (const relative of files) {
  const file = new URL(relative, import.meta.url)
  await transform(await readFile(file, 'utf8'), { loader: 'tsx', sourcefile: file.pathname })
}

let generation = 0
let committed = null
const issue = () => ++generation
const resolve = (ticket, value) => { if (isCurrentGeneration(generation, ticket)) committed = value }
const older = issue()
const newer = issue()
resolve(newer, 'fresh')
resolve(older, 'stale')
assert.equal(committed, 'fresh')
console.log(`settings-forms behavior: 8 assertions passed; esbuild syntax-transformed ${files.length} TSX modules`)
