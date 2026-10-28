import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from '../node_modules/esbuild/lib/main.js'

let failed = 0
const ok = (cond, label) => {
  if (cond) console.log(`  ✓ ${label}`)
  else {
    failed++
    console.log(`  ✗ ${label}`)
  }
}
const eq = (actual, expected, label) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  ok(pass, pass ? label : `${label}（实得 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`)
}

await build({
  entryPoints: ['src/main/native-session-io.ts'],
  outfile: 'out/test/native-session-io.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const io = await import('../out/test/native-session-io.mjs')

const work = await mkdtemp(join(tmpdir(), 'native-session-io-'))
const agentDir = join(work, 'pi-agent')
await mkdir(agentDir, { recursive: true })

const header = {
  type: 'session',
  version: 3,
  id: 'sess-1',
  timestamp: '2024-12-03T14:00:00.000Z',
  cwd: 'C:/work/app'
}
const userA = { type: 'message', id: 'a', parentId: null, timestamp: 't1', message: { role: 'user', content: 'hi' } }
const assistantB = { type: 'message', id: 'b', parentId: 'a', timestamp: 't2', message: { role: 'assistant', content: [] } }
const userC = { type: 'message', id: 'c', parentId: 'b', timestamp: 't3', message: { role: 'user', content: 'branch-c' } }
const assistantD = { type: 'message', id: 'd', parentId: 'b', timestamp: 't4', message: { role: 'assistant', content: [] } }
const sessionText = [header, userA, assistantB, userC, assistantD].map((e) => JSON.stringify(e)).join('\n') + '\n'
const sessionPath = join(work, 'session-source.jsonl')
writeFileSync(sessionPath, sessionText, 'utf8')

const calls = []
let queue = []
const runner = async (command, args, options) => {
  calls.push({ command, args, options })
  const handler = queue.shift()
  if (!handler) return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false }
  return handler(command, args, options)
}
const pushResult = (result) => queue.push(() => result)

io.configureNativeSessionIo({
  agentDir: () => agentDir,
  runCommand: runner,
  now: () => new Date('2025-01-01T00:00:00.000Z'),
  newId: () => 'deadbeef'
})

console.log('\n--- JSONL 逐行校验（parseSessionJsonl / inspectSessionJsonl）---')
{
  const good = io.parseSessionJsonl(sessionText)
  ok(good.ok && good.value.header.id === 'sess-1' && good.value.entries.length === 4, '合法文件解析出头与 4 条条目')
  ok(good.value.leafId === 'd', '叶子是最后一个有 id 的条目')
  ok(!io.parseSessionJsonl('').ok, '空文件被拒（empty）')
  eq((await io.parseSessionJsonl('')).code, 'empty', '空文件错误码')
  const noHeader = io.parseSessionJsonl(JSON.stringify(userA) + '\n')
  eq(noHeader.code, 'invalid_header', '首行不是会话头 → invalid_header')
  const badJson = io.parseSessionJsonl(JSON.stringify(header) + '\n{not json}\n')
  eq(badJson.code, 'invalid_json', '坏 JSON 行 → invalid_json')
  const badType = io.parseSessionJsonl(JSON.stringify(header) + '\n{"id":"x"}\n')
  eq(badType.code, 'invalid_line', '缺少 type 字段 → invalid_line')
  const headerNoId = io.parseSessionJsonl(JSON.stringify({ type: 'session' }) + '\n')
  eq(headerNoId.code, 'invalid_header', '会话头缺 id → invalid_header')
  eq((await io.inspectSessionJsonl(join(work, 'missing.jsonl'))).code, 'not_found', '文件不存在 → not_found')

  const tooBig = join(work, 'too-big.jsonl')
  writeFileSync(tooBig, sessionText, 'utf8')
  eq((await io.inspectSessionJsonl(tooBig, 10)).code, 'too_large', '超过大小上限 → too_large')
  const info = await io.inspectSessionJsonl(sessionPath)
  ok(info.ok && info.entryCount === 4 && info.version === 3, 'inspect 返回条目数与版本')
}

console.log('\n--- 活动分支（buildActiveBranch / serializeSessionBranch）---')
{
  const parsed = io.parseSessionJsonl(sessionText).value
  const branch = io.buildActiveBranch(parsed.entries, parsed.leafId)
  eq(branch.map((e) => e.id), ['a', 'b', 'd'], '叶子 d 的活动分支排除被放弃的 c')
  const serialized = io.serializeSessionBranch({
    sessionId: parsed.header.id,
    cwd: parsed.header.cwd,
    entries: parsed.entries,
    leafId: parsed.leafId
  })
  const lines = serialized.trimEnd().split('\n').map((l) => JSON.parse(l))
  eq(lines[0].version, 3, '导出头版本为 3')
  eq(lines[0].id, 'sess-1', '导出头保留会话 id')
  eq(lines.slice(1).map((e) => e.id), ['a', 'b', 'd'], '导出只含活动分支')
  eq(lines.slice(1).map((e) => e.parentId), [null, 'a', 'b'], 'parentId 重串成线性链')

  const shared = io.serializeSessionBranch({
    sessionId: parsed.header.id,
    cwd: parsed.header.cwd,
    entries: parsed.entries,
    leafId: parsed.leafId,
    forShare: true,
    systemPrompt: 'SYS',
    tools: [{ name: 'read', description: 'r', parameters: {} }]
  })
  const shareLines = shared.trimEnd().split('\n').map((l) => JSON.parse(l))
  const trailing = shareLines[shareLines.length - 1]
  ok(trailing.type === 'custom' && trailing.customType === 'pi.share', 'forShare 追加 pi.share 尾条目')
  eq(trailing.parentId, 'd', '尾条目接到当前叶子')
  eq(trailing.id, 'deadbeef', '尾条目用注入的 id 生成器')
  eq(trailing.data.systemPrompt, 'SYS', '尾条目带 systemPrompt')
}

console.log('\n--- JSONL 导出（exportSessionJsonl）---')
{
  const outBranch = join(work, 'out-branch.jsonl')
  const r1 = await io.exportSessionJsonl({ sourcePath: sessionPath, outputPath: outBranch })
  ok(r1.ok && r1.scope === 'branch' && r1.entryCount === 3, '默认导出活动分支（3 条）')
  const outLines = readFileSync(outBranch, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l))
  eq(outLines[0].version, 3, '导出文件是 v3 头')
  eq(readFileSync(sessionPath, 'utf8'), sessionText, '导出不修改源文件')

  const outFull = join(work, 'out-full.jsonl')
  const r2 = await io.exportSessionJsonl({ sourcePath: sessionPath, outputPath: outFull, scope: 'full' })
  ok(r2.ok && r2.scope === 'full', 'full 模式可用')
  eq(readFileSync(outFull, 'utf8'), sessionText, 'full 模式原样复制（含放弃分支）')

  eq((await io.exportSessionJsonl({ sourcePath: sessionPath, outputPath: outBranch })).code, 'exists', '默认拒绝覆盖已有导出')
  ok((await io.exportSessionJsonl({ sourcePath: sessionPath, outputPath: outBranch, overwrite: true })).ok, '显式 overwrite 才覆盖')
  eq((await io.exportSessionJsonl({ sourcePath: sessionPath, outputPath: sessionPath })).code, 'invalid_path', '导出目标不能是源文件')
}

console.log('\n--- JSONL 导入（importSessionJsonl，不覆盖 + 保留原件）---')
{
  const sessionsDir = join(work, 'sessions-flat')
  const incoming = join(work, 'incoming.jsonl')
  writeFileSync(incoming, sessionText, 'utf8')
  const first = await io.importSessionJsonl({ sourcePath: incoming, sessionDir: sessionsDir })
  ok(first.ok && first.destinationPath === join(sessionsDir, 'incoming.jsonl'), '首次导入复制到会话目录')
  ok(existsSync(incoming), '导入保留源文件（只复制）')
  eq(readFileSync(first.destinationPath, 'utf8'), sessionText, '复制内容与源一致')

  const second = await io.importSessionJsonl({ sourcePath: incoming, sessionDir: sessionsDir })
  ok(second.ok && second.destinationPath.endsWith('incoming-1.jsonl'), '同名冲突追加 -1，绝不覆盖')
  const third = await io.importSessionJsonl({ sourcePath: incoming, sessionDir: sessionsDir })
  ok(third.ok && third.destinationPath.endsWith('incoming-2.jsonl'), '再次冲突追加 -2')

  const inPlace = await io.importSessionJsonl({ sourcePath: join(sessionsDir, 'incoming.jsonl'), sessionDir: sessionsDir })
  ok(inPlace.ok && inPlace.alreadyStored && inPlace.destinationPath === join(sessionsDir, 'incoming.jsonl'), '源已在目标位置时不复制')

  const invalid = join(work, 'invalid.jsonl')
  writeFileSync(invalid, '{}\n', 'utf8')
  eq((await io.importSessionJsonl({ sourcePath: invalid, sessionDir: sessionsDir })).code, 'invalid_line', '非法文件拒绝导入（首行无 type）')
}

console.log('\n--- 会话目录编码（与 pi getDefaultSessionDirPath 一致）---')
{
  const saved = process.env.YAN_SESSIONS_DIR
  delete process.env.YAN_SESSIONS_DIR
  const cwd = process.platform === 'win32' ? 'C:\\work\\app' : '/home/u/app'
  const expected = process.platform === 'win32' ? '--C--work-app--' : '--home-u-app--'
  eq(io.encodeSessionDirName(cwd), expected, 'cwd 编码规则一致')
  const dir = io.defaultSessionDirFor(cwd, '/base/agent')
  ok(dir.endsWith(join('sessions', expected)), '默认会话目录落在 <agent>/sessions/<encoded>')
  process.env.YAN_SESSIONS_DIR = join(work, 'override-sessions')
  eq(io.defaultSessionDirFor(cwd, '/base/agent'), join(work, 'override-sessions'), 'YAN_SESSIONS_DIR 覆盖时平铺')
  if (saved === undefined) delete process.env.YAN_SESSIONS_DIR
  else process.env.YAN_SESSIONS_DIR = saved
}

console.log('\n--- Desktop live-leaf and import-identity regressions ---')
{
  const outputPath = join(work, 'live-leaf.jsonl')
  const exported = await io.exportSessionJsonl({ sourcePath: sessionPath, outputPath, leafId: 'b' })
  ok(exported.ok, 'live leaf overrides file tail')
  const lines = readFileSync(outputPath,'utf8').trim().split('\n').map(JSON.parse)
  eq(lines.slice(1).map(entry=>entry.id), ['a','b'], 'selected branch excludes later appended branch')
  const empty = await io.exportSessionJsonl({ sourcePath: sessionPath, outputPath: join(work,'empty-branch.jsonl'), leafId:null })
  ok(empty.ok && empty.entryCount === 0, 'null live leaf exports header only')
  const imported = await io.importSessionJsonl({sourcePath:sessionPath,sessionDir:join(work,'fresh-import'),freshSessionId:true})
  ok(imported.ok && imported.sessionId !== header.id, 'fresh import has unique desktop id')
  eq(JSON.parse(readFileSync(imported.destinationPath,'utf8').split('\n')[0]).id, imported.sessionId, 'fresh header id matches index id')
  eq(readFileSync(sessionPath,'utf8'),sessionText,'import never modifies original file')
}

console.log('\n--- gh / 分享探测与执行 ---')
{
  queue = []
  calls.length = 0

  pushResult({ code: null, stdout: '', stderr: '', timedOut: false, aborted: false, error: 'spawn gh ENOENT', errorCode: 'ENOENT' })
  const missing = await io.checkGhStatus()
  ok(missing.installed === false && missing.authenticated === false, 'gh 未安装 → installed:false')

  pushResult({ code: 1, stdout: '', stderr: 'not logged in', timedOut: false, aborted: false })
  const notLogged = await io.checkGhStatus()
  ok(notLogged.installed === true && notLogged.authenticated === false, 'gh 未登录 → authenticated:false')

  pushResult({ code: 0, stdout: 'ok', stderr: '', timedOut: false, aborted: false })
  const logged = await io.checkGhStatus()
  ok(logged.installed === true && logged.authenticated === true, 'gh 已登录 → authenticated:true')
  eq(calls[0].args, ['auth', 'status'], 'gh 探测用参数数组，不过 shell')

  process.env.PI_SHARE_VIEWER_URL = 'https://example.test/s/'
  const htmlPath = join(work, 'share.html')
  writeFileSync(htmlPath, '<html></html>', 'utf8')
  queue = []
  pushResult({ code: 0, stdout: 'ok', stderr: '', timedOut: false, aborted: false })
  pushResult({ code: 0, stdout: 'https://gist.github.com/u/abc123\n', stderr: '', timedOut: false, aborted: false })
  const shared = await io.shareViaGist({ htmlPath })
  ok(shared.ok && shared.gistId === 'abc123', '解析 gh 输出的 gist ID')
  eq(shared.viewerUrl, 'https://example.test/s/#abc123', '查看链接用 PI_SHARE_VIEWER_URL 覆盖')
  eq(calls[calls.length - 1].args, ['gist', 'create', '--public=false', htmlPath], 'gist 命令参数数组正确')
  delete process.env.PI_SHARE_VIEWER_URL
  eq(io.shareViewerUrl('zzz'), 'https://pi.dev/session/#zzz', '默认查看链接基址与 pi 一致')

  queue = []
  pushResult({ code: 0, stdout: 'ok', stderr: '', timedOut: false, aborted: false })
  const beforeCancelledUpload = calls.length
  const cancelledUpload = await io.shareViaGist({ htmlPath, beforeUpload: () => false })
  ok(!cancelledUpload.ok && cancelledUpload.code === 'aborted', 'ownership change cancels upload after auth')
  ok(calls.length === beforeCancelledUpload + 1, 'ownership change never invokes gist upload')

  queue = []
  pushResult({ code: null, stdout: '', stderr: '', timedOut: false, aborted: false, error: 'spawn gh ENOENT', errorCode: 'ENOENT' })
  const before = calls.length
  const blocked = await io.shareViaGist({ htmlPath })
  ok(!blocked.ok && blocked.code === 'unavailable', 'gh 缺失时分享返回 unavailable')
  ok(calls.length === before + 1, 'gh 缺失时不再尝试 gist 命令')

  queue = []
  pushResult({ code: 0, stdout: 'ok', stderr: '', timedOut: false, aborted: false })
  pushResult({ code: null, stdout: '', stderr: '', timedOut: true, aborted: false })
  eq((await io.shareViaGist({ htmlPath })).code, 'timeout', 'gist 超时 → timeout')
  queue = []
  pushResult({ code: 0, stdout: 'ok', stderr: '', timedOut: false, aborted: false })
  pushResult({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true })
  eq((await io.shareViaGist({ htmlPath })).code, 'aborted', 'gist 取消 → aborted')
}

await rm(work, { recursive: true, force: true })
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
