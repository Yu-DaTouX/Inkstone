/**
 * 学习数据导出到 `YAN_DIR/learning-export/`。
 *
 * 直接读四个落盘文件的原始 JSON（不经过各 store），学习功能收缩后也能用。
 * 导出是派生副本：每次调用整份重写；原始文件只读，不修改、不删除。
 * 没有任何学习数据时不创建导出目录。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
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

async function readRaw(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
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
    if (!existsSync(path)) continue
    raw[key] = await readRaw(path)
    any = true
  }
  if (!any) return null

  const dir = join(root, LEARNING_EXPORT_DIRNAME)
  const files = buildLearningExport(raw, now)
  /* 先写到临时目录再整体换上，导出中途失败时不留下半份 */
  const staging = `${dir}.tmp-${process.pid}-${now}`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  for (const file of files) await writeFile(join(staging, file.name), file.content, 'utf8')
  const old = `${dir}.old-${process.pid}-${now}`
  if (existsSync(dir)) await rename(dir, old)
  await rename(staging, dir)
  await rm(old, { recursive: true, force: true })
  return { dir, files: (await readdir(dir)).sort() }
}
