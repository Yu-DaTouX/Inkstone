#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runSuite } from './lib/test-suite.mjs'

const lines = (entries) => entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
const message = (id, parentId, msg) => ({ type: 'message', id, parentId, timestamp: '2026-11-12T00:00:00.000Z', message: msg })

function fakeRpcFactory() {
  const created = []
  const createRpc = ({ cwd, args }) => {
    const handlers = new Map()
    const rpc = {
      cwd, args, prompts: [], running: false,
      on(event, listener) { handlers.set(event, [...(handlers.get(event) ?? []), listener]); return rpc },
      spawn() { rpc.running = true },
      async command(type, payload) {
        if (type === 'get_state') return { success: true, data: { model: { provider: 'anthropic', id: 'claude-opus-5-5' }, thinkingLevel: 'high' } }
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

await runSuite(import.meta.url, async (ok, compile) => {
  const extension = await import(pathToFileURL(join(process.cwd(), 'resources/pi-extensions/side-question.js')).href)
  const hooks = (env) => {
    const handlers = {}
    extension.default({ on: (name, fn) => { handlers[name] = fn } }, env)
    return handlers
  }
  ok(Object.keys(hooks({})).length === 0, '普通会话不加载拦截')
  const active = hooks({ YAN_SIDE_QUESTION: '1' })
  const blocked = active.tool_call?.({ toolName: 'edit', input: { path: 'a.ts' } })
  ok(blocked?.block === true && blocked.reason === extension.SIDE_QUESTION_BLOCK, '旁路快问里任何工具调用都被拦下并说明没有执行')
  ok(active.tool_call({ toolName: 'read', input: { path: 'a.ts' } })?.block === true, '只读工具同样不执行')

  const fork = await compile('src/main/subagent-fork.ts')
  const base = { cwd: 'C:/p', args: ['--mode', 'rpc', '--no-extensions', '--extension', 'danger-guard.js'], env: { YAN_PROJECT_ID: 'p' }, sessionFile: 'parent.jsonl', model: 'anthropic/claude-opus-5-5', thinkingLevel: 'high' }
  const side = fork.sideQuestionForkSource(base, 'side-question.js')
  ok(side.sideQuestion === true && side.env.YAN_SIDE_QUESTION === '1' && side.env.YAN_PROJECT_ID === 'p' && !base.env.YAN_SIDE_QUESTION, '旁路来源：带标记与环境变量，不改原来源')
  const args = fork.forkPiArgs(side.args, { sessionDir: 'd', sessionFile: 'f.jsonl', model: side.model, thinkingLevel: side.thinkingLevel })
  const extensions = args.flatMap((arg, index) => (args[index - 1] === '--extension' ? [arg] : []))
  ok(extensions.join() === 'side-question.js,danger-guard.js', '拦截扩展排在守卫之前加载，先于审批生效', extensions.join())
  ok(args.join(' ').endsWith('--model anthropic/claude-opus-5-5 --thinking high'), '沿用父会话模型与思考档（缓存前缀一致）', args.join(' '))
  const prompt = fork.sideQuestionPrompt('这个函数为什么要加锁？')
  ok(/^<side-question>[\s\S]*Tools are disabled[\s\S]*这个函数为什么要加锁？\n<\/side-question>$/.test(prompt), '旁路指令说明不用工具并包住问题')

  const { isForkDirective } = await compile('src/shared/host-notice-text.ts')
  ok(isForkDirective(prompt) && !isForkDirective('<side-question>问题</side-question> 以及别的'), '记录面板把旁路指令当宿主包装隐藏，只显示问题')

  const resume = await compile('src/main/subagent-resume.ts')
  const saved = resume.persistableForkLaunch(side)
  ok(saved.sideQuestion === true && saved.args[1] === 'side-question.js' && saved.env.YAN_SIDE_QUESTION === '1', '历史记录保存旁路标记，续接时仍不执行工具')

  const { SubagentController } = await compile('src/main/subagents.ts')
  const scratch = await mkdtemp(join(tmpdir(), 'inkstone-side-question-'))
  try {
    const parent = join(scratch, 'parent.jsonl')
    await writeFile(parent, lines([
      { type: 'session', version: 3, id: 'parent-1', timestamp: '2026-11-12T00:00:00.000Z', cwd: scratch },
      message('u1', null, { role: 'user', content: [{ type: 'text', text: '重构队列' }] }),
      message('a1', 'u1', { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'npm test' } }] })
    ]))
    const factory = fakeRpcFactory()
    const archive = join(scratch, 'archive')
    const changes = []
    const ctrl = new SubagentController({ cwd: scratch, archiveDir: archive, parentSessionId: 'parent-1', createRpc: factory.createRpc,
      prepare: async (rootCwd, _id, isolation) => ({ isolation, rootCwd, cwd: rootCwd }), onChange: (run) => changes.push(run) })
    const started = await ctrl.start('为什么先跑测试？', side.model, 'shared-cwd', { title: '旁路快问' }, { ...side, cwd: scratch, sessionFile: parent }, { cwd: scratch, parentSessionId: 'parent-1', parentMessageId: 'a1' })
    ok(started.ok && started.run?.sideQuestion === true && started.run.fork === true && started.run.parentMessageId === 'a1', '旁路快问作为 fork 子代理启动，挂在最近一条回复下', started.error)
    const rpc = factory.created.at(-1)
    ok(/^<side-question>/.test(rpc.prompts[0] ?? '') && !rpc.prompts[0].includes('<fork-directive>'), '发出的是旁路指令而不是 fork 任务指令')
    ok(rpc.args.includes('side-question.js') && rpc.cwd === scratch, '子进程带上拦截扩展，在父会话目录运行')
    rpc.emit('event', { type: 'agent_settled', aborted: false })
    for (let i = 0; i < 100 && ctrl.get(started.run.id)?.status !== 'done'; i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    ok(ctrl.get(started.run.id)?.sideQuestion === true, '结束后快照仍带旁路标记')
    const record = JSON.parse(await readFile(join(archive, `${started.run.id}.json`), 'utf8'))
    ok(record.sideQuestion === true && record.resume?.forkLaunch?.sideQuestion === true, '历史记录里的运行与启动参数都带旁路标记')
    await ctrl.stopAll?.()
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }

  const { submitComposerInput } = await compile('src/renderer/src/lib/composer-submit.ts')
  const submit = async (text, overrides = {}) => {
    const calls = { asked: [], notes: [], sent: [], restored: [] }
    const outcome = await submitComposerInput({
      text, attachments: [], models: [], session: null, thinkingLevels: [], roundRunning: true, isCompacting: false,
      commands: [{ name: 'btw', source: 'yan', executable: true }],
      t: (key) => key,
      actions: {
        askSideQuestion: async (question) => { calls.asked.push(question); return overrides.result ?? { ok: true } },
        notify: (level, note) => calls.notes.push([level, note])
      },
      clearText: () => undefined, clearAll: () => undefined,
      restoreText: (raw) => calls.restored.push(raw), restoreAttachments: () => undefined, readAttachments: () => [],
      send: async (outgoing, _images, mode) => { calls.sent.push([outgoing, mode]); return true },
      holdSend: () => undefined, focusComposer: () => undefined
    })
    return { outcome, ...calls }
  }
  const asked = await submit('/btw 为什么先跑测试？')
  ok(asked.outcome === 'handled' && asked.asked.join() === '为什么先跑测试？' && asked.sent.length === 0, '运行中输入 /btw 走旁路，不进主会话排队')
  const empty = await submit('/btw')
  ok(empty.asked.length === 0 && empty.notes.some(([, note]) => note === 'composer.btwUsage'), '/btw 没写问题时提示用法')
  const failed = await submit('/btw 问题', { result: { ok: false, error: '来源会话没有在运行' } })
  ok(failed.restored.join() === '/btw 问题' && failed.notes.some(([level, note]) => level === 'error' && note === '来源会话没有在运行'), '启动失败时恢复输入并报出原因')

  const main = await readFile('src/main/index.ts', 'utf8')
  ok(/if \(!run\.launchFailed && !run\.sideQuestion\) notifySubagentFinished\(run\)/.test(main), '旁路快问结束不给主会话发通知')
})
