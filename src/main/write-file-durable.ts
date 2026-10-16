import { open } from 'node:fs/promises'

export async function writeFileDurable(path: string, text: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}
