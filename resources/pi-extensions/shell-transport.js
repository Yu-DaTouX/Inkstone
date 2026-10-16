import { randomBytes } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function bashQuotedPath(path) {
  return `'${path.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`
}

export function fileTransportOperations(base, { dir = tmpdir(), preamble = '' } = {}) {
  return {
    ...base,
    async exec(command, cwd, options) {
      const file = join(dir, `yan-bash-${randomBytes(8).toString('hex')}.sh`)
      await writeFile(file, command, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      try {
        return await base.exec(`${preamble ? `${preamble}; ` : ''}. ${bashQuotedPath(file)}`, cwd, options)
      } finally {
        await rm(file, { force: true }).catch(() => {})
      }
    }
  }
}
