import { join } from 'node:path'
import { createComfyService } from './service.mjs'
import { requestHost, cancelHostRequest } from './bridge.mjs'
import { stopManagedComfy } from './launcher.mjs'

const requests = new Map()
process.on('message', message => {
  if (message?.type === 'cancel-request') { requests.get(message.id)?.abort(); cancelHostRequest(message.id); return }
  if (message?.type !== 'request') return
  const controller = new AbortController()
  requests.set(message.id, controller)
  void execute(message, controller.signal).then(
    value => { if (process.connected) process.send?.({ type: 'response', id: message.id, value }) },
    error => { if (process.connected) process.send?.({ type: 'response', id: message.id, error: String(error.message ?? error), code: typeof error.code === 'string' ? error.code : undefined }) }
  ).finally(() => requests.delete(message.id))
})
const service = createComfyService({
  artifactDir: join(process.env.INKSTONE_DATA_ROOT, 'artifacts', 'comfyui'),
  sourceArtifactDir: join(process.env.INKSTONE_DATA_ROOT, 'artifacts'),
  confirm: (title, detail, signal) => {
    if (signal?.aborted) return false
    const owner = [...requests].find(([, controller]) => controller.signal === signal)?.[0]
    return requestHost('user.confirm', { title, detail }, owner)
  }
})
async function execute(message, signal) {
  return service(message.action, message.params, signal)
}
function shutdown() {
  for (const request of requests.values()) request.abort()
  cancelHostRequest()
  stopManagedComfy()
  process.exit(0)
}
process.on('disconnect', shutdown)
process.on('SIGTERM', shutdown)
process.send?.({ type: 'ready' })
