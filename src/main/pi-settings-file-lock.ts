import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { delay } from '../shared/delay'

const LOCK_ATTEMPTS = 10
const LOCK_RETRY_MS = 20

async function acquire(file: string): Promise<() => Promise<void>> {
  const { default: lockfile } = await import('proper-lockfile')
  for (let attempt = 1; ; attempt++) {
    try {
      return await lockfile.lock(file, {
        realpath: false,
        onCompromised: (error) => console.warn('[pi-settings-lock] lock compromised:', error.message)
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ELOCKED' || attempt >= LOCK_ATTEMPTS) throw error
      await delay(LOCK_RETRY_MS)
    }
  }
}

export async function withPiSettingsFileLock<T>(file: string, run: () => Promise<T>): Promise<T> {
  await mkdir(dirname(file), { recursive: true })
  const release = await acquire(file)
  try {
    return await run()
  } finally {
    await release().catch(() => undefined)
  }
}
