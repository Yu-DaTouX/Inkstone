import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { transform } from 'esbuild'
const source = await readFile('src/main/ipc/files-ipc.ts', 'utf8')
const start = source.indexOf("  handle('yan:attachments:prune',")
const snippet = source.slice(start, source.indexOf('\n  })', start) + '\n  })'.length)
const { code } = await transform(snippet, { loader: 'ts' })
async function fixture(disappear) {
  let callback, afterScan = false, pruned = false
  runInNewContext(code, {
    handle: (_, fn) => { callback = fn }, deps: { isSessionBusy: () => false },
    SESSIONS_DIR: '/fixture/sessions', YAN_DIR: '/fixture', join, existsSync: () => true,
    listSessionFiles: () => ['session.jsonl'],
    stat: async () => { if (disappear && afterScan) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return { size: 1, mtimeMs: 1, ctimeMs: 1 } },
    PRUNE_FINGERPRINT_BATCH: 32, clearSessionReadCache: () => {},
    referencedAttachmentNames: async () => { afterScan = true; return new Set() },
    pruneAttachments: () => { pruned = true; return { removed: 0 } }, Date, JSON
  })
  if (disappear) await assert.rejects(callback(), /会话在扫描期间发生变化/)
  else assert.equal((await callback()).removed, 0)
  assert.equal(pruned, !disappear)
}
await fixture(true)
await fixture(false)
assert.equal(/statSync/.test(snippet), false, '清理指纹不再同步 stat')

async function batchFixture(count, batch) {
  let callback
  const files = Array.from({ length: count }, (_, index) => `session-${index}.jsonl`)
  let seen = 0
  let secondBatchYielded = null
  runInNewContext(code, {
    handle: (_, fn) => { callback = fn }, deps: { isSessionBusy: () => false },
    SESSIONS_DIR: '/fixture/sessions', YAN_DIR: '/fixture', join, existsSync: () => true,
    listSessionFiles: () => files,
    stat: () => {
      const index = seen++
      if (index === batch) secondBatchYielded = yielded
      return new Promise((done) => setImmediate(() => done({ size: 1, mtimeMs: 1, ctimeMs: 1 })))
    },
    PRUNE_FINGERPRINT_BATCH: batch, clearSessionReadCache: () => {},
    referencedAttachmentNames: async () => new Set(),
    pruneAttachments: () => ({ removed: 0 }), Date, JSON
  })
  let yielded = false
  setImmediate(() => { yielded = true })
  const result = await callback()
  return { secondBatchYielded, result }
}
const batched = await batchFixture(200, 32)
assert.equal(batched.result.removed, 0)
assert.equal(batched.secondBatchYielded, true, '第二批 stat 之前事件循环已经跑过（同步实现时该断言失败）')
console.log('attachment-prune-race: 6 assertions passed（200 个会话文件时指纹分批计算，第二批之前已让出事件循环）')
