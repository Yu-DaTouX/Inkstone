import { closeAllIndexes, runGrepJob, runNameJob } from './file-search-index'
import type { GrepJob, NameJob } from './file-search-index'

interface NameRequest extends NameJob {
  id: string
  kind: 'name'
}

interface GrepRequest extends GrepJob {
  id: string
  kind: 'grep'
}

interface QuitRequest {
  id: string
  kind: 'quit'
}

type Request = NameRequest | GrepRequest | QuitRequest

function handle(request: NameRequest | GrepRequest): Promise<unknown> {
  return request.kind === 'name' ? runNameJob(request) : runGrepJob(request)
}

const port = process.parentPort
port.on('message', (event: { data: unknown }) => {
  const request = event.data as Request | null
  if (!request || typeof request !== 'object' || typeof request.id !== 'string') return
  if (request.kind === 'quit') {
    closeAllIndexes()
    port.postMessage({ id: request.id, value: true })
    return
  }
  if (request.kind !== 'name' && request.kind !== 'grep') return
  void handle(request).then(
    (value) => port.postMessage({ id: request.id, value }),
    (error: unknown) => port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) })
  )
})
