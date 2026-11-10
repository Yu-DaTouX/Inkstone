import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from '../node_modules/esbuild/lib/main.js'

const dir = await mkdtemp(join(tmpdir(), 'yan-peer-confirm-'))
let pass = 0
function ok(condition, label, detail) {
  assert.ok(condition, `${label}${detail === undefined ? '' : ` ← ${JSON.stringify(detail)}`}`)
  pass += 1
  console.log(`  ✓ ${label}`)
}

const dialogCalls = []
let dialogResponse = 1
try {
  const outfile = join(dir, 'peer-ipc.mjs')
  await build({
    entryPoints: ['src/main/ipc/peer-ipc.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [
      {
        name: 'electron-fixture',
        setup(builder) {
          builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            loader: 'js',
            contents: `export const dialog = { showMessageBox: async (...args) => { globalThis.__dialogCalls.push(args.at(-1)); return { response: globalThis.__dialogResponse } } }`
          }))
        }
      }
    ]
  })
  globalThis.__dialogCalls = dialogCalls
  globalThis.__dialogResponse = dialogResponse
  const { registerPeerIpc } = await import(pathToFileURL(outfile).href)

  const handlers = {}
  const ipc = { handle: (channel, fn) => { handlers[channel] = fn } }
  const asked = []
  const client = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'pair') {
          return async (address, code, confirm) => {
            asked.push({ address, code, hasConfirm: typeof confirm === 'function' })
            if (typeof confirm !== 'function') return { ok: false, code: 'identity_confirm_required' }
            const accepted = await confirm({ computer: 'Office PC', fingerprint: 'ABCD-EF01-2345-6789' })
            return accepted ? { ok: true, data: { id: 'peer-1' } } : { ok: false, code: 'pair-cancelled' }
          }
        }
        return async () => ({})
      }
    }
  )
  registerPeerIpc(ipc, client)

  dialogResponse = 1
  globalThis.__dialogResponse = 1
  const cancelled = await handlers['yan:peer:pair']('10.0.0.2:37892', '123456')
  ok(cancelled.ok === false && cancelled.code === 'pair-cancelled', '用户取消核对则配对取消', cancelled)
  ok(asked[0]?.hasConfirm === true, 'IPC 调用必传指纹确认回调')
  const cancelDialog = dialogCalls.at(-1)
  ok(cancelDialog?.detail.includes('Office PC') && cancelDialog.detail.includes('ABCD-EF01-2345-6789'), '对话框展示电脑名与指纹')
  ok(cancelDialog?.defaultId === 1 && cancelDialog?.cancelId === 1, '默认不连接，取消是安全出口')

  dialogResponse = 0
  globalThis.__dialogResponse = 0
  const paired = await handlers['yan:peer:pair']('10.0.0.2:37892', '123456')
  ok(paired.ok === true, '用户确认后继续配对', paired)
  ok(asked.length === 2, '每次配对都重新确认')
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`Peer 配对指纹核对：${pass} 项通过`)
