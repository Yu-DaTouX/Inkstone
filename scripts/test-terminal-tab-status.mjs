import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temp = await mkdtemp(join(tmpdir(), 'inkstone-terminal-tabs-'))
try {
  await build({ entryPoints: { label: 'src/renderer/src/lib/terminal-tab-status.ts', consumer: 'src/renderer/src/state/push-consumers.ts' }, bundle: true, platform: 'node', format: 'esm', outdir: temp, outExtension: { '.js': '.mjs' }, logLevel: 'silent' })
  const { terminalTabStatus } = await import(pathToFileURL(resolve(temp, 'label.mjs')).href)
  const { consumeShellPush } = await import(pathToFileURL(resolve(temp, 'consumer.mjs')).href)
  let checks = 0
  const check = (value, text) => { assert.ok(value, text); checks += 1 }
  const base = { id: 'a', title: 'shell', shell: 'fixture', cwd: '.', cols: 80, rows: 24, alive: true }
  check(terminalTabStatus(base) === null, '没有主动上报的存活 Shell 不显示正在运行')
  const row = status => terminalTabStatus({ ...base, status })
  check(row({ state: 'working', progress: 30 }).progress === 30 && row({ state: 'working' }).tone === 'accent', '运行态与进度投影')
  check(row({ state: 'working', progress: NaN }).progress === undefined && row({ state: 'working', progress: 101 }).progress === undefined, '无效进度不显示')
  for (const [kind, key] of [['permission', 'term.waitPermission'], ['question', 'term.waitAnswer'], ['auth', 'term.waitAuth']]) {
    check(row({ state: 'blocked', kind }).key === key && row({ state: 'blocked', kind }).tone === 'warn', `${kind} 等待文字不只靠颜色`)
  }
  check(row({ state: 'blocked' }).key === 'term.wait', '未知等待类型不猜')
  check(row({ state: 'done' }).tone === 'ok' && row({ state: 'error' }).tone === 'err' && row({ state: 'idle' }).tone === 'neutral', '完成/错误/空闲语义')
  check(row({ state: 'clear' }) === null, 'clear 不显示成状态')
  check(terminalTabStatus({ ...base, alive: false, status: { state: 'working' } }) === null, '退出的终端不显示运行')
  check(terminalTabStatus({ ...base, alive: false, status: { state: 'done' } }).key === 'term.ok', '退出保留程序报告的完成')
  let state = { terminals: [base, { ...base, id: 'b' }] }
  let updates = 0
  const ctx = { set(patch) { state = { ...state, ...patch }; updates += 1 } }
  const emit = payload => consumeShellPush({ ch: 'terminal', payload }, state, ctx)
  const other = state.terminals[1]
  emit({ kind: 'status', id: 'a', status: { state: 'blocked', kind: 'auth' } })
  check(state.terminals[0].status.kind === 'auth' && state.terminals[1] === other, '状态只覆盖同 id，不覆盖其他终端')
  const beforeData = updates
  emit({ kind: 'data', id: 'a', data: 'raw output', seq: 1 })
  check(updates === beforeData, '高频输出仍直连 xterm，不进入 store')
  emit({ kind: 'status', id: 'a', status: undefined })
  check(state.terminals[0].status === undefined, 'clear 推送移除旧投影')
  emit({ kind: 'status', id: 'a', status: { state: 'blocked', kind: 'permission' } })
  emit({ kind: 'exit', id: 'a', exitCode: 0 })
  check(state.terminals[0].alive === false && state.terminals[0].status === undefined, '即使漏掉清理推送，退出也移除旧等待')
  emit({ kind: 'status', id: 'b', status: { state: 'error' } })
  emit({ kind: 'exit', id: 'b', exitCode: 1 })
  check(state.terminals[1].status.state === 'error', '退出保留程序报告的错误')
  emit({ kind: 'status', id: 'closed', status: { state: 'working' } })
  check(state.terminals.length === 2 && !state.terminals.some(item => item.id === 'closed'), '关闭后迟到事件不复活终端')
  console.log(`terminal-tab-status: ${checks} 项标签/推送检查通过`)
} finally { await rm(temp, { recursive: true, force: true }) }
