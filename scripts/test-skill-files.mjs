import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from '../node_modules/esbuild/lib/main.js'

const root = await mkdtemp(join(tmpdir(), 'yan-skill-files-'))
try {
  await build({ entryPoints: ['src/main/capabilities/skill-files.ts'], outfile: 'out/test/skill-files.mjs', bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  await build({ entryPoints: ['src/main/capabilities/acquisition-service.ts'], outfile: 'out/test/acquisition-service.mjs', bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  const skillFiles = await import('../out/test/skill-files.mjs')
  const source = join(root, 'declared')
  await mkdir(join(source, 'skills', 'fixture'), { recursive: true })
  const file = join(source, 'skills', 'fixture', 'SKILL.md')
  await writeFile(file, '# fixture\n')
  const { AcquisitionService } = await import('../out/test/acquisition-service.mjs')
  const service = new AcquisitionService({ root })
  const tx = await service.begin({ planId: 'skill-plan', candidateId: 'skill:fixture', digest: 'digest', projectId: 'project-a' })
  const staged = await skillFiles.stageSkillFiles({ root, operationId: tx.operationId, candidateId: tx.candidateId, projectId: tx.projectId, files: [{ path: 'skills/fixture/SKILL.md', content: await readFile(file) }] })
  if (staged.manifest.files.length !== 1) throw new Error('manifest 文件数错误')
  await skillFiles.writeActiveSkillFiles(root, 'project-a', staged.skills)
  const activeArgs = await skillFiles.activeSkillArgs(root, 'project-a')
  if (activeArgs.length !== 2) throw new Error('active --skill 参数错误')
  if ((await skillFiles.activeSkillArgs(root, 'project-b')).length !== 0) throw new Error('项目隔离失败')
  await writeFile(activeArgs[1], 'tampered')
  if ((await skillFiles.activeSkillArgs(root, 'project-a')).length !== 0) throw new Error('hash 篡改未拒绝')
  let rejected = false
  try { await skillFiles.stageSkillFiles({ root, operationId: tx.operationId, candidateId: tx.candidateId, projectId: tx.projectId, files: [{ path: '../escape/SKILL.md', content: 'x' }] }) } catch { rejected = true }
  if (!rejected) throw new Error('路径穿越未拒绝')
  rejected = false
  try { await skillFiles.stageSkillFiles({ root, operationId: tx.operationId, candidateId: tx.candidateId, projectId: tx.projectId, files: [{ path: 'C:/Users/public/skills/fixture/SKILL.md', content: 'x' }] }) } catch { rejected = true }
  if (!rejected) throw new Error('绝对路径未拒绝')
  console.log('skill-files tests: ok')
} finally { await rm(root, { recursive: true, force: true }) }
