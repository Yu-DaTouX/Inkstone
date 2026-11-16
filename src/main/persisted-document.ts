import { constants } from 'node:fs'
import { copyFile, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { pick } from '../shared/ui-lang'

export function parsePersistedDocument(text: string, fields: Record<string, 'array' | 'object'>): Record<string, unknown> {
  return validatePersistedDocument(JSON.parse(text), fields)
}

export function validatePersistedDocument(value: unknown, fields: Record<string, 'array' | 'object'>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(pick('持久文档必须是对象，已拒绝覆盖', 'A persisted document must be an object. Refusing to overwrite'))
  const document = value as Record<string, unknown>
  if (document.version !== undefined && document.version !== 1) throw new Error(pick('持久文档版本不受支持，已拒绝覆盖', 'Unsupported persisted document version. Refusing to overwrite'))
  for (const [field, type] of Object.entries(fields)) {
    const item = document[field]
    if (type === 'array' ? !Array.isArray(item) : !item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(pick(`持久文档字段 ${field} 格式无效，已拒绝覆盖`, `Invalid persisted document field ${field}. Refusing to overwrite`))
    }
  }
  return document
}

export async function backupCorruptFile(file: string): Promise<string> {
  const target = `${file}.corrupt-${Date.now()}-${randomBytes(3).toString('hex')}`
  await copyFile(file, target, constants.COPYFILE_EXCL)
  return target
}

export async function readPersistedJson<T>(file: string, parse: (value: unknown) => T, empty: () => T): Promise<T> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    try {
      await backupCorruptFile(file)
    } catch (backupError) {
      throw new Error(
        pick(`文件已损坏且无法备份，已拒绝覆盖：${file}（${backupError instanceof Error ? backupError.message : String(backupError)}）`, `The file is corrupt and could not be backed up. Refusing to overwrite: ${file} (${backupError instanceof Error ? backupError.message : String(backupError)})`),
        { cause: backupError }
      )
    }
    return empty()
  }
  return parse(value)
}
