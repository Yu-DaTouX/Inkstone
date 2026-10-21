import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/renderer/src/features/composer/draft-store.ts', import.meta.url))
const result = await build({ entryPoints: [source], bundle: true, write: false, platform: 'node', format: 'esm' })
const {
  parseDrafts,
  putDraft,
  draftOf,
  trimDraftAttachments,
  DRAFT_LIMIT,
  DRAFT_ATTACHMENT_BUDGET,
  DRAFT_STORAGE_KEY,
  readDrafts,
  writeDrafts,
  saveDraft,
  loadDraft
} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

const image = (id, size = 8) => ({
  id,
  name: `${id}.png`,
  mimeType: 'image/png',
  size,
  data: 'A'.repeat(8),
  preview: 'A'.repeat(8),
  kind: 'image'
})
const fileRef = (id, path = 'E:/repo/README.md') => ({
  id,
  name: 'README.md',
  mimeType: 'text/markdown',
  size: 10,
  data: '',
  preview: '',
  kind: 'file',
  path
})

assert.deepEqual(parseDrafts(null), {})
assert.deepEqual(parseDrafts([]), {})
assert.deepEqual(parseDrafts({ a: { text: 'x', attachments: [], at: 5 } }), { a: { text: 'x', attachments: [], at: 5 } })
assert.deepEqual(parseDrafts({ a: { text: '', attachments: [] } }), {}, '空白草稿丢弃')
assert.equal(parseDrafts({ a: { text: 'x', attachments: [{ id: 'bad' }] } }).a.attachments.length, 0, '坏附件丢弃')
assert.equal(parseDrafts({ a: { text: 'x', attachments: [fileRef('f')] } }).a.attachments.length, 1, '文件引用保留')
assert.equal(parseDrafts({ a: { text: 'x', attachments: [{ ...fileRef('f'), path: '' }] } }).a.attachments.length, 0, '没有路径的文件引用丢弃')
assert.equal(parseDrafts({ a: { text: 'x', attachments: [image('i')] } }).a.attachments.length, 1, '图片保留')
assert.equal(parseDrafts({ a: { text: 'x', attachments: [], at: 'nope' } }).a.at, 0, '时间戳异常归零')

assert.equal(trimDraftAttachments([image('i'), fileRef('f')]).length, 2, '预算内原样保留')
const big = trimDraftAttachments([{ ...image('big'), data: 'A'.repeat(DRAFT_ATTACHMENT_BUDGET) }, fileRef('f')])
assert.equal(big.length, 1, '超预算时只留文件引用')
assert.equal(big[0].kind, 'file')

let map = {}
map = putDraft(map, 'session:1', { text: '草稿一', attachments: [] }, 1)
assert.equal(draftOf(map, 'session:1')?.text, '草稿一')
assert.equal(draftOf(map, undefined), undefined)
assert.equal(draftOf({}, 'session:1'), undefined)

map = putDraft(map, 'session:1', { text: '', attachments: [] }, 2)
assert.equal(draftOf(map, 'session:1'), undefined, '清空即删除条目')

map = putDraft(map, 'session:1', { text: '甲', attachments: [fileRef('f')] }, 3)
assert.equal(draftOf(map, 'session:1')?.attachments[0].path, 'E:/repo/README.md', '文件引用随草稿保存')

for (let i = 0; i < DRAFT_LIMIT + 3; i += 1) {
  map = putDraft(map, `session:${i}`, { text: `d${i}`, attachments: [] }, 100 + i)
}
assert.equal(Object.keys(map).length, DRAFT_LIMIT, `最多保留 ${DRAFT_LIMIT} 条草稿`)
assert.ok(draftOf(map, 'session:0') === undefined, '最老的草稿被淘汰')
assert.ok(draftOf(map, `session:${DRAFT_LIMIT + 2}`), '最新的草稿保留')

const now = 500
const kept = putDraft({}, 'k', { text: 'x', attachments: [image('i')] }, now)
assert.equal(kept.k.at, now, '记录保存时间')

const guarded = putDraft(
  { a: { text: 'A'.repeat(50), attachments: [], at: 1 } },
  'b',
  { text: 'B'.repeat(50), attachments: [] },
  2,
  { maxTotal: 60 }
)
assert.ok(draftOf(guarded, 'a') === undefined, '总量超预算时淘汰其它草稿')
assert.ok(draftOf(guarded, 'b'), '刚保存的草稿保留')

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(String(key)) ? storage.get(String(key)) : null),
  setItem: (key, value) => storage.set(String(key), String(value)),
  removeItem: (key) => storage.delete(String(key))
}

saveDraft('session:c1', { text: '甲', attachments: [] }, 10)
assert.equal(loadDraft('session:c1')?.text, '甲', '保存后能读回草稿')
const before = readDrafts()
storage.set(DRAFT_STORAGE_KEY, JSON.stringify({ 'session:c1': { text: '乙', attachments: [], at: 20 } }))
assert.equal(readDrafts(), before, '重复读取直接复用缓存对象，不再逐次解析整份草稿表')
assert.equal(loadDraft('session:c1')?.text, '甲', '缓存命中时不回读 localStorage')
saveDraft('session:c2', { text: '丙', attachments: [] }, 30)
assert.deepEqual(Object.keys(JSON.parse(storage.get(DRAFT_STORAGE_KEY))).sort(), ['session:c1', 'session:c2'], '缓存与落盘保持一致')
writeDrafts({})
assert.equal(loadDraft('session:c1'), undefined, '写入空表后清空内存缓存与 localStorage')
assert.equal(storage.has(DRAFT_STORAGE_KEY), false, '空草稿表删除存储键')

console.log('输入框草稿持久化：解析、附件预算、上限淘汰、清空、缓存复用与总量控制检查通过')
