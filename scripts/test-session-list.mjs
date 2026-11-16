import './lib/test-isolate.mjs'
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isIsolatedTestEnv } from './lib/test-env.mjs'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const isolatedEnv = isIsolatedTestEnv()
  const dir = await mkdtemp(join(tmpdir(), 'yan-sessions-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'yan-data-'))
  process.env.YAN_SESSIONS_DIR = dir
  process.env.YAN_DATA_DIR = dataDir

  const { listSessions, deleteSession, readTitleSamples, restoreSession, SESSIONS_DIR } = await compile('src/main/sessions.ts')

  console.log(`临时会话目录: ${dir}`)
  console.log(`模块用的目录: ${SESSIONS_DIR}`)
  ok(SESSIONS_DIR === dir, 'YAN_SESSIONS_DIR 生效（测试不会碰真实会话）')
  ok(isolatedEnv, '测试环境已隔离（宿主 YAN_*/PI_* 已清空，数据目录在临时区）')

  const PROJECT = join(dir, '--C--Users-Test--')
  await mkdir(PROJECT, { recursive: true })

  const line = (o) => JSON.stringify(o) + '\n'

  async function makeSession(file, opts) {
    const p = join(PROJECT, file)
    let body = line({
      type: 'session',
      version: 3,
      id: opts.id,
      timestamp: opts.timestamp,
      cwd: opts.cwd,
      ...(opts.parentSession ? { parentSession: opts.parentSession } : {})
    })
    if (opts.name) {
      body += line({
        type: 'session_info',
        id: 'n1',
        parentId: null,
        timestamp: opts.timestamp,
        name: opts.name
      })
    }
    for (const text of opts.messages) {
      body += line({
        type: 'message',
        id: 'm' + Math.random().toString(36).slice(2, 8),
        parentId: null,
        timestamp: opts.timestamp,
        message: { role: 'user', content: [{ type: 'text', text }] }
      })
    }
    await writeFile(p, body, 'utf8')
    return p
  }

  const HOME = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Test'

  console.log('\n--- 1. 标题：优先 session_info 的名字 ---')

  const pNamed = await makeSession('a.jsonl', {
    id: 'aaa',
    timestamp: new Date().toISOString(),
    cwd: 'C:\\Users\\Test\\proj',
    name: '季度总结',
    messages: ['这条应该被名字盖住']
  })

  const pUnnamed = await makeSession('b.jsonl', {
    id: 'bbb',
    timestamp: new Date().toISOString(),
    cwd: 'C:\\Users\\Test\\proj',
    messages: ['没名字的会话就用首条消息当标题']
  })

  let list = await listSessions()
  const named = list.find((s) => s.id === 'aaa')
  const unnamed = list.find((s) => s.id === 'bbb')

  ok(!!named && named.title === '季度总结', '有 session_info 时用名字', `title=${named?.title}`)
  ok(!!named && named.named === true, 'named 标记为 true')
  ok(!!unnamed && unnamed.title === '没名字的会话就用首条消息当标题', '没有名字时用首条用户消息')
  ok(!!unnamed && unnamed.named === false, 'named 标记为 false')
  ok(list.length === 2, `列出 ${list.length} 个会话`)

  console.log('\n--- 1b. 按需标题只取首条 / 最近用户文字 ---')

  const pSamples = await makeSession('samples.jsonl', {
    id: 'samples',
    timestamp: new Date().toISOString(),
    cwd: 'C:\\Users\\Test\\proj',
    messages: ['首条用户意图', '中间消息', '最近的用户问题']
  })
  const titleSamples = await readTitleSamples(pSamples)
  ok(titleSamples.length === 2, '标题样本只有首条和最近一条', JSON.stringify(titleSamples))
  ok(titleSamples[0] === '首条用户意图' && titleSamples[1] === '最近的用户问题', '标题样本保持时间顺序')

  const pLongSamples = await makeSession('samples-long.jsonl', {
    id: 'samples-long',
    timestamp: new Date().toISOString(),
    cwd: 'C:\\Users\\Test\\proj',
    messages: ['A'.repeat(800), 'B'.repeat(800)]
  })
  const longTitleSamples = await readTitleSamples(pLongSamples)
  ok(longTitleSamples.every((sample) => sample.length <= 600), '每条标题样本最多 600 字符')
  ok(longTitleSamples.reduce((n, sample) => n + sample.length, 0) <= 1200, '标题样本总量最多 1200 字符')

  console.log('\n--- 2. 名字取最后一个（改名后应生效）---')

  const pRename = join(PROJECT, 'a.jsonl')
  const renamed = await import('node:fs/promises').then((fs) => fs.readFile(pRename, 'utf8'))
  await writeFile(
    pRename,
    renamed +
      line({
        type: 'session_info',
        id: 'n2',
        parentId: 'n1',
        timestamp: new Date().toISOString(),
        name: '季度总结 · 定稿'
      }),
    'utf8'
  )

  list = await listSessions()
  const afterRename = list.find((s) => s.id === 'aaa')
  ok(
    afterRename?.title === '季度总结 · 定稿',
    '名字改了之后列出的是新名字',
    `title=${afterRename?.title}`
  )

  console.log('\n--- 3. 家目录缩成 ~ ---')

  const pPath = await makeSession('c.jsonl', {
    id: 'ccc',
    timestamp: new Date().toISOString(),
    cwd: HOME,
    messages: [`${HOME}\\Desktop\\pi-desktop 读这个文件`]
  })

  list = await listSessions()
  const shortened = list.find((s) => s.id === 'ccc')
  ok(
    shortened?.title.startsWith('~'),
    '标题里的家目录被缩成 ~',
    `title=${shortened?.title}`
  )
  ok(shortened?.title.length <= 35, `标题被截断到 ${shortened?.title.length} 字符（上限 34+省略号）`)

  console.log('\n--- 4. cwd 取自 session 头 ---')
  ok(shortened?.cwd === HOME, 'cwd 解析正确', `cwd=${shortened?.cwd}`)

  console.log('\n--- 5. 消息条数 ---')
  ok(shortened?.messageCount === 1, 'messageCount = 1', `实际 ${shortened?.messageCount}`)

  console.log('\n--- 6. 按更新时间倒序 ---')
  const times = list.map((s) => s.updatedAt)
  ok(
    times.every((v, i) => i === 0 || times[i - 1] >= v),
    '列表按 updatedAt 倒序',
    times.join(' ≥ ')
  )

  console.log('\n--- 8. 删除的路径防护 ---')

  const branchRoot = await makeSession('branch-root.jsonl', {
    id: 'branch-root', timestamp: new Date().toISOString(), cwd: 'C:\\branch', messages: ['root']
  })
  const branchChild = await makeSession('branch-child.jsonl', {
    id: 'branch-child', parentSession: 'branch-root', timestamp: new Date().toISOString(), cwd: 'C:\\branch', messages: ['child']
  })
  const branchGrandchild = await makeSession('branch-grandchild.jsonl', {
    id: 'branch-grandchild', parentSession: 'branch-child', timestamp: new Date().toISOString(), cwd: 'C:\\branch', messages: ['grandchild']
  })
  const branchToken = await deleteSession(branchRoot, branchGrandchild)
  const afterBranchDelete = await listSessions()
  ok(!afterBranchDelete.some((s) => s.path === branchRoot), '删除父会话只移除父会话本身')
  ok([branchChild, branchGrandchild].every((p) => afterBranchDelete.some((s) => s.path === p)), '删除父会话保留分支会话')
  await restoreSession(branchToken)
  const afterBranchRestore = await listSessions()
  ok([branchRoot, branchChild, branchGrandchild].every((p) => afterBranchRestore.some((s) => s.path === p)), '撤销删除恢复父会话')

  let protectedRejected = false
  try { await deleteSession(branchGrandchild, branchGrandchild) } catch { protectedRejected = true }
  ok(protectedRejected, '拒绝删除当前正在使用的会话')
  const afterProtected = await listSessions()
  ok([branchRoot, branchChild, branchGrandchild].every((p) => afterProtected.some((s) => s.path === p)), '拒绝删除时不会移动任何会话文件')

  await writeFile(`${pPath}.history.txt`, '=== compaction 1 ===\n')
  const undoToken = await deleteSession(pPath)
  list = await listSessions()
  ok(!list.some((s) => s.id === 'ccc'), '删除后列表里没有了')
  ok(!existsSync(`${pPath}.history.txt`), '压缩原文快照随会话一起移进回收站')
  await restoreSession(undoToken)
  list = await listSessions()
  ok(list.some((s) => s.id === 'ccc'), '撤销后会话恢复到原路径')
  ok(existsSync(`${pPath}.history.txt`), '撤销删除时快照也恢复')

  const outsideDir = await mkdtemp(join(tmpdir(), 'yan-sessions-outside-'))
  const evilPath = join(outsideDir, 'evil.jsonl')
  await writeFile(evilPath, line({ type: 'session', version: 3, id: 'evil', timestamp: new Date().toISOString(), cwd: 'C:\\evil' }), 'utf8')
  let rejectedMessage = ''
  try {
    await deleteSession(join(dir, '..', outsideDir.split(/[\\/]/).pop(), 'evil.jsonl'))
  } catch (error) {
    rejectedMessage = String(error?.message ?? error)
  }
  ok(/会话目录|sessions folder/.test(rejectedMessage), '拒绝删除会话目录之外的文件', rejectedMessage)
  ok(existsSync(evilPath), '拒绝删除时目录外文件仍在原位')
  await rm(outsideDir, { recursive: true, force: true })

  const txtPath = join(PROJECT, 'a.txt')
  await writeFile(txtPath, 'not a session\n', 'utf8')
  rejectedMessage = ''
  try {
    await deleteSession(txtPath)
  } catch (error) {
    rejectedMessage = String(error?.message ?? error)
  }
  ok(/不是会话文件|Not a session file/.test(rejectedMessage), '拒绝删除非 .jsonl 文件', rejectedMessage)
  ok(existsSync(txtPath), '拒绝删除时非会话文件仍在原位')
  await rm(txtPath, { force: true })

  console.log('\n--- 9. 坏数据不致命 ---')

  await writeFile(join(PROJECT, 'broken.jsonl'), 'not json at all\n{{{', 'utf8')
  await writeFile(join(PROJECT, 'empty.jsonl'), '', 'utf8')

  const survived = await listSessions()
  ok(Array.isArray(survived), '遇到坏文件仍返回数组', `${survived.length} 条`)
  ok(
    survived.some((s) => s.id === 'aaa'),
    '正常会话不受影响'
  )

  console.log('\n--- 10. 不存在的目录 ---')
  await rm(dir, { recursive: true, force: true })
  process.env.YAN_SESSIONS_DIR = join(dir, 'nope')
  const empty = await listSessions()
  ok(Array.isArray(empty), '目录被删后仍返回数组', `${empty.length} 条`)
  await rm(dataDir, { recursive: true, force: true })
})
