import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-attachments-read-'))
const yanDir = join(root, 'yan')
const attachments = join(yanDir, 'attachments')
await mkdir(attachments, { recursive: true })

const plugin = {
  name: 'files-ipc-fixtures',
  setup(api) {
    api.onResolve({ filter: /^\.\.\/paths$/ }, () => ({ path: 'paths', namespace: 'fixture' }))
    api.onResolve({ filter: /^\.\.?\// }, (args) => (args.kind === 'entry-point' ? undefined : { path: args.path, namespace: 'inert' }))
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `exports.YAN_DIR = ${JSON.stringify(yanDir)}`, loader: 'js' }))
    api.onLoad({ filter: /.*/, namespace: 'inert' }, () => ({ contents: 'module.exports = new Proxy({}, { get: () => () => undefined })', loader: 'js' }))
  }
}

try {
  const outfile = join(root, 'files-ipc.cjs')
  await build({ entryPoints: ['src/main/ipc/files-ipc.ts'], outfile, bundle: true, platform: 'node', format: 'cjs', plugins: [plugin], logLevel: 'silent' })
  const loaded = createRequire(import.meta.url)(outfile)
  const { registerFilesIpc } = loaded
  const handlers = new Map()
  registerFilesIpc({ handle: (channel, fn) => handlers.set(channel, fn), rawHandle: (channel, fn) => handlers.set(channel, fn) }, {})
  const read = handlers.get('yan:attachments:read')
  assert.equal(typeof read, 'function', '注册了附件读回通道')

  const hash = 'a'.repeat(40)
  const png = Buffer.from([137, 80, 78, 71, 1, 2, 3])
  await writeFile(join(attachments, `${hash}.png`), png)
  await writeFile(join(attachments, `${'b'.repeat(40)}.jpg`), Buffer.from('jpg-bytes'))
  await writeFile(join(attachments, 'notes.txt'), 'secret')
  await writeFile(join(attachments, `${'a'.repeat(40)}xpng`), 'x')
  await writeFile(join(attachments, `${'c'.repeat(40)}.svg`), '<svg/>')
  await writeFile(join(attachments, `${'d'.repeat(39)}.png`), 'short')
  await writeFile(join(yanDir, `${'e'.repeat(40)}.png`), 'outside')
  await mkdir(join(attachments, 'nested'))
  await writeFile(join(attachments, 'nested', `${'f'.repeat(40)}.png`), 'nested')
  const url = (path) => pathToFileURL(path).href

  const good = await read(url(join(attachments, `${hash}.png`)))
  assert.deepEqual({ ok: good.ok, mimeType: good.mimeType, data: good.data }, { ok: true, mimeType: 'image/png', data: png.toString('base64') }, '附件目录内的内容寻址图片原样读回')
  const jpg = await read(url(join(attachments, `${'b'.repeat(40)}.jpg`)))
  assert.equal(jpg.ok === true && jpg.mimeType, 'image/jpeg', 'jpg 的 MIME 是 image/jpeg')

  for (const [label, target] of [
    ['非内容寻址文件名', join(attachments, 'notes.txt')],
    ['不在白名单里的扩展名', join(attachments, `${'c'.repeat(40)}.svg`)],
    ['扩展名前不是点号', join(attachments, `${'a'.repeat(40)}xpng`)],
    ['哈希长度不对', join(attachments, `${'d'.repeat(39)}.png`)],
    ['附件目录之外', join(yanDir, `${'e'.repeat(40)}.png`)],
    ['附件目录的子目录', join(attachments, 'nested', `${'f'.repeat(40)}.png`)],
    ['用 .. 逃出附件目录', join(attachments, '..', `${'e'.repeat(40)}.png`)],
    ['附件目录内但文件不存在', join(attachments, `${'9'.repeat(40)}.png`)]
  ]) {
    assert.deepEqual(await read(url(target)), { ok: false }, `拒绝：${label}`)
  }
  for (const [label, value] of [['非 file 地址', 'https://example.com/a.png'], ['空字符串', ''], ['undefined', undefined], ['对象', {}], ['相对路径', `${hash}.png`]]) {
    assert.deepEqual(await read(value), { ok: false }, `拒绝：${label}`)
  }
  assert.deepEqual(await read(url(join(attachments, `${hash}.png`)).replace('file:///', 'file://remote-host/')), { ok: false }, '拒绝：远程主机的 file 地址')

  console.log('attachments-read-ipc: 只读附件目录内的内容寻址图片，其余路径一律拒绝')
} finally {
  await rm(root, { recursive: true, force: true })
}
