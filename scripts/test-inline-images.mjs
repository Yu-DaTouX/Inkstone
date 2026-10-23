import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'inkstone-inline-images-'))
const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL, window: globalThis.window, document: globalThis.document, Image: globalThis.Image }
const active = new Map()
const revoked = []
let sequence = 0
URL.createObjectURL = (blob) => { const url = `blob:unit-${++sequence}`; active.set(url, blob); return url }
URL.revokeObjectURL = (url) => { assert.ok(active.has(url), `URL must be owned and live: ${url}`); active.delete(url); revoked.push(url) }

function hooks() {
  const cells = []
  let index = 0
  let pending = []
  let dirty = false
  const runtime = {
    useState(initial) {
      const i = index++
      cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [cells[i].value, (value) => { cells[i].value = value; dirty = true }]
    },
    useRef(value) {
      const i = index++
      cells[i] ??= { value: { current: value } }
      return cells[i].value
    },
    useEffect(fn, deps) {
      const i = index++
      cells[i] ??= {}
      if (!cells[i].deps || deps.some((value, n) => !Object.is(value, cells[i].deps[n]))) pending.push({ i, fn, deps })
    },
    render(Component, props, commit = true) {
      globalThis.__INLINE_HOOKS = runtime
      let tree
      for (let n = 0; n < 12; n++) {
        index = 0; pending = []; dirty = false
        tree = Component(props)
        if (!commit) return tree
        for (const effect of pending) {
          const cell = cells[effect.i]
          cell.cleanup?.()
          cell.fn = effect.fn; cell.deps = effect.deps; cell.cleanup = effect.fn()
        }
        if (!dirty) return tree
      }
      throw new Error('Hook rendering did not settle')
    },
    value(i) { return cells[i]?.value },
    replay() { for (const cell of cells) if (cell.fn) { cell.cleanup?.(); cell.cleanup = cell.fn() } },
    unmount() { for (const cell of cells) cell.cleanup?.() }
  }
  return runtime
}

try {
  const stubs = new Map([
    [resolve('src/renderer/src/i18n/index.tsx'), 'export const useT = () => (key) => key'],
    [resolve('src/renderer/src/state/store.ts'), 'export const useStore = (selector) => selector({ notify: (...args) => globalThis.__INLINE_NOTICES.push(args) })'],
    [resolve('src/renderer/src/features/session/message-menu.ts'), 'export function openMessageMenu(event, label, items) { globalThis.__INLINE_MENU = items }'],
    [resolve('src/renderer/src/features/composer/image-viewer.tsx'), 'export function ImageViewer() { return null }']
  ])
  const result = await build({
    stdin: { contents: `export * from './src/renderer/src/ui/InlineImage'; export { MessageImage } from './src/renderer/src/features/session/Image'`, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', logLevel: 'silent',
    plugins: [{ name: 'inline-image-fixtures', setup(b) {
      b.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, ({ path }) => ({ path, namespace: 'react-fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'react-fixture' }, ({ path }) => ({ contents: path === 'react'
        ? 'export const useState = (...args) => globalThis.__INLINE_HOOKS.useState(...args); export const useEffect = (...args) => globalThis.__INLINE_HOOKS.useEffect(...args); export const useRef = (...args) => globalThis.__INLINE_HOOKS.useRef(...args)'
        : 'export const Fragment = Symbol.for("fragment"); export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx' }))
      b.onResolve({ filter: /.*/ }, (args) => {
        const path = resolve(args.resolveDir, args.path)
        const hit = [path, `${path}.ts`, `${path}.tsx`, join(path, 'index.tsx')].find((candidate) => stubs.has(candidate))
        return hit ? { path: hit, namespace: 'fixture' } : null
      })
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: stubs.get(path), loader: 'tsx' }))
    } }]
  })
  const file = join(dir, 'inline-images.mjs')
  await writeFile(file, result.outputFiles[0].text)
  const { InlineImage, inlineImageObjectUrl, MessageImage } = await import(pathToFileURL(file).href)
  const first = 'data:image/png;base64,AQID'
  const second = 'data:image/gif;base64,BAUG'
  assert.equal(inlineImageObjectUrl('https://example.com/x.png'), null)
  assert.equal(inlineImageObjectUrl('data:text/html;base64,AQID'), null)
  assert.equal(inlineImageObjectUrl('data:image/png;base64,%%%'), null)
  assert.equal(active.size, 0)
  const binary = inlineImageObjectUrl(second)
  assert.equal(active.get(binary).type, 'image/gif')
  assert.deepEqual([...new Uint8Array(await active.get(binary).arrayBuffer())], [4, 5, 6])
  URL.revokeObjectURL(binary)

  const rt = hooks()
  const ref = { current: null }
  const click = () => {}
  const props = { src: first, alt: 'fixture', ref, onClick: click, loading: 'lazy', decoding: 'async' }
  assert.equal(rt.render(InlineImage, props, false).props.src, undefined)
  assert.equal(active.size, 0)
  const initial = rt.render(InlineImage, props)
  assert.ok(initial.props.src.startsWith('blob:'))
  assert.equal(initial.props.ref, ref)
  assert.equal(initial.props.onClick, click)
  assert.equal(initial.props.loading, 'lazy')
  assert.equal(rt.render(InlineImage, props).props.src, initial.props.src)
  const count = sequence
  assert.equal(rt.render(InlineImage, { ...props, src: second }, false).props.src, undefined)
  assert.equal(sequence, count)
  assert.ok(active.has(initial.props.src))
  const replacement = rt.render(InlineImage, { ...props, src: second })
  assert.ok(!active.has(initial.props.src))
  assert.ok(active.has(replacement.props.src))
  rt.replay()
  const replayed = rt.render(InlineImage, { ...props, src: second })
  assert.ok(!active.has(replacement.props.src))
  assert.ok(active.has(replayed.props.src))
  assert.equal(rt.render(InlineImage, { ...props, src: 'file:///image.png' }).props.src, 'file:///image.png')
  assert.equal(rt.value(0), null)
  assert.equal(active.size, 0)
  assert.equal(rt.render(InlineImage, { ...props, src: 'data:image/png;base64,%%%' }).props.src, undefined)
  rt.render(InlineImage, props)
  rt.unmount()
  assert.equal(active.size, 0)
  assert.equal(new Set(revoked).size, revoked.length)

  const copied = []
  const saved = []
  const read = []
  globalThis.__INLINE_NOTICES = []
  globalThis.window = { yan: {
    copyImage: async (value) => { copied.push(value); return { ok: true } },
    saveImage: async (...value) => { saved.push(value); return { ok: true } },
    readPreviewBytes: async (...value) => { read.push(value); return { ok: true, bytes: new Uint8Array([255, 216, 255]) } }
  } }
  let decodeFailure = false
  let conversionFailure = false
  globalThis.Image = class {
    naturalWidth = 1
    naturalHeight = 1
    set src(value) { assert.ok(active.has(value)); queueMicrotask(() => decodeFailure ? this.onerror?.() : this.onload?.()) }
    removeAttribute(name) { assert.equal(name, 'src') }
  }
  globalThis.document = { createElement: (name) => {
    assert.equal(name, 'canvas')
    return { getContext: () => ({ drawImage() {} }), toDataURL: () => { if (conversionFailure) throw new Error('conversion failed'); return 'data:image/png;base64,Y29udmVydGVk' } }
  } }
  async function action(src, kind) {
    const component = hooks()
    const tree = component.render(MessageImage, { src, alt: 'original-image', sourceCwd: 'C:/fixture' })
    const image = tree.props.children[0]
    assert.equal(image.props.src, src)
    image.props.ref.current = { naturalWidth: 1, naturalHeight: 1 }
    image.props.onContextMenu({})
    globalThis.__INLINE_MENU.find((item) => item.id === `${kind}-image`).run()
    await new Promise(setImmediate)
    component.unmount()
    assert.equal(active.size, 0)
  }
  await action(first, 'copy')
  assert.equal(copied.at(-1), first)
  await action(second, 'save')
  assert.deepEqual(saved.at(-1), [second, 'original-image'])
  await action(second, 'copy')
  assert.equal(copied.at(-1), 'data:image/png;base64,Y29udmVydGVk')
  await action('file:///C:/fixture/photo.jpg', 'copy')
  assert.deepEqual(read.at(-1), ['C:/fixture/photo.jpg', 'C:/fixture'])
  assert.equal(copied.at(-1), 'data:image/png;base64,Y29udmVydGVk')
  decodeFailure = true
  await action('file:///C:/fixture/bad.jpg', 'copy')
  decodeFailure = false; conversionFailure = true
  await action('file:///C:/fixture/canvas-failure.jpg', 'copy')
  assert.equal(new Set(revoked).size, revoked.length)

  const csp = await readFile('src/renderer/index.html', 'utf8')
  assert.match(csp, /img-src 'self' data: blob:;/)
  assert.match(csp, /script-src 'self';/)
  assert.doesNotMatch(csp, /script-src[^;]*blob:/)
  console.log('inline-images: render/commit ownership, replacement, abort, replay, unmount, byte preservation, original copy/save, conversion cleanup and image-only CSP passed')
} finally {
  URL.createObjectURL = original.create
  URL.revokeObjectURL = original.revoke
  globalThis.window = original.window
  globalThis.document = original.document
  globalThis.Image = original.Image
  delete globalThis.__INLINE_HOOKS
  delete globalThis.__INLINE_MENU
  delete globalThis.__INLINE_NOTICES
  await rm(dir, { recursive: true, force: true })
}
