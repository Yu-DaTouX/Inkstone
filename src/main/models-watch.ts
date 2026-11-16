import { createHash } from 'node:crypto'
import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

export interface ModelsWatcher {
  close(): void
  noteWritten(text: string): void
}

export interface ModelsWatchOptions {
  file: string
  onChange: () => void
  debounceMs?: number
  retryMs?: number
  watch?: (dir: string, listener: (event: string, name: string | null) => void) => { close(): void; on(event: 'error', cb: () => void): unknown }
  read?: (file: string) => Promise<string | null>
  onError?: (error: unknown) => void
}

const DEBOUNCE_MS = 400
const RETRY_MS = 5_000

function digest(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

async function defaultRead(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function parses(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

let active: ModelsWatcher | null = null

export function noteModelsWritten(text: string): void {
  active?.noteWritten(text)
}

export function watchModelsFile(opts: ModelsWatchOptions): ModelsWatcher {
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS
  const retryMs = opts.retryMs ?? RETRY_MS
  const read = opts.read ?? defaultRead
  const target = basename(opts.file)
  const dir = dirname(opts.file)
  let closed = false
  let last: string | null = null
  let ready = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let watcher: { close(): void } | null = null
  let missingOnce = false
  let openFailureReported = false
  let generation = 0
  let baseline: Promise<void> = Promise.resolve()

  const schedule = (): void => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; void check() }, debounceMs)
    timer.unref?.()
  }

  const check = async (): Promise<void> => {
    await baseline
    if (closed) return
    const mine = ++generation
    let text: string | null
    try {
      text = await read(opts.file)
    } catch (error) {
      opts.onError?.(error)
      return
    }
    if (closed || mine !== generation) return
    if (text === null) {
      if (!missingOnce) {
        missingOnce = true
        schedule()
        return
      }
    } else if (!parses(text)) {
      missingOnce = false
      return
    }
    missingOnce = false
    const next = digest(text ?? '')
    if (next === last) return
    last = next
    try {
      opts.onChange()
    } catch (error) {
      opts.onError?.(error)
    }
  }

  const open = (): void => {
    if (closed) return
    try {
      const listener = (_event: string, name: string | null): void => {
        if (name === null || name === target) schedule()
      }
      const handle = opts.watch ? opts.watch(dir, listener) : (fsWatch(dir, { persistent: false }, listener) as FSWatcher)
      watcher = handle
      openFailureReported = false
      handle.on('error', () => {
        try { handle.close() } catch {}
        if (watcher === handle) watcher = null
        if (closed) return
        retry = setTimeout(() => { retry = null; open() }, retryMs)
        retry.unref?.()
      })
    } catch (error) {
      if (!openFailureReported) {
        openFailureReported = true
        opts.onError?.(error)
      }
      if (closed) return
      retry = setTimeout(() => { retry = null; open() }, retryMs)
      retry.unref?.()
    }
  }

  baseline = read(opts.file).then((text) => {
    if (!ready && !closed) {
      last = digest(text ?? '')
      ready = true
    }
  }, (error) => opts.onError?.(error))
  open()

  const handle: ModelsWatcher = {
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      if (retry) clearTimeout(retry)
      timer = null
      retry = null
      try { watcher?.close() } catch {}
      watcher = null
      if (active === handle) active = null
    },
    noteWritten(text) {
      last = digest(text)
      ready = true
    }
  }
  active = handle
  return handle
}
