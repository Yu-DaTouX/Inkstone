/**
 * 会话模块的单元测试（不启动 Electron、不碰 pi、不花 token）。
 *
 * 为什么单独做：listSessions 的解析逻辑是纯函数式的 ——
 * 名字来源、`~` 缩写、缓存、删除的路径防护都可以用合成文件确定性地验证。
 * 放在真实会话目录里跑会污染用户数据，所以用 YAN_SESSIONS_DIR 指向临时目录。
 *
 * 用法： npm run test:unit
 */
import { mkdtemp, writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = await mkdtemp(join(tmpdir(), 'yan-sessions-'))
process.env.YAN_SESSIONS_DIR = dir

// 必须在设置 env 之后 import（模块顶层读了这个变量）
const { listSessions, deleteSession, SESSIONS_DIR } = await import('../out/main/sessions.js')

/*
 * 回合分组的纯逻辑用 esbuild 现场编译。
 *
 * 为什么不用 out/main/*.js：`src/shared/turns.ts` 是共享层的模块，
 * 主进程的构建不会把它输出到 out/main（那是摇树后的产物，只有主进程
 * 真正 import 到的东西）。为了一个纯函数去改主进程的 import 图不值得 ——
 * 直接用项目里已有的 esbuild（vite 的依赖）转一下，几十毫秒。
 */
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/turns.ts'],
    outfile: 'out/test/turns.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)
const { runTurnTests } = await import('./test-turns.mjs')

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) {
    pass++
    console.log(`✓ ${label}${extra ? '  ' + extra : ''}`)
  } else {
    fail++
    console.log(`✗ ${label}${extra ? '  ' + extra : ''}`)
  }
}

console.log(`临时会话目录: ${dir}`)
console.log(`模块用的目录: ${SESSIONS_DIR}`)
ok(SESSIONS_DIR === dir, 'YAN_SESSIONS_DIR 生效（测试不会碰真实会话）')

const PROJECT = join(dir, '--C--Users-Test--')
await mkdir(PROJECT, { recursive: true })

const line = (o) => JSON.stringify(o) + '\n'

/** 造一个会话文件 */
async function makeSession(file, opts) {
  const p = join(PROJECT, file)
  let body = line({
    type: 'session',
    version: 3,
    id: opts.id,
    timestamp: opts.timestamp,
    cwd: opts.cwd
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

/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
console.log('\n--- 4. cwd 取自 session 头 ---')
ok(shortened?.cwd === HOME, 'cwd 解析正确', `cwd=${shortened?.cwd}`)

/* ------------------------------------------------------------------ */
console.log('\n--- 5. 消息条数 ---')
ok(shortened?.messageCount === 1, 'messageCount = 1', `实际 ${shortened?.messageCount}`)

/* ------------------------------------------------------------------ */
console.log('\n--- 6. 按更新时间倒序 ---')
const times = list.map((s) => s.updatedAt)
ok(
  times.every((v, i) => i === 0 || times[i - 1] >= v),
  '列表按 updatedAt 倒序',
  times.join(' ≥ ')
)

/* ------------------------------------------------------------------ */
console.log('\n--- 7. 缓存：内容没变时不重读 ---')
const before = (await listSessions()).find((s) => s.id === 'aaa')
const after = (await listSessions()).find((s) => s.id === 'aaa')
ok(before === after || (before?.title === after?.title && before?.updatedAt === after?.updatedAt), '两次调用结果一致')

/* ------------------------------------------------------------------ */
console.log('\n--- 8. 删除的路径防护 ---')

// 正常删除
await deleteSession(pPath)
list = await listSessions()
ok(!list.some((s) => s.id === 'ccc'), '删除后列表里没有了')

// 越界路径必须被拒
let rejected = false
try {
  await deleteSession(join(dir, '..', '..', 'evil.jsonl'))
} catch {
  rejected = true
}
ok(rejected, '拒绝删除会话目录之外的文件')

// 非 jsonl 必须被拒
rejected = false
try {
  await deleteSession(join(PROJECT, 'a.txt'))
} catch {
  rejected = true
}
ok(rejected, '拒绝删除非 .jsonl 文件')

/* ------------------------------------------------------------------ */
console.log('\n--- 9. 坏数据不致命 ---')

await writeFile(join(PROJECT, 'broken.jsonl'), 'not json at all\n{{{', 'utf8')
await writeFile(join(PROJECT, 'empty.jsonl'), '', 'utf8')

const survived = await listSessions()
ok(Array.isArray(survived), '遇到坏文件仍返回数组', `${survived.length} 条`)
ok(
  survived.some((s) => s.id === 'aaa'),
  '正常会话不受影响'
)

/* ------------------------------------------------------------------ */
console.log('\n--- 10. 不存在的目录 ---')
await rm(dir, { recursive: true, force: true })
process.env.YAN_SESSIONS_DIR = join(dir, 'nope')
// 模块常量已经定型，这里只能验证「已删除的目录」不会抛
const empty = await listSessions()
ok(Array.isArray(empty), '目录被删后仍返回数组', `${empty.length} 条`)

/* ------------------------------------------------------------------ */
// 回合分组 / 段落拆分 / 缓存命中率（纯函数，不启动 Electron）
await runTurnTests(ok)

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
