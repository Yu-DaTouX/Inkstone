import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_FRAME_BYTES = 64 * 1024 * 1024
const here = dirname(fileURLToPath(import.meta.url))

let discovery
try {
  discovery = JSON.parse(readFileSync(join(here, 'discovery.json'), 'utf8'))
} catch {
  process.exit(1)
}
if (!Number.isInteger(discovery?.port) || typeof discovery?.token !== 'string') process.exit(1)

const caller = process.argv.slice(2).find((arg) => /^chrome-extension:\/\//.test(arg)) ?? process.argv[3] ?? ''

function writeFrame(text) {
  const body = Buffer.from(text, 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  process.stdout.write(Buffer.concat([head, body]))
}

const pending = []
const socket = new WebSocket(`ws://127.0.0.1:${discovery.port}/browser-bridge?token=${encodeURIComponent(discovery.token)}&caller=${encodeURIComponent(caller)}`)
socket.onopen = () => {
  writeFrame(JSON.stringify({ event: 'ready' }))
  for (const text of pending.splice(0)) socket.send(text)
}
socket.onmessage = (event) => writeFrame(String(event.data))
socket.onclose = () => process.exit(0)
socket.onerror = () => process.exit(1)

let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0)
    if (length > MAX_FRAME_BYTES) process.exit(1)
    if (buffer.length < 4 + length) break
    const text = buffer.subarray(4, 4 + length).toString('utf8')
    buffer = buffer.subarray(4 + length)
    if (socket.readyState === 1) socket.send(text)
    else pending.push(text)
  }
})
process.stdin.on('end', () => process.exit(0))
