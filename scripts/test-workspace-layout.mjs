import assert from 'node:assert/strict'
import { transform } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
mkdirSync('out/test', { recursive: true })
writeFileSync('out/test/workspace-layout.mjs', (await transform(readFileSync('src/renderer/src/state/workspace-layout.ts', 'utf8'), { loader: 'ts', format: 'esm' })).code)
const { defaultWorkspaceLayout, dockGroups, openDockPane, hideDockPane, moveDockPane, resizeDockSplit, normalizeWorkspaceLayout, measureDockLayout } = await import('../out/test/workspace-layout.mjs')
let checks = 0
function invariant(layout) {
  const groups = dockGroups(layout.root), refs = groups.flatMap(g => g.panes)
  assert.equal(new Set(refs).size, refs.length)
  assert.equal(refs.filter(id => id === 'chat').length, 1)
  assert.equal(groups.find(g => g.panes.includes('chat')).panes.length, 1)
  assert(!layout.hidden.includes('chat'))
  for (const group of groups) assert(group.panes.includes(group.active))
  checks += 5
}
let layout = defaultWorkspaceLayout()
assert.deepEqual(dockGroups(layout.root).map(g => g.panes), [['chat']])
for (const id of ['browser', 'review', 'terminal:a', 'terminal:b', 'file:cwd/a', 'agent:hub:one']) layout = openDockPane(layout, id)
invariant(layout)
const aux = dockGroups(layout.root).find(g => g.panes.includes('browser')).id
assert.equal(dockGroups(layout.root).length, 2)
assert.equal(dockGroups(openDockPane(layout, 'terminal:a').root).flatMap(g => g.panes).filter(id => id === 'terminal:a').length, 1)
assert.deepEqual(hideDockPane(layout, 'chat'), layout)
for (const edge of ['left', 'right', 'top', 'bottom']) {
  const moved = moveDockPane(layout, 'terminal:a', 'conversation', edge)
  invariant(moved)
  assert.equal(dockGroups(moved.root).length, 3)
  const chat = measureDockLayout(moved, new Set(dockGroups(moved.root).flatMap(g => g.panes)), 1600, 900).groups.find(r => r.group.panes.includes('chat'))
  assert(chat.w >= 340 && chat.h >= 180)
}
const split = moveDockPane(layout, 'terminal:a', aux, 'top')
const group = dockGroups(split.root).find(g => g.panes.includes('terminal:a'))
assert.deepEqual(moveDockPane(split, 'chat', group.id, 'center'), split)
const merged = moveDockPane(split, 'terminal:a', aux, 'center')
assert.equal(dockGroups(merged.root).length, 2)
const hidden = hideDockPane(split, 'terminal:a')
assert(hidden.hidden.includes('terminal:a'))
assert.equal(dockGroups(openDockPane(hidden, 'terminal:a').root).find(g => g.panes.includes('terminal:a')).id, group.id)
const maximum = { ...split, maximized: 'terminal:a' }
assert.equal(measureDockLayout(maximum, new Set(['chat', 'tools', 'terminal:a']), 818, 500).groups.length, 1)
assert.equal(openDockPane(maximum, 'terminal:a').maximized, 'terminal:a')
assert.deepEqual(resizeDockSplit(split, 'missing', .2), split)
const resized = resizeDockSplit(layout, layout.root.id, 500)
assert.equal(resized.root.ratio, .9)
invariant(normalizeWorkspaceLayout({ version: 1, root: { type: 'group', id: 'bad', panes: ['chat', 'chat', 'terminal:a'], active: 'missing' }, hidden: ['chat'] }))
assert.deepEqual(normalizeWorkspaceLayout({ version: 99 }), defaultWorkspaceLayout())
// Exercise many layouts, including hidden resources, same-group splits and narrow recovery.
let seed = 1937
const rand = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n }
const edges = ['left', 'right', 'top', 'bottom', 'center']
for (let i = 0; i < 600; i++) {
  const groups = dockGroups(layout.root), refs = groups.flatMap(g => g.panes), pane = refs[rand(refs.length)]
  layout = i % 7 === 0 ? hideDockPane(layout, pane) : i % 5 === 0 ? openDockPane(layout, pane) : moveDockPane(layout, pane, groups[rand(groups.length)].id, edges[rand(5)])
  invariant(layout)
  const restored = normalizeWorkspaceLayout(JSON.parse(JSON.stringify(layout)))
  assert.deepEqual(restored, layout)
  const measured = measureDockLayout(layout, new Set(refs), 740, 420)
  for (const rect of measured.groups) {
    assert(rect.w >= 199.99 && rect.h >= 179.99)
    assert(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= measured.width + .01 && rect.y + rect.h <= measured.height + .01)
  }
  for (let a = 0; a < measured.groups.length; a++) for (let b = a + 1; b < measured.groups.length; b++) {
    const x = measured.groups[a], y = measured.groups[b]
    assert(x.x + x.w <= y.x || y.x + y.w <= x.x || x.y + x.h <= y.y || y.y + y.h <= x.y)
  }
  checks += 3
}
console.log(`Workspace layout: ${checks} invariant groups passed, 600 docking/hide/restore sequences`)
