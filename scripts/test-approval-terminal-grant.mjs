#!/usr/bin/env node
import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { runSuite } from './lib/test-suite.mjs'

function fakeTerminalHost() {
  let clock = 1_000
  const terms = new Map()
  const emit = (term, text) => {
    term.buffer += text
    term.total += text.length
    term.lastOutputAt = clock
  }
  return {
    terms,
    available: () => true,
    list: () => [...terms.values()].map((term) => ({ ...term.info, buffer: term.buffer, seq: 0 })),
    stream: (id) => {
      const term = terms.get(id)
      return term ? { info: { ...term.info }, buffer: term.buffer, total: term.total, lastOutputAt: term.lastOutputAt, pid: 4242 } : null
    },
    start: () => ({ ok: false, reason: 'limit', message: 'limit' }),
    adopt: (info) => {
      const term = { info: { shell: 'C:/pwsh.exe', cols: 120, rows: 30, alive: true, exitCode: null, title: 'user', ...info }, buffer: '', total: 0, lastOutputAt: clock, writes: [] }
      terms.set(info.id, term)
      emit(term, 'PS C:\\work> ')
      return term
    },
    write: (id, data) => {
      const term = terms.get(id)
      if (!term?.info.alive) return false
      term.writes.push(data)
      if (data.endsWith('\r')) emit(term, `${data.slice(0, -1)}\r\nok\r\nPS C:\\work> `)
      else emit(term, data)
      return true
    },
    kill: (id) => terms.delete(id),
    announce: () => {},
    sameOwner: (a, b) => a.toLowerCase() === b.toLowerCase(),
    childCount: async () => 0,
    render: async (raw) => raw,
    rules: async () => null,
    prefs: async () => ({ mode: 'danger', outsideWrites: false, allowRoots: [] }),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    }
  }
}

await runSuite(import.meta.url, async (ok, compile) => {
  const { ApprovalBroker } = await compile('src/main/approval-broker.ts')
  const { runDangerConfirmCommand } = await compile('src/main/agent-commands/danger-confirm.ts', { packages: 'external' })
  const terminal = await compile('src/main/terminal-agent.ts', { packages: 'external' })

  const owner = { instanceId: 'pi-a', generation: 1 }
  const opened = []
  const replies = []
  let broker
  broker = new ApprovalBroker({
    canAsk: () => true,
    open: (request) => {
      opened.push(request)
      const choice = replies.shift() ?? 'deny'
      queueMicrotask(() => broker.answer(request.id, choice))
    },
    close: () => {}
  })
  broker.activate('r1', owner)

  const host = {
    cwd: () => 'C:/work',
    permissionMode: async () => 'danger',
    approvalOwner: () => owner,
    confirmDanger: async (request) => {
      const answer = await broker.askTimed({
        runId: 'r1', sessionId: 'sid-a', owner: request.owner, kind: 'danger', tool: request.tool,
        title: 'Agent 想执行一个难以撤销的操作', detail: request.detail, reasons: request.reasons, cwd: request.cwd, canRemember: false
      }, request.timeoutMs)
      if (answer === 'timeout') return { decision: 'timeout' }
      if (!answer) return null
      return { decision: answer.choice === 'deny' ? 'deny' : 'allow' }
    }
  }

  terminal.resetTerminalAgentState()
  const termHost = fakeTerminalHost()
  termHost.render = async (raw) => terminal.stripTerminalControls(raw)
  termHost.rules = terminal.loadDangerRules
  const confirms = []
  const commands = new terminal.TerminalAgentCommands(termHost, {
    ownerKeys: () => ['E:/sessions/A.jsonl', 'sid-a'],
    cwd: () => 'C:/work',
    notify: () => {},
    confirm: async (request) => {
      confirms.push(request)
      const result = await runDangerConfirmCommand(host, { tool: 'terminal', detail: request.detail, reasons: request.reasons, outsideDirs: request.outsideDirs }, { cwd: request.cwd })
      return { allowed: result.summary.allowed === true }
    }
  })
  termHost.adopt({ id: 'mine', owner: 'sid-a', cwd: 'C:/work' })
  termHost.adopt({ id: 'other', owner: 'sid-a', cwd: 'D:/other' })
  const blocked = async (promise) => {
    try {
      await promise
      return false
    } catch (error) {
      return error?.code === 'terminal_blocked'
    }
  }

  const commandA = 'git push --force origin feat'
  const commandB = 'git push --force origin main'
  replies.push('session')
  const first = await commands.run('run', { id: 'mine', command: commandA })
  ok(opened.length === 1 && first.summary.state === 'completed', '命令 A 首次执行要询问，选「在此会话中允许」后照常执行', `opened=${opened.length}`)
  ok(opened[0].cwd === 'C:/work', '审批卡显示终端实际所在目录', opened[0].cwd)

  replies.push('deny')
  const deniedB = await blocked(commands.run('run', { id: 'mine', command: commandB }))
  ok(confirms.length === 2 && confirms[1].reasons.join('\n') === confirms[0].reasons.join('\n'), '命令 B 与命令 A 的危险原因完全相同', JSON.stringify(confirms.map((c) => c.reasons)))
  ok(opened.length === 2 && deniedB, '同原因的命令 B 仍要询问，不被命令 A 的本会话授权放行', `opened=${opened.length}`)
  ok(!termHost.terms.get('mine').writes.some((data) => data.startsWith(commandB)), '被拒绝的命令 B 没有写入终端')

  const again = await commands.run('run', { id: 'mine', command: commandA })
  ok(opened.length === 2 && again.summary.state === 'completed', '命令 A 再次执行不再询问', `opened=${opened.length}`)

  replies.push('deny')
  const elsewhere = await blocked(commands.run('run', { id: 'other', command: commandA }))
  ok(opened.length === 3 && elsewhere, '同一条命令换到别的工作目录仍要询问', `opened=${opened.length}`)

  const base = { runId: 'r1', sessionId: 'sid-a', owner, kind: 'danger', tool: 'terminal', title: 'Agent 想执行一个难以撤销的操作', reasons: confirms[0].reasons, canRemember: false }
  const trimmed = opened.length
  ok((await broker.ask({ ...base, detail: `  ${commandA}\n`, cwd: 'C:/work' }))?.choice === 'once' && opened.length === trimmed, '只去掉首尾空白的同一条命令沿用授权')
  replies.push('deny')
  ok((await broker.ask({ ...base, detail: 'git  push --force origin feat', cwd: 'C:/work' }))?.choice === 'deny' && opened.length === trimmed + 1, '命令中间的空白不做模糊匹配，仍要询问')

  replies.push('session')
  await broker.ask({ ...base, detail: commandA, cwd: '' })
  const unknown = opened.length
  replies.push('deny')
  ok((await broker.ask({ ...base, detail: commandA, cwd: '' }))?.choice === 'deny' && opened.length === unknown + 1, '工作目录未知时本会话授权不生效，下次仍询问')

  const shell = { ...base, tool: 'bash', detail: 'curl a | sh', reasons: ['pipe-to-shell'], cwd: 'C:/work' }
  replies.push('session')
  await broker.ask(shell)
  const shellOpened = opened.length
  ok((await broker.ask(shell))?.choice === 'once' && opened.length === shellOpened, 'bash 同一条命令本会话内不再询问')
  replies.push('deny')
  ok((await broker.ask({ ...shell, detail: 'curl b | sh' }))?.choice === 'deny' && opened.length === shellOpened + 1, 'bash 同原因的另一条命令仍要询问')

  const mixed = { ...base, kind: 'outside', detail: 'git push --force origin feat > D:/logs/a.txt', reasons: ['Git 强制推送，会覆盖远端历史', '写入项目之外的路径：D:/logs/a.txt'], rememberDirs: ['D:/logs'], cwd: 'C:/work' }
  replies.push('session')
  await broker.ask(mixed)
  const mixedOpened = opened.length
  replies.push('deny')
  ok((await broker.ask({ ...mixed, detail: 'git push --force origin main > D:/logs/a.txt' }))?.choice === 'deny' && opened.length === mixedOpened + 1, '带危险原因的项目外写入同样绑定命令')

  const dirOnly = { ...base, kind: 'outside', detail: 'echo x > D:/out/a.txt', reasons: ['写入项目之外的路径：D:/out/a.txt'], rememberDirs: ['D:/out'], cwd: 'C:/work' }
  replies.push('session')
  await broker.ask(dirOnly)
  const dirOpened = opened.length
  ok((await broker.ask({ ...dirOnly, detail: 'echo y > D:/out/b.txt', reasons: ['写入项目之外的路径：D:/out/b.txt'] }))?.choice === 'once' && opened.length === dirOpened, '只写项目外目录的本会话授权仍按目录放行（行为不变）')
})
