import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'
import { bashQuotedPath, fileTransportOperations } from '../resources/pi-extensions/shell-transport.js'
import { registerBashFileTransport, createUtf8ConsolePreamble, needsUtf8Console, needsPipefail, withPipefail } from '../resources/pi-extensions/shell-fallback.js'
import { planPythonPath } from '../resources/pi-extensions/windows-python.js'

assert.equal(bashQuotedPath('C:\\Users\\a b\\x.sh'), `'C:/Users/a b/x.sh'`)
assert.equal(bashQuotedPath("C:\\Users\\o'neil\\x.sh"), `'C:/Users/o'\\''neil/x.sh'`)

const skippable = [
  'git status',
  'cd src && rg -n "a|b" . | head -20',
  'ls -la 2>&1 | wc -l',
  'FOO=1 git log -1',
  'timeout 30 git fetch',
  '# 注释\ngit diff',
  'xargs -n 1 rm < list.txt',
  'yan subagent list',
  'node x.mjs',
  'python -c "print(1)"',
  'node --test 2>&1 | tail -20'
]
for (const command of skippable) assert.equal(needsUtf8Console(command), false, `应可跳过 chcp: ${command}`)

const needsChcp = [
  'npm test',
  'powershell -NoProfile -c "Get-Date"',
  'git log $(cat ref)',
  'echo `date`',
  '(cd x; ls)',
  'cat <<EOF\nhi\nEOF',
  'source env.sh',
  './run.sh',
  'find . -name "*.ps1" -exec powershell -File {} \\;',
  'echo "unterminated'
]
for (const command of needsChcp) assert.equal(needsUtf8Console(command), true, `应需要 chcp: ${command}`)

const pipefailCommands = [
  'npm test 2>&1 | tail -20',
  'node --test test/*.mjs |& tail -n 30',
  'cd lib && node probe.mjs 2>&1 | tee out.log | tail -5',
  'FOO=1 timeout 60 npm run check | tail'
]
for (const command of pipefailCommands) assert.equal(needsPipefail(command), true, `管道只接读完输入的命令时保留上游退出码: ${command}`)

const plainCommands = [
  'npm test',
  'git log | head -5',
  'node x.mjs | grep ok',
  'grep -rn foo src | tail -5',
  'rg foo | tail',
  'git grep foo | tail',
  'diff a b | tail',
  'ls | wc -l',
  'npm test | tail -5; git log | head -1',
  'for f in *.js; do node $f; done | tail',
  'node $(cat entry) | tail',
  'false || true'
]
for (const command of plainCommands) assert.equal(needsPipefail(command), false, `不开 pipefail: ${command}`)

{
  const preamble = withPipefail(createUtf8ConsolePreamble({ queryUtf8CodePage: () => Promise.resolve(false) }))
  assert.equal(await preamble('node --test | tail -5'), 'set -o pipefail', 'pipefail 与 chcp 分别判断')
  assert.equal(await preamble('npm test | tail -5'), 'set -o pipefail; chcp.com 65001 >/dev/null 2>&1')
  assert.equal(await preamble('git status'), '')
}

{
  const preamble = createUtf8ConsolePreamble({ queryUtf8CodePage: () => Promise.resolve(false) })
  assert.equal(await preamble('git status'), '', '代码页非 65001 时，可跳过命令不带前置')
  assert.match(await preamble('npm test'), /chcp\.com 65001/, '代码页非 65001 时，需要的命令带前置')
}

{
  const preamble = createUtf8ConsolePreamble({ queryUtf8CodePage: () => Promise.resolve(true) })
  assert.equal(await preamble('npm test'), '', '代码页已是 65001 时，即便命令需要也不带前置')
}

{
  const previous = process.env.YAN_BASH_UTF8_CONSOLE
  process.env.YAN_BASH_UTF8_CONSOLE = 'always'
  try {
    const preamble = createUtf8ConsolePreamble({ queryUtf8CodePage: () => Promise.resolve(true) })
    assert.match(await preamble('git status'), /chcp\.com 65001/, 'YAN_BASH_UTF8_CONSOLE=always 时总是带前置')
  } finally {
    if (previous === undefined) delete process.env.YAN_BASH_UTF8_CONSOLE
    else process.env.YAN_BASH_UTF8_CONSOLE = previous
  }
}

{
  let seen
  const ops = fileTransportOperations({
    async exec(command) {
      seen = command
      return 'ok'
    }
  }, { preamble: (command) => (command.includes('skip') ? '' : 'PRE') })
  await ops.exec('skip me', tmpdir())
  assert.ok(!seen.startsWith('PRE'), 'preamble 为函数时，可跳过的命令不带前置')
  await ops.exec('need it', tmpdir())
  assert.ok(seen.startsWith('PRE; .'), 'preamble 为函数时，需要的命令带前置')
}

{
  let seen
  const ops = fileTransportOperations({
    async exec(command) {
      seen = command
      return 'ok'
    }
  }, { preamble: 'PRE' })
  await ops.exec('anything', tmpdir())
  assert.ok(seen.startsWith('PRE; .'), 'preamble 为字符串时行为不变')
}

const deadPid = await new Promise((resolvePid, rejectPid) => {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' })
  const pid = child.pid
  child.on('error', rejectPid)
  child.on('exit', () => resolvePid(pid))
})
const sweepDir = await mkdtemp(join(tmpdir(), 'yan-bash-transport-sweep-'))
try {
  const stale = join(sweepDir, `yan-bash-${deadPid}-deadbeefdeadbeef.sh`)
  await writeFile(stale, 'echo leaked')
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await utimes(stale, old, old)
  const freshName = `yan-bash-${deadPid}-0011223344556677.sh`
  const fresh = join(sweepDir, freshName)
  await writeFile(fresh, 'echo fresh')
  const unrelated = join(sweepDir, 'notes.txt')
  await writeFile(unrelated, 'x')
  let used = ''
  const ops = fileTransportOperations({
    async exec() {
      used = (await readdir(sweepDir)).find((name) => name.startsWith('yan-bash-') && name.includes(String(process.pid)))
      return 'ok'
    }
  }, { dir: sweepDir })
  assert.equal(await ops.exec('echo ok', tmpdir()), 'ok')
  assert.ok(used && new RegExp(`^yan-bash-${process.pid}-[0-9a-f]+\\.sh$`).test(used), '临时命令文件名里带 pid（清理时判断归属）')
  assert.deepEqual((await readdir(sweepDir)).sort(), ['notes.txt', freshName].sort(), '启动时只删超过一小时且进程已退出的命令文件')
} finally {
  await rm(sweepDir, { recursive: true, force: true })
}

if (process.platform !== 'win32') {
  console.log('bash-transport: ok (non-Windows, pure checks only)')
  process.exit(0)
}

const core = await import(pathToFileURL(join(selectedPiRuntime(resolve('resources/pi-runtime')), 'dist', 'bundle', 'index.js')).href)
const cwd = await mkdtemp(join(tmpdir(), 'yan-bash-transport-'))
const scratch = await mkdtemp(join(tmpdir(), 'yan-bash-transport-files-'))

const ctx = { cwd, sessionManager: { getSessionId: () => 'test', getSessionFile: () => undefined } }
let registered
registerBashFileTransport({ registerTool: (tool) => { registered = tool } }, core)
assert.equal(registered?.name, 'bash', '覆盖的是 pi 的 bash 工具')
const nativeParameters = JSON.parse(JSON.stringify(core.createBashToolDefinition(cwd).parameters))
assert.deepEqual({ ...registered.parameters, properties: { ...registered.parameters.properties, description: undefined } }, { ...nativeParameters, properties: { ...nativeParameters.properties, description: undefined } }, '除说明参数外与 pi 原生一致')
assert.equal(registered.parameters.properties.description?.type, 'string', '多一个可选的说明参数')
assert.ok(!registered.parameters.required?.includes('description'), '说明参数可省略')
assert.equal((await registered.execute('t', { command: 'echo described', description: '打个招呼' }, undefined, undefined, ctx)).content.map((c) => c.text ?? '').join('').trim(), 'described', '带说明参数照常执行')

async function run(command) {
  const result = await registered.execute('t', { command }, undefined, undefined, ctx)
  return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim()
}

const cases = [
  ['成对反斜杠', "printf '%s\\n' 'left\\\\right'", 'left\\\\right'],
  ['末尾成对反斜杠', "printf '%s\\n' 'end\\\\'", 'end\\\\'],
  ['四个反斜杠', "printf '%s\\n' 'a\\\\\\\\b'", 'a\\\\\\\\b'],
  ['heredoc 正则', "cat <<'X'\nre\\\\d+ \\\\n\nX", 're\\\\d+ \\\\n'],
  ['Windows 路径', "printf '%s\\n' 'C:\\Users\\a b\\x'", 'C:\\Users\\a b\\x'],
  ['双引号', "printf '%s\\n' \"say \\\"hi\\\"\"", 'say "hi"'],
  ['中文与 emoji', "printf '%s\\n' '中文 😀'", '中文 😀'],
  ['超过 8186 字符', "printf '%s' '" + 'x'.repeat(20000) + "' | wc -c", '20000'],
  ['读 stdin 不吃脚本', 'cat\necho after', 'after'],
  ['工作目录', 'pwd -W', cwd.replace(/\\/g, '/')]
]
for (const [name, command, want] of cases) {
  assert.equal(await run(command), want, name)
}

if (planPythonPath(process.env.PATH ?? process.env.Path ?? '')) {
  assert.match(await run('python --version'), /^Python 3\./, 'python')
  assert.match(await run('python3 --version'), /^Python 3\./, 'python3')
  console.log('bash-transport: python redirect checked on this machine')
}

assert.equal(await run(`powershell -NoProfile -Command 'Write-Output "中文输出"'`), '中文输出', 'PowerShell 5.1')
assert.equal(await run('cmd //c "echo 中文"'), '中文', 'cmd')
if (planPythonPath(process.env.PATH ?? process.env.Path ?? '') || /Python/.test(await run('python --version'))) {
  assert.equal(await run(`python -c "print('中文')"`), '中文', 'python')
}

const native = core.createBashToolDefinition(cwd)
const nativeOut = (await native.execute('n', { command: "printf '%s\\n' 'left\\\\right'" }, undefined, undefined, ctx))
  .content.map((c) => c.text).join('').trim()
assert.equal(nativeOut, 'left\\right', '本机 Git Bash 的 -c 交付仍有反斜杠减半（若已修复，可以考虑撤掉本层）')

const failed = async (tool) => {
  try {
    const result = await tool.execute('f', { command: 'echo oops >&2; exit 3' }, undefined, undefined, ctx)
    return JSON.stringify(result, (key, value) => (key === 'wall_time_seconds' ? undefined : value))
  } catch (error) {
    return `throw:${error.message}`
  }
}
const nativeFailure = await failed(native)
assert.match(nativeFailure, /3/)
assert.equal(await failed(registered), nativeFailure)

const piped = await failed({ execute: (id, params, ...rest) => registered.execute(id, { command: 'node -e "console.log(1); process.exit(3)" 2>&1 | tail -5' }, ...rest) })
assert.match(piped, /exited with code 3/, '测试命令接 tail 时失败不再被吞')
assert.equal(await run("printf 'a\\nb\\n' | head -1"), 'a', '接 head 的管道语义不变')
assert.equal(await run('grep nomatch-xyz /dev/null | wc -l'), '0', '接 wc 的管道语义不变')

const odd = await mkdtemp(join(scratch, "it's here "))
const ops = fileTransportOperations(core.createLocalBashOperations(), { dir: odd })
let out = ''
const { exitCode } = await ops.exec("printf '%s' 'p\\\\q'", cwd, { onData: (d) => { out += d.toString() } })
assert.equal(exitCode, 0)
assert.equal(out, 'p\\\\q')
assert.deepEqual(await readdir(odd), [], '临时文件已删除')

await rm(cwd, { recursive: true, force: true })
await rm(scratch, { recursive: true, force: true })
console.log('bash-transport: ok')
