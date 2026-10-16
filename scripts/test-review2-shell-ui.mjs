import assert from 'node:assert/strict'
import { build, transform } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const helperPath = fileURLToPath(new URL('../src/renderer/src/components/shell/notice-timers.ts', import.meta.url))
const compiled = await build({ entryPoints: [helperPath], bundle: true, platform: 'node', format: 'esm', write: false })
const helperUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`
const { createPerIdTimers, optionKey } = await import(helperUrl)

let time = 0
let nextId = 0
const pending = new Map()
const scheduler = {
  set(callback, delay) {
    const id = ++nextId
    pending.set(id, { callback, at: time + delay })
    return id
  },
  clear(id) { pending.delete(id) }
}
const advance = (ms) => {
  const until = time + ms
  while (true) {
    const due = [...pending].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
    if (!due) break
    time = due[1].at
    pending.delete(due[0])
    due[1].callback()
  }
  time = until
}
const timers = createPerIdTimers(scheduler)
const fired = []
timers.schedule('departed-a', 110, () => fired.push('a'))
advance(50)
timers.schedule('departed-b', 110, () => fired.push('b'))
advance(60)
assert.deepEqual(fired, ['a'], 'later notification must not extend the earlier leaving item')
advance(50)
assert.deepEqual(fired, ['a', 'b'])
timers.schedule('notice-a', 5000, () => fired.push('notice-a'))
advance(1000)
timers.schedule('notice-b', 5000, () => fired.push('notice-b'))
advance(4000)
assert.ok(fired.includes('notice-a'), 'unrelated notice arrival must not reset an existing notice deadline')
assert.ok(!fired.includes('notice-b'))
timers.clearMissing(new Set())
assert.equal(pending.size, 0, 'removed notices release their timers')
assert.equal(optionKey('same', 0) === optionKey('same', 1), false, 'duplicate display options receive distinct keys')
timers.dispose()

const files = [
  'src/renderer/src/components/shell/UiBridge.tsx',
  'src/renderer/src/components/shell/PeerApprovalDialog.tsx',
  'src/renderer/src/components/browser/BrowserSurface.tsx',
  'src/renderer/src/components/ui/index.tsx'
]
for (const file of files) {
  const source = await readFile(new URL(file, root), 'utf8')
  await transform(source, { loader: 'tsx', jsx: 'automatic', sourcefile: file })
}
const grow = await readFile(new URL('src/renderer/src/components/ui/index.tsx', root), 'utf8')
assert.match(grow, /aria-hidden=\{!open\} inert=\{!open\}/, 'collapsed Grow subtree is both hidden and inert')
const peer = await readFile(new URL('src/renderer/src/components/shell/PeerApprovalDialog.tsx', root), 'utf8')
assert.match(peer, /useModalLayer\(!!current, \(\) => decide\(false\)\)/)
assert.match(peer, /useFocusTrap\(panel, !!current, isTop\)/)
const browser = await readFile(new URL('src/renderer/src/components/browser/BrowserSurface.tsx', root), 'utf8')
assert.match(browser, /catch \(cause\)[\s\S]*browser\.permissionUpdateFailed/)
assert.match(browser, /permission\.status}:\$\{index\}/)
assert.match(browser, /item\.from \?\? ''}:\$\{index\}/)
console.log('review2 shell-ui isolated behavior: 8 checks passed; 4 production TSX modules compiled')
