import { readFile, rm } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { VoiceService } from './engine.mjs'

const inbox = join(process.env.INKSTONE_PLUGIN_DATA ?? '', 'inbox')
let settings
const voice = new VoiceService(async () => settings)

async function transcribe({ path, language }) {
  const rel = typeof path === 'string' ? relative(inbox, path) : ''
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { ok: false, error: '录音文件位置无效' }
  try {
    return await voice.transcribe(new Uint8Array(await readFile(path)), language)
  } finally {
    await rm(path, { force: true }).catch(() => undefined)
  }
}

const actions = {
  status: async () => ({ ready: await voice.ready() }),
  details: () => voice.status(),
  prepare: () => voice.prepare(),
  plan: ({ target }) => voice.plan(target),
  download: ({ planId }) => voice.download(String(planId ?? '')),
  cancel: () => { voice.cancel(); return true },
  transcribe
}

process.on('message', (message) => {
  if (message?.type !== 'request') return
  const params = message.params && typeof message.params === 'object' ? message.params : {}
  if ('settings' in params) settings = params.settings
  const action = actions[message.action]
  void Promise.resolve()
    .then(() => {
      if (!action) throw new Error('未知的语音操作')
      return action(params)
    })
    .then(
      (value) => { if (process.connected) process.send?.({ type: 'response', id: message.id, value }) },
      (error) => { if (process.connected) process.send?.({ type: 'response', id: message.id, error: String(error?.message ?? error) }) }
    )
})

function shutdown() {
  voice.dispose()
  process.exit(0)
}
process.on('disconnect', shutdown)
process.on('SIGTERM', shutdown)
process.send?.({ type: 'ready' })
