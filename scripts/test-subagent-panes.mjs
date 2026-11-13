import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-subagent-panes-'))
  try {
    const panes = await compile('src/renderer/src/features/workbench/subagent-panes.ts', join(dir, 'subagent-panes.mjs'))

    assert.equal(panes.subagentPaneId('sub-1a'), 'subagent:sub-1a')
    assert.equal(panes.subagentRunOfPane('subagent:sub-1a'), 'sub-1a')
    assert.equal(panes.subagentRunOfPane('subagent:'), null)
    assert.equal(panes.subagentRunOfPane('subagent:../x'), null)
    assert.equal(panes.subagentRunOfPane('subagent:a b'), null)
    assert.equal(panes.subagentRunOfPane(`subagent:${'a'.repeat(97)}`), null)
    assert.equal(panes.subagentRunOfPane('files'), null)
    assert.equal(panes.subagentRunOfPane(null), null)

    assert.deepEqual(panes.removedRunIds([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [{ id: 'b' }]), ['a', 'c'])
    assert.deepEqual(panes.removedRunIds([{ id: 'a' }], [{ id: 'a' }, { id: 'n' }]), [])

    console.log('subagent-panes: 通过')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await run()
