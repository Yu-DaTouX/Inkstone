export function soakOptions(argv) {
  const number = (name, fallback, min) => {
    const index = argv.indexOf(name)
    if (index < 0) return fallback
    const value = Number(argv[index + 1])
    if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} requires an integer >= ${min}`)
    return value
  }
  const cycles = number('--soak-cycles', 0, 1)
  const diagnose = argv.includes('--soak-diagnose')
  if (diagnose && !cycles) throw new Error('--soak-diagnose requires --soak-cycles')
  const delayMs = number('--soak-delay-ms', 1500, 0)
  if (!cycles && argv.includes('--soak-delay-ms')) throw new Error('--soak-delay-ms requires --soak-cycles')
  if (cycles && argv.some((arg) => ['--watch-targets', '--idle', '--steps', '--browser', '--main-heap', '--procs', '--verify'].includes(arg))) {
    throw new Error('Soak mode cannot be combined with other probe modes')
  }
  return { cycles, delayMs, diagnose, sessions: 3, messagesPerSession: 600, imagesPerSession: 4, imageSize: 512 }
}

export function fixtureExpression(action, options, cycle = 0, index = 0, cwd = '') {
  return `(${rendererFixture.toString()})(${JSON.stringify({ action, options, cycle, index, cwd })})`
}

function rendererFixture({ action, options, cycle, index, cwd }) {
  const store = window.__yanStore
  if (action === 'clear') {
    for (const url of window.__memorySoakObjectUrls ?? []) URL.revokeObjectURL(url)
    delete window.__memorySoakObjectUrls
    delete window.__memorySoakFixtures
    store?.setState({ messages: [], sessions: [], session: null, filePreview: null })
    return { cleared: true }
  }
  if (action === 'prepare') {
    const fixtures = []
    for (let s = 0; s < options.sessions; s++) {
      const id = `memory-soak-${cycle}-${s}`
      const messages = Array.from({ length: options.messagesPerSession }, (_, m) => ({
        id: `${id}-${m}`, role: m % 2 ? 'assistant' : 'user',
        text: `Synthetic cycle ${cycle}, session ${s}, message ${m}\n\n${'Long conversation fixture. '.repeat(80)}`
      }))
      for (let n = 0; n < options.imagesPerSession; n++) {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = options.imageSize
        const context = canvas.getContext('2d')
        const image = context.createImageData(canvas.width, canvas.height)
        let seed = cycle * 1009 + s * 101 + n + 1
        for (let p = 0; p < image.data.length; p += 4) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
          image.data[p] = seed & 255
          image.data[p + 1] = (seed >>> 8) & 255
          image.data[p + 2] = (seed >>> 16) & 255
          image.data[p + 3] = 255
        }
        context.putImageData(image, 0, 0)
        const data = canvas.toDataURL('image/png').split(',')[1]
        let attachment = { mimeType: 'image/png', data }
        if (options.blobImages) {
          const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
          const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
          const urls = window.__memorySoakObjectUrls ??= []
          urls.push(url)
          attachment = { mimeType: 'image/png', url }
        }
        messages[messages.length - 2 - n * 2].images = [attachment]
        canvas.width = canvas.height = 0
      }
      fixtures.push({ id, messages })
    }
    window.__memorySoakFixtures = fixtures
    store.setState({ sessions: fixtures.map(({ id }) => ({ id, path: `${cwd}/${id}.jsonl`, cwd, title: id, named: true, createdAt: 1, updatedAt: 1, messageCount: options.messagesPerSession })) })
    const images = fixtures.flatMap((fixture) => fixture.messages.flatMap((message) => message.images ?? []))
    return { sessions: fixtures.length, imageStats: { count: images.length, base64Chars: images.reduce((sum, image) => sum + (image.data?.length ?? 0), 0), referenceChars: images.reduce((sum, image) => sum + (image.url?.length ?? (image.data.length + 22)), 0) } }
  }
  if (action === 'switch') {
    const fixture = window.__memorySoakFixtures[index]
    store.setState({
      session: { sessionId: fixture.id, cwd, thinkingLevel: 'off', availableThinkingLevels: [], isStreaming: false, isCompacting: false, messageCount: fixture.messages.length },
      messages: fixture.messages,
      filePreview: { path: `${cwd}/synthetic-canvas.html`, cwd, loading: true, data: null }
    })
    return { sessionId: fixture.id, messages: store.getState().messages.length, canvasCoverage: 'store-only-loading-placeholder-no-native-view' }
  }
  if (action === 'close-canvas') {
    store.setState({ filePreview: null })
    return true
  }
  throw new Error(`Unknown fixture action: ${action}`)
}

export function summarizeMemoryDump(events) {
  return events.filter((event) => event.args?.dumps?.allocators && Object.keys(event.args.dumps.allocators).length > 0).map((event) => ({
    pid: event.pid,
    dumpId: event.id ?? event.id2?.global,
    allocators: Object.entries(event.args.dumps.allocators)
      .filter(([name]) => /skia|gpu|discardable|v8|malloc|partition_alloc|blink|cc\/|shared_images|canvas|web_cache|memory_cache|resource_cache|image|tile/i.test(name))
      .map(([name, value]) => ({
        name,
        attributes: Object.fromEntries(Object.entries(value.attrs ?? {}).filter(([, attr]) => attr.type === 'scalar').map(([key, attr]) => [key, {
          value: Number.parseInt(attr.value, 16), units: attr.units
        }]))
      }))
      .sort((a, b) => (b.attributes.size?.value ?? 0) - (a.attributes.size?.value ?? 0))
      .slice(0, 100)
  }))
}

export function soakGrowth(rows) {
  const baseline = rows.find((row) => row.phase === 'baseline')
  const cleared = rows.filter((row) => row.phase === 'cleared')
  const metrics = ['heapUsedMiB', 'backingStorageMiB', 'embedderHeapMiB', 'domNodes', 'jsEventListeners', 'documents', 'processes', 'treeWorkingSetMiB', 'treePrivateMiB']
  return Object.fromEntries(metrics.map((key) => {
    const points = [baseline, ...cleared].filter((row) => row && Number.isFinite(row[key]))
    if (points.length < 2) return [key, null]
    const first = points[0]
    const last = points.at(-1)
    const meanX = points.reduce((sum, row) => sum + row.cycle, 0) / points.length
    const meanY = points.reduce((sum, row) => sum + row[key], 0) / points.length
    const numerator = points.reduce((sum, row) => sum + (row.cycle - meanX) * (row[key] - meanY), 0)
    const denominator = points.reduce((sum, row) => sum + (row.cycle - meanX) ** 2, 0)
    return [key, {
      baseline: first[key], lastCleared: last[key], delta: last[key] - first[key],
      deltaPercent: first[key] ? (last[key] - first[key]) / first[key] * 100 : null,
      slopePerCycle: denominator ? numerator / denominator : null,
      clearedSamples: cleared.filter((row) => Number.isFinite(row[key])).length,
      peakBusy: Math.max(...rows.filter((row) => row.phase === 'busy' && Number.isFinite(row[key])).map((row) => row[key]), last[key])
    }]
  }))
}
