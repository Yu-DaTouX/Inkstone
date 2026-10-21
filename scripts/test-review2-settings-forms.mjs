import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const entry = new URL('../src/renderer/src/features/settings/models/models-model.ts', import.meta.url)
const built = await build({ entryPoints: [fileURLToPath(entry)], bundle: true, format: 'esm', platform: 'node', write: false })
const { mergeDiscoveredModels } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

assert.deepEqual(mergeDiscoveredModels([{ id: 'a', name: 'typed' }], [{ id: 'a', protocol: 'chat' }, { id: 'b' }], (draft, found) => ({ ...found, ...draft })), [
  { id: 'a', protocol: 'chat', name: 'typed' }, { id: 'b' }
])
console.log('settings-forms behavior: 1 assertions passed')
