import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/renderer/src/features/session/RemoteImage.tsx', import.meta.url))
const stubs = {
  'lucide-react': 'export const ImageDown = () => null',
  '../../i18n': 'export const useT = () => (key) => key',
  '../../state/store': 'export const useStore = () => ""',
  '../../ui': 'export const Button = () => null',
  './Image': 'export const MessageImage = () => null'
}
const result = await build({
  entryPoints: [source],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  logLevel: 'silent',
  external: ['react', 'react/jsx-runtime'],
  plugins: [{
    name: 'stubs',
    setup(api) {
      api.onResolve({ filter: /.*/ }, (args) => (Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'stub' } : undefined))
      api.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: stubs[args.path], loader: 'js' }))
    }
  }]
})
const { createRemoteImageGroup } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text.replace(/from "react(\/jsx-runtime)?"/g, (_, sub) => `from "${import.meta.resolve(`react${sub ?? ''}`)}"`)).toString('base64')}`)

const group = createRemoteImageGroup()
let notified = 0
const stop = group.subscribe(() => { notified += 1 })
const empty = group.summary()
assert.deepEqual(empty, { blocked: 0, loading: 0, failed: 0, hosts: [] })

const loads = []
const member = (src, state) => ({ src, state, load: (prompt) => loads.push([src, prompt]) })
const a = {}
const b = {}
const c = {}
const d = {}
group.report(a, member('https://img.shields.io/a.svg', { phase: 'checking' }))
assert.equal(group.summary(), empty, '检查中的图片不计入')
assert.equal(notified, 0)

group.report(a, member('https://img.shields.io/a.svg', { phase: 'idle' }))
group.report(b, member('https://img.shields.io/b.svg', { phase: 'idle' }))
group.report(c, member('https://example.com/c.png', { phase: 'idle' }))
group.report(d, member('https://example.com/d.png', { phase: 'ready', dataUrl: 'data:' }))
const blocked = group.summary()
assert.equal(blocked.blocked, 3)
assert.deepEqual(blocked.hosts, ['img.shields.io', 'example.com'])
const before = notified
group.report(d, member('https://example.com/d.png', { phase: 'ready', dataUrl: 'data:' }))
assert.equal(group.summary(), blocked, '摘要不变时快照保持同一引用')
assert.equal(notified, before, '摘要不变时不通知')

group.loadBlocked()
assert.deepEqual(loads, [['https://img.shields.io/a.svg', true], ['https://img.shields.io/b.svg', true], ['https://example.com/c.png', true]], '全部加载逐张走原有的带确认加载')

loads.length = 0
group.report(a, member('https://img.shields.io/a.svg', { phase: 'failed', code: 'denied' }))
group.report(b, member('https://img.shields.io/b.svg', { phase: 'failed', code: 'network' }))
group.report(c, member('https://example.com/c.png', { phase: 'loading' }))
const mixed = group.summary()
assert.equal(mixed.blocked, 0)
assert.equal(mixed.loading, 1)
assert.equal(mixed.failed, 2)
group.retryFailed()
assert.deepEqual(loads, [['https://img.shields.io/a.svg', true], ['https://img.shields.io/b.svg', true]], '重试与原来逐张按钮一样重新走带确认加载，拒绝只取消那一次')

group.report(a, null)
group.report(b, null)
group.report(c, null)
assert.deepEqual(group.summary(), empty, '卸载后移出分组')
stop()
const settled = notified
group.report(a, member('https://img.shields.io/a.svg', { phase: 'idle' }))
assert.equal(notified, settled, '退订后不再通知')

console.log('test-remote-image-group ok')
