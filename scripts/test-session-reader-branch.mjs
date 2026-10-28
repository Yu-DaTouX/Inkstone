import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'yan-reader-branch-'))
const line = (x) => JSON.stringify(x) + '\n'
const head = line({ type: 'session', version: 3, id: 'branch-session', cwd: 'C:/synthetic' })
const msg = (id, parentId, role, text) => line({ type: 'message', id, parentId, message: { role, content: [{ type: 'text', text }] } })
const texts = (result) => result.messages.map((m) => m.text)

try {
  const moduleFile = join(dir, 'reader.mjs')
  await build({ stdin: { contents: "export { readSessionMessages, leafBranch } from './src/main/session-reader'", resolveDir: process.cwd(), sourcefile: 'reader-branch.ts', loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: moduleFile })
  const { readSessionMessages, leafBranch } = await import(pathToFileURL(moduleFile))

  const branched = join(dir, 'branched.jsonl')
  await writeFile(branched, head +
    msg('u1', null, 'user', '第一句') +
    msg('a1', 'u1', 'assistant', '回复一') +
    msg('u2a', 'a1', 'user', '第二句 A') +
    msg('a2a', 'u2a', 'assistant', '回复 A') +
    msg('u2b', 'a1', 'user', '第二句 B') +
    msg('a2b', 'u2b', 'assistant', '回复 B') +
    line({ type: 'model_change', id: 'mc', parentId: 'a2b', provider: 'fake', modelId: 'm' }) +
    msg('u3', 'mc', 'user', '第三句'))
  const result = await readSessionMessages(branched)
  assert.deepEqual(texts(result), ['第一句', '回复一', '第二句 B', '回复 B', '第三句'], '只读当前叶子所在分支')
  assert.deepEqual(result.messages.map((m) => m.entryId), ['u1', 'a1', 'u2b', 'a2b', 'u3'])

  const backToA = join(dir, 'back-to-a.jsonl')
  await writeFile(backToA, head +
    msg('u1', null, 'user', '第一句') +
    msg('u2a', 'u1', 'user', '第二句 A') +
    msg('u2b', 'u1', 'user', '第二句 B') +
    msg('u3a', 'u2a', 'user', '接在 A 后'))
  assert.deepEqual(texts(await readSessionMessages(backToA)), ['第一句', '第二句 A', '接在 A 后'], '叶子回到旧分支时只显示旧分支')

  const legacy = join(dir, 'legacy.jsonl')
  await writeFile(legacy, head +
    line({ type: 'message', id: 'x1', message: { role: 'user', content: [{ type: 'text', text: '旧格式一' }] } }) +
    line({ type: 'message', id: 'x2', message: { role: 'user', content: [{ type: 'text', text: '旧格式二' }] } }))
  assert.deepEqual(texts(await readSessionMessages(legacy)), ['旧格式一', '旧格式二'], '没有 parentId 的旧文件全部保留')

  const staleTitle = join(dir, 'stale-title.jsonl')
  await writeFile(staleTitle, head +
    msg('u1', null, 'user', '第一句') +
    msg('a1', 'u1', 'assistant', '回复一') +
    msg('u2', 'a1', 'user', '第二句') +
    line({ type: 'session_info', id: 'info', parentId: 'a1', name: '另一个进程写的标题' }))
  assert.deepEqual(texts(await readSessionMessages(staleTitle)), ['第一句', '回复一', '第二句'], '末尾元数据条目的父节点过时时不藏掉最新消息')

  assert.deepEqual(leafBranch([{ id: 'a', parentId: null, value: 1 }, { id: 'b', parentId: 'a', value: 2 }, { id: 'c', parentId: 'a' }]).map((e) => e.id), ['a'], '叶子是非消息条目时沿它的父链走')
  assert.deepEqual(leafBranch([{ id: 'a', parentId: 'b', value: 1 }, { id: 'b', parentId: 'a', value: 2 }]).map((e) => e.id), ['a', 'b'], '父链成环时不死循环')
  console.log('test-session-reader-branch 通过')
} finally {
  await rm(dir, { recursive: true, force: true })
}
