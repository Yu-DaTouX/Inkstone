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
    const ui = await compile('src/renderer/src/state/ui-v3.ts', join(dir, 'ui-v3.mjs'))

    assert.equal(panes.subagentPaneId('sub-1a'), 'subagent:sub-1a')
    assert.equal(panes.subagentRunOfPane('subagent:sub-1a'), 'sub-1a')
    assert.equal(panes.subagentRunOfPane('subagent:'), null)
    assert.equal(panes.subagentRunOfPane('subagent:../x'), null)
    assert.equal(panes.subagentRunOfPane('subagent:a b'), null)
    assert.equal(panes.subagentRunOfPane(`subagent:${'a'.repeat(97)}`), null)
    assert.equal(panes.subagentRunOfPane('files'), null)
    assert.equal(panes.subagentRunOfPane(null), null)

    assert.equal(panes.isSubagentPaneId('subagent:sub-2'), true)
    assert.equal(panes.isSubagentPaneId('terminal'), false)
    assert.equal(panes.isSubagentPaneId(42), false)
    assert.equal(panes.isToolPane('files'), true)
    assert.equal(panes.isToolPane('subagent:sub-2'), false)
    assert.equal(panes.isWorkspacePaneId('terminal'), true)
    assert.equal(panes.isWorkspacePaneId('subagent:sub-2'), true)
    assert.equal(panes.isWorkspacePaneId('subagent:'), false)
    assert.equal(panes.isWorkspacePaneId('nope'), false)
    assert.deepEqual(panes.toolPanes(['files', 'subagent:sub-2', 'terminal']), ['files', 'terminal'])

    assert.deepEqual(
      panes.staleSubagentPanes(['files', 'subagent:sub-1', 'subagent:sub-2', 'terminal'], new Set(['sub-2'])),
      ['subagent:sub-1']
    )
    assert.deepEqual(panes.staleSubagentPanes(['files', 'terminal'], new Set()), [])
    assert.deepEqual(panes.removedRunIds([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [{ id: 'b' }]), ['a', 'c'])
    assert.deepEqual(panes.removedRunIds([{ id: 'a' }], [{ id: 'a' }, { id: 'n' }]), [])

    assert.deepEqual(ui.restorableWorkspacePanes(['files', 'subagent:sub-1', 'subagent:bad id', 'subagent:sub-1', 'terminal'], 'files'), ['files', 'subagent:sub-1'])
    assert.deepEqual(ui.restorableWorkspacePanes(['preview', 'changes'], 'files'), ['files', 'changes'])
    assert.deepEqual(ui.restorableWorkspacePanes(null, 'overview'), [])

    const store = ui.useUiV3
    store.setState({ workspaceOpen: true, workspaceTab: 'files', workspacePanes: ['files'], workspaceFocus: false })
    store.getState().setWorkspaceTab('subagent:sub-1')
    assert.equal(store.getState().workspaceTab, 'subagent:sub-1')
    assert.deepEqual(store.getState().workspacePanes, ['files', 'subagent:sub-1'])
    store.getState().setWorkspaceTab('subagent:sub-1')
    assert.deepEqual(store.getState().workspacePanes, ['files', 'subagent:sub-1'])
    store.getState().setWorkspaceTab('subagent:has space')
    assert.equal(store.getState().workspaceTab, 'subagent:sub-1')

    store.getState().setWorkspaceTab('subagent:sub-2')
    store.getState().dropWorkspacePanes(['subagent:sub-2', 'subagent:sub-9'])
    assert.deepEqual(store.getState().workspacePanes, ['files', 'subagent:sub-1'])
    assert.equal(store.getState().workspaceTab, 'subagent:sub-1')

    store.getState().setWorkspaceTab('files')
    store.getState().dropWorkspacePanes(['subagent:sub-1'])
    assert.deepEqual(store.getState().workspacePanes, ['files'])
    assert.equal(store.getState().workspaceTab, 'files')

    const before = store.getState()
    store.getState().dropWorkspacePanes(['subagent:absent'])
    assert.equal(store.getState(), before)

    store.getState().closeWorkspacePane('files')
    assert.deepEqual(store.getState().workspacePanes, [])
    assert.equal(store.getState().workspaceTab, 'overview')

    console.log('subagent-panes: 通过')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await run()
