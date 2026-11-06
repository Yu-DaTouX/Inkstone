import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const stubs = {
  './sessions': `
    export const sessionsToDelete = async (path) => globalThis.__del.extra.map((p) => ({ path: p }))
    export const deleteSession = async (path, current) => {
      globalThis.__del.log.push(['delete', path, current ?? null])
      if (globalThis.__del.failOn && path.toLowerCase().split(String.fromCharCode(92)).join('/').endsWith(globalThis.__del.failOn)) throw new Error('磁盘错误')
      return 'token:' + path
    }
    export const restoreSession = async (token) => {
      globalThis.__del.log.push(['restore', token])
      if (globalThis.__del.restoreFails.some((name) => token.toLowerCase().split(String.fromCharCode(92)).join('/').endsWith(name))) throw new Error('恢复失败')
    }
  `,
  './terminal': `export const closeTerminalsForOwner = (path) => globalThis.__del.log.push(['terminal', path])`
}
const plugin = {
  name: 'delete-fixtures',
  setup(api) {
    api.onResolve({ filter: /.*/ }, (args) => (Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'fixture' } : undefined))
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: stubs[args.path], loader: 'js' }))
  }
}

const dir = await mkdtemp(join(tmpdir(), 'inkstone-session-delete-'))
try {
  const outfile = join(dir, 'session-delete.mjs')
  await build({ entryPoints: ['src/main/session-delete.ts'], outfile, bundle: true, platform: 'node', format: 'esm', plugins: [plugin], logLevel: 'silent' })
  const { deleteSessionChain } = await import(pathToFileURL(outfile).href)

  const makeHost = ({ chain = null, current = null } = {}) => {
    const events = []
    return {
      events,
      host: {
        sessionChains: { load: async () => {}, chainOf: () => chain, forget: async (path) => { events.push(['forget', path]); return true } },
        ac: () => (current ? { getState: () => ({ sessionFile: current }) } : null),
        runners: () => ({ stopBySessionFile: async (path) => { events.push(['stop', path]) } }),
        pushRunners: () => events.push(['push'])
      }
    }
  }
  const reset = (extra = [], failOn = null, restoreFails = []) => { globalThis.__del = { log: [], extra, failOn, restoreFails } }

  reset()
  let fixture = makeHost()
  let result = await deleteSessionChain(fixture.host, 'C:/s/a.jsonl')
  assert.equal(result.ok, true, '普通会话删除成功')
  assert.equal(result.undoToken, 'token:C:/s/a.jsonl', '返回撤销令牌')
  assert.ok(fixture.events.some((e) => e[0] === 'forget'), '删除后清理链记录')
  assert.ok(fixture.events.some((e) => e[0] === 'stop' && e[1] === resolve('C:/s/a.jsonl')), '删除前先停掉该会话的运行实例')
  assert.ok(fixture.events.at(-1)[0] === 'push', '最后刷新运行实例列表')
  assert.ok(globalThis.__del.log.some((e) => e[0] === 'terminal' && e[1] === 'C:/s/a.jsonl'), '关闭该会话的终端')

  reset()
  fixture = makeHost({ current: 'C:/s/a.jsonl' })
  result = await deleteSessionChain(fixture.host, 'C:/s/a.jsonl')
  assert.equal(result.ok, false, '当前正在使用的会话不能删除')
  assert.match(result.error, /正在使用/, '给出明确原因')
  assert.equal(globalThis.__del.log.length, 0, '拒绝时不删除任何文件')
  assert.equal(fixture.events.length, 0, '拒绝时不停止任何运行实例')

  reset([resolve('C:/s/child.jsonl')])
  fixture = makeHost({ current: 'C:/s/other.jsonl' })
  result = await deleteSessionChain(fixture.host, 'C:/s/a.jsonl')
  assert.equal(result.ok, true, '附带会话（子代理等）也在受影响集合里时仍可删除')
  assert.ok(fixture.events.some((e) => e[0] === 'stop' && e[1] === resolve('C:/s/child.jsonl')), '附带会话的运行实例也被停止')

  reset([resolve('C:/s/other.jsonl')])
  fixture = makeHost({ current: 'C:/s/other.jsonl' })
  result = await deleteSessionChain(fixture.host, 'C:/s/a.jsonl')
  assert.equal(result.ok, false, '附带会话是当前会话时同样拒绝')
  assert.equal(globalThis.__del.log.length, 0, '附带会话拒绝时不删除')

  const chain = { segments: [{ sessionFile: 'C:/s/one.jsonl' }, { sessionFile: 'C:/s/two.jsonl' }, { sessionFile: 'C:/s/three.jsonl' }] }
  reset()
  fixture = makeHost({ chain })
  result = await deleteSessionChain(fixture.host, 'C:/s/two.jsonl')
  const deleted = globalThis.__del.log.filter((e) => e[0] === 'delete').map((e) => e[1])
  assert.equal(result.ok, true, '多段会话链整体删除')
  assert.equal(deleted.length, 3, '链内每一段都删除', JSON.stringify(deleted))
  assert.equal(result.undoToken.split('|').length, 3, '撤销令牌覆盖每一段')

  reset([], 'three.jsonl')
  fixture = makeHost({ chain })
  result = await deleteSessionChain(fixture.host, 'C:/s/two.jsonl')
  const restored = globalThis.__del.log.filter((e) => e[0] === 'restore').map((e) => e[1])
  assert.equal(result.ok, false, '某一段删除失败：整体失败')
  assert.match(result.error, /磁盘错误/, '带回原始错误')
  assert.equal(restored.length, 2, '已删除的段全部回滚', JSON.stringify(restored))
  assert.equal(result.undoToken, undefined, '全部回滚成功时不留撤销令牌')
  assert.ok(fixture.events.at(-1)[0] === 'push', '失败后也刷新运行实例列表')
  assert.ok(!fixture.events.some((e) => e[0] === 'forget'), '失败时不清理链记录')

  reset([], 'three.jsonl', ['one.jsonl'])
  fixture = makeHost({ chain })
  result = await deleteSessionChain(fixture.host, 'C:/s/two.jsonl')
  assert.equal(result.ok, false, '回滚部分失败仍然报失败')
  assert.match(result.error, /恢复失败|撤销令牌/, '说明部分会话恢复失败')
  assert.equal(result.undoToken.toLowerCase(), 'token:c:/s/one.jsonl', '只保留没恢复成功的令牌供重试')

  console.log('session-delete: 当前会话保护、链整体删除、失败回滚、撤销令牌通过')
} finally {
  await rm(dir, { recursive: true, force: true })
}
