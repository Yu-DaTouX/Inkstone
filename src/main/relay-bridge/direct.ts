import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Pipe } from './tunnel'

const MAX_FRAME_BYTES = 16 * 1024 * 1024
const MAX_SOCKETS = 32
const PING_MS = 25_000

export class DirectTunnelEndpoint {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false })
  private readonly alive = new WeakMap<WebSocket, boolean>()
  private readonly timer: ReturnType<typeof setInterval>

  constructor(private readonly onPipe: (pipe: Pipe) => void) {
    this.timer = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (this.alive.get(ws) === false) {
          ws.terminate()
          continue
        }
        this.alive.set(ws, false)
        ws.ping()
      }
    }, PING_MS)
    this.timer.unref?.()
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.wss.clients.size >= MAX_SOCKETS) {
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws))
  }

  private accept(ws: WebSocket): void {
    this.alive.set(ws, true)
    const pipe: Pipe = {
      send: (text) => {
        if (ws.readyState === ws.OPEN) ws.send(text)
      },
      close: (code, reason) => ws.close(code ?? 1000, reason)
    }
    ws.on('pong', () => this.alive.set(ws, true))
    ws.on('message', (data, binary) => {
      this.alive.set(ws, true)
      if (binary) {
        ws.close(1003, 'text only')
        return
      }
      pipe.onmessage?.(Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data).toString('utf8'))
    })
    ws.on('close', () => pipe.onclose?.())
    ws.on('error', () => ws.terminate())
    this.onPipe(pipe)
  }

  stop(): void {
    for (const ws of this.wss.clients) ws.terminate()
  }

  dispose(): void {
    clearInterval(this.timer)
    this.stop()
    this.wss.close()
  }
}
