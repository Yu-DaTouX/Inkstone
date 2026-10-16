import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, normalize, resolve } from 'node:path'
import type { AppSettings, ProjectDirectoryChange, ProjectDirectoryResult } from '../shared/ipc'
import { getSettings, updateSettings } from './settings'
import { listSessions } from './sessions'

function directoryKey(path: string): string {
  const key = normalize(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? key.toLowerCase() : key
}

function checkRequest(value: unknown): ProjectDirectoryChange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('项目目录请求格式无效')
  const request = value as Partial<ProjectDirectoryChange>
  if (typeof request.projectId !== 'string' || !request.projectId || request.projectId.length > 80) throw new Error('项目标识无效')
  for (const path of [request.cwd, request.expectedCwd]) {
    if (typeof path !== 'string' || !path.trim() || path.length > 32768 || path.includes('\0') || !isAbsolute(path.trim())) {
      throw new Error('请选择有效的绝对文件夹路径')
    }
  }
  return { projectId: request.projectId, cwd: request.cwd!.trim(), expectedCwd: request.expectedCwd! }
}

export function projectDirectoryPatch(current: AppSettings, request: ProjectDirectoryChange): Partial<AppSettings> {
  const project = current.projects.find((item) => item.id === request.projectId)
  if (!project) throw new Error('项目不存在，请刷新项目列表')
  if (directoryKey(project.cwd) !== directoryKey(request.expectedCwd)) throw new Error('项目文件夹已被更改，请重新打开对话框')
  const sameOld = (path: string): boolean => directoryKey(path) === directoryKey(project.cwd)
  const sameNew = (path: string): boolean => directoryKey(path) === directoryKey(request.cwd)
  if (current.projects.some((item) => item.id !== project.id && sameNew(item.cwd))) {
    throw new Error('此文件夹已被其他项目使用，请选择未被占用的文件夹；不会自动合并项目')
  }
  const othersAtOld = current.projects.some((item) => item.id !== project.id && sameOld(item.cwd))
  const projectNames = Object.fromEntries(Object.entries(current.projectNames).filter(([path]) =>
    !sameOld(path) || othersAtOld
  ))
  return {
    projects: current.projects.map((item) => item.id === project.id ? { ...item, name: item.name || current.projectNames[item.cwd], cwd: request.cwd, updatedAt: Date.now() } : item),
    projectNames,
    recentCwds: [request.cwd, ...current.recentCwds.filter((path) => !sameNew(path) && (othersAtOld || !sameOld(path)))].slice(0, 8),
    ...(sameOld(current.cwd) && !othersAtOld ? { cwd: request.cwd } : {})
  }
}

export async function changeProjectDirectory(value: unknown): Promise<ProjectDirectoryResult> {
  try {
    const request = checkRequest(value)
    const cwd = resolve(request.cwd)
    const canonical = await realpath(cwd)
    if (!(await stat(canonical)).isDirectory()) throw new Error('所选路径不是文件夹')
    await access(canonical, constants.R_OK)
    const checked = { ...request, cwd }
    const before = await getSettings()
    projectDirectoryPatch(before, checked)
    if (directoryKey(request.expectedCwd) === directoryKey(cwd)) return { ok: true, settings: before }
    const projectRoots = new Map(await Promise.all(before.projects.map(async (project) => {
      const actual = await realpath(project.cwd).catch(() => project.cwd)
      if (project.id !== request.projectId && directoryKey(actual) === directoryKey(canonical)) {
        throw new Error('此文件夹已被其他项目使用（可能通过目录链接），不会自动合并项目')
      }
      return [project.id, project.cwd] as const
    })))
    await listSessions(500, before.projects)
    const settings = await updateSettings((current) => {
      const patch = projectDirectoryPatch(current, checked)
      if (current.projects.some((project) => projectRoots.get(project.id) !== project.cwd)) {
        throw new Error('项目列表已变化，请重新打开对话框后重试')
      }
      return patch
    })
    return { ok: true, settings }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}
