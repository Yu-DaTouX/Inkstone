export const PROVIDER_REQUEST_STAGES = [
  'provider-diagnostics',
  'anthropic-progress-updates',
  'parallel-tool-calls',
  'native-web-search',
  'fast-mode',
  'prompt-suggestion',
  'context-compact',
  'context-usage'
]

const COLLECT_CHANNEL = 'inkstone:provider-request:collect'
const HOST_CHANNEL = 'inkstone:provider-request:host'

const reportStageError = (name, error) => {
  try {
    console.error(`[Inkstone/provider-request] ${name}: ${error instanceof Error ? error.message : String(error)}`)
  } catch {
  }
}

export function runProviderRequestStages(stages, payload, ctx, onError = reportStageError) {
  let current
  for (const name of PROVIDER_REQUEST_STAGES) {
    const run = stages.get(name)
    if (!run) continue
    try {
      const next = run(current === undefined ? payload : current, ctx)
      if (next !== undefined) current = next
    } catch (error) {
      onError(name, error)
    }
  }
  return current
}

export function collectProviderRequestStages(events) {
  const stages = new Map()
  events.emit(COLLECT_CHANNEL, (name, run) => {
    if (!stages.has(name)) stages.set(name, run)
  })
  return stages
}

export function registerProviderRequestStage(pi, name, run) {
  if (!PROVIDER_REQUEST_STAGES.includes(name)) throw new Error(`Unknown provider request stage: ${name}`)
  pi.events.on(COLLECT_CHANNEL, (collect) => collect(name, run))
  let hosted = false
  pi.events.emit(HOST_CHANNEL, () => { hosted = true })
  if (hosted) return
  pi.events.on(HOST_CHANNEL, (claim) => claim())
  pi.on('before_provider_request', (event, ctx) => runProviderRequestStages(collectProviderRequestStages(pi.events), event?.payload, ctx))
}
