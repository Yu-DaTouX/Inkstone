import assert from 'node:assert/strict'
import { build } from 'esbuild'

const componentEntries = [
  'src/renderer/src/components/review/EnvironmentMenu.tsx',
  'src/renderer/src/components/review/SourceMenu.tsx',
  'src/renderer/src/components/review/useGitReview.ts',
  'src/renderer/src/components/toolbar/QuotaSection.tsx',
  'src/renderer/src/components/toolbar/Resizer.tsx',
  'src/renderer/src/components/toolbar/FileTree.tsx',
  'src/renderer/src/components/toolbar/ToolSection.tsx',
  'src/renderer/src/components/toolbar/TodoSection.tsx',
  'src/renderer/src/components/rail/Rail.tsx',
  'src/renderer/src/components/rail/useRailProjects.ts'
]
await build({ entryPoints: componentEntries, bundle: false, outdir: 'out-review-controls', write: false, jsx: 'automatic' })
const result = await build({
  entryPoints: ['src/renderer/src/components/toolbar/workspace-control-guards.ts'],
  bundle: true,
  format: 'esm',
  write: false
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
const { indexVisiblePaths, selectFiniteQuotaWindow, sessionSourceStorageKey, shouldIncludeSyntheticCurrent } = await import(moduleUrl)

const valid = { id: 'good', used: 8, total: 10 }
const invalid = { id: 'zero', used: 1, total: 0 }
assert.equal(selectFiniteQuotaWindow([invalid, valid]), valid)
assert.equal(selectFiniteQuotaWindow([invalid]), null)
assert.equal(selectFiniteQuotaWindow([{ used: Number.NaN, total: 4 }]), null)

const positions = indexVisiblePaths(['', 'src', 'src/main.ts'])
assert.equal(positions.get('src/main.ts'), 2)
assert.equal(positions.has('missing'), false)

assert.notEqual(sessionSourceStorageKey('session/A'), sessionSourceStorageKey('session:B'))
assert.equal(sessionSourceStorageKey('a/b'), 'yan.source-links.v1:a%2Fb')
assert.equal(shouldIncludeSyntheticCurrent(false, '/workspace/session.jsonl'), true)
assert.equal(shouldIncludeSyntheticCurrent(true, '/workspace/session.jsonl'), false)
assert.equal(shouldIncludeSyntheticCurrent(false, undefined), false)
console.log('workspace controls behavioral checks passed (10 assertions; esbuild compiled touched components and isolated source)')
