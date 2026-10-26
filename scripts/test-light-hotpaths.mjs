import assert from 'node:assert/strict'
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { build } from 'esbuild'
import ts from 'typescript'

const source = await readFile('src/main/index.ts', 'utf8')
const temp = await mkdtemp(join(tmpdir(), 'inkstone-hotpaths-'))
const previous = process.env.YAN_DATA_DIR
process.env.YAN_DATA_DIR = temp
let checks = 0
const check = (condition, label) => { assert(condition, label); checks++ }
try {
  const sourceTree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const ownershipHelperNames = ['normalizeExpectedRuntime', 'targetMatchesExpected', 'resolveExpectedTarget', 'pinSendTarget', 'pinnedTargetMatches']
  const ownershipHelpers = ownershipHelperNames.map(name => {
    const node = sourceTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
    assert(node, `Missing production helper: ${name}`)
    return node.getText(sourceTree)
  }).join('\n')
  const runStateSource = await readFile('src/core/run-state.ts', 'utf8')
  const runStateTree = ts.createSourceFile('run-state.ts', runStateSource, ts.ScriptTarget.Latest, true)
  const sameEnvelopeNode = runStateTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'sameRuntimeEnvelope')
  assert(sameEnvelopeNode, 'Missing production helper: sameRuntimeEnvelope')
  const ownershipDeps = ownershipHelpers + '\n' + sameEnvelopeNode.getText(runStateTree).replace(/^export /, '')
  const compileHandler = async (name, end, ports, prelude = '') => {
    const start = source.indexOf(`  handle('yan:${name}',`)
    assert(start >= 0)
    const text = source.slice(start, source.indexOf(end, start))
    const { transform } = await import('esbuild')
    const js = await transform(ownershipDeps + '\n' + prelude + '\n' + text, { loader: 'ts', target: 'es2022' })
    let callback
    vm.runInNewContext(js.code, { ...ports, handle: (_channel, handler) => { callback = handler } })
    return callback
  }

  const guardCompiled = await build({
    entryPoints: [resolve('src/main/session-send-guard.ts')],
    bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent'
  })
  const { guardSameCwdExecute } = await import(
    `data:text/javascript;base64,${Buffer.from(guardCompiled.outputFiles[0].text).toString('base64')}`
  )

  let sent, captured = 0, aborted = 0
  let busyElsewhere = false
  const agent = { running: true, workingDirectory: temp, getState: () => ({ sessionId: 'session-a' }), hasRunningBash: () => false,
    send: (...args) => { sent = args; return { ok: true } }, abort: async () => { aborted++; return { steering: ['queued'], followUp: [] } } }
  const runners = {
    activeRunnerId: 'a',
    agentOf: id => id === 'a' ? agent : undefined,
    runtimeOf: id => id === 'a' ? { runId: id, generation: 1, sessionId: agent.getState()?.sessionId, sessionFile: agent.getState()?.sessionFile } : undefined,
    guardExecute: id => {
      const target = id === 'a' ? agent : undefined
      return guardSameCwdExecute(
        target ? { runnerId: id, cwd: target.workingDirectory, selfBusy: target.getState()?.isAgentRunning === true } : null,
        () => busyElsewhere
      )
    },
    admitExecute: () => ({ ok: true, token: 1 }),
    releaseExecute: () => {}
  }
  const ports = { runners, reserveWorkspaceMutation: () => () => {}, warnSharedCwdOnce: () => {}, userMessageSent: () => {},
    getSettings: async () => ({ checkpointsEnabled: true }), captureCheckpoint: async () => { captured++ }, ac: () => agent,
    startAgent: async () => { throw Error('unexpected restart') } }
  const send = await compileHandler('send', "  handle('yan:steer'", ports)
  check((await send('normal message')).ok && sent[0] === 'normal message', '普通发送无需旧目标/模式存储即可到达当前实例')
  check(captured === 1, '普通发送保留检查点')
  await send('steer message', undefined, 'steer')
  check(captured === 1 && sent[2] === 'steer', '插话不创建检查点且保留发送模式')
  agent.getState = () => ({ sessionId: 'session-a', isAgentRunning: true })
  await send('queued message')
  check(captured === 1, '忙碌会话发送保持队列语义')

  agent.getState = () => ({ sessionId: 'session-a' })
  busyElsewhere = true
  const beforeSent = sent
  const rejected = await send('blocked message')
  check(rejected && rejected.ok === false && /同一工作目录/.test(rejected.error ?? ''), '同 cwd 冲突时发送前置复核拒绝')
  check(sent === beforeSent, '被拒绝的发送不调用实例 send')
  check(captured === 1, '被拒绝的发送不创建检查点')
  busyElsewhere = false

  agent.getState = () => ({ sessionId: 'session-a', isAgentRunning: true })
  const stopRunnerStart = source.indexOf('const stopRunner = async')
  assert(stopRunnerStart >= 0, 'Missing production helper: stopRunner')
  const stopRunnerSource = source.slice(stopRunnerStart, source.indexOf('\n\n', stopRunnerStart))
  const abort = await compileHandler('abort', "  handle('yan:runBash'", ports, stopRunnerSource)
  const cleared = await abort()
  check(aborted === 1 && cleared.steering[0] === 'queued', '停止直接终止当前实例，并返回排队文本')
  check((await readdir(temp)).length === 0, '发送与停止不会创建任何旧模式/目标文件')
  const bundle = async (file, name) => {
    const out = join(temp, name + '.mjs')
    await build({ entryPoints: [resolve(file)], outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      plugins: [{ name: 'isolated-electron', setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const app={getPath:()=>${JSON.stringify(temp)},getLocale:()=> 'zh-CN'};` }))
      } }] })
    return import(pathToFileURL(out).href)
  }

  const rootEntries = await readdir(temp)
  check(!rootEntries.includes('goals.json'), '启动与推送不创建目标存储（no-goals）')
  const catalog = await bundle('src/main/capabilities/catalog.ts', 'catalog')
  const built = catalog.buildCatalog([])
  check(!built.capabilities.some(c => /^builtin:(goal|knowledge|follow|research)\./.test(c.id)), '默认模型目录不再推荐已退出的领域流程')
  check(built.capabilities.some(c => c.id === 'builtin:subagent.start' && c.source.location.includes('--model')), '保留指定模型子任务的可执行指引')
  console.log(`PASS: light hotpaths ${checks} checks; no inference`)
} finally {
  if (previous === undefined) delete process.env.YAN_DATA_DIR; else process.env.YAN_DATA_DIR = previous
  await rm(temp, { recursive: true, force: true })
}
