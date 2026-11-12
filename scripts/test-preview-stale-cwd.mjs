import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-preview-stale-cwd-'))
const gone = join(root, 'gone-project')
const file = join(root, '附件 测试.md')
await writeFile(file, '# 附件\n内容\n')

const real = new Set(['../file-refs', './file-path-gate', './file-preview-classify', './office/pdf-text', '../shared/ui-lang', '../../shared/ui-lang'])
const plugin = {
  name: 'preview-stale-cwd',
  setup(api) {
    api.onResolve({ filter: /^\.\.\/settings$/ }, () => ({ path: 'settings', namespace: 'fixture' }))
    api.onResolve({ filter: /^\.\.?\// }, (args) => (args.kind === 'entry-point' || real.has(args.path) || args.importer.includes('file-refs') || args.importer.includes('file-path-gate') || args.importer.includes('file-preview-classify') || args.importer.includes('pdf-text') ? undefined : { path: args.path, namespace: 'inert' }))
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `exports.getSettings = async () => ({ cwd: ${JSON.stringify(gone)}, projects: [] })`, loader: 'js' }))
    api.onLoad({ filter: /.*/, namespace: 'inert' }, () => ({ contents: 'module.exports = new Proxy({}, { get: () => () => undefined })', loader: 'js' }))
  }
}

try {
  const outfile = join(root, 'files-ipc.cjs')
  await build({ entryPoints: ['src/main/ipc/files-ipc.ts'], outfile, bundle: true, platform: 'node', format: 'cjs', plugins: [plugin], logLevel: 'silent', external: ['electron', 'pdfjs-dist', 'pdfjs-dist/*'] })
  const { registerFilesIpc } = createRequire(import.meta.url)(outfile)
  const handlers = new Map()
  const resolveFileContext = async (_settings, fallback, raw) => {
    const cwd = raw?.cwd ?? fallback
    if (cwd === gone) return { ok: false, context: { cwd, generation: 0 }, error: '工作目录不存在或不可访问' }
    if (cwd !== root) return { ok: false, context: { cwd, generation: 0 }, error: '工作目录不属于已授权的项目或会话' }
    return { ok: true, context: { cwd, generation: 0 } }
  }
  registerFilesIpc({ handle: (channel, fn) => handlers.set(channel, fn), rawHandle: (channel, fn) => handlers.set(channel, (...args) => fn({}, ...args)) }, { resolveFileContext, isSessionBusy: () => false })

  const read = handlers.get('yan:readPreview')
  const stale = await read(file)
  assert.equal(stale.ok, true, `默认工作目录已失效时，绝对路径附件照常读取：${stale.error ?? ''}`)
  assert.match(stale.text ?? '', /内容/, '读到正文')
  assert.equal(stale.outsideRoot, true, '仍标记为项目外')

  const bytes = await handlers.get('yan:readPreviewBytes')(file)
  assert.equal(bytes.ok, true, '字节读取同样不受失效工作目录影响')
  const st = await handlers.get('yan:statPreview')(file)
  assert.equal(st.ok, true, '文件信息同样可读')

  const relative = await read('README.md')
  assert.equal(relative.ok, false, '相对路径仍需要有效的工作目录')

  const unauthorized = await read(file, undefined, join(root, 'other'))
  assert.equal(unauthorized.ok, false, '显式传入未授权的工作目录仍然拒绝')
  assert.match(unauthorized.error ?? '', /未授权|不属于/, '拒绝原因是未授权')

  console.log('test-preview-stale-cwd: 7/7 通过')
} finally {
  await rm(root, { recursive: true, force: true })
}
