import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'review-remotecli-'))
try {
  const bundles = {}
  for (const [name, source] of Object.entries({ devices: 'src/main/remote-devices.ts', consent: 'src/main/consent-store.ts', relay: 'src/main/relay-bridge/store.ts', assistant: 'src/main/assistant-link.ts' })) {
    const outfile = join(root, `${name}.mjs`)
    await build({ entryPoints: [source], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    bundles[name] = await import(pathToFileURL(outfile).href)
  }

  const deviceDir = join(root, 'devices')
  await mkdir(deviceDir)
  await mkdir(join(deviceDir, 'remote-devices.json'))
  const devices = new bundles.devices.RemoteDeviceStore(deviceDir)
  await assert.rejects(devices.list(), /EISDIR|directory/i)
  await rm(join(deviceDir, 'remote-devices.json'), { recursive: true })
  const pairing = devices.startPairing()
  const paired = await devices.pair(pairing.code, 'fixture')
  assert.equal(paired.ok, true, 'device read failure is not cached; subsequent read/write can recover')

  const badLedger = join(root, 'broken-consent.json')
  await writeFile(badLedger, '{broken')
  await assert.rejects(bundles.consent.readConsentLedger(badLedger), SyntaxError)

  const queryPath = join(root, 'query.json')
  await writeFile(queryPath, JSON.stringify({ queryText: 'fixture' }))
  let receivedParams
  const cliServer = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      receivedParams = JSON.parse(Buffer.concat(chunks).toString('utf8')).params
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise(resolveListen => cliServer.listen(0, '127.0.0.1', resolveListen))
  try {
    const child = spawn(process.execPath, [resolve('resources/yan-cli/yan.mjs'), 'capabilities', 'search', '--query-file', queryPath, '--scope', 'available'], {
      env: { ...process.env, YAN_CLI_URL: `http://127.0.0.1:${cliServer.address().port}/rpc`, YAN_CLI_TOKEN: 'fixture', YAN_SESSION_ID: 'session-fixture', YAN_PROJECT_ID: 'project-fixture' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const result = await new Promise((resolveResult, rejectResult) => {
      let stdout = '', stderr = ''
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
      child.on('error', rejectResult)
      child.on('close', code => code === 0 ? resolveResult(stdout) : rejectResult(new Error(`yan exited ${code}: ${stderr}`)))
    })
    assert.equal(JSON.parse(result).ok, true)
    assert.deepEqual(receivedParams, { scope: 'available', queryText: 'fixture' }, 'file params and CLI flags are combined')
  } finally {
    cliServer.closeAllConnections()
    await new Promise(resolveClose => cliServer.close(resolveClose))
  }

  const relayDir = join(root, 'relay')
  await mkdir(relayDir)
  await writeFile(join(relayDir, 'relay-bridge.json'), '{broken')
  const relay = new bundles.relay.RelayBridgeStore(relayDir)
  await assert.rejects(relay.secret(), SyntaxError, 'damaged relay state must not silently regenerate host identity')
  await assert.rejects(relay.secret(), SyntaxError, 'subsequent calls still refuse to overwrite damaged identity')
  assert((await readdir(relayDir)).some(name => name.endsWith('.corrupt')), 'damaged relay state is preserved as backup')

  const events = []
  const server = createServer((req, res) => {
    if (req.url === '/v1/health') return res.end(JSON.stringify({ ok: true, version: 'test', timezone: 'UTC', now: '', now_ms: 0, model: null }))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('id: 9\r\nevent: reminder\r\ndata: {"delivery_id":9}\r\n\r\n')
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const link = new bundles.assistant.AssistantLink({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'fixture', onReminder: event => events.push(event) })
  try {
    link.startEvents()
    const deadline = Date.now() + 2000
    while (!events.length && Date.now() < deadline) await new Promise(resolveTick => setTimeout(resolveTick, 10))
    assert.equal(events[0]?.delivery_id, 9, 'SSE CRLF frame is parsed')
  } finally {
    link.stop()
    await new Promise(resolveClose => server.close(resolveClose))
  }
  console.log('PASS: isolated remotecli regression fixtures (device-store read recovery, corrupt consent refusal, relay backup/refusal, SSE CRLF)')
} finally {
  await rm(root, { recursive: true, force: true })
}
