import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const work = await mkdtemp(join(tmpdir(), 'yan-isolation-param-'))
process.env.YAN_DATA_DIR = join(work, 'data')
process.env.YAN_PI_DIR = join(work, 'pi')
const entry = join(work, 'entry.ts')
await writeFile(entry, `export { SubagentService, parseIsolation } from ${JSON.stringify(resolve('src/main/subagent-service.ts').split(sep).join('/'))}`)
const outfile = join(work, 'fixture.mjs')
await build({
  entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  plugins: [{ name: 'electron-fixture', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: [
      'export const app = { getPath: () => process.env.YAN_DATA_DIR, getLocale: () => "zh-CN", isPackaged: false, getVersion: () => "0.0.0" }',
      'export const BrowserWindow = class {}',
      'export const safeStorage = { isEncryptionAvailable: () => false }',
      'export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }',
      'export const session = { defaultSession: {}, fromPartition: () => ({}) }'
    ].join('\n') }))
  } }]
})
try {
  const { SubagentService, parseIsolation } = await import(pathToFileURL(outfile).href)
  assert.equal(parseIsolation(undefined), undefined)
  assert.equal(parseIsolation('worktree'), 'worktree')
  assert.equal(parseIsolation(' Worktree '), 'worktree')
  for (const value of ['none', 'shared', 'cwd', 'shared-cwd', false, '']) assert.equal(parseIsolation(value), undefined, `显式不隔离：${String(value)}`)
  for (const value of ['worktee', 'workspace', 'wortree', true, 1, {}]) {
    assert.throws(() => parseIsolation(value), { code: 'subagent_isolation_invalid' }, `写错的值报错：${JSON.stringify(value)}`)
  }

  const starts = []
  const service = new SubagentService({ resolveModelLabel: async () => ({ ok: true, label: 'fixture/fixture' }) })
  service.get = async () => ({
    setContext() {},
    start: async (_task, _model, isolation) => { starts.push(isolation); return { ok: true, run: { id: 'sub-a1b2c3d4', status: 'running', transcript: [], task: 't' } } }
  })
  const context = { cwd: work, parentSessionId: 'p' }
  await service.run('subagent.start', { task: 'x', isolation: 'worktree' }, context)
  await service.run('subagent.start', { task: 'x' }, context)
  await service.run('subagent.start', { task: 'x', isolation: 'none' }, context)
  assert.deepEqual(starts, ['worktree', 'shared-cwd', 'shared-cwd'])
  for (const isolation of ['worktre', true, 'isolated']) {
    await assert.rejects(service.run('subagent.start', { task: 'x', isolation }, context), { code: 'subagent_isolation_invalid' })
  }
  await assert.rejects(service.run('subagent.start', { task: 'x', isolation: 'worktre', fork: true }, context), { code: 'subagent_isolation_invalid' })
  assert.equal(starts.length, 3, '写错 isolation 时不启动子代理，也不退回共享目录')
  const finished = { id: 'sub-a1b2c3d4', status: 'done', task: 't', parentSessionId: 'p', isolation: 'shared-cwd', startedAt: 1, endedAt: 2, review: 'none', transcript: [{ id: 'm1', role: 'assistant', text: '最终结论全文' }], deliverables: [], toolCalls: 0 }
  service.get = async () => ({ setContext() {}, get: () => finished, getFull: async () => finished })
  const plain = await service.run('subagent.get', { id: finished.id }, context)
  const withTranscript = await service.run('subagent.get', { id: finished.id, transcript: true }, context)
  assert.equal(typeof plain.data.finalMessage, 'string')
  assert.equal(withTranscript.data.finalMessage, plain.data.finalMessage, '带 transcript 时结果文件顶层也有 finalMessage（--final 才取得到）')
  assert.ok(withTranscript.data.transcript.length === 1)
  console.log('Subagent service params: ok')
} finally {
  await rm(work, { recursive: true, force: true })
}
