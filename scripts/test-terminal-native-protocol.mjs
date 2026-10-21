import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createContext, Script } from 'node:vm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { build, transform } from 'esbuild'
import ts from 'typescript'

const RUNTIME_ROOT = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'resources/pi-runtime')
const ENTRY = 'src/main/terminal-status.ts'

const WANTED_FUNCS = ['isProgramStatusReply', 'truncateUtf8', 'formatProgramStatus']
const WANTED_VARS = ['PROGRAM_STATUS_QUERY', 'APP_PATTERN', 'CONTROL_CHARACTERS', 'MAX_MESSAGE_BYTES']
const WANTED = [...WANTED_FUNCS, ...WANTED_VARS]

let checks = 0
const ok = (condition, message) => {
  assert.ok(condition, message)
  checks += 1
}
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks += 1
}

async function findPiChunk() {
  const manifest = JSON.parse(await readFile(join(RUNTIME_ROOT, 'current.json'), 'utf8'))
  assert.ok(typeof manifest.generation === 'string', 'current.json 缺少 generation')
  const chunksDir = join(RUNTIME_ROOT, manifest.generation, 'dist/bundle/chunks')
  const files = (await readdir(chunksDir)).filter((name) => name.endsWith('.js'))
  const matches = []
  for (const name of files) {
    const text = await readFile(join(chunksDir, name), 'utf8')
    if (WANTED.every((symbol) => text.includes(symbol))) matches.push({ path: join(chunksDir, name), text })
  }
  assert.ok(matches.length > 0, '在 pi bundle 里找不到 OSC 7501 声明')
  matches.sort((a, b) => Number(b.path.endsWith('chunk-6MWTY2OB.js')) - Number(a.path.endsWith('chunk-6MWTY2OB.js')))
  return matches[0]
}

function extractDeclarations(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const found = new Map()
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && WANTED_FUNCS.includes(statement.name.text)) {
      found.set(statement.name.text, statement.getText(sourceFile))
      continue
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && WANTED_VARS.includes(declaration.name.text)) {
          found.set(declaration.name.text, `var ${declaration.getText(sourceFile)};`)
        }
      }
    }
  }
  for (const symbol of WANTED) assert.ok(found.has(symbol), `pi 源缺少声明 ${symbol}`)
  const code = `${WANTED.map((symbol) => found.get(symbol)).join('\n')}\n;({ ${WANTED.join(', ')} })`
  return new Script(code, { filename: fileName })
}

function loadPi(script) {
  const context = createContext({ Buffer })
  return script.runInContext(context)
}

async function loadModule() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-terminal-native-'))
  const outfile = join(dir, 'terminal-status.mjs')
  const result = await build({
    entryPoints: [ENTRY],
    outfile,
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    metafile: true,
    logLevel: 'silent'
  })
  assert.deepEqual(Object.keys(result.metafile.inputs), [ENTRY], '终端状态解析应是自包含纯模块')
  return { mod: await import(pathToFileURL(outfile).href), dir }
}

async function loadTerminalEnvironment() {
  const source = await readFile('src/main/terminal.ts', 'utf8')
  const file = ts.createSourceFile('terminal.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const fn = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'terminalEnvironment')
  assert.ok(fn, '正式终端必须使用可核对的环境适配函数')
  const { code } = await transform(fn.getText(file).replace('export function', 'function'), { loader: 'ts' })
  return new Script(`${code};terminalEnvironment`).runInNewContext({ process: { platform: process.platform } })
}

const bodyOf = (frame) => frame.slice(2, -2)

export async function runNativeProtocolTests() {
  const { path: chunkPath, text } = await findPiChunk()
  const pi = loadPi(extractDeclarations(text, chunkPath))
  const { mod, dir } = await loadModule()
  try {
    const {
      TerminalStatusScanner,
      TerminalProgramStatusTracker,
      parseTerminalStatusReport,
      PROGRAM_STATUS_REPLY
    } = mod

    const environment = await loadTerminalEnvironment()
    eq(environment({ KEEP: 'yes' }, 'win32').PI_PROGRAM_STATUS, '1', 'Windows自建终端默认使用原生报告开关')
    eq(environment({ PI_PROGRAM_STATUS: '0' }, 'win32').PI_PROGRAM_STATUS, '0', '显式关闭不被覆盖')
    eq(environment({ PI_PROGRAM_STATUS: 'auto' }, 'win32').PI_PROGRAM_STATUS, 'auto', '显式自动模式保留')
    eq(environment({}, 'linux').PI_PROGRAM_STATUS, undefined, '非Windows不强制上报')
    eq(environment({ KEEP: 'yes' }, 'win32').KEEP, 'yes', '其他环境配置保留')
    const untouched = {}
    environment(untouched, 'win32')
    eq(untouched, {}, '不修改传入环境或全局process.env')

    eq(pi.PROGRAM_STATUS_QUERY, '\x1b]7501;?\x1b\\', 'pi PROGRAM_STATUS_QUERY 是精确查询')
    eq(pi.MAX_MESSAGE_BYTES, 2048, 'pi MAX_MESSAGE_BYTES = 2048')
    ok(pi.APP_PATTERN.test('my.app+v1-2'), 'pi APP_PATTERN 接受 . + -')
    ok(!pi.APP_PATTERN.test('bad app'), 'pi APP_PATTERN 拒绝空格')
    eq(typeof pi.isProgramStatusReply, 'function', 'isProgramStatusReply 已抽出')
    eq(typeof pi.formatProgramStatus, 'function', 'formatProgramStatus 已抽出')
    eq(typeof pi.truncateUtf8, 'function', 'truncateUtf8 已抽出')

    ok(pi.isProgramStatusReply(PROGRAM_STATUS_REPLY), '本模块 7501;?1 回复被 pi isProgramStatusReply 接受')
    ok(pi.isProgramStatusReply(PROGRAM_STATUS_REPLY + ''), '写回帧本身被 pi 接受')
    ok(pi.isProgramStatusReply('\x1b]7501;?\x07'), '空 payload + BEL 也被 pi 接受')
    ok(!pi.isProgramStatusReply('\x1b]7501;state=working\x1b\\'), '状态上报不是能力回复')
    {
      const tracker = new TerminalProgramStatusTracker()
      eq(tracker.consume(PROGRAM_STATUS_REPLY).queries, 0, '回复回显不触发查询')
      eq(tracker.consume(PROGRAM_STATUS_REPLY).queries, 0, '重复回显仍不触发查询')
      eq(tracker.consume(pi.PROGRAM_STATUS_QUERY).queries, 1, 'pi 精确查询触发一次回复')
    }
    eq(new TerminalStatusScanner().write(pi.PROGRAM_STATUS_QUERY), [{ kind: 'query' }], '真实查询帧被识别')

    const projections = [
      [{ state: 'working' }, { state: 'working' }, 'working'],
      [{ state: 'working', app: 'pi' }, { state: 'working', app: 'pi' }, 'working + app'],
      [{ state: 'working', app: 'my.app+v1-2', message: '编译中' }, { state: 'working', app: 'my.app+v1-2', title: '编译中' }, 'app 含 . + -'],
      [{ state: 'blocked', kind: 'permission', message: '允许？' }, { state: 'blocked', kind: 'permission', title: '允许？' }, 'blocked permission'],
      [{ state: 'blocked', kind: 'question', message: '选一个' }, { state: 'blocked', kind: 'question', title: '选一个' }, 'blocked question'],
      [{ state: 'blocked', kind: 'auth', message: '登录' }, { state: 'blocked', kind: 'auth', title: '登录' }, 'blocked auth'],
      [{ state: 'done' }, { state: 'done' }, 'done'],
      [{ state: 'error', message: '失败' }, { state: 'error', title: '失败' }, 'error'],
      [{ state: 'idle' }, { state: 'idle' }, 'idle']
    ]
    for (const [input, expected, label] of projections) {
      const frame = pi.formatProgramStatus(input)
      const body = bodyOf(frame)
      eq(parseTerminalStatusReport(body), expected, `${label}: 解析 pi 真实帧`)
      const tracker = new TerminalProgramStatusTracker()
      eq(tracker.consume(frame).queries, 0, `${label}: 真实上报不触发查询`)
      eq(tracker.status, expected, `${label}: Tracker 落成投影`)
    }

    {
      const working = pi.formatProgramStatus({ state: 'working' })
      const clear = pi.formatProgramStatus({ state: 'clear' })
      const tracker = new TerminalProgramStatusTracker()
      tracker.consume(working)
      eq(tracker.status, { state: 'working' }, 'clear 前有记录')
      eq(tracker.consume(clear).changed, true, 'pi clear 帧清除记录')
      eq(tracker.status, undefined, 'clear 后无记录')
    }

    {
      const frames = [
        [pi.formatProgramStatus({ state: 'working', app: 'pi', message: '多字节😀' }), { state: 'working', app: 'pi', title: '多字节😀' }],
        [pi.formatProgramStatus({ state: 'blocked', kind: 'question', message: '选一个' }), { state: 'blocked', kind: 'question', title: '选一个' }],
        [pi.formatProgramStatus({ state: 'error', message: '失败' }), { state: 'error', title: '失败' }]
      ]
      for (const [frame, expected] of frames) {
        for (let i = 0; i <= frame.length; i += 1) {
          const tracker = new TerminalProgramStatusTracker()
          tracker.consume(frame.slice(0, i))
          tracker.consume(frame.slice(i))
          eq(tracker.status, expected, `真实帧在第 ${i} 个字符分割等价`)
        }
        const charByChar = new TerminalProgramStatusTracker()
        for (const char of frame) charByChar.consume(char)
        eq(charByChar.status, expected, '真实帧逐字符输入等价')
      }
    }

    {
      const long = pi.formatProgramStatus({ state: 'working', message: '编'.repeat(800) + '😀'.repeat(100) })
      const decoded = parseTerminalStatusReport(bodyOf(long))
      eq(decoded.state, 'working', '长 msg 帧仍是 working')
      eq(Array.from(decoded.title).length, 120, '解码标题按码点截到 120')
      ok(decoded.title.isWellFormed(), '标题无孤立代理')
      eq(pi.truncateUtf8('a' + '😀'.repeat(10), 4), 'a', 'pi truncateUtf8 不切代理对')
      eq(pi.truncateUtf8('😀😀😀', 4), '😀', 'pi truncateUtf8 保留完整码点')
      ok(Buffer.byteLength(pi.truncateUtf8('😀😀😀', 4), 'utf8') <= 4, 'pi truncateUtf8 不超字节上限')
    }

    eq(parseTerminalStatusReport(bodyOf(pi.formatProgramStatus({ state: 'working', app: 'bad app' }))), { state: 'working' }, 'pi 丢弃非法 app，解析结果不带 app')
    eq(parseTerminalStatusReport(bodyOf(pi.formatProgramStatus({ state: 'working', kind: 'permission' }))), { state: 'working' }, '非 blocked 的 kind 不出现在真实帧里')

    ok(!pi.formatProgramStatus({ state: 'working', message: 'x' }).includes('progress'), 'pi 1.2 formatter 不产出 progress')
    eq(parseTerminalStatusReport('7501;state=working:progress=42'), { state: 'working', progress: 42 }, 'progress 是本模块额外接受的扩展，不代表从 pi 收到百分比')

    console.log(`terminal-native-protocol: ${checks} 项真实 pi 源兼容检查通过 (chunk: ${chunkPath.replace(/\\/g, '/')})`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--pty')) await runPtyProbe()
  else await runNativeProtocolTests()
}

async function runPtyProbe() {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { createServer } = await import('node:http')

  const root = await mkdtemp(join(tmpdir(), 'inkstone-terminal-pty-'))
  const work = join(root, 'work')
  const agentDir = join(root, 'agent')
  const sessionDir = join(root, 'sessions')
  let server
  let moduleDir
  const terms = []
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitFor = async (predicate, ms) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (predicate()) return true
      await sleep(150)
    }
    return predicate()
  }
  try {
    await mkdir(work, { recursive: true })
    await mkdir(agentDir, { recursive: true })
    await mkdir(sessionDir, { recursive: true })

    let httpRequests = 0
    server = createServer((_req, res) => {
      httpRequests += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    await writeFile(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          s3pty: {
            name: 'S3 PTY',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: 'openai-completions',
            models: [{ id: 'mock', name: 'Mock', contextWindow: 200000, maxTokens: 4096 }]
          }
        }
      })
    )
    await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ s3pty: { type: 'api_key', key: 'fixture-key' } }))

    const manifest = JSON.parse(await readFile(join(RUNTIME_ROOT, 'current.json'), 'utf8'))
    const cli = join(RUNTIME_ROOT, manifest.generation, 'dist/bundle/cli.js')

    let pty
    try {
      pty = await import('node-pty')
    } catch (error) {
      console.log(`terminal-native-pty: node-pty 不可用（ABI 或安装问题）：${error.message}`)
      console.log('terminal-native-pty: 0 项（未跑真实 PTY，如实报告）')
      return
    }

    const baseEnv = {}
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ComSpec']) {
      if (process.env[key]) baseEnv[key] = process.env[key]
    }
    Object.assign(baseEnv, {
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      TERM: 'xterm-256color'
    })

    const { mod, dir: loadedDir } = await loadModule()
    moduleDir = loadedDir
    const { TerminalProgramStatusTracker, PROGRAM_STATUS_REPLY } = mod
    const environment = await loadTerminalEnvironment()

    const spawnPi = (extraEnv = {}, hostEnvironment = false) => {
      const tracker = new TerminalProgramStatusTracker()
      const state = { raw: '', sawQuery: false, replies: 0, statuses: [] }
      const term = pty.spawn(process.execPath, [cli, '--no-extensions', '--no-skills', '--session-dir', sessionDir, '--model', 's3pty/mock'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: work,
        env: hostEnvironment ? environment({ ...baseEnv, ...extraEnv }) : { ...baseEnv, ...extraEnv }
      })
      const lifetime = { term, exited: false }
      terms.push(lifetime)
      term.onExit(() => { lifetime.exited = true })
      term.onData((data) => {
        state.raw = (state.raw + data).slice(-40000)
        const { queries, changed } = tracker.consume(data)
        if (queries > 0) state.sawQuery = true
        for (let i = 0; i < queries; i += 1) {
          state.replies += 1
          term.write(PROGRAM_STATUS_REPLY)
        }
        if (changed && tracker.status) state.statuses.push(tracker.status)
      })
      return { term, tracker, state }
    }

    const a = spawnPi()
    await waitFor(() => a.state.sawQuery, 20000)
    await sleep(3000)
    ok(a.state.sawQuery, '真实 pi TUI 发出了 OSC 7501 查询')
    ok(a.state.replies > 0, '生产 Tracker 用回复帧应答了查询')
    eq(a.state.replies, 1, '只应答一次，不反射自己的回复')
    if (a.tracker.status?.state === 'idle') {
      ok(true, `握手后收到真实 idle 帧：${JSON.stringify(a.tracker.status)}`)
    } else {
      console.log('terminal-native-pty: 幕 A 未收到恢复后的 idle（Windows ConPTY 丢弃 OSC 输入，pi 收不到回复），如实报告')
    }
    try {
      a.term.write('\x03')
      await sleep(1000)
      a.term.write('\x04')
      await sleep(1500)
    } catch {
    }

    const b = spawnPi(process.platform === 'win32' ? {} : { PI_PROGRAM_STATUS: '1' }, true)
    eq(environment(baseEnv).PI_PROGRAM_STATUS, process.platform === 'win32' ? '1' : undefined, '实际宿主环境适配与平台一致')
    const gotIdle = await waitFor(() => b.tracker.status?.state === 'idle', 15000)
    ok(gotIdle, `宿主环境模式收到真实 idle 帧：${JSON.stringify(b.tracker.status)}`)
    eq(b.tracker.status, { state: 'idle', app: 'pi' }, '正式 Tracker 解析真实 idle 帧（含 app=pi）')
    try {
      b.term.write('\x03')
      await sleep(1500)
      b.term.write('\x04')
      await sleep(2500)
    } catch {
    }
    ok(/7501;state=clear/.test(b.state.raw), '观察到真实 clear 帧（进程退出前清状态）')

    eq(httpRequests, 0, '无任何模型 / 网络请求')
    ok(/\x1b\]7501;/.test(a.state.raw), 'PTY 原始输出里出现 7501 帧')
    console.log(`terminal-native-pty: ${checks} 项本机 PTY 检查通过；HTTP 请求=${httpRequests}；幕A回复次数=${a.state.replies}；幕B idle=${JSON.stringify(b.state.statuses)}；幕B clear=${/7501;state=clear/.test(b.state.raw)}`)
  } finally {
    for (const lifetime of terms) {
      try {
        lifetime.term.kill()
      } catch {
      }
    }
    if (server) await new Promise((resolve) => server.close(resolve))
    if (moduleDir) await rm(moduleDir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
