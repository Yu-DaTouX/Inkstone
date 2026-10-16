import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { YAN_DIR } from './paths'
import { buildLearningExport, type LearningRawData } from '../shared/learning-export'

export const LEARNING_EXPORT_DIRNAME = 'learning-export'

const SOURCES: Record<keyof LearningRawData, string> = {
  courses: 'courses.json',
  studySessions: 'study-sessions.json',
  exercises: 'exercises.json',
  learningMemory: 'learning-memory.json'
}

async function readRaw(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`学习数据文件读取或解析失败：${file}`, { cause: error })
  }
}

export async function exportLearningData(
  root: string = YAN_DIR,
  now: number = Date.now()
): Promise<{ dir: string; files: string[] } | null> {
  const raw: LearningRawData = {}
  let any = false
  for (const [key, name] of Object.entries(SOURCES) as [keyof LearningRawData, string][]) {
    const path = join(root, name)
    try {
      await stat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    raw[key] = await readRaw(path)
    any = true
  }
  if (!any) return null

  const dir = join(root, LEARNING_EXPORT_DIRNAME)
  const files = buildLearningExport(raw, now)
  const staging = `${dir}.tmp-${process.pid}-${now}`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  const old = `${dir}.old-${process.pid}-${now}`
  let movedOld = false
  try {
    for (const file of files) await writeFile(join(staging, file.name), file.content, 'utf8')
    try { await stat(dir); await rename(dir, old); movedOld = true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    try {
      await rename(staging, dir)
    } catch (error) {
      if (movedOld) await rename(old, dir).catch((rollback) => {
        throw new Error(`导出目录替换失败，旧目录回滚也失败：${String(rollback)}`, { cause: error })
      })
      throw error
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  if (movedOld) await rm(old, { recursive: true, force: true })
  return { dir, files: (await readdir(dir)).sort() }
}
