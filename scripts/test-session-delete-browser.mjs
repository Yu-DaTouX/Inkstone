import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const stubs = {
  './sessions': `
    export const sessionsToDelete = async (path) => [{ path, ...(globalThis.__del.ids[path] ? { sessionId: globalThis.__del.ids[path] } : {}) }]
    export const deleteSession = async (path) => {
      if (globalThis.__del.failOn === path) throw new Error('磁盘错误')
      globalThis.__del.log.push(['delete', path])
      return 'token:' + path
    }
    export const restoreSession = async (token) => { globalThis.__del.log.push(['restore', token]) }
  `,
  './terminal': `export const closeTerminalsForOwner = () => undefined`
}
const plugin = {
  name: 'delete-fixtures',
  setup(api) {
    api.onResolve({ filter: /.*/ }, (args) => (Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'fixture' } : undefined))
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: stubs[args.path], loader: 'js' }))
  }
}

let checks = 0
const ok = (condition, label, detail) => {
  assert.ok(condition, `${label}${detail === undefined ? '' : ` ← ${JSON.stringify(detail)}`}`)
  checks++
}

const dir = await mkdtemp(join(tmpdir(), 'inkstone-session-delete-browser-'))
try {
  const outfile = join(dir, 'session-delete.mjs')
  await build({
    stdin: {
      contents: "export { deleteSessionChain } from './src/main/session-delete'; export { setSessionBrowserCloser } from './src/main/session-browser-cleanup'",
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    plugins: [plugin],
    logLevel: 'silent'
  })
  const { deleteSessionChain, setSessionBrowserCloser } = await import(pathToFileURL(outfile).href)

  const closed = []
  setSessionBrowserCloser(async (id) => { closed.push(id) })
  const makeHost = ({ chain = null, current = null, statuses = [] } = {}) => ({
    sessionChains: { load: async () => {}, chainOf: () => chain, forget: async () => true },
    ac: () => (current ? { getState: () => ({ sessionFile: current }) } : null),
    runners: () => ({ stopBySessionFile: async () => {}, statuses: () => statuses }),
    pushRunners: () => {}
  })
  const reset = (ids = {}, failOn = null) => { globalThis.__del = { log: [], ids, failOn }; closed.length = 0 }

  const a = resolve('C:/s/a.jsonl')
  const b = resolve('C:/s/b.jsonl')
  const other = resolve('C:/s/other.jsonl')

  reset({ [a]: 'sess-a', [other]: 'sess-other' })
  let result = await deleteSessionChain(makeHost(), 'C:/s/a.jsonl')
  ok(result.ok === true, '删除成功')
  ok(closed.join() === 'sess-a', '删除会话后关闭该会话的浏览器标签，且只关它', closed)

  reset({})
  result = await deleteSessionChain(makeHost({ statuses: [
    { sessionId: 'sess-a-live', sessionFile: 'C:\\s\\A.jsonl' },
    { sessionId: 'sess-other-live', sessionFile: 'C:/s/other.jsonl' }
  ] }), 'C:/s/a.jsonl')
  ok(result.ok === true && closed.join() === 'sess-a-live', '从运行实例反查会话 id（路径大小写与分隔符不同也能对上），不波及其他会话', closed)

  reset({ [a]: 'sess-a', [b]: 'sess-b', [other]: 'sess-other' })
  const chain = { chainId: 'c', updatedAt: 0, segments: [{ sessionFile: 'C:/s/a.jsonl', startedAt: 1, handoffId: null }, { sessionFile: 'C:/s/b.jsonl', startedAt: 2, handoffId: 'h' }] }
  result = await deleteSessionChain(makeHost({ chain }), 'C:/s/a.jsonl')
  ok(result.ok === true && [...closed].sort().join() === 'sess-a,sess-b', '链式会话的每一段都关闭浏览器标签', closed)

  reset({ [a]: 'sess-a' })
  result = await deleteSessionChain(makeHost({ current: 'C:/s/a.jsonl' }), 'C:/s/a.jsonl')
  ok(result.ok === false && closed.length === 0, '拒绝删除当前会话时不关任何标签', closed)

  reset({ [a]: 'sess-a' }, 'C:/s/a.jsonl')
  result = await deleteSessionChain(makeHost(), 'C:/s/a.jsonl')
  ok(result.ok === false && closed.length === 0, '删除失败（已回滚）时不关标签', closed)

  const realPlatform = process.platform
  const withPlatform = async (platform, fn) => {
    Object.defineProperty(process, 'platform', { value: platform })
    try { return await fn() } finally { Object.defineProperty(process, 'platform', { value: realPlatform }) }
  }
  const casedStatuses = [{ sessionId: 'sess-upper', sessionFile: 'C:/s/A.jsonl' }]
  reset({})
  await withPlatform('win32', () => deleteSessionChain(makeHost({ statuses: casedStatuses }), 'C:/s/a.jsonl'))
  ok(closed.join() === 'sess-upper', 'Windows 路径不区分大小写：A.jsonl 与 a.jsonl 视为同一文件', closed)
  reset({})
  await withPlatform('linux', () => deleteSessionChain(makeHost({ statuses: casedStatuses }), 'C:/s/a.jsonl'))
  ok(closed.length === 0, '区分大小写的平台：A.jsonl 与 a.jsonl 是不同会话，不误关', closed)

  setSessionBrowserCloser(async () => { throw new Error('browser gone') })
  reset({ [a]: 'sess-a' })
  result = await deleteSessionChain(makeHost(), 'C:/s/a.jsonl')
  ok(result.ok === true, '浏览器关闭失败不影响删除结果')
} finally {
  await rm(dir, { recursive: true, force: true })
}
console.log(`session-delete browser: ${checks} checks passed`)
