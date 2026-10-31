import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const lines = (entries) => entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
const message = (id, parentId, msg) => ({ type: 'message', id, parentId, timestamp: '2026-10-21T00:00:00.000Z', message: msg })

function parentSession(cwd) {
  return lines([
    { type: 'session', version: 3, id: 'parent-session-1', timestamp: '2026-10-21T00:00:00.000Z', cwd },
    { type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-10-21T00:00:00.000Z', provider: 'commandcode', modelId: 'deepseek/deepseek-v4.1-flash' },
    message('u1', 'm1', { role: 'user', content: [{ type: 'text', text: '先读一下 a.ts，然后派 fork 去改 b.ts' }] }),
    message('a1', 'u1', { role: 'assistant', content: [{ type: 'toolCall', id: 'call-read', name: 'read', arguments: { path: 'a.ts' } }] }),
    message('r1', 'a1', { role: 'toolResult', toolCallId: 'call-read', toolName: 'read', content: [{ type: 'text', text: 'export const a = 1' }] }),
    message('a2', 'r1', { role: 'assistant', content: [
      { type: 'toolCall', id: 'call-done', name: 'read', arguments: { path: 'c.ts' } },
      { type: 'toolCall', id: 'call-fork', name: 'bash', arguments: { command: 'yan subagent start --fork --task "改 b.ts"' } }
    ] }),
    message('r2', 'a2', { role: 'toolResult', toolCallId: 'call-done', toolName: 'read', content: [{ type: 'text', text: 'c' }] })
  ])
}

function fakeRpcFactory() {
  const created = []
  const createRpc = ({ cwd, args }) => {
    const handlers = new Map()
    const rpc = {
      cwd, args, prompts: [], running: false,
      on(event, listener) { handlers.set(event, [...(handlers.get(event) ?? []), listener]); return rpc },
      spawn() { rpc.running = true },
      async command(type, payload) {
        if (type === 'get_state') return { success: true, data: { model: { provider: 'commandcode', id: 'deepseek/deepseek-v4.1-flash' }, thinkingLevel: 'high' } }
        if (type === 'prompt') rpc.prompts.push(payload?.message)
        return { success: true }
      },
      async close() { rpc.running = false },
      emit(event, ...payload) { for (const listener of handlers.get(event) ?? []) listener(...payload) }
    }
    created.push(rpc)
    return rpc
  }
  return { created, createRpc }
}

export async function runSubagentForkTests(ok, fork, SubagentController) {
  const scratch = await mkdtemp(join(tmpdir(), 'inkstone-subagent-fork-'))
  try {
    const args = fork.forkPiArgs(
      ['--no-extensions', '--extension', 'x.js', '--model', 'old/model', '--session-dir', 'D', '--thinking', 'low', '--continue', '--skill', 's'],
      { sessionDir: 'child-dir', sessionFile: 'child.jsonl', model: 'commandcode/deepseek/deepseek-v4.1-flash', thinkingLevel: 'high' }
    )
    ok(args.join(' ') === '--no-extensions --extension x.js --skill s --session-dir child-dir --session child.jsonl --model commandcode/deepseek/deepseek-v4.1-flash --thinking high',
      'fork 启动参数：保留父会话的扩展与技能，换成子会话文件并显式带上父会话的模型与档位', args.join(' '))

    ok(fork.forkContextError({ contextTokens: 100_000, contextWindow: 400_000 }) === undefined, 'fork 上下文：25% 可以派')
    ok(/61%/.test(fork.forkContextError({ contextTokens: 244_000, contextWindow: 400_000 }) ?? ''), 'fork 上下文：超过 60% 拒绝并写明占用')
    ok(fork.forkContextError({}) === undefined, 'fork 上下文：用量未知时不拦')
    ok(/<fork-directive>[\s\S]*改 b\.ts[\s\S]*<\/fork-directive>/.test(fork.forkPrompt('改 b.ts')), 'fork 指令包住任务')

    const source = join(scratch, 'parent.jsonl')
    const original = parentSession(scratch)
    await writeFile(source, original)
    const first = await fork.writeForkSession(source, join(scratch, 'one'), new Date('2026-10-21T01:00:00Z'))
    const second = await fork.writeForkSession(source, join(scratch, 'two'), new Date('2026-10-21T01:00:05Z'))
    ok(await readFile(source, 'utf8') === original, 'fork 会话：不改父会话文件')
    ok(first.sessionId === 'parent-session-1' && first.file.endsWith('_parent-session-1.jsonl'), 'fork 会话：沿用父会话 id（会话级技能路径、缓存 key 一致）', first.file)
    ok(first.placeholders === 1, 'fork 会话：只给未完成的工具调用补占位结果', String(first.placeholders))
    const entries = (await readFile(first.file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    const header = entries[0]
    ok(header.type === 'session' && header.parentSession === source && header.cwd === scratch, 'fork 会话：会话头记录来源')
    const placeholder = entries.at(-1)
    ok(placeholder.parentId === 'r2' && placeholder.message.role === 'toolResult' && placeholder.message.toolCallId === 'call-fork' && placeholder.message.content[0].text === fork.FORK_PLACEHOLDER,
      'fork 会话：占位结果接在当前叶子后面', JSON.stringify(placeholder))
    const strip = (text) => text.trim().split('\n').slice(1).map((line) => { const e = JSON.parse(line); delete e.timestamp; delete e.id; if (e.message) delete e.message.timestamp; delete e.parentId; return JSON.stringify(e) }).join('\n')
    ok(strip(await readFile(first.file, 'utf8')) === strip(await readFile(second.file, 'utf8')), 'fork 会话：并行派出的多个 fork 内容一致（共享前缀）')
    await writeFile(join(scratch, 'broken.jsonl'), '{"type":"message"}\n')
    let rejected = ''
    try { await fork.writeForkSession(join(scratch, 'broken.jsonl'), join(scratch, 'three')) } catch (error) { rejected = error.message }
    ok(/会话头/.test(rejected), 'fork 会话：缺会话头时拒绝', rejected)

    const factory = fakeRpcFactory()
    const archive = join(scratch, 'archive')
    const ctrl = new SubagentController({ cwd: scratch, archiveDir: archive, parentSessionId: 'parent-session-1', createRpc: factory.createRpc,
      prepare: async (rootCwd, _id, isolation) => ({ isolation, rootCwd, cwd: rootCwd }), onChange: () => {} })
    const forkSource = { cwd: scratch, args: ['--no-extensions', '--extension', 'guide.js'], env: { YAN_PROJECT_ID: 'p' }, sessionFile: source, model: 'commandcode/deepseek/deepseek-v4.1-flash', thinkingLevel: 'high' }
    const denied = await ctrl.start('改 b.ts', undefined, 'controlled-cwd', undefined, forkSource)
    ok(!denied.ok && /当前目录/.test(denied.error ?? ''), 'fork 控制器：只读隔离被拒', denied.error)
    const started = await ctrl.start('改 b.ts', 'other/model', 'shared-cwd', { title: '改 b' }, forkSource)
    ok(started.ok && started.run?.fork === true, 'fork 控制器：启动成功并标记 fork', started.error)
    const rpc = factory.created.at(-1)
    const at = (flag) => rpc.args[rpc.args.indexOf(flag) + 1]
    ok(rpc.args[2] === 'guide.js' && at('--model') === forkSource.model && at('--thinking') === 'high', 'fork 控制器：用父会话的启动参数与模型，忽略另行指定的模型', rpc.args.join(' '))
    const childDir = join(archive, 'sessions', started.run.id)
    ok(at('--session-dir') === childDir && at('--session').startsWith(childDir) && (await readdir(childDir)).length === 1, 'fork 控制器：子会话文件写在自己的会话目录')
    ok(rpc.cwd === scratch && /^<fork-directive>/.test(rpc.prompts[0] ?? ''), 'fork 控制器：在父会话目录运行，任务以 fork 指令发出', rpc.prompts[0])
    ok(ctrl.list().find((run) => run.id === started.run.id)?.fork === true, 'fork 控制器：快照里带 fork 标记')
    const forkId = started.run.id
    rpc.emit('event', { type: 'agent_settled', aborted: false })
    for (let i = 0; i < 100 && ctrl.get(forkId)?.status !== 'done'; i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    ok(ctrl.get(forkId)?.status === 'done' && ctrl.get(forkId).resumable?.ok === true, 'fork 控制器：结束后标明可续派', JSON.stringify(ctrl.get(forkId)?.resumable))
    const saved = JSON.parse(await readFile(join(archive, `${forkId}.json`), 'utf8'))
    ok(saved.resume?.forkLaunch?.model === forkSource.model && saved.resume.forkLaunch.args.includes('guide.js') && saved.resume.forkLaunch.env.YAN_PROJECT_ID === 'p', 'fork 控制器：来源信息写进历史记录', JSON.stringify(saved.resume))
    ok(!JSON.stringify(saved.resume).includes('TOKEN'), 'fork 控制器：历史记录不含令牌类环境变量')
    await ctrl.stopAll?.()
    const reopened = new SubagentController({ cwd: scratch, archiveDir: archive, parentSessionId: 'parent-session-1', createRpc: factory.createRpc,
      prepare: async (rootCwd, _id, isolation) => ({ isolation, rootCwd, cwd: rootCwd }), onChange: () => {} })
    await reopened.loadHistory()
    ok(reopened.get(forkId)?.resumable?.ok === true, 'fork 控制器：重启后仍标明可续派', JSON.stringify(reopened.get(forkId)?.resumable))
    const before = factory.created.length
    const resumed = await reopened.send(forkId, '接着改 c.ts', 'steer', { from: 'user' })
    ok(resumed.ok && resumed.delivery === 'resumed' && factory.created.length === before + 1, 'fork 控制器：重启后可续接', JSON.stringify(resumed))
    const again = factory.created.at(-1)
    const atAgain = (flag) => again.args[again.args.indexOf(flag) + 1]
    ok(atAgain('--model') === forkSource.model && again.args.includes('guide.js') && atAgain('--session').startsWith(childDir), 'fork 控制器：续接沿用来源参数与自己的会话文件', again.args.join(' '))
    await reopened.stopAll?.()
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const out = await mkdtemp(join(tmpdir(), 'inkstone-fork-build-'))
  const compile = async (entry, name) => {
    const outfile = join(out, `${name}.mjs`)
    await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
    return import(pathToFileURL(outfile).href)
  }
  let passed = 0
  let failed = 0
  try {
    const fork = await compile('src/main/subagent-fork.ts', 'fork')
    const { SubagentController } = await compile('src/main/subagents.ts', 'controller')
    await runSubagentForkTests((condition, label, detail) => {
      if (condition) passed++
      else { failed++; console.error(`✗ ${label}${detail === undefined ? '' : ` ← ${detail}`}`) }
    }, fork, SubagentController)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
  console.log(`subagent-fork: ${passed} 通过 / ${failed} 失败`)
  if (failed) process.exitCode = 1
}
