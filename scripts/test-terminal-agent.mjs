#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
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

async function bundle(entry, name) {
  const file = join(dir, name)
  await build({ entryPoints: [entry], outfile: file, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
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
      if (options.startFails) return null
      const id = `t${++seq}`
      const term = { info: { id, title: opts.title ?? 'pwsh · work', shell: 'C:/Program Files/PowerShell/7/pwsh.exe', cwd: opts.cwd, cols: 120, rows: 30, alive: true, exitCode: null, owner: opts.owner }, buffer: '', total: 0, lastOutputAt: clock, writes: [] }
      terms.set(id, term)
      emit(term, 'PS C:\\work> ')
      return { ...term.info, buffer: term.buffer, seq: 0 }
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
  const mod = await bundle('src/main/terminal-agent.ts', 'terminal-agent.mjs')
  const { keySequence, keysToSequence, planSubmission, stripTerminalControls, looksLikePrompt, lastNonEmptyLine, sliceSince, tailText, renderTerminalText, loadDangerRules, TerminalAgentCommands, resetTerminalAgentState } = mod

  const setup = (options = {}) => {
    resetTerminalAgentState()
    const host = fakeHost(options)
    host.render = options.realRender ? renderTerminalText : async (raw) => stripTerminalControls(raw)
    host.rules = loadDangerRules
    const confirms = []
    const ctx = {
      ownerKeys: () => ['E:/sessions/A.jsonl', 'sid-a'],
      cwd: () => process.cwd(),
      confirm: async (request) => {
        confirms.push(request)
        return { allowed: options.allow ?? false, ...(options.feedback ? { feedback: options.feedback } : {}) }
      }
    }
    return { host, confirms, commands: new TerminalAgentCommands(host, ctx) }
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

  await check('start --cwd 不存在时报错，终端上限时报错', async () => {
    const { commands } = setup()
    await failsWith(commands.run('start', { cwd: 'no/such/dir' }), 'terminal_bad_cwd')
    const full = setup({ startFails: true })
    await failsWith(full.commands.run('start', {}), 'terminal_start_failed')
  })

  console.log(`test-terminal-agent: ${pass} 项全部通过`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
