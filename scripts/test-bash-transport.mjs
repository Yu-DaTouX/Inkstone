import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'
import { bashQuotedPath, fileTransportOperations } from '../resources/pi-extensions/shell-transport.js'
import { registerBashFileTransport } from '../resources/pi-extensions/shell-fallback.js'
import { planPythonPath } from '../resources/pi-extensions/windows-python.js'

assert.equal(bashQuotedPath('C:\\Users\\a b\\x.sh'), `'C:/Users/a b/x.sh'`)
assert.equal(bashQuotedPath("C:\\Users\\o'neil\\x.sh"), `'C:/Users/o'\\''neil/x.sh'`)

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
