import assert from 'node:assert/strict'
import { build } from 'esbuild'

let stateIndex = 0
const states = []
let effect
let measurements = 0
let scans = 0
const observed = new Set()
const fontListeners = new Set()
let resizeCallback
let mutationCallback
const frames = new Map()
let nextFrame = 1
const label = {}
const block = {}
let targets = [label, block]
const host = {
  clientWidth: 500,
  querySelectorAll() { scans++; return targets },
  closest() { return host }
}
globalThis.__controlsHooks = {
  useState(initial) {
    const i = stateIndex++
    if (!(i in states)) states[i] = initial
    return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next }]
  },
  useLayoutEffect(callback) { effect = callback }
}
globalThis.__measureControls = () => {
  measurements++
  return { gap: 2, naturalFixedWidth: 100, minimumFixedWidth: 60, blockWidths: [60], iconOnlyBlockWidths: [30], overflowWidth: 24 }
}
globalThis.getComputedStyle = () => ({ paddingInlineStart: '0', paddingInlineEnd: '0' })
globalThis.requestAnimationFrame = callback => { const id = nextFrame++; frames.set(id, callback); return id }
globalThis.cancelAnimationFrame = id => frames.delete(id)
globalThis.ResizeObserver = class {
  constructor(callback) { resizeCallback = callback }
  observe(node) { observed.add(node) }
  unobserve(node) { observed.delete(node) }
  disconnect() { observed.clear() }
}
globalThis.MutationObserver = class {
  constructor(callback) { mutationCallback = callback }
  observe() {}
  disconnect() {}
}
globalThis.document = { fonts: {
  addEventListener(type, callback) { fontListeners.add(callback) },
  removeEventListener(type, callback) { fontListeners.delete(callback) }
} }
const result = await build({
  entryPoints: ['src/renderer/src/features/composer/composer-controls-layout.ts'],
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'controls-runtime', setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'controls-runtime' }))
    builder.onResolve({ filter: /restingComposerControlsMeasurement$/ }, () => ({ path: 'measure', namespace: 'controls-runtime' }))
    builder.onLoad({ filter: /.*/, namespace: 'controls-runtime' }, ({ path }) => ({
      contents: path === 'react'
        ? 'export const useState = (...args) => globalThis.__controlsHooks.useState(...args); export const useLayoutEffect = (...args) => globalThis.__controlsHooks.useLayoutEffect(...args); export const useCallback = fn => fn'
        : 'export const measureRestingComposerControls = (...args) => globalThis.__measureControls(...args)',
      loader: 'js'
    }))
  } }]
})
const { useComposerControlsLayout } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
const render = () => { stateIndex = 0; return useComposerControlsLayout() }
const flush = () => {
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach(callback => callback())
}
render().attachHost(host)
render()
const cleanup = effect()
assert.equal(measurements, 1)
assert.deepEqual(observed, new Set([host, label, block]))
const initialScans = scans
for (let i = 0; i < 20; i++) {
  resizeCallback([])
  mutationCallback([{ type: 'characterData' }])
  for (const listener of fontListeners) listener()
}
assert.equal(frames.size, 1)
assert.equal(measurements, 1)
flush()
assert.equal(measurements, 2)
assert.equal(scans, initialScans)
const replacement = {}
targets = [replacement]
mutationCallback([{ type: 'childList' }])
resizeCallback([])
assert.equal(frames.size, 1)
flush()
assert.deepEqual(observed, new Set([host, replacement]))
assert.equal(measurements, 3)
resizeCallback([])
assert.equal(frames.size, 1)
cleanup()
assert.equal(frames.size, 0)
assert.equal(observed.size, 0)
assert.equal(fontListeners.size, 0)
console.log('PASS composer controls: immediate initial layout, batched resize/mutation/fonts, no text rescans, removed-node cleanup, cancelled pending frames')
