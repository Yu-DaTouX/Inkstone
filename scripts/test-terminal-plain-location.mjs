#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const report = { pass: 0, fail: 0 }
async function check(message, fn) {
  try {
    await fn()
    report.pass += 1
    process.stdout.write(`  ✓ ${message}\n`)
  } catch (error) {
    report.fail += 1
    process.stdout.write(`  ✗ ${message}\n    ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

const built = await build({
  entryPoints: ['src/main/terminal-agent.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const bundleDir = await mkdtemp(join(tmpdir(), 'yan-terminal-plain-'))
const bundleFile = join(bundleDir, 'terminal-agent.mjs')
await writeFile(bundleFile, built.outputFiles[0].text)
const mod = await import(pathToFileURL(bundleFile).href)
const dangerBlockBuild = await build({ entryPoints: ['src/shared/danger-block.ts'], bundle: true, write: false, platform: 'neutral', format: 'esm', logLevel: 'silent' })
const { dangerBlockKind } = await import(`data:text/javascript;base64,${Buffer.from(dangerBlockBuild.outputFiles[0].text).toString('base64')}`)
const { TerminalPlainText, plainSince, stripTerminalControls, programBusy, userLocationAfterUserInput, loadDangerRules, noteTerminalUserInput, TerminalAgentCommands } = mod

process.stdout.write('\n▌终端输出清洗：增量结果必须与一次清洗相同（B5）\n')
await check('CR 覆盖跨 chunk：abcdef\\r12 + 34 与一次清洗一致', async () => {
  const tracker = new TerminalPlainText()
  tracker.push('abcdef\r12')
  assert.equal(tracker.text, '12cdef')
  tracker.push('34')
  assert.equal(tracker.text, '1234ef')
  assert.equal(tracker.text, stripTerminalControls('abcdef\r1234'))
})

await check('ANSI 序列被拆到两个 chunk 时不丢字符', async () => {
  const full = 'ab\x1b[31mcd\x1b[0mef'
  const tracker = new TerminalPlainText()
  tracker.push('ab\x1b[3')
  tracker.push('1mcd\x1b')
  tracker.push('[0mef')
  assert.equal(tracker.text, stripTerminalControls(full))
  assert.equal(tracker.text, 'abcdef')
})

await check('OSC 标题序列被拆到两个 chunk 时整段丢弃', async () => {
  const full = 'x\x1b]0;hello\x07y'
  const tracker = new TerminalPlainText()
  tracker.push('x\x1b]0;he')
  tracker.push('llo\x07y')
  assert.equal(tracker.text, stripTerminalControls(full))
})

await check('任意切分都与一次 strip 相同（200 组随机）', async () => {
  const tokens = ['a', 'b', ' ', '\r', '\r', '\n', '\x1b[31m', '\x1b[0m', '\x1b]0;title\x07', '\x1b[3', 'xy', '\t', '\x08', 'PROMPT> ']
  let seed = 20261110
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let round = 0; round < 200; round += 1) {
    let text = ''
    const count = 1 + Math.floor(random() * 24)
    for (let i = 0; i < count; i += 1) text += tokens[Math.floor(random() * tokens.length)]
    text += 'Z'
    const tracker = new TerminalPlainText()
    let at = 0
    while (at < text.length) {
      const step = 1 + Math.floor(random() * 5)
      tracker.push(text.slice(at, at + step))
      at += step
    }
    assert.equal(tracker.text, stripTerminalControls(text), `第 ${round} 组：${JSON.stringify(text)}`)
  }
})

await check('plainSince 增量只处理新增部分，结果与整段切片相同', async () => {
  const full = 'line1\r\nabcdef\r12'
  let stream = { buffer: full.slice(0, 8), total: 8 }
  assert.equal(plainSince('t1', stream, 0), stripTerminalControls(full.slice(0, 8)))
  stream = { buffer: full, total: full.length }
  assert.equal(plainSince('t1', stream, 0), stripTerminalControls(full))
})

await check('输出滚出缓冲后仍返回整段清洗结果，且不变时复用同一结果', async () => {
  const full = 'a'.repeat(50) + '\r\nlast\r'
  const from = 0
  const start = 20
  const stream = { buffer: full.slice(start), total: full.length }
  const first = plainSince('t2', stream, from)
  assert.equal(first, stripTerminalControls(stream.buffer))
  const second = plainSince('t2', { ...stream }, from)
  assert.equal(second, first)
  const grown = { buffer: `${stream.buffer}more`, total: stream.total + 4 }
  assert.equal(plainSince('t2', grown, from), stripTerminalControls(grown.buffer))
})

process.stdout.write('\n▌终端忙状态：自报告只是提示（B11b）\n')
await check('程序自称 working 但没有子进程时不阻止复用', async () => {
  assert.equal(programBusy({ state: 'working' }, 0), false)
  assert.equal(programBusy({ state: 'blocked' }, 0), false)
})

await check('有子进程时算忙，进程信息拿不到才退回自报告', async () => {
  assert.equal(programBusy(undefined, 2), true)
  assert.equal(programBusy({ state: 'idle' }, 1), true)
  assert.equal(programBusy({ state: 'working' }, null), true)
  assert.equal(programBusy({ state: 'blocked' }, null), true)
  assert.equal(programBusy({ state: 'idle' }, null), false)
})

process.stdout.write('\n▌用户手动 cd 后的可信位置（B9）\n')
const rules = await loadDangerRules()
const root = process.platform === 'win32' ? 'C:\\work\\proj' : '/work/proj'
const outside = process.platform === 'win32' ? 'C:\\work\\outside' : '/work/outside'
const joinPath = (...parts) => parts.join(process.platform === 'win32' ? '\\' : '/')
const normalized = (path) => (process.platform === 'win32' ? path.replace(/\\/g, '/').toLowerCase() : path)

await check('用户 cd 到项目外后，位置跟踪跟着变', async () => {
  assert.ok(rules, 'danger-guard 应当能加载')
  const next = userLocationAfterUserInput(rules, 'cd ../outside', root)
  assert.equal(next, normalized(outside))
  assert.equal(userLocationAfterUserInput(rules, 'ls -la', normalized(root)), normalized(root))
})

await check('普通命令保留当前位置', async () => {
  assert.equal(userLocationAfterUserInput(rules, 'ls -la', normalized(root)), normalized(root))
  assert.equal(userLocationAfterUserInput(rules, 'git status', normalized(root)), normalized(root))
})

await check('未知命令或别名不再把旧目录当作可信', async () => {
  assert.equal(userLocationAfterUserInput(rules, 'my-alias-to-somewhere', root), null)
  assert.equal(userLocationAfterUserInput(rules, 'z deep/path', root), null)
})

await check('切换 shell 或子 shell 后位置未知', async () => {
  assert.equal(userLocationAfterUserInput(rules, 'bash', root), null)
  assert.equal(userLocationAfterUserInput(rules, 'pwsh -NoLogo', root), null)
  assert.equal(userLocationAfterUserInput(rules, 'cd .. && bash', joinPath(root, 'sub')), null)
})

await check('popd 一类无法确定的位置变成未知', async () => {
  assert.equal(userLocationAfterUserInput(rules, 'popd', root), null)
})

process.stdout.write('\n▌模型在用户手动 cd 后的写入守卫\n')
const work = await mkdtemp(join(process.cwd(), '.tmp', 'terminal-guard-'))
try {
  const project = join(work, 'proj')
  const elsewhere = join(work, 'elsewhere')
  await mkdir(project, { recursive: true })
  await mkdir(elsewhere, { recursive: true })
  const info = { id: 't1', title: 'x', cwd: project, shell: '/bin/bash', owner: 'owner-1', cols: 120, rows: 30, alive: true, exitCode: null }
  const stream = { info, buffer: '', total: 0, lastOutputAt: 0, pid: 1234 }
  const requests = []
  const host = {
    available: () => true,
    list: () => [snapshot()],
    stream: () => stream,
    start: () => ({ ok: false, reason: 'spawn', message: 'unused' }),
    write: () => true,
    kill: () => true,
    announce: () => {},
    sameOwner: (a, b) => a === b,
    childCount: async () => 0,
    render: async (raw) => raw,
    rules: async () => rules,
    prefs: async () => ({ mode: 'danger', outsideWrites: true, allowRoots: [] }),
    now: () => Date.now(),
    sleep: async () => {}
  }
  const snapshot = () => ({ ...info, buffer: '', seq: 0 })
  const ctx = {
    ownerKeys: () => ['owner-1'],
    cwd: () => project,
    confirm: async (request) => {
      requests.push(request)
      return { allowed: false }
    }
  }
  const agent = new TerminalAgentCommands(host, ctx)
  const attempt = async (command) => {
    requests.length = 0
    try {
      await agent.run('run', { id: 't1', command })
    } catch (error) {
      globalThis.__lastTerminalError = error
    }
    return requests
  }

  await check('用户 cd 到项目外后，模型相对写入要问用户', async () => {
    await noteTerminalUserInput('t1', `cd ${elsewhere}\r`, project)
    const asked = await attempt('echo hi > note.txt')
    assert.equal(asked.length, 1, `应当有确认请求：${globalThis.__lastTerminalError?.message ?? ''}`)
    assert.ok(asked[0].outsideDirs.length >= 1, JSON.stringify(asked[0]))
    assert.ok(asked[0].reasons.some((reason) => reason.includes('项目之外')), JSON.stringify(asked[0].reasons))
  })

  await check('用户在项目内普通操作后，项目内相对写入不问', async () => {
    await noteTerminalUserInput('t1', `cd ${project}\r`, project)
    await noteTerminalUserInput('t1', 'ls\r', project)
    const asked = await attempt('echo hi > inside.txt')
    assert.equal(asked.length, 0, JSON.stringify(asked))
  })

  await check('拒绝后的说明与 danger-guard 同格式：外层英文、明确不绕开', async () => {
    await noteTerminalUserInput('t1', `cd ${elsewhere}\r`, project)
    await attempt('echo hi > note.txt')
    const message = globalThis.__lastTerminalError?.message ?? ''
    assert.match(message, /^High-risk operation not confirmed by the user: /, message)
    assert.match(message, /The user declined this operation/)
    assert.match(message, /Do not retry it and do not work around the refusal by another route/, message)
    assert.doesNotMatch(message, /更安全的做法/)
    assert.equal(dangerBlockKind(message), 'denied')
    await noteTerminalUserInput('t1', `cd ${project}\r`, project)
  })

  await check('用户跑了未知命令后，相对写入按未知位置询问', async () => {
    await noteTerminalUserInput('t1', 'some-alias\r', project)
    const asked = await attempt('echo hi > inside.txt')
    assert.equal(asked.length, 1, `未知位置应当询问：${globalThis.__lastTerminalError?.message ?? ''}`)
    assert.ok(asked[0].reasons.some((reason) => reason.includes('无法确定写入位置')), JSON.stringify(asked[0].reasons))
  })
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => undefined)
}

await rm(bundleDir, { recursive: true, force: true }).catch(() => undefined)

process.stdout.write(`\n${report.fail === 0 ? '✅' : '❌'} 终端清洗与可信位置：${report.pass} 通过 / ${report.fail} 失败\n`)
process.exit(report.fail === 0 ? 0 : 1)
