import './lib/test-isolate.mjs'
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
    hasActiveWriter: () => false,
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
  const levels = []
  const briefs = []
  service.get = async () => ({
    setContext() {},
    hasActiveWriter: () => false,
    start: async (_task, _model, _isolation, brief, _resume, startContext) => {
      levels.push(startContext.thinkingLevel)
      briefs.push(brief)
      return { ok: true, run: { id: 'sub-a1b2c3d4', status: 'running', transcript: [], task: 't', ...(brief?.title ? { brief: { goal: 'x', deliverables: [], sources: [], boundary: '', ...brief } } : {}) } }
    }
  })
  for (const thinking of ['off', 'xhigh', 'max', ' MAX ']) await service.run('subagent.start', { task: 'x', thinking, isolation: 'none' }, context)
  const titledStart = await service.run('subagent.start', { task: 'x', title: '查接口边界', thinkingLevel: 'max', isolation: 'none' }, context)
  assert.equal(briefs.at(-1)?.title, '查接口边界', 'subagent.start 将 title 写入 brief')
  assert.equal(titledStart.summary.title, '查接口边界', 'subagent.start 摘要回传 title')
  assert.deepEqual(levels, ['off', 'xhigh', 'max', 'max', 'max'], '子代理入口接受与主会话相同的思考档，含 max')
  for (const thinking of ['ultra', '', 5]) {
    await assert.rejects(service.run('subagent.start', { task: 'x', thinking, isolation: 'none' }, context), { code: 'subagent_thinking_invalid' }, `写错的思考档报错：${JSON.stringify(thinking)}`)
  }
  await assert.rejects(service.run('subagent.start', { task: 'x', thinking: 'max', fork: true }, context), { code: 'subagent_fork_thinking' })
  assert.equal(levels.length, 5, '写错思考档时不启动子代理')
  const autoStarts = []
  let activeWriter = false
  const gitDir = await mkdtemp(join(tmpdir(), 'yan-auto-worktree-'))
  await writeFile(join(gitDir, 'a.txt'), 'x')
  const { spawnSync } = await import('node:child_process')
  spawnSync('git', ['init', '-q'], { cwd: gitDir })
  spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: gitDir })
  const unbornDir = await mkdtemp(join(tmpdir(), 'yan-auto-unborn-'))
  spawnSync('git', ['init', '-q'], { cwd: unbornDir })
  const plainDir = await mkdtemp(join(tmpdir(), 'yan-auto-shared-'))
  let release
  const gate = new Promise((done) => { release = done })
  service.get = async () => ({
    setContext() {},
    hasActiveWriter: () => activeWriter,
    start: async (_task, _model, isolation) => {
      autoStarts.push(isolation)
      if (autoStarts.length === 1) await gate
      return { ok: true, run: { id: 'sub-a1b2c3d4', status: 'running', transcript: [], task: 't', isolation } }
    }
  })
  const first = service.run('subagent.start', { task: 'x' }, { cwd: gitDir, parentSessionId: 'p' })
  await new Promise((done) => setTimeout(done, 20))
  const second = await service.run('subagent.start', { task: 'y' }, { cwd: gitDir, parentSessionId: 'p' })
  assert.equal(second.summary.isolation, 'worktree', '同时派出的第二个写入型子代理自动进 worktree，不被启动竞态漏掉')
  assert.match(second.summary.note, /worktree/)
  release()
  const firstResult = await first
  assert.equal(firstResult.summary.isolation, 'shared-cwd', '第一个仍在当前目录')
  assert.equal(firstResult.summary.note, undefined)
  activeWriter = true
  assert.equal((await service.run('subagent.start', { task: 'z' }, { cwd: gitDir })).summary.isolation, 'worktree', '已有写入者在跑时自动隔离')
  assert.equal((await service.run('subagent.start', { task: 'z', isolation: 'none' }, { cwd: gitDir })).summary.isolation, 'shared-cwd', '显式 none 不隔离')
  assert.equal((await service.run('subagent.start', { task: 'z', 'read-only': true }, { cwd: gitDir })).summary.isolation, 'controlled-cwd', '只读不隔离')
  const nonGit = await service.run('subagent.start', { task: 'z' }, { cwd: plainDir })
  assert.equal(nonGit.summary.isolation, 'shared-cwd', '非 Git 目录退回共享')
  assert.match(nonGit.summary.note, /not a Git project/)
  assert.equal((await service.run('subagent.start', { task: 'z' }, { cwd: unbornDir })).summary.isolation, 'shared-cwd', '还没有提交的仓库退回共享，不启动失败')
  await rm(unbornDir, { recursive: true, force: true })
  await rm(gitDir, { recursive: true, force: true })
  await rm(plainDir, { recursive: true, force: true })

  const longTask = '很长的子代理任务说明。'.repeat(20_000)
  const longCalls = []
  const sendOpts = []
  const modelCalls = []
  service.get = async () => ({
    setContext() {},
    hasActiveWriter: () => false,
    parentOwns: () => true,
    start: async (task) => { longCalls.push(['start', task]); return { ok: true, run: { id: 'sub-a1b2c3d4', status: 'running', transcript: [], task } } },
    send: async (_id, message, _mode, origin) => {
      longCalls.push(['send', message])
      sendOpts.push(origin)
      return { ok: true, delivery: 'queued', run: { id: 'sub-a1b2c3d4', status: 'running', model: origin?.model ?? 'fixture/fixture', thinkingLevel: origin?.thinkingLevel, transcript: [], task: 't' } }
    },
    setModel: async (id, options) => {
      modelCalls.push({ id, ...options })
      return { ok: true, applied: 'live', run: { id, status: 'running', model: options.model ?? 'fixture/fixture', thinkingLevel: options.thinkingLevel, transcript: [], task: 't' } }
    }
  })
  await service.run('subagent.start', { task: longTask, isolation: 'none' }, context)
  await service.run('subagent.send', { id: 'sub-a1b2c3d4', message: longTask }, context)
  assert.deepEqual(longCalls.map(([kind, text]) => [kind, text.length]), [['start', longTask.length], ['send', longTask.length]], '很长的任务文本能启动、能续派，不按长度拒绝或截断')
  const sendWithModel = await service.run('subagent.send', { id: 'sub-a1b2c3d4', message: '继续', model: 'opencode-go/deepseek-v4.1-flash', thinkingLevel: 'HIGH' }, context)
  assert.equal(sendOpts.at(-1)?.model, 'fixture/fixture', 'subagent.send 经过 resolveModelLabel 解析模型')
  assert.equal(sendOpts.at(-1)?.thinkingLevel, 'high', 'subagent.send 规范化并透传 thinkingLevel')
  assert.equal(sendWithModel.summary.model, 'fixture/fixture')
  const switched = await service.run('subagent.set_model', { id: 'sub-a1b2c3d4', model: 'opencode-go/deepseek-v4.1-flash', thinking: 'medium' }, context)
  assert.equal(modelCalls.length, 1)
  assert.equal(switched.summary.applied, 'live')
  assert.equal(switched.summary.thinkingLevel, 'medium')
  await assert.rejects(service.run('subagent.set_model', { id: 'sub-a1b2c3d4' }, context), { code: 'subagent_model_required' })

  const finished = { id: 'sub-a1b2c3d4', status: 'done', task: 't', parentSessionId: 'p', isolation: 'shared-cwd', startedAt: 1, endedAt: 2, review: 'none', transcript: [{ id: 'm1', role: 'assistant', text: '最终结论全文' }], deliverables: [], toolCalls: 0 }
  service.get = async () => ({ setContext() {}, get: () => finished, getFull: async () => finished, parentOwns: (id, sessionId) => sessionId === finished.parentSessionId })
  const plain = await service.run('subagent.get', { id: finished.id }, context)
  const withTranscript = await service.run('subagent.get', { id: finished.id, transcript: true }, context)
  assert.equal(typeof plain.data.finalMessage, 'string')
  assert.equal(withTranscript.data.finalMessage, plain.data.finalMessage, '带 transcript 时结果文件顶层也有 finalMessage（--final 才取得到）')
  assert.ok(withTranscript.data.transcript.length === 1)
  console.log('Subagent service params: ok')
} finally {
  await rm(work, { recursive: true, force: true })
}
