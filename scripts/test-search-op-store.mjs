import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const outDir = '.tmp/search-op-store/out'
await mkdir(outDir, { recursive: true })
const outfile = join(outDir, 'op-store.mjs')

const fakeReact = `
const components = new Set()
const effects = []
let current = null
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
export function useSyncExternalStore(subscribe, snapshot) {
  const inst = current
  if (!inst.unsubscribe) inst.unsubscribe = subscribe(() => { inst.dirty = true })
  return snapshot()
}
export function useEffect(fn, deps) {
  const inst = current
  const index = inst.index++
  const prev = inst.hooks[index]
  if (prev && same(prev.deps, deps)) return
  inst.hooks[index] = { deps, cleanup: prev?.cleanup }
  effects.push(() => {
    inst.hooks[index].cleanup?.()
    inst.hooks[index].cleanup = fn()
  })
}
export function useMemo(fn, deps) {
  const inst = current
  const index = inst.index++
  const prev = inst.hooks[index]
  if (prev && same(prev.deps, deps)) return prev.value
  const value = fn()
  inst.hooks[index] = { deps, value }
  return value
}
export function mount(render) {
  const inst = { render, hooks: [], dirty: true, index: 0, renders: 0 }
  components.add(inst)
  return inst
}
export function unmount(inst) {
  components.delete(inst)
  inst.unsubscribe?.()
  for (const hook of inst.hooks) hook?.cleanup?.()
}
export function flush() {
  let guard = 0
  for (;;) {
    const dirty = [...components].filter((c) => c.dirty)
    if (!dirty.length && !effects.length) return
    if (++guard > 1000) throw new Error('render loop')
    for (const inst of dirty) {
      inst.dirty = false
      inst.index = 0
      inst.renders += 1
      current = inst
      inst.value = inst.render()
      current = null
    }
    for (const run of effects.splice(0)) run()
  }
}
`

const reactFile = resolve(outDir, 'fake-react.mjs')
await writeFile(reactFile, fakeReact)
await build({
  entryPoints: ['src/renderer/src/features/session/web-search/op-store.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [
    {
      name: 'fake-react',
      setup(b) {
        b.onResolve({ filter: /^react$/ }, () => ({ path: pathToFileURL(reactFile).href, external: true }))
      }
    }
  ]
})
const m = await import(pathToFileURL(outfile).href)
const { mount, unmount, flush } = await import(pathToFileURL(reactFile).href)

const reads = new Map()
globalThis.window = {
  yan: {
    searchOps: {
      read: async (id) => {
        reads.set(id, (reads.get(id) ?? 0) + 1)
        return { ok: true, kind: 'search', operationId: id, sources: [] }
      }
    }
  }
}
const settle = async () => {
  for (let i = 0; i < 20; i += 1) {
    flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  flush()
}

const many = Array.from({ length: 60 }, (_, i) => `many-${i}`)
const big = mount(() => m.useSearchOps(many))
await settle()
assert.ok(big.value.every((state) => state.status === 'ready'), '挂载中的搜索超过缓存上限时全部就绪')
assert.ok(many.every((id) => reads.get(id) === 1), '超过缓存上限也只读取一次，不会反复重取')
assert.ok(big.renders < 10, `超过缓存上限时渲染能收敛（${big.renders} 次）`)

unmount(big)
const fresh = Array.from({ length: 60 }, (_, i) => `fresh-${i}`)
const next = mount(() => m.useSearchOps(fresh))
await settle()
assert.ok(next.value.every((state) => state.status === 'ready'), '卸载后新挂载的搜索全部就绪')

const back = mount(() => m.useSearchOp('many-0'))
await settle()
assert.equal(back.value.status, 'ready', '被淘汰的搜索重新挂载时会再读取并就绪')
assert.equal(reads.get('many-0'), 2, '被淘汰后重新挂载只补读一次')

console.log('search op store: cache limit / eviction / remount passed')
