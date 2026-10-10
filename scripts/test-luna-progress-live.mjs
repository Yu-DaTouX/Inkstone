/** Bounded real Codex Luna experiment using only synthetic files and copied OAuth. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'

if (!process.argv.includes('--real-luna')) throw Error('Requires explicit --real-luna')
const tag = process.argv.includes('--after') ? 'after' : 'current'
const root = await mkdtemp(join(tmpdir(), 'inkstone-luna-progress-'))
const pi = join(root, 'pi'), cwd = join(root, 'files')
await mkdir(pi); await mkdir(cwd)
const source = JSON.parse(await readFile(join(homedir(), '.pi/agent/auth.json'), 'utf8'))
assert.equal(source['openai-codex']?.type, 'oauth', 'Codex OAuth must already exist')
await writeFile(join(pi, 'auth.json'), JSON.stringify({ 'openai-codex': source['openai-codex'] }))
await writeFile(join(pi, 'settings.json'), JSON.stringify({ packages: [], compaction: { enabled: false } }))
await writeFile(join(cwd, 'input-a.txt'), 'apple=3\npear=5\norange=2\n')
await writeFile(join(cwd, 'input-b.txt'), 'apple=4\npear=5\nbanana=1\n')
const env = { ...process.env, PI_CODING_AGENT_DIR: pi, YAN_PI_DIR: pi }
for (const key of Object.keys(env)) if (/API_KEY$|AUTH_TOKEN$|ACCESS_TOKEN$|^ANTHROPIC_|^CLAUDECODE$|^ELECTRON_RUN_AS_NODE$/.test(key)) delete env[key]
const cli = join(selectedPiRuntime(resolve('resources/pi-runtime')), 'dist/bundle/cli.js')
const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--no-extensions', '--extension', resolve('resources/pi-extensions/preamble.js'),
  '--no-skills', '--tools', 'read,write', '--provider', 'openai-codex', '--model', 'gpt-6-luna', '--thinking', 'low', '--session-dir', join(root, 'sessions')],
  { cwd, env, windowsHide: true, stdio: 'pipe' })
const exited = new Promise(done => child.once('exit', done))
let buffer = '', sequence = 0, start = 0, stderr = ''
const pending = new Map(), events = []
child.stdout.on('data', part => {
  buffer += part
  let end
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
    if (!line.trim()) continue
    const event = JSON.parse(line)
    if (event.type === 'response') { pending.get(event.id)?.(event); pending.delete(event.id) }
    else events.push({ atMs: start ? Date.now() - start : 0, event })
  }
})
child.stderr.on('data', part => { stderr += part })
function command(type, params = {}) {
  return new Promise((done, reject) => {
    const id = String(++sequence)
    const timer = setTimeout(() => { pending.delete(id); reject(Error('RPC timeout: ' + type)) }, 15000)
    pending.set(id, event => { clearTimeout(timer); done(event) })
    child.stdin.write(JSON.stringify({ id, type, ...params }) + '\n')
  })
}
try {
  const models = await command('get_available_models')
  assert(models.success, 'Cannot read available models')
  const available = models.data.models ?? models.data
  assert(available.some(m => m.provider === 'openai-codex' && m.id === 'gpt-6-luna'), 'Exact Codex Luna unavailable; no fallback')
  const selected = await command('set_model', { provider: 'openai-codex', modelId: 'gpt-6-luna' })
  assert(selected.success, 'Exact Luna selection failed')
  start = Date.now()
  assert((await command('prompt', { message: '检查 input-a.txt 和 input-b.txt，把比较结果写到 result.md。先实际读取两个文件，完成后用中文说明差异。使用 read/write 工具，不使用 shell，不联网。' })).success)
  const deadline = Date.now() + 90000
  while (!events.some(row => row.event.type === 'agent_end' || row.event.type === 'agent_settled')) {
    if (Date.now() > deadline) throw Error('Luna task exceeded 90 seconds')
    await new Promise(done => setTimeout(done, 100))
  }
  const text = events.filter(row => row.event.assistantMessageEvent?.type === 'text_delta')
  const tools = events.filter(row => row.event.type === 'tool_execution_start')
  assert(tools.length >= 2 && text.length > 0, 'Expected actual tools and streamed text')
  assert((await readFile(join(cwd, 'result.md'), 'utf8')).length > 0, 'Missing real task result')
  const summary = { tag, provider: 'openai-codex', model: 'gpt-6-luna', thinking: 'low', elapsedMs: Date.now() - start,
    firstTextMs: text[0].atMs, firstToolMs: tools[0].atMs, toolCount: tools.length, textDeltaCount: text.length,
    textBeforeFirstTool: text.filter(row => row.atMs < tools[0].atMs).map(row => row.event.assistantMessageEvent.delta).join(''),
    timeline: events.filter(row => ['message_end', 'tool_execution_start', 'tool_execution_end'].includes(row.event.type)).map(row => ({ atMs: row.atMs, type: row.event.type, tool: row.event.toolName,
      text: Array.isArray(row.event.message?.content) ? row.event.message.content.filter(p => p.type === 'text').map(p => p.text).join('') : undefined })) }
  await writeFile(resolve(`.local-docs/evidence/luna-progress-${tag}-${Date.now()}.json`), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
} finally {
  child.stdin.end(); child.kill()
  await exited
  // Only the isolated OAuth copy is removed; retain synthetic event evidence.
  await writeFile(join(pi, 'auth.json'), '{}')
  await writeFile(join(root, 'events.json'), JSON.stringify(events))
  await writeFile(join(root, 'stderr.log'), stderr)
}
