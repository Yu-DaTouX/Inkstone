import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from '../node_modules/esbuild/lib/main.js'

const root = await mkdtemp(join(tmpdir(), 'yan-skill-files-'))
const rejects = (work, label) => {
  try {
    work()
    throw new Error(`未拒绝：${label}`)
  } catch (error) {
    if (String(error?.message ?? error).startsWith('未拒绝')) throw error
    if (error?.code !== 'file-path') throw new Error(`${label} 的拒绝原因不对：${error?.code ?? error}`)
  }
}
try {
  await build({ entryPoints: ['src/main/capabilities/acquired-skills.ts'], outfile: 'out/test/skill-files.mjs', bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  const skillFiles = await import('../out/test/skill-files.mjs')

  const declared = skillFiles.declaredSkillFile(root, 'skills/fixture/SKILL.md')
  if (declared.path !== 'skills/fixture/SKILL.md') throw new Error('声明路径未归一')
  if (!declared.absolute.startsWith(root)) throw new Error('声明路径没落在项目内')
  rejects(() => skillFiles.declaredSkillFile(root, '../escape/SKILL.md'), '路径穿越')
  rejects(() => skillFiles.declaredSkillFile(root, 'C:/Users/public/skills/fixture/SKILL.md'), '绝对路径')
  rejects(() => skillFiles.declaredSkillFile(root, '/etc/skills/fixture/SKILL.md'), '绝对路径（posix）')
  rejects(() => skillFiles.declaredSkillFile(root, 'skills/fixture/scripts/run.py'), '只接受 skills/<name>/SKILL.md')
  rejects(() => skillFiles.declaredSkillFile(root, 'notes/SKILL.md'), '缺少 skills/<name> 目录')

  if (skillFiles.normalizeSkillFilePath('skills\\fixture\\SKILL.md') !== 'skills/fixture/SKILL.md') throw new Error('反斜杠未归一')
  rejects(() => skillFiles.normalizeSkillFilePath('skills/./fixture/SKILL.md'), '点目录')
  rejects(() => skillFiles.normalizeSkillFilePath(''), '空路径')
  rejects(() => skillFiles.normalizeSkillFilePath('skills/fixture/\0SKILL.md'), '空字节')

  console.log('skill-files tests: ok')
} finally {
  await rm(root, { recursive: true, force: true })
}
