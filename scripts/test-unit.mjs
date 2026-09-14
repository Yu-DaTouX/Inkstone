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
const { listSessions, deleteSession, restoreSession, SESSIONS_DIR } = await import('../out/main/sessions.js')

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

/*
 * 界面缩放的纯计算（src/main/zoom-math.ts）。
 *
 * 为什么不直接从 out/main/zoom-math.js import：它现在已经进了主进程
 * 构建入口（electron.vite.config.ts 的 input），但只要哪天有人把它
 * 从入口列表里删掉（它只被 zoom.ts import，而 zoom.ts 会被摇进 index.js），
 * 这个测试就会静默地找不到文件。现场编译一份不依赖构建图。
 */
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/zoom-math.ts'],
    outfile: 'out/test/zoom-math.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)

/*
 * 流式增量推送（src/main/agent.ts）。
 *
 * 为什么不直接 import out/main/index.js：整个主进程入口会把 Electron 拉进来
 * （node 下跑不了）。而 AgentController 本身只依赖 node 内置与本地模块，
 * 所以单独 bundle 一份 —— 它的 handleEvent 是纯逻辑，不需要窗口、不需要 pi。
 */
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/agent.ts'],
    outfile: 'out/test/agent.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)
const { runTurnTests } = await import('./test-turns.mjs')
const { runZoomTests } = await import('./test-zoom.mjs')

/*
 * 本机 Chrome profile 同步的纯逻辑（选 profile / 拼路径 / 逐项容错）。
 * 现场编译，理由同 turns.ts：这段逻辑只被 browser.ts import，
 * 主进程构建会把它摇进 index.js，不单独产出到 out/main。
 */
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/chrome-profile.ts'],
    outfile: 'out/test/chrome-profile.mjs',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)
const { runChromeProfileTests } = await import('./test-chrome-profile.mjs')

/*
 * 对话宽度钳取（src/shared/ipc.ts）。
 * ipc.ts 是纯类型/常量模块（无 electron / DOM 依赖），可以现场编译。
 */
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/shared/ipc.ts'],
    outfile: 'out/test/ipc.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)
const { runStreamWidthTests } = await import('./test-stream-width.mjs')
const { runQuestionTests } = await import('./test-question.mjs')

/*
 * 历史任务快照归并（src/main/todo-snapshots.ts）。
 * 纯函数（不碰 electron），现场编译一份测它 —— 不被主进程构建图影响。
 */
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/todo-snapshots.ts'],
    outfile: 'out/test/todo-snapshots.mjs',
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent'
  })
)
const { runTodoHistoryTests } = await import('./test-todo-history.mjs')

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


console.log('\n--- 7. 缓存：内容没变时不重读 ---')
const before = (await listSessions()).find((s) => s.id === 'aaa')
const after = (await listSessions()).find((s) => s.id === 'aaa')
ok(before === after || (before?.title === after?.title && before?.updatedAt === after?.updatedAt), '两次调用结果一致')


console.log('\n--- 8. 删除的路径防护 ---')

// 父子孙分支必须作为一棵树移动，并可完整撤销。
const branchRoot = await makeSession('branch-root.jsonl', {
  id: 'branch-root', timestamp: new Date().toISOString(), cwd: 'C:\\branch', messages: ['root']
})
const branchChild = await makeSession('branch-child.jsonl', {
  id: 'branch-child', parentSession: 'branch-root', timestamp: new Date().toISOString(), cwd: 'C:\\branch', messages: ['child']
})
const branchGrandchild = await makeSession('branch-grandchild.jsonl', {
  id: 'branch-grandchild', parentSession: 'branch-child', timestamp: new Date().toISOString(), cwd: 'C:\\branch', messages: ['grandchild']
})
const branchToken = await deleteSession(branchRoot)
const afterBranchDelete = await listSessions()
ok(![branchRoot, branchChild, branchGrandchild].some((p) => afterBranchDelete.some((s) => s.path === p)), '删除父会话会移除整棵父子孙树')
await restoreSession(branchToken)
const afterBranchRestore = await listSessions()
ok([branchRoot, branchChild, branchGrandchild].every((p) => afterBranchRestore.some((s) => s.path === p)), '撤销删除会恢复整棵父子孙树')

let protectedRejected = false
try { await deleteSession(branchRoot, branchGrandchild) } catch { protectedRejected = true }
ok(protectedRejected, '当前会话位于子树时拒绝删除父会话')
const afterProtected = await listSessions()
ok([branchRoot, branchChild, branchGrandchild].every((p) => afterProtected.some((s) => s.path === p)), '拒绝删除时不会移动任何分支文件')

// 正常删除：先移入回收站，再允许本次运行内撤销
const undoToken = await deleteSession(pPath)
list = await listSessions()
ok(!list.some((s) => s.id === 'ccc'), '删除后列表里没有了')
await restoreSession(undoToken)
list = await listSessions()
ok(list.some((s) => s.id === 'ccc'), '撤销后会话恢复到原路径')

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
// 模块常量已经定型，这里只能验证「已删除的目录」不会抛
const empty = await listSessions()
ok(Array.isArray(empty), '目录被删后仍返回数组', `${empty.length} 条`)


// pi 定位（来源分类）——纯文件探测，不启 pi
console.log('\n--- 11. pi 定位：来源分类 ---')
const { resolvePi, bundledAvailable, piInfo, resetPiVersionCache } = await import('../out/main/protocol.js')

const piTmp = await mkdtemp(join(tmpdir(), 'yan-pi-'))
const fakeCli = join(piTmp, 'fake-cli.js')
await writeFile(fakeCli, '// stub\n', 'utf8')

// 环境变量命中
process.env.YAN_PI_BIN = fakeCli
const envProbe = resolvePi()
ok(envProbe.source === 'env', 'YAN_PI_BIN 命中时来源 = env', `source=${envProbe.source}`)
ok(envProbe.args.includes(fakeCli), 'env 命中时参数指向该入口')

// 设置项 override 优先于环境变量
const ovProbe = resolvePi({ override: fakeCli })
ok(ovProbe.source === 'override', 'piBin 优先于 YAN_PI_BIN', `source=${ovProbe.source}`)
ok(ovProbe.home === undefined || typeof ovProbe.home === 'string', 'home 字段类型正确')

delete process.env.YAN_PI_BIN

// piInfo 透传来源（会跑一次 --version，stub 无输出 → 版本 undefined）
resetPiVersionCache()
const piInfoRes = await piInfo(fakeCli, { fresh: true })
ok(piInfoRes.source === 'override', 'piInfo 透传来源', `source=${piInfoRes.source}`)
ok(piInfoRes.bin === fakeCli, 'piInfo.bin 为指定入口')
ok(typeof piInfoRes.bundledAvailable === 'boolean', 'piInfo.bundledAvailable 是布尔')

await rm(piTmp, { recursive: true, force: true })


// 回合分组 / 段落拆分 / 缓存命中率（纯函数，不启动 Electron）
await runTurnTests(ok)


// 界面缩放（纯函数：DPI 取整 / 夹取 / 梯子）
await runZoomTests(ok)


// 本机 Chrome profile 同步（合成目录，不碰真实 profile）
await runChromeProfileTests(ok)


// 对话宽度钳取（纯函数）
await runStreamWidthTests(ok)


// 内置提问扩展（不启动 pi：import 后喂假 pi API）
await runQuestionTests(ok)
await runTodoHistoryTests(ok)

// 流式增量推送协议（textDelta / thinkingDelta / outputDelta）
const { runStreamDeltasTests } = await import('./test-stream-deltas.mjs')
await runStreamDeltasTests(ok)

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
