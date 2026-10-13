import { open } from 'node:fs/promises'

/** 写入调用方拥有的临时文件并同步内容；目标替换与失败清理由调用方负责。 */
export async function writeFileDurable(path: string, text: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}
