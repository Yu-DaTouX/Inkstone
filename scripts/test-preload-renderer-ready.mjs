#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const report = { pass: 0, fail: 0 }

function ok(cond, label, detail) {
  const pass = !!cond
  if (pass) report.pass += 1
  else report.fail += 1
  process.stdout.write(`${pass ? '  ✓' : '  ✗'} ${label}${pass ? '' : `  ← 实际: ${JSON.stringify(detail)}`}\n`)
  return pass
}

const sends = []
const handlers = new Map()

globalThis.__YAN_IPC = {
  on: (channel, listener) => {
    const list = handlers.get(channel) ?? []
    handlers.set(channel, [...list, listener])
  },
  removeListener: (channel, listener) => {
    handlers.set(channel, (handlers.get(channel) ?? []).filter((fn) => fn !== listener))
  },
  send: (channel) => {
    sends.push(channel)
  },
  invoke: async () => null
}

const ELECTRON_STUB = `export const contextBridge = { exposeInMainWorld(name, value) { globalThis.__YAN_EXPOSED = globalThis.__YAN_EXPOSED ?? {}; globalThis.__YAN_EXPOSED[name] = value } }
export const ipcRenderer = globalThis.__YAN_IPC
export const webUtils = { getPathForFile: () => '' }
`

const built = await build({
  entryPoints: [resolve(ROOT, 'src/preload/index.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [
    {
      name: 'preload-electron-stub',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron-stub', namespace: 'electron-stub' }))
        b.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({ contents: ELECTRON_STUB, loader: 'js' }))
      }
    }
  ]
})

const code = built.outputFiles[0].text
await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
const yan = globalThis.__YAN_EXPOSED.yan

const readyCount = () => sends.filter((channel) => channel === 'yan:renderer-ready').length

ok(typeof yan?.onPush === 'function', 'preload 暴露 yan.onPush')
ok(readyCount() === 0, '加载 preload 本身不发 renderer-ready', sends)

yan.onPush(() => {})
ok(readyCount() === 1, '首个 push 订阅发一次 renderer-ready', sends)

for (let i = 0; i < 4; i += 1) yan.onPush(() => {})
ok(readyCount() === 1, '终端标签 / 统计等后续订阅不再重发 renderer-ready', sends)

const off = yan.onPush(() => {})
off()
yan.onPush(() => {})
ok(readyCount() === 1, '退订后再订阅仍不重发 renderer-ready', sends)

ok((handlers.get('yan:push') ?? []).length > 0, 'yan:push 监听仍然注册', handlers.get('yan:push')?.length)

process.stdout.write(`\n================ 结果：${report.pass} 通过 / ${report.fail} 失败 ================\n`)
if (report.fail > 0) process.exitCode = 1
