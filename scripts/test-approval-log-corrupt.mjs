#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const root = await mkdtemp(join(tmpdir(), 'yan-approval-log-'))
process.env.YAN_DATA_DIR = root

const built = await build({
  entryPoints: ['src/main/approval-log.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const { ApprovalLogStore } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const file = join(root, 'approval-log.json')
const request = (sessionId, index, toolCallId = `call-${index}`) => ({
  id: `req-${index}`,
  sessionId,
  toolCallId,
  kind: 'permission',
  tool: 'bash',
  title: '运行命令',
  detail: 'ls',
  reasons: ['示例'],
  cwd: root,
  createdAt: 1_700_000_000_000 + index
})
const corruptBackups = async () => (await readdir(root)).filter((name) => name.includes('approval-log.json.corrupt-'))

try {
  process.stdout.write('\n▌审批坏日志只备份一次（B6）\n')
  const store = new ApprovalLogStore(() => file)
  await check('同一个坏文件反复读取只留一份备份，坏文件本身不动', async () => {
    await writeFile(file, '{"version":1,"sessions":{"bad id":[]}}')
    const before = await readFile(file, 'utf8')
    assert.deepEqual(store.list('s-1'), [])
    assert.deepEqual(store.list('s-1'), [])
    assert.deepEqual(store.list('s-2'), [])
    assert.equal((await corruptBackups()).length, 1, '只应有一份备份')
    assert.equal(await readFile(file, 'utf8'), before, '坏文件本身保留原样')
  })

  await check('坏文件被改过之后才会生成第二份备份', async () => {
    await writeFile(file, '{"version":1,"sessions":"not-an-object"}')
    await utimes(file, new Date(), new Date(Date.now() + 1000))
    assert.deepEqual(store.list('s-1'), [])
    assert.equal((await corruptBackups()).length, 2)
  })

  await check('另一个 store 实例面对同一坏文件也只备份一次', async () => {
    const second = new ApprovalLogStore(() => file)
    assert.deepEqual(second.list('s-1'), [])
    assert.equal((await corruptBackups()).length, 2, '同一份坏内容不重复备份')
  })

  process.stdout.write('\n▌审批日志读写\n')
  await check('记录审批回执后能读回，文件内容完整', async () => {
    await rm(file, { force: true })
    const fresh = new ApprovalLogStore(() => file)
    const update = fresh.record(request('s-1', 1), { choice: 'once' })
    assert.equal(update?.sessionId, 's-1')
    assert.equal(fresh.list('s-1').length, 1)
    const doc = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(doc.sessions['s-1'][0].toolCallId, 'call-1')
  })

  await check('重复回执同一 id 不会重复累加', async () => {
    const fresh = new ApprovalLogStore(() => file)
    fresh.record(request('s-1', 1), { choice: 'deny', feedback: '换个做法' })
    const entries = fresh.list('s-1')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].choice, 'deny')
    assert.equal(entries[0].feedback, '换个做法')
  })

  await check('别的进程改写文件后，读到的不是旧缓存', async () => {
    const fresh = new ApprovalLogStore(() => file)
    assert.equal(fresh.list('s-1').length, 1)
    const doc = JSON.parse(await readFile(file, 'utf8'))
    doc.sessions['s-1'].push({ id: 'req-9', toolCallId: 'call-9', kind: 'danger', tool: 'bash', title: '外部写入', choice: 'once', askedAt: 1, at: 2 })
    await writeFile(file, JSON.stringify(doc))
    await utimes(file, new Date(), new Date(Date.now() + 2000))
    assert.equal(fresh.list('s-1').length, 2)
  })

  await check('单会话超过 200 条只留最近的', async () => {
    await rm(file, { force: true })
    const fresh = new ApprovalLogStore(() => file)
    for (let i = 0; i < 205; i += 1) fresh.record(request('s-1', i), { choice: 'once' })
    const entries = fresh.list('s-1')
    assert.equal(entries.length, 200)
    assert.equal(entries.at(-1).toolCallId, 'call-204')
  })

  await check('会话数没有破坏性上限：每个会话的审批历史都保留', async () => {
    await rm(file, { force: true })
    const fresh = new ApprovalLogStore(() => file)
    for (let i = 0; i < 205; i += 1) fresh.record(request(`session-${i}`, i), { choice: 'once' }, 1_700_000_000_000 + i)
    const doc = JSON.parse(await readFile(file, 'utf8'))
    const keys = Object.keys(doc.sessions)
    assert.equal(keys.length, 205, `实际 ${keys.length}`)
    assert.equal(keys.includes('session-0'), true, '最早的会话也没有被静默清掉')
    assert.equal(keys.includes('session-204'), true)
    assert.equal((await stat(file)).size > 0, true)
  })
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}

process.stdout.write(`\n${report.fail === 0 ? '✅' : '❌'} 审批日志：${report.pass} 通过 / ${report.fail} 失败\n`)
process.exit(report.fail === 0 ? 0 : 1)
