import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  formatSkillSecurityReview,
  reviewSkillFiles,
  type SkillSecurityReview
} from '../../shared/skill-security'
import { acquisitionRoot } from './acquisition-service'
import { declaredSkillFile } from './acquired-skills'

export type ManagedSkill = {
  candidateId: string
  operationId: string
  projectId: string
  path: string
  relativePath: string
  sha256: string
}
export type SkillActiveFile = { version: 1; projectId: string; skills: ManagedSkill[]; securityReview?: SkillSecurityReview }

export class SkillSecurityError extends Error {
  constructor(readonly review: SkillSecurityReview) {
    super(formatSkillSecurityReview(review))
    this.name = 'SkillSecurityError'
  }
}

const ACTIVE = 'skill-files-active.json'

export function skillFilesActivePath(root: string, projectId: string): string {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(projectId)) throw new Error('项目 ID 不安全')
  return join(acquisitionRoot(root), 'active', projectId, ACTIVE)
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
    const review = reviewSkillFiles(await Promise.all(valid.map(async (skill) => ({
      path: skill.relativePath,
      content: await readFile(skill.path)
    }))))
    if (!review.ok) throw new SkillSecurityError(review)
    return valid
  } catch (error) {
    if (error instanceof SkillSecurityError) throw error
    return []
  }
}

export async function activeSkillArgs(root: string, projectId: string): Promise<string[]> {
  return (await readActiveSkillFiles(root, projectId)).flatMap((skill) => ['--skill', skill.path])
}
