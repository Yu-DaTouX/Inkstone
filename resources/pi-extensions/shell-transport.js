import { randomBytes } from 'node:crypto'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STALE_COMMAND_MS = 60 * 60 * 1000
const COMMAND_FILE = /^yan-bash-(\d+)-[0-9a-f]+\.sh$/

export function bashQuotedPath(path) {
  return `'${path.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function sweepStaleCommands(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    const match = COMMAND_FILE.exec(name)
    if (!match) continue
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid === process.pid || pidAlive(pid)) continue
    const file = join(dir, name)
    try {
      if (now - statSync(file).mtimeMs < STALE_COMMAND_MS) continue
      rmSync(file, { force: true })
    } catch {
    }
  }
}

export function fileTransportOperations(base, { dir = tmpdir(), preamble = '' } = {}) {
  sweepStaleCommands(dir)
  return {
    ...base,
    async exec(command, cwd, options) {
      const file = join(dir, `yan-bash-${process.pid}-${randomBytes(8).toString('hex')}.sh`)
      await writeFile(file, command, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      try {
        const resolvedPreamble = typeof preamble === 'function' ? await preamble(command) : preamble
        return await base.exec(`${resolvedPreamble ? `${resolvedPreamble}; ` : ''}. ${bashQuotedPath(file)}`, cwd, options)
      } finally {
        await rm(file, { force: true }).catch(() => {})
      }
    }
  }
}
