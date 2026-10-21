import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const entry = new URL('../src/renderer/src/features/settings/models/models-model.ts', import.meta.url)
const result = await build({ entryPoints: [fileURLToPath(entry)], bundle: true, format: 'esm', platform: 'node', write: false })
const source = result.outputFiles[0].text
const { mergeDiscoveredModels } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

const fetched = mergeDiscoveredModels(
  [{ id: 'model-a', name: 'edited while fetching', context: 128 }, { id: '  ' }],
  [{ id: 'model-a', name: 'server name', protocol: 'chat' }, { id: 'model-b', name: 'new' }],
  (current, discovered) => ({ ...discovered, ...current, protocol: discovered.protocol })
)
assert.deepEqual(fetched, [
  { id: 'model-a', name: 'edited while fetching', context: 128, protocol: 'chat' },
  { id: 'model-b', name: 'new' }
])
console.log('settings-ui behavior: 1 assertions passed')
