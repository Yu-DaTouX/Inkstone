#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const report = { pass: 0, fail: 0 }
async function check(message, fn) {
  try {
    await fn()
    report.pass += 1
    process.stdout.write(`  ✓ ${message}\n`)
  } catch (error) {
    report.fail += 1
    process.stdout.write(`  ✗ ${message}\n    ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

async function bundle(entry) {
  const built = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
}

const names = await bundle('src/main/win-file-names.ts')
const skills = await bundle('src/main/capabilities/acquired-skills.ts')
const userSkills = await bundle('src/main/user-skills.ts')
const syncStore = await bundle('src/main/sync/local-store.ts')

process.stdout.write('\n▌Windows 设备名判定（E7d）\n')
await check('常见设备名与带扩展名的写法都算保留名', async () => {
  for (const name of ['con', 'CON', 'con.txt', 'nul', 'aux', 'prn', 'com1', 'COM9', 'lpt1', 'clock$', 'conin$']) {
    assert.equal(names.isWindowsDeviceName(name), true, name)
  }
})

await check('普通名字和近似写法不算', async () => {
  for (const name of ['console', 'com', 'com0x', 'lpt', 'conifer', 'con-1', 'nulify', '']) {
    assert.equal(names.isWindowsDeviceName(name), false, name)
  }
})

process.stdout.write('\n▌技能名与文件路径\n')
await check('技能名不能用设备名', async () => {
  assert.throws(() => skills.acquiredSkillName('con'), /设备名/)
  assert.throws(() => skills.acquiredSkillName('nul'), /设备名/)
  assert.equal(skills.acquiredSkillName('console'), 'console')
})

await check('相对路径里的设备名段被拒绝', async () => {
  for (const path of ['con/SKILL.md', 'nul.txt', 'sub/aux.md', 'sub/lpt1/file.md']) {
    assert.throws(() => skills.safeSkillRelativePath(path), /不安全|设备/, path)
  }
  assert.equal(skills.safeSkillRelativePath('sub/normal.md'), 'sub/normal.md')
})

await check('安装技能时设备名在写盘前就被拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yan-skill-names-'))
  try {
    await assert.rejects(
      skills.installAcquiredSkill({ root, scope: 'session', sessionId: 's1', name: 'con', description: 'x', files: [{ path: 'SKILL.md', content: '# x' }], source: { candidateId: 'c1' } }),
      /设备名/
    )
    await assert.rejects(
      skills.installAcquiredSkill({ root, scope: 'session', sessionId: 's1', name: 'ok-name', description: 'x', files: [{ path: 'SKILL.md', content: '# x' }, { path: 'con.txt', content: 'x' }], source: { candidateId: 'c1' } }),
      /不安全|设备/
    )
    assert.deepEqual(await readdir(join(root, 'capabilities', 'session-skills')).catch(() => []), [])
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
})

await check('保存用户技能时设备名得到明确拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yan-user-skill-names-'))
  try {
    const result = await userSkills.saveUserSkill({ name: 'con', description: '说明', body: '正文' }, { root })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'bad-name')
    assert.match(result.error, /设备名/)
    assert.deepEqual(await readdir(join(root, 'skills')).catch(() => []), [])
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
})

process.stdout.write('\n▌同步记录里的设备名\n')
await check('同步技能 key 用设备名时按非法 key 拒绝，不创建目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yan-sync-names-'))
  try {
    const store = new syncStore.LocalStore({
      settingsFile: join(root, 'desktop.json'),
      promptsDir: join(root, 'prompts'),
      skillsDir: join(root, 'skills'),
      interactionStateDir: join(root, 'state')
    })
    await assert.rejects(() => store.apply({ kind: 'skill', key: 'skill:con', payload: '# x', modifiedAt: 1 }), /非法/)
    await assert.rejects(() => store.apply({ kind: 'prompt', key: 'prompt:aux', payload: 'x', modifiedAt: 1 }), /非法/)
    assert.deepEqual(await readdir(join(root, 'skills')).catch(() => []), [])
    assert.deepEqual(await readdir(join(root, 'prompts')).catch(() => []), [])
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
})

process.stdout.write(`\n${report.fail === 0 ? '✅' : '❌'} Windows 设备名：${report.pass} 通过 / ${report.fail} 失败\n`)
process.exit(report.fail === 0 ? 0 : 1)
