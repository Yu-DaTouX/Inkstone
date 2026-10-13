/** 现场附件清理IPC回调：目录扫描期间消失的文件不得产生裸stat异常或误删。 */
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
    PI_AGENT_DIR: '/fixture', YAN_DIR: '/fixture', join, existsSync: () => true,
    listSessionFiles: () => ['session.jsonl'],
    statSync: () => { if (disappear && afterScan) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return { size: 1, mtimeMs: 1, ctimeMs: 1 } },
    referencedAttachmentNames: async () => { afterScan = true; return new Set() },
    pruneAttachments: () => { pruned = true; return { removed: 0 } }, Date, JSON
  })
  if (disappear) await assert.rejects(callback(), /会话在扫描期间发生变化/)
  else assert.equal((await callback()).removed, 0)
  assert.equal(pruned, !disappear)
}
await fixture(true)
await fixture(false)
console.log('attachment-prune-race: 4 assertions passed')
