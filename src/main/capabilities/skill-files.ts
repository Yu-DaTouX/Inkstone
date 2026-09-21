/** 受管 skill-files 最小接入器：固定声明文件、受管 staging、项目级 active 记录。 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { AcquisitionService, acquisitionRoot, stagingDirOf, type StagedManifest } from './acquisition-service'

export type SkillFileInput = { path: string; content: string | Uint8Array }
export type ManagedSkill = {
  candidateId: string
  operationId: string
  projectId: string
  path: string
  relativePath: string
  sha256: string
}
export type SkillActiveFile = { version: 1; projectId: string; skills: ManagedSkill[] }

const ACTIVE = 'skill-files-active.json'

export function normalizeSkillFilePath(path: string): string {
  const raw = String(path)
  if (!raw || raw.includes('\0') || isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || /^[\\/]/.test(raw)) {
    throw new Error(`Skill 文件路径不安全：${path}`)
  }
  const value = raw.replaceAll('\\', '/')
  if (value.split('/').some((part) => part === '..' || part === '.')) throw new Error(`Skill 文件路径不安全：${path}`)
  return value
}

export function declaredSkillFile(root: string, path: string): { path: string; absolute: string } {
  const value = normalizeSkillFilePath(path)
  if (!/^skills\/[^/]+\/SKILL\.md$/i.test(value)) {
    throw new Error(`Skill 文件必须是 skills/<name>/SKILL.md：${value}`)
  }
  const base = resolve(root)
  const absolute = resolve(base, value)
  const escaped = relative(base, absolute)
  if (/^\.\.(?:[\\/]|$)/.test(escaped) || isAbsolute(escaped)) {
    throw new Error(`Skill 文件路径越界：${path}`)
  }
  return { path: value, absolute }
}

export function skillFilesActivePath(root: string, projectId: string): string {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(projectId)) throw new Error('项目 ID 不安全')
  return join(acquisitionRoot(root), 'active', projectId, ACTIVE)
}

export async function stageSkillFiles(input: {
  root: string; operationId: string; candidateId: string; projectId: string
  files: readonly SkillFileInput[]; expectedHashes?: Record<string, string>
}): Promise<{ manifest: StagedManifest; skills: ManagedSkill[] }> {
  if (input.files.length === 0) throw new Error('Skill 候选没有声明文件')
  const seen = new Set<string>()
  const files = input.files.map((file) => {
    const path = declaredSkillFile(input.root, file.path).path
    if (seen.has(path)) throw new Error(`Skill 候选重复声明文件：${path}`)
    seen.add(path)
    const hash = createHash('sha256').update(Buffer.from(file.content)).digest('hex')
    const expected = input.expectedHashes?.[path] ?? input.expectedHashes?.[file.path]
    if (expected && expected !== hash) throw new Error(`Skill 文件 hash 与固定声明不符：${path}`)
    return { path, content: file.content }
  })
  const service = new AcquisitionService({ root: input.root })
  const manifest = await service.stage({ operationId: input.operationId, files })
  const verified = await service.verifyStaged(input.operationId)
  if (!verified.ok) throw new Error(`Skill staging 复核失败：${verified.problems.join('；')}`)
  const skills = files.map((file) => ({
    candidateId: input.candidateId,
    operationId: input.operationId,
    projectId: input.projectId,
    path: join(stagingDirOf(input.root, input.operationId), 'payload', file.path),
    relativePath: file.path,
    sha256: createHash('sha256').update(Buffer.from(file.content)).digest('hex')
  }))
  return { manifest, skills }
}

export async function writeActiveSkillFiles(root: string, projectId: string, skills: ManagedSkill[]): Promise<void> {
  const activeDir = join(acquisitionRoot(root), 'active', projectId)
  const recordPath = join(activeDir, ACTIVE)
  await mkdir(activeDir, { recursive: true })
  const materialized: ManagedSkill[] = []
  for (const skill of skills) {
    const relativePath = declaredSkillFile(activeDir, skill.relativePath).path
    const sourceInfo = await lstat(skill.path)
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error(`Skill staging 不是普通文件：${skill.path}`)
    const content = await readFile(skill.path)
    const sha256 = createHash('sha256').update(content).digest('hex')
    if (sha256 !== skill.sha256) throw new Error(`Skill staging hash 已变化：${relativePath}`)
    const target = join(activeDir, relativePath)
    await mkdir(dirname(target), { recursive: true })
    const tmpTarget = `${target}.tmp-${Date.now()}-${materialized.length}`
    await writeFile(tmpTarget, content)
    await rm(target, { force: true })
    await rename(tmpTarget, target)
    materialized.push({ ...skill, path: target, relativePath, sha256 })
  }
  const tmp = `${recordPath}.tmp-${Date.now()}`
  await writeFile(tmp, JSON.stringify({ version: 1, projectId, skills: materialized }, null, 2), 'utf8')
  await rename(tmp, recordPath)
}

/** Materialize only the verified operation payload; callers must run verifyStaged first. */
export async function activateStagedSkillFiles(
  root: string,
  operation: { operationId: string; candidateId: string; projectId: string }
): Promise<ManagedSkill[]> {
  const manifest = JSON.parse(await readFile(join(stagingDirOf(root, operation.operationId), 'manifest.json'), 'utf8')) as StagedManifest
  if (manifest.version !== 1 || manifest.operationId !== operation.operationId || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Skill staging manifest 无效')
  }
  const skills = manifest.files.map((file) => ({
    candidateId: operation.candidateId,
    operationId: operation.operationId,
    projectId: operation.projectId,
    path: join(stagingDirOf(root, operation.operationId), 'payload', file.path),
    relativePath: file.path,
    sha256: file.sha256
  }))
  await writeActiveSkillFiles(root, operation.projectId, skills)
  return skills
}

export async function readActiveSkillFiles(root: string, projectId: string): Promise<ManagedSkill[]> {
  try {
    const record = JSON.parse(await readFile(skillFilesActivePath(root, projectId), 'utf8')) as SkillActiveFile
    if (record.version !== 1 || record.projectId !== projectId || !Array.isArray(record.skills)) return []
    const activeDir = resolve(acquisitionRoot(root), 'active', projectId)
    const valid: ManagedSkill[] = []
    for (const skill of record.skills) {
      if (!skill || skill.projectId !== projectId || typeof skill.path !== 'string' || typeof skill.relativePath !== 'string') continue
      const relativePath = declaredSkillFile(activeDir, skill.relativePath).path
      const expectedPath = resolve(activeDir, relativePath)
      if (resolve(skill.path) !== expectedPath) continue
      const info = await lstat(skill.path)
      if (!info.isFile() || info.isSymbolicLink()) continue
      const content = await readFile(skill.path)
      if (createHash('sha256').update(content).digest('hex') !== skill.sha256) continue
      valid.push(skill)
    }
    return valid
  } catch { return [] }
}

export async function activeSkillArgs(root: string, projectId: string): Promise<string[]> {
  return (await readActiveSkillFiles(root, projectId)).flatMap((skill) => ['--skill', skill.path])
}
