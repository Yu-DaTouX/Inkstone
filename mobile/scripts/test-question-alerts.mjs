import http from 'node:http'
import { spawnSync } from 'node:child_process'
const adb = process.env.INKSTONE_ADB || 'adb'
const device = process.env.INKSTONE_DEVICE
const args = device ? ['-s', device] : []
let phase = 0
const streams = new Set()
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture')
  if (url.pathname === '/probe/phase') {
    phase = Number(url.searchParams.get('value'))
    for (const stream of streams) stream.write(`event: ${phase >= 3 ? 'runners' : phase ? 'ui-request' : 'ui-resolved'}\ndata: {}\n\n`)
    res.end('ok'); return
  }
  if (req.headers.authorization !== 'Bearer isolated-probe-token') { res.writeHead(401); res.end(); return }
  if (url.pathname.endsWith('/questions')) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, data: { questions: Array.from({ length: phase < 3 ? phase : 0 }, (_, i) => ({ id: `fixture-${i}`, sessionId: 'fixture-task', title: 'PRIVATE_FIXTURE', message: 'PRIVATE_FIXTURE' })) } }))
  } else if (url.pathname.endsWith('/status')) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, data: { agent: { runners: phase === 3 ? [{ sessionId: 'fixture-task', running: true, waiting: false }] : [] }, sessions: [{ id: 'fixture-task', title: 'PRIVATE_TASK' }] } }))
  } else if (url.pathname.endsWith('/events')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: ready\ndata: {}\n\nevent: resync\ndata: {}\n\n')
    streams.add(res); req.on('close', () => streams.delete(res))
  } else { res.writeHead(404); res.end() }
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(38444, '127.0.0.1', resolve) })
const reverse = spawnSync(adb, [...args, 'reverse', 'tcp:38444', 'tcp:38444'], { encoding: 'utf8' })
if (reverse.status !== 0) { server.close(); throw new Error(reverse.stderr) }
const { spawn } = await import('node:child_process')
try {
  const child = spawn(adb, [...args, 'shell', 'am', 'instrument', '-w', '-e', 'fixtureUrl', 'http://127.0.0.1:38444', 'com.yudatoux.inkstone.test/com.yudatoux.inkstone.QuestionAlertProbe'])
  let output = ''
  child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk) })
  child.stderr.pipe(process.stderr)
  await new Promise(resolve => child.on('exit', resolve))
  if (!output.includes('PASS:')) process.exitCode = 1
} finally {
  spawnSync(adb, [...args, 'reverse', '--remove', 'tcp:38444'])
  for (const stream of streams) stream.end()
  server.close()
}
