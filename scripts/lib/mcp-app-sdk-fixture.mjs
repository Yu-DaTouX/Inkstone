import { App } from '@modelcontextprotocol/ext-apps'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/ext-apps/app-bridge'

export { LATEST_PROTOCOL_VERSION }

export function fakeWindow() {
  const listeners = new Set()
  return {
    listeners,
    addEventListener(_type, listener) { listeners.add(listener) },
    removeEventListener(_type, listener) { listeners.delete(listener) },
    emit(event) { for (const listener of [...listeners]) listener(event) }
  }
}

export async function connectOfficialApp(Channel, options) {
  const win = fakeWindow()
  const posted = []
  const transport = {
    async start() {},
    async send(data) { win.emit({ data, origin: 'null', source: frame }) },
    async close() { transport.onclose?.() }
  }
  const frame = { posted, postMessage(message) { posted.push(message); transport.onmessage?.(message) } }
  const app = new App({ name: 'MCP App regression fixture', version: '1.0.0' }, { availableDisplayModes: ['inline', 'fullscreen', 'pip'] }, { autoResize: false })
  const channel = new Channel({ ...options, window: win, getFrame: () => frame })
  channel.attach()
  await app.connect(transport)
  await new Promise((resolve) => setTimeout(resolve, 10))
  return { app, channel, win, frame, transport }
}

export async function waitFor(predicate, timeout = 2000) {
  const end = Date.now() + timeout
  while (!await predicate()) {
    if (Date.now() > end) throw new Error('MCP App fixture timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
