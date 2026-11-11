#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

await mkdir(join(process.cwd(), 'out'), { recursive: true })
const dir = await mkdtemp(join(process.cwd(), 'out', 'test-terminal-agent-'))
let pass = 0
async function check(label, fn) {
  await fn()
  pass += 1
  process.stdout.write(`  ✓ ${label}\n`)
}

async function bundle(entry, name, plugins = []) {
  const file = join(dir, name)
  await build({ entryPoints: [entry], outfile: file, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent', plugins })
  return import(pathToFileURL(file).href)
}

function fakeHost(options = {}) {
  let clock = 1_000
  let seq = 0
  const terms = new Map()
  const events = []
  const emit = (term, text) => {
    term.buffer += text
    term.total += text.length
    term.lastOutputAt = clock
  }
  const shell = (term, data) => {
    if (!data.endsWith('\r')) {
      emit(term, data)
      return
    }
    const command = data.slice(0, -1)
    emit(term, `${command}\r\n`)
    if (options.respond) options.respond(term, command, (text) => emit(term, text))
    else emit(term, `ok:${command}\r\nPS C:\\work> `)
  }
  const host = {
    terms,
    events,
    available: () => true,
    list: () => [...terms.values()].map((term) => ({ ...term.info, buffer: term.buffer, seq: 0 })),
    stream: (id) => {
      const term = terms.get(id)
      return term ? { info: { ...term.info }, buffer: term.buffer, total: term.total, lastOutputAt: term.lastOutputAt, pid: term.info.alive ? 4242 : null } : null
    },
    start: (opts) => {
      if (options.startFails) return { ok: false, reason: options.startFails === 'spawn' ? 'spawn' : 'limit', message: options.startFails === 'spawn' ? 'spawn ENOENT pwsh.exe' : 'limit' }
      const id = `t${++seq}`
      const term = { info: { id, title: opts.title ?? 'pwsh · work', shell: 'C:/Program Files/PowerShell/7/pwsh.exe', cwd: opts.cwd, cols: 120, rows: 30, alive: true, exitCode: null, owner: opts.owner }, buffer: '', total: 0, lastOutputAt: clock, writes: [] }
      terms.set(id, term)
      emit(term, 'PS C:\\work> ')
      return { ok: true, snapshot: { ...term.info, buffer: term.buffer, seq: 0 } }
    },
    adopt: (info, buffer = 'PS C:\\work> ') => {
      const term = { info: { shell: 'C:/pwsh.exe', cols: 120, rows: 30, alive: true, exitCode: null, title: 'user', cwd: 'C:/work', ...info }, buffer: '', total: 0, lastOutputAt: clock, writes: [] }
      terms.set(info.id, term)
      emit(term, buffer)
      return term
    },
    write: (id, data) => {
      const term = terms.get(id)
      if (!term?.info.alive) return false
      term.writes.push(data)
      shell(term, data)
      return true
    },
    kill: (id) => terms.delete(id),
    announce: (id, phase, action) => events.push(`${id}:${phase}:${action}`),
    sameOwner: (a, b) => a.toLowerCase() === b.toLowerCase(),
    childCount: async () => options.children ?? 0,
    render: async (raw) => raw,
    rules: async () => null,
    prefs: async () => options.prefs ?? { mode: 'danger', outsideWrites: false, allowRoots: [] },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    }
  }
  return host
}

try {
  const entry = join(dir, 'entry.ts')
  const src = (path) => JSON.stringify(join(process.cwd(), path).replace(/\\/g, '/'))
  await writeFile(entry, `export * from ${src('src/main/terminal-agent.ts')}\nexport * from ${src('src/main/terminal-jobs.ts')}\nexport * from ${src('src/main/terminal-notice-step.ts')}\n`)
  const mod = await bundle(entry, 'terminal-agent.mjs')
  const { noteTerminalUserInput } = mod
  const { listTerminalJobs, requestTerminalJobStop, markTerminalJobsStopping, clearFinishedTerminalJobs, resetTerminalJobs, terminalNoticeStep } = mod
  const { createUntilMatcher, forgetTerminalAgentState, terminalAgentStateOf, keySequence, keysToSequence, planSubmission, stripTerminalControls, looksLikePrompt, lastNonEmptyLine, sliceSince, tailText, renderTerminalText, loadDangerRules, TerminalAgentCommands, resetTerminalAgentState } = mod

  const setup = (options = {}) => {
    resetTerminalAgentState()
    const host = fakeHost(options)
    host.render = options.realRender ? renderTerminalText : async (raw) => stripTerminalControls(raw)
    host.rules = loadDangerRules
    const confirms = []
    const notices = []
    const ctx = {
      notify: (text, stillOwner, wake) => notices.push({ text, owned: stillOwner(), wake }),
      ownerKeys: () => ['E:/sessions/A.jsonl', 'sid-a'],
      cwd: () => process.cwd(),
      confirm: async (request) => {
        confirms.push(request)
        return { allowed: options.allow ?? false, ...(options.feedback ? { feedback: options.feedback } : {}) }
      }
    }
    return { host, confirms, notices, commands: new TerminalAgentCommands(host, ctx) }
  }
  const failsWith = async (promise, code) => {
    await assert.rejects(promise, (error) => {
      assert.equal(error.code, code, error.message)
      return true
    })
  }

  await check('bash 层守卫只把单独一条 yan terminal run/write/keys 交给宿主扫描，拼接了别的命令照常拦', async () => {
    const guard = await import(pathToFileURL(join(process.cwd(), 'resources', 'pi-extensions', 'danger-guard.js')).href)
    const scan = (command) => guard.detectDanger('bash', { command }, process.cwd())
    assert.deepEqual(scan(`yan terminal run --command 'reg delete "HKCU\\Software\\X" /f'`), [])
    assert.deepEqual(scan(`yan terminal write --id t1 --text 'reg delete "HKCU\\Software\\X" /f' --enter`), [])
    assert.ok(scan(`yan terminal run --command 'ls'; reg delete "HKCU\\Software\\X" /f`).length > 0)
    assert.ok(scan('yan terminal list && rm -rf /').length > 0)
    assert.ok(scan(`yan terminal-x run --command 'reg delete "HKCU\\Software\\X" /f'`).length > 0)
  })

  await check('按键映射：控制键、方向键、ctrl 组合与未知键', () => {
    assert.equal(keySequence('ctrl+c'), '\x03')
    assert.equal(keySequence('Ctrl+D'), '\x04')
    assert.equal(keySequence('up'), '\x1b[A')
    assert.equal(keySequence('enter'), '\r')
    assert.equal(keySequence('q'), 'q')
    assert.equal(keySequence('f13'), null)
    assert.deepEqual(keysToSequence(['up', 'enter', 'wat']), { data: '\x1b[A\r', unknown: ['wat'] })
  })

  await check('提交行：分段输入在回车时合并，ctrl+c / 退格 / 方向键序列按终端语义处理', () => {
    assert.deepEqual(planSubmission('rm -r', ' -f /\r'), { submitted: ['rm -r -f /'], pending: '' })
    assert.deepEqual(planSubmission('danger', '\x03ls\r'), { submitted: ['ls'], pending: '' })
    assert.deepEqual(planSubmission('lsx', '\x7f\r'), { submitted: ['ls'], pending: '' })
    assert.deepEqual(planSubmission('', '\x1b[Agit\r\nnext'), { submitted: ['git'], pending: 'next' })
    assert.deepEqual(planSubmission('', 'a\r\r'), { submitted: ['a'], pending: '' })
  })

  await check('去控制符与提示符识别：PowerShell / cmd / bash，进度条以最后一次覆盖为准', () => {
    assert.equal(stripTerminalControls('\x1b[32mok\x1b[0m\r\n10%\r50%\r100%'), 'ok\r\n100%'.replace('\r', ''))
    assert.ok(looksLikePrompt('PS C:\\Users\\me> '))
    assert.ok(looksLikePrompt('C:\\Users\\me>'))
    assert.ok(looksLikePrompt('me@box:~/repo$ '))
    assert.ok(!looksLikePrompt('compiling module 3/9'))
    assert.equal(lastNonEmptyLine('a\nPS C:\\x> \n\n'), 'PS C:\\x>')
  })

  await check('增量切片：缓冲是尾部；起点早于缓冲时标记截断', () => {
    assert.deepEqual(sliceSince({ buffer: 'cdef', total: 6 }, 4), { raw: 'ef', truncated: false, context: 'cd' })
    assert.deepEqual(sliceSince({ buffer: 'cdef', total: 6 }, 0), { raw: 'cdef', truncated: true, context: '' })
    assert.deepEqual(sliceSince({ buffer: 'cdef', total: 6 }, 6), { raw: '', truncated: false, context: '' })
    const tail = tailText(Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'), 10, 10_000)
    assert.equal(tail.text.split('\n').length, 10)
    assert.ok(tail.truncated)
  })

  await check('headless 渲染：颜色去掉、自动折行拼回整行、回车覆盖', async () => {
    const text = await renderTerminalText(`\x1b[31mred\x1b[0m\r\n${'x'.repeat(30)}\r\n10%\r100%`, 20)
    assert.deepEqual(text.split('\n'), ['red', 'x'.repeat(30), '100%'])
  })

  await check('headless 渲染带上下文：绝对光标定位重绘提示符时不出现空行，从输入命令的那行开始', async () => {
    const context = Array.from({ length: 12 }, (_, i) => `old ${i}\r\n`).join('') + 'PS C:\\w> '
    const fresh = '\x1b[13;1HPS C:\\w> \x1b[93mStart-Sleep\x1b[0m 3\r\nslow-done\r\nPS C:\\w> '
    const text = await renderTerminalText(fresh, 40, context)
    assert.deepEqual(text.split('\n').map((line) => line.trimEnd()), ['PS C:\\w> Start-Sleep 3', 'slow-done', 'PS C:\\w>'])
  })

  await check('list / read 只看得到本会话的终端', async () => {
    const { host, commands } = setup()
    host.adopt({ id: 'mine', owner: 'e:/sessions/a.jsonl' })
    host.adopt({ id: 'other', owner: 'E:/sessions/B.jsonl' })
    host.adopt({ id: 'none' })
    const list = await commands.run('list', {})
    assert.deepEqual(list.summary.terminals.map((item) => item.id), ['mine'])
    const read = await commands.run('read', { id: 'mine' })
    assert.match(read.summary.output, /PS C:\\work>/)
    await failsWith(commands.run('read', { id: 'other' }), 'terminal_not_found')
  })

  await check('run 没有终端时新开一个，宣告开始与结束，等到提示符后返回输出', async () => {
    const { host, commands } = setup()
    const result = await commands.run('run', { command: 'npm test' })
    assert.equal(result.summary.state, 'completed')
    assert.equal(result.summary.created, true)
    assert.match(result.summary.output, /ok:npm test/)
    const [id] = [...host.terms.keys()]
    assert.deepEqual(host.terms.get(id).writes, ['npm test\r'])
    assert.equal(host.terms.get(id).info.owner, 'E:/sessions/A.jsonl')
    assert.deepEqual(host.events, [`${id}:start:run`, `${id}:end:run`])
  })

  await check('run 复用空闲终端；终端有子进程时换一个新终端；--id 指定忙终端直接拒绝', async () => {
    const idle = setup()
    idle.host.adopt({ id: 'mine', owner: 'sid-a' })
    const reused = await idle.commands.run('run', { command: 'git status' })
    assert.equal(reused.summary.id, 'mine')
    assert.equal(reused.summary.created, false)

    const busy = setup({ children: 1 })
    busy.host.adopt({ id: 'server', owner: 'sid-a' })
    await failsWith(busy.commands.run('run', { id: 'server', command: 'ls' }), 'terminal_busy')
    assert.deepEqual(busy.host.terms.get('server').writes, [])
    const fresh = await busy.commands.run('run', { command: 'ls', quiet: 2 })
    assert.equal(fresh.summary.created, true)
    assert.notEqual(fresh.summary.id, 'server')
    assert.deepEqual(busy.host.terms.get('server').writes, [])
  })

  await check('危险命令经宿主审批；拒绝时不写入终端', async () => {
    const { host, confirms, commands } = setup({ allow: false, feedback: '别删' })
    host.adopt({ id: 'mine', owner: 'sid-a' })
    await failsWith(commands.run('run', { id: 'mine', command: 'Remove-Item -Recurse -Force C:\\InkstoneProbe' }), 'terminal_blocked')
    assert.equal(confirms.length, 1)
    assert.match(confirms[0].reasons.join(), /递归删除/)
    assert.deepEqual(host.terms.get('mine').writes, [])
  })

  await check('批准后照常执行；不受限制档不再询问', async () => {
    const allowed = setup({ allow: true })
    allowed.host.adopt({ id: 'mine', owner: 'sid-a' })
    const ran = await allowed.commands.run('run', { id: 'mine', command: 'reg delete "HKCU\\Software\\InkstoneProbe" /f' })
    assert.equal(allowed.confirms.length, 1)
    assert.equal(ran.summary.state, 'completed')

    const all = setup({ prefs: { mode: 'all', outsideWrites: false, allowRoots: [] } })
    all.host.adopt({ id: 'mine', owner: 'sid-a' })
    await all.commands.run('run', { id: 'mine', command: 'reg delete "HKCU\\Software\\InkstoneProbe" /f' })
    assert.equal(all.confirms.length, 0)
  })

  await check('把危险命令拆成两次 write，在回车提交时按整行审批', async () => {
    const { host, confirms, commands } = setup({ allow: false })
    host.adopt({ id: 'mine', owner: 'sid-a' })
    const first = await commands.run('write', { id: 'mine', text: 'Remove-Item -Recurse' })
    assert.equal(first.summary.action, 'write')
    assert.equal(confirms.length, 0)
    await failsWith(commands.run('write', { id: 'mine', text: ' -Force C:\\InkstoneProbe', enter: true }), 'terminal_blocked')
    assert.equal(confirms.length, 1)
    assert.match(confirms[0].detail, /Remove-Item -Recurse -Force/)
    assert.deepEqual(host.terms.get('mine').writes, ['Remove-Item -Recurse'])
  })

  await check('keys：ctrl+c 清掉已输入的半行，未知键报错', async () => {
    const { host, confirms, commands } = setup({ allow: false })
    host.adopt({ id: 'mine', owner: 'sid-a' })
    await commands.run('write', { id: 'mine', text: 'Remove-Item -Recurse -Force C:\\InkstoneProbe' })
    await commands.run('keys', { id: 'mine', keys: 'ctrl+c' })
    await commands.run('keys', { id: 'mine', keys: 'enter' })
    assert.equal(confirms.length, 0)
    await failsWith(commands.run('keys', { id: 'mine', keys: 'ctrl+c,f13' }), 'terminal_bad_keys')
  })

  await check('命令回显本身像提示符（以 $ 结尾）时不误判为已跑完', async () => {
    const { commands } = setup({ respond: () => {} })
    const result = await commands.run('run', { command: 'echo $', quiet: 2 })
    assert.equal(result.summary.state, 'quiet')
  })

  await check('长时间无输出返回 quiet，--until 命中返回 matched', async () => {
    const quiet = setup({ respond: (_term, _command, emit) => emit('starting server...\r\n') })
    const silent = await quiet.commands.run('run', { command: 'npm run dev', quiet: 2 })
    assert.equal(silent.summary.state, 'quiet')
    assert.ok(silent.summary.hint)

    const ready = setup({ respond: (_term, _command, emit) => emit('  VITE ready in 300 ms\r\n  Local: http://localhost:5173/\r\n') })
    const matched = await ready.commands.run('run', { command: 'npm run dev', until: 'Local:' })
    assert.equal(matched.summary.state, 'matched')
    await failsWith(ready.commands.run('run', { command: 'x', until: '(' }), 'terminal_bad_until')
  })

  await check('read --since 只取新输出', async () => {
    const { host, commands } = setup()
    host.adopt({ id: 'mine', owner: 'sid-a' })
    const first = await commands.run('read', { id: 'mine' })
    host.write('mine', 'echo hi\r')
    const next = await commands.run('read', { id: 'mine', since: first.summary.cursor })
    assert.match(next.summary.output, /ok:echo hi/)
    assert.doesNotMatch(next.summary.output.split('\n')[0], /^PS C:\\work> $/)
  })

  await check('stop 只能关 agent 自己开的终端', async () => {
    const { host, commands } = setup()
    host.adopt({ id: 'user', owner: 'sid-a' })
    await failsWith(commands.run('stop', { id: 'user' }), 'terminal_not_agent_opened')
    const started = await commands.run('start', {})
    assert.equal(started.summary.agentOpened, true)
    const stopped = await commands.run('stop', { id: started.summary.id })
    assert.equal(stopped.summary.stopped, true)
    assert.equal(host.terms.has(started.summary.id), false)
  })

  await check('项目外写入按终端实际位置判断，基准是会话项目而不是终端目录', async () => {
    const prefs = { mode: 'danger', outsideWrites: true, allowRoots: [] }
    const away = setup({ prefs, allow: true })
    away.host.adopt({ id: 'away', owner: 'sid-a', cwd: 'D:/elsewhere' })
    await away.commands.run('run', { id: 'away', command: 'echo x > a.txt' })
    assert.equal(away.confirms.length, 1)

    const local = setup({ prefs, allow: true })
    local.host.adopt({ id: 'local', owner: 'sid-a', cwd: process.cwd() })
    await local.commands.run('run', { id: 'local', command: 'echo x > a.txt' })
    assert.equal(local.confirms.length, 0)
    await local.commands.run('run', { id: 'local', command: 'cd D:/elsewhere' })
    assert.equal(local.confirms.length, 0)
    await local.commands.run('run', { id: 'local', command: 'echo x > a.txt' })
    assert.equal(local.confirms.length, 1)
    assert.match(local.confirms[0].reasons.join(), /d:\/elsewhere\/a\.txt/)
    await local.commands.run('run', { id: 'local', command: 'popd' })
    await local.commands.run('run', { id: 'local', command: 'echo x > b.txt' })
    assert.equal(local.confirms.length, 2)

    const free = setup({ prefs: { ...prefs, mode: 'all' } })
    free.host.adopt({ id: 'free', owner: 'sid-a', cwd: process.cwd() })
    await free.commands.run('run', { id: 'free', command: 'cd D:/elsewhere' })
    await free.commands.run('run', { id: 'free', command: 'echo x > a.txt' })
    assert.equal(free.confirms.length, 0)
  })

  await check('--until 的灾难性正则会超时报错，不会冻住主进程', async () => {
    const { host, commands } = setup({
      prefs: { mode: 'all', outsideWrites: false, allowRoots: [] },
      respond: (_term, _command, emit) => emit(`${'a'.repeat(40)}!\r\n`)
    })
    host.adopt({ id: 'slow', owner: 'sid-a' })
    const started = Date.now()
    await failsWith(commands.run('run', { id: 'slow', command: 'x', until: '(a+)+$', timeout: 5 }), 'terminal_bad_until')
    assert.ok(Date.now() - started < 5000)
  })

  const { parseHostTextNotice } = await bundle('src/shared/host-notice-text.ts', 'host-notice-text.mjs')
  const settle = async (notices) => {
    for (let i = 0; i < 200 && !notices.length; i++) await new Promise((done) => setImmediate(done))
  }

  await check('--background：长命令先返回 background，结束后发宿主通知；期间终端算忙', async () => {
    let finish = () => {}
    const { commands, notices } = setup({
      respond: (_term, _command, emit) => {
        emit('building...\r\n')
        finish = () => emit('done ```\r\nPS C:\\work> ')
      }
    })
    const started = await commands.run('run', { command: 'npm run build', background: true, timeout: 600 })
    assert.equal(started.summary.state, 'background')
    assert.match(started.summary.output, /building/)
    assert.match(started.summary.hint, /通知/)
    await failsWith(commands.run('run', { id: started.summary.id, command: 'ls' }), 'terminal_busy')
    finish()
    await settle(notices)
    assert.equal(notices.length, 1)
    assert.equal(notices[0].owned, true)
    assert.equal(notices[0].wake, true)
    assert.match(notices[0].text, /done ```/)
    assert.match(notices[0].text, /\n````\n/)
    assert.match(notices[0].text, new RegExp(`--id ${started.summary.id} --since \\d+`))
    assert.deepEqual(parseHostTextNotice(notices[0].text), { kind: 'terminal', command: 'npm run build', state: 'completed' })
  })

  await check('--background：短命令直接返回结果不发通知；超时发 timeout 通知；stop 后不再通知', async () => {
    const quick = setup()
    const done = await quick.commands.run('run', { command: 'git status', background: true })
    assert.equal(done.summary.state, 'completed')
    await settle(quick.notices)
    assert.equal(quick.notices.length, 0)

    const slow = setup({ respond: (_term, _command, emit) => emit('waiting\r\n') })
    await slow.commands.run('run', { command: 'sleep 9999', background: true, timeout: 5 })
    await settle(slow.notices)
    assert.equal(parseHostTextNotice(slow.notices[0]?.text)?.state, 'timeout')
    assert.equal(slow.notices[0].wake, true)

    const stopped = setup({ respond: (_term, _command, emit) => emit('waiting\r\n') })
    const job = await stopped.commands.run('run', { command: 'sleep 9999', background: true, timeout: 600 })
    await stopped.commands.run('stop', { id: job.summary.id })
    await settle(stopped.notices)
    assert.equal(stopped.notices.length, 0)
  })

  await check('后台命令登记为后台任务；从面板停止会发 ctrl+c，结束后记为 stopped 并通知；清除只删已结束的', async () => {
    resetTerminalJobs()
    const { host, commands, notices } = setup({
      respond: (_term, command, emit) => emit(command ? 'working\r\n' : '^C\r\nPS C:\\work> ')
    })
    const started = await commands.run('run', { command: 'npm run long', background: true, timeout: 600 })
    const [job] = listTerminalJobs()
    assert.equal(started.summary.jobId, job.id)
    assert.equal(job.state, 'running')
    assert.equal(job.terminalId, started.summary.id)
    assert.deepEqual(job.owners, ['E:/sessions/A.jsonl', 'sid-a'])
    clearFinishedTerminalJobs()
    assert.equal(listTerminalJobs().length, 1)
    assert.equal(requestTerminalJobStop(job.id), started.summary.id)
    assert.equal(requestTerminalJobStop(job.id), null)
    host.write(started.summary.id, '\r')
    await settle(notices)
    assert.equal(listTerminalJobs()[0].state, 'stopped')
    assert.ok(listTerminalJobs()[0].endedAt)
    assert.equal(parseHostTextNotice(notices[0]?.text)?.state, 'stopped')
    assert.equal(notices[0].wake, false)
    clearFinishedTerminalJobs([job.id])
    assert.equal(listTerminalJobs().length, 0)
  })

  const idle = async () => {
    for (let i = 0; i < 400; i++) await new Promise((done) => setImmediate(done))
  }
  const running = (job) => listTerminalJobs().find((item) => item.id === job)?.state

  await check('后台命令：没给 --timeout 时监视到时限只改任务状态，不发通知', async () => {
    resetTerminalJobs()
    const { commands, notices } = setup({ respond: (_term, _command, emit) => emit('serving\r\n') })
    const started = await commands.run('run', { command: 'npm run dev', background: true })
    await idle()
    assert.equal(running(started.summary.jobId), 'timeout')
    assert.equal(notices.length, 0)
  })

  await check('后台命令：模型自己 ctrl+c 停掉的记为 stopped，不发通知；write 回答提示后跑完的照常通知', async () => {
    resetTerminalJobs()
    const own = setup({ respond: (_term, command, emit) => emit(command ? 'serving\r\n' : '') })
    const started = await own.commands.run('run', { command: 'npm run dev', background: true, timeout: 600 })
    const term = own.host.terms.get(started.summary.id)
    const write = own.host.write
    own.host.write = (id, data) => {
      const ok = write(id, data)
      if (data === '\x03') {
        const tail = '^C\r\nPS C:\\work> '
        term.buffer += tail
        term.total += tail.length
      }
      return ok
    }
    await own.commands.run('keys', { id: started.summary.id, keys: 'ctrl+c' })
    await idle()
    assert.equal(running(started.summary.jobId), 'stopped')
    assert.equal(own.notices.length, 0)

    resetTerminalJobs()
    let finish = () => {}
    const answered = setup({
      respond: (_term, command, emit) => {
        if (command === 'y') finish = () => emit('installed\r\nPS C:\\work> ')
        else emit('Proceed? (y/n) ')
      }
    })
    const install = await answered.commands.run('run', { command: 'npm install', background: true, timeout: 600 })
    await answered.commands.run('write', { id: install.summary.id, text: 'y', enter: true, wait: 0 })
    finish()
    await settle(answered.notices)
    assert.equal(parseHostTextNotice(answered.notices[0]?.text)?.state, 'completed')
    assert.equal(answered.notices[0].wake, true)
  })

  await check('后台命令：用户在终端里按 ctrl+c 或关掉终端，记为 stopped，通知不叫醒', async () => {
    resetTerminalJobs()
    const typed = setup({ respond: (_term, command, emit) => emit(command ? 'serving\r\n' : '^C\r\nPS C:\\work> ') })
    const started = await typed.commands.run('run', { command: 'npm run dev', background: true, timeout: 600 })
    markTerminalJobsStopping(started.summary.id)
    assert.equal(running(started.summary.jobId), 'stopping')
    typed.host.write(started.summary.id, '\r')
    await settle(typed.notices)
    assert.equal(parseHostTextNotice(typed.notices[0]?.text)?.state, 'stopped')
    assert.match(typed.notices[0].text, /用户停止了这条命令/)
    assert.equal(typed.notices[0].wake, false)

    resetTerminalJobs()
    const closed = setup({ respond: (_term, _command, emit) => emit('serving\r\n') })
    const job = await closed.commands.run('run', { command: 'npm run dev', background: true, timeout: 600 })
    markTerminalJobsStopping(job.summary.id)
    closed.host.terms.delete(job.summary.id)
    await settle(closed.notices)
    assert.equal(parseHostTextNotice(closed.notices[0]?.text)?.state, 'stopped')
    assert.equal(closed.notices[0].wake, false)

    resetTerminalJobs()
    const died = setup({ respond: (_term, _command, emit) => emit('serving\r\n') })
    const gone = await died.commands.run('run', { command: 'npm run dev', background: true, timeout: 600 })
    died.host.terms.delete(gone.summary.id)
    await settle(died.notices)
    assert.equal(parseHostTextNotice(died.notices[0]?.text)?.state, 'exited')
    assert.equal(died.notices[0].wake, true)
  })

  await check('通知投递：回合在跑就插进当前回合，空闲时只有该叫醒的才起回合，其余留到下一回合', () => {
    const at = (patch) => terminalNoticeStep({ stopping: false, owned: true, ready: true, running: false, wake: true, ...patch })
    assert.equal(at({ running: true }), 'steer')
    assert.equal(at({ running: true, wake: false }), 'steer')
    assert.equal(at({}), 'wake')
    assert.equal(at({ wake: false }), 'hold')
    assert.equal(at({ ready: false }), 'wait')
    assert.equal(at({ ready: false, wake: false }), 'wait')
    assert.equal(at({ owned: false }), 'drop')
    assert.equal(at({ stopping: true, running: true }), 'drop')
  })

  await check('start --cwd 不存在时报错，终端上限时报错', async () => {
    const { commands } = setup()
    await failsWith(commands.run('start', { cwd: 'no/such/dir' }), 'terminal_bad_cwd')
    const full = setup({ startFails: true })
    await failsWith(full.commands.run('start', {}), 'terminal_start_failed')
    await assert.rejects(full.commands.run('start', {}), /终端上限/)
  })

  await check('D-11：spawn 失败把真实原因带进报错，不再一律说达到上限', async () => {
    const broken = setup({ startFails: 'spawn' })
    await assert.rejects(broken.commands.run('start', {}), (error) => {
      assert.equal(error.code, 'terminal_start_failed')
      assert.match(error.message, /spawn ENOENT pwsh\.exe/)
      assert.doesNotMatch(error.message, /上限/)
      return true
    })
    await assert.rejects(broken.commands.run('run', { command: 'echo hi' }), /spawn ENOENT pwsh\.exe/)
  })

  await check('D-10：终端被关闭后清掉 agent 侧的每终端状态（含 lastUsed、输入行、位置、plain 缓存）', async () => {
    const { host, commands } = setup()
    const first = await commands.run('run', { command: 'echo one' })
    const id = first.summary.id
    await commands.run('write', { id, text: 'typing' })
    const live = terminalAgentStateOf(id)
    assert.equal(live.agentOpened, true)
    assert.equal(live.typedLine, true)
    assert.equal(live.lastUsed, true)
    host.kill(id)
    forgetTerminalAgentState(id)
    const gone = terminalAgentStateOf(id)
    assert.deepEqual(gone, { agentOpened: false, typedLine: false, location: false, lastUsed: false, plain: false, truncatedPlain: false, interrupt: false })
    const second = await commands.run('run', { command: 'echo two' })
    assert.notEqual(second.summary.id, id)
    await commands.run('stop', { id: second.summary.id })
    assert.equal(terminalAgentStateOf(second.summary.id).lastUsed, false)
    assert.equal(terminalAgentStateOf(second.summary.id).typedLine, false)
  })

  await check('D-10：关闭终端时用户输入链还在跑也不会把状态写回来', async () => {
    const { host, commands } = setup()
    const started = await commands.run('start', {})
    const id = started.summary.id
    const pending = noteTerminalUserInput(id, 'cd C:/work\r', 'C:/work')
    host.kill(id)
    forgetTerminalAgentState(id)
    await pending.catch(() => undefined)
    await new Promise((done) => setTimeout(done, 5))
    assert.equal(terminalAgentStateOf(id).location, false)
    assert.equal(terminalAgentStateOf(id).typedLine, false)
  })

  await check('D-06：--until 匹配器复用同一个 vm 脚本和上下文，仍能匹配并保留超时保护', async () => {
    const matcher = createUntilMatcher(/ready/m)
    assert.equal(matcher('booting'), false)
    assert.equal(matcher('server ready'), true)
    assert.equal(matcher('booting again'), false)
    const slow = createUntilMatcher(/^(a+)+$/)
    assert.throws(() => slow('a'.repeat(40) + '!'), (error) => error.code === 'terminal_bad_until')
  })

  await check('D-06：等待期间输出总量没变就不重新匹配 --until', async () => {
    const { commands } = setup({ respond: (term, command, emit) => emit(term, `${command}\r\nbooting\r\n`) })
    const original = RegExp.prototype.test
    let calls = 0
    RegExp.prototype.test = function (text) {
      if (this.source === 'NEVER-APPEARS') calls += 1
      return original.call(this, text)
    }
    try {
      const result = await commands.run('run', { command: 'serve', until: 'NEVER-APPEARS', timeout: 20, quiet: 600 })
      assert.equal(result.summary.state, 'timeout')
    } finally {
      RegExp.prototype.test = original
    }
    assert.ok(calls >= 1 && calls <= 3, `无新输出时匹配次数应很少，实际 ${calls}`)
  })

  await check('F-04：@xterm/headless 加载失败时 renderTerminalText 退回去控制序列的原文，只记一次日志', async () => {
    const plugin = {
      name: 'broken-require',
      setup(builder) {
        builder.onResolve({ filter: /^node:module$/ }, () => ({ path: 'broken-require', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: "export const createRequire = () => () => { throw new Error(\"Cannot find module '@xterm/headless'\") }",
          loader: 'js'
        }))
      }
    }
    const brokenEntry = join(dir, 'broken-entry.ts')
    await writeFile(brokenEntry, `export { renderTerminalText } from ${src('src/main/terminal-agent.ts')}\n`)
    const broken = await bundle(brokenEntry, 'terminal-agent-broken.mjs', [plugin])
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args.map(String).join(' '))
    try {
      assert.equal(await broken.renderTerminalText('\x1b[31mred\x1b[0m text\r\nnext', 80), 'red text\nnext')
      assert.equal(await broken.renderTerminalText('again', 80, 'ctx'), 'again')
      assert.equal(await broken.renderTerminalText('', 80), '')
    } finally {
      console.warn = originalWarn
    }
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /@xterm\/headless/)
  })

  console.log(`test-terminal-agent: ${pass} 项全部通过`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
