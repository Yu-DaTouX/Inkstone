#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const dir = await mkdtemp(join(tmpdir(), 'yan-route-back-'))
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
}
globalThis.window = {
  location: { hash: '' },
  addEventListener() {},
  removeEventListener() {},
  localStorage: globalThis.localStorage,
  matchMedia: () => ({ matches: false })
}

const outfile = join(dir, 'ui-v3.mjs')
await build({
  entryPoints: [join(ROOT, 'src/renderer/src/state/ui-v3.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'error'
})
const { useUiV3 } = await import(pathToFileURL(outfile).href)

let failed = 0
const ok = (cond, label, extra) => {
  if (cond) return console.log(`  [ok] ${label}`)
  failed++
  console.log(`  [x] ${label}`, extra ?? '')
}

const routeName = () => useUiV3.getState().route.name
const backNames = () => useUiV3.getState().back.map((r) => r.name)

console.log('## 平级页面：返回一律回聊天')
for (const page of ['schedule', 'collab', 'usage']) {
  useUiV3.setState({ route: { name: 'chat' }, back: [] })
  useUiV3.getState().navigate({ name: page })
  ok(routeName() === page, `进入 ${page}`)
  useUiV3.getState().goBack()
  ok(routeName() === 'chat', `${page} 点返回回到聊天`, routeName())
  ok(useUiV3.getState().back.length === 0, `${page} 返回后历史清空`, JSON.stringify(backNames()))
}

console.log('## 平级页之间互相跳转后再返回，仍然直接回聊天')
useUiV3.setState({ route: { name: 'chat' }, back: [] })
useUiV3.getState().navigate({ name: 'schedule' })
useUiV3.getState().navigate({ name: 'collab' })
useUiV3.getState().navigate({ name: 'usage' })
ok(routeName() === 'usage', '连跳到用量页')
ok(JSON.stringify(backNames()) === JSON.stringify(['chat', 'schedule', 'collab']), '历史栈记录了连跳', JSON.stringify(backNames()))
useUiV3.getState().goBack()
ok(routeName() === 'chat', '在用量页点返回直接回聊天（不再退到协作页）', routeName())

console.log('## 历史栈与当前页不一致时（hash 同步等）也不会卡住')
useUiV3.setState({ route: { name: 'collab' }, back: [{ name: 'collab' }] })
useUiV3.getState().goBack()
ok(routeName() === 'chat', '栈顶与当前页相同时仍然回聊天', routeName())

console.log('## 聊天页点返回不做任何事')
useUiV3.setState({ route: { name: 'chat' }, back: [] })
useUiV3.getState().goBack()
ok(routeName() === 'chat', '聊天页返回保持聊天')

console.log('## navigate 仍然会记录历史（供工作台等其它用途）')
useUiV3.setState({ route: { name: 'chat' }, back: [] })
useUiV3.getState().navigate({ name: 'schedule' })
ok(JSON.stringify(backNames()) === JSON.stringify(['chat']), 'navigate 记录上一页', JSON.stringify(backNames()))

await rm(dir, { recursive: true, force: true })

if (failed) {
  console.log(`\nFAIL: ${failed} 项未通过`)
  process.exit(1)
}
console.log('\nPASS: 全部通过')
