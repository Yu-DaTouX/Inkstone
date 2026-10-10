/** Real RemoteServer HTTP protocol + Python plugin handlers. No Electron/model/user data. */
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const temp = await mkdtemp(join(tmpdir(), 'inkstone-hermes-test-'))
let server
let broker
try {
  const bundle = join(temp, 'remote.mjs')
  await build({ stdin: { contents: `export { RemoteServer } from './src/main/remote-server'; export { RemoteDeviceStore } from './src/main/remote-devices'; export * from './src/main/remote-approval'; export { ApprovalBroker } from './src/main/approval-broker'`, resolveDir: resolve('.') },
    bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' })
  const { RemoteServer, RemoteDeviceStore, ApprovalBroker, remoteApprovalQuestion, applyHumanApproval } = await import(pathToFileURL(bundle).href)
  const devices = new RemoteDeviceStore(temp)
  const owner = await devices.pair(devices.startPairing().code, 'Hermes approval fixture')
  if (!owner.ok) throw Error('Fixture pairing failed')
  const pairing = devices.startPairing()
  const calls = []
  broker = new ApprovalBroker({ canAsk: () => true, open: () => {}, close: () => {} })
  for (const detail of ['fixture dangerous operation A', 'fixture dangerous operation B']) {
    void broker.ask({ kind: 'danger', tool: 'bash', title: 'Confirm fixture', detail, reasons: ['fixture only'], cwd: temp, canRemember: false, sessionId: 's-1', runId: 'r1' })
  }
  server = new RemoteServer({ host: '127.0.0.1', port: 0, devices, token: 'fixture-token-hermes', handlers: {
    snapshot: async () => ({ sessions: [{ id: 's-1', title: 'Fixture' }], runners: [{ runId: 'r1', sessionId: 's-1', busy: false }], calls }),
    history: async (sessionId, limit, before) => ({ ok: true, data: { sessionId, limit, before, messages: [{ id: 'm-1', role: 'assistant', text: 'fixture answer' }], nextBefore: 'cursor-1', hasMore: true } }),
    models: async sessionId => ({ ok: true, data: { sessionId, models: [{ provider: 'fixture', id: 'local' }] } }),
    questions: async () => [{ id: 'ordinary-question', sessionId: 's-1', runId: 'r1', method: 'input', title: 'Which file?', message: '', sensitive: false, deadline: 0 }, ...broker.list().map(remoteApprovalQuestion)],
    answer: async (questionId, answer) => questionId === 'ordinary-question' ? { ok: true, data: { questionId, answer } } : { ok: false, status: 403, code: 'sensitive_confirmation_requires_desktop' },
    humanApproval: async (questionId, answer) => applyHumanApproval(broker.list().map(remoteApprovalQuestion).find(q => q.id === questionId), answer, choice => { calls.push({ action: 'human-approval', questionId, choice }); broker.answer(questionId.slice('approval:'.length), choice ? 'once' : 'deny') }),
    command: async command => { calls.push(command); return { ok: true, data: { ...command, runId: 'r1', sessionId: 's-1' } } }
  } })
  const info = await server.start()
  const config = join(temp, 'connection.json')
  await writeFile(config, JSON.stringify({ url: `http://127.0.0.1:${info.port}`, token: owner.token }))
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', INKSTONE_CONNECTION_FILE: config, INKSTONE_TEST_URL: `http://127.0.0.1:${info.port}`, INKSTONE_TEST_PAIR_CODE: pairing.code, PYTHONIOENCODING: 'utf-8' }
  delete env.INKSTONE_URL; delete env.INKSTONE_TOKEN
  const exit = await new Promise((resolveExit, reject) => {
    const child = spawn(process.env.YAN_TEST_PYTHON || 'python', ['scripts/test-hermes-plugin.py'], { env, stdio: 'inherit', windowsHide: true })
    child.once('error', reject); child.once('exit', resolveExit)
  })
  if (exit !== 0) throw Error(`Python plugin checks failed (${exit})`)
  const paired = (await devices.list()).find(device => device.name === 'Hermes test')
  if (!paired) throw Error('Pairing did not persist a revocable device')
  console.log(`PASS: Python plugin + real RemoteServer; ${calls.length} bounded operations, revocable pairing persisted`)
} finally {
  for (const request of broker?.list() ?? []) broker.answer(request.id, 'deny')
  await server?.stop()
  await rm(temp, { recursive: true, force: true })
}
