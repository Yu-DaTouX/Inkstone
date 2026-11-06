import { readUsageStats } from './usage-stats'
import type { UsageRange } from '../shared/usage-stats'

interface Request {
  id: string
  range: UsageRange
}

const port = process.parentPort
port.on('message', (event: { data: unknown }) => {
  const request = event.data as Request | null
  if (!request || typeof request !== 'object' || typeof request.id !== 'string') return
  void readUsageStats(request.range).then(
    (value) => port.postMessage({ id: request.id, value }),
    (error: unknown) => port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) })
  )
})
