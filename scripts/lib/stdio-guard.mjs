let brokenPipe = false
let otherErrorReported = false
let exiting = false

export function stdioPipeBroken() {
  return brokenPipe
}

const missingHandlerCounts = new Map()
let muted = false

export function muteMissingHandlerNoise() {
  if (muted) return
  muted = true

  const pattern = /^Error occurred in handler for '([^']+)': Error: No handler registered/
  const original = process.stderr.write.bind(process.stderr)

  process.stderr.write = (chunk, encoding, callback) => {
    const text =
      typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : ''
    const hit = text ? pattern.exec(text) : null
    if (hit) {
      missingHandlerCounts.set(hit[1], (missingHandlerCounts.get(hit[1]) ?? 0) + 1)
      const done = typeof encoding === 'function' ? encoding : callback
      if (typeof done === 'function') done()
      return true
    }
    return original(chunk, encoding, callback)
  }
}

export function missingHandlerSummary() {
  let total = 0
  for (const n of missingHandlerCounts.values()) total += n
  if (!total) return null
  const names = [...missingHandlerCounts.keys()].sort()
  return { total, names, counts: new Map(missingHandlerCounts) }
}

function warnOnce(text) {
  if (otherErrorReported) return
  otherErrorReported = true
  try {
    process.stderr.write(text + '\n')
  } catch {
  }
}

function streamHandler(kind) {
  return (error) => {
    const code = error && error.code
    if (code === 'EPIPE') {
      brokenPipe = true
      return
    }
    warnOnce(`[stdio-guard] ${kind} 写入失败：${code || String(error)}（后续日志可能丢失）`)
  }
}

function fatal(kind, err) {
  if (exiting) return
  exiting = true
  const detail = err instanceof Error ? `${err.message}\n${err.stack || ''}` : String(err)
  warnOnce(`[stdio-guard] ${kind}：\n${detail}`)
  process.exitCode = 1
  process.exit(1)
}

let installed = false
export function installStdioGuard() {
  if (installed) return
  installed = true

  process.stdout.on('error', streamHandler('stdout'))
  process.stderr.on('error', streamHandler('stderr'))

  process.on('uncaughtException', (err) => fatal('uncaughtException', err))
  process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason))
}

installStdioGuard()
