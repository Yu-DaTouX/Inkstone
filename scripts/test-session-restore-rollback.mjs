/** 执行现场restoreSession，模拟第二条搬移失败及第一条回滚失败，随后重试。 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { transform } from 'esbuild'
const source = await readFile('src/main/sessions.ts', 'utf8')
const start = source.indexOf('export async function restoreSession(')
const { code } = await transform(source.slice(start).replace('export async', 'async') + '\nglobalThis.restoreSession=restoreSession', { loader: 'ts' })
const first = { from: '/original/a', to: '/trash/a' }, second = { from: '/original/b', to: '/trash/b' }
const deleted = new Map([['token', [first, second]]])
const calls = []
let fault = true
const context = { deleted, resolve, mkdir: async () => {}, rename: async (from, to) => {
 calls.push([from, to])
 if (fault && (from === second.to || from === first.from)) throw new Error('fixture rename failure')
} }
runInNewContext(code, context)
await assert.rejects(context.restoreSession('token'), /1 个已恢复条目未能回滚/)
assert.equal(JSON.stringify(deleted.get('token')), JSON.stringify([second]))
fault = false
await context.restoreSession('token')
assert.equal(deleted.has('token'), false)
assert.equal(calls.filter(([from]) => from === first.to).length, 1)
assert.equal(calls.filter(([from]) => from === second.to).length, 2)
console.log('session-restore-rollback: 5 assertions passed (不操作真实会话)')
