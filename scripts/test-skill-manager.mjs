import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

const toPosix = (path) => path.replace(/\\/g, '/')

async function writeSkill(dir, content) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), content, 'utf8')
}

async function run() {
  const root = await mkdtemp(join(tmpdir(), 'inkstone-skill-manager-'))
  try {
    const mod = await compile('src/main/skill-manager.ts', join(root, 'skill-manager.mjs'))
    const {
      piSkillPattern,
      piSkillRoots,
      managedSkillOf,
      managedSkillDir,
      listManagedSkills,
      setManagedSkillEnabled,
      trashManagedSkill
    } = mod

    const yanRoot = join(root, 'yan')
    const agentDir = join(root, 'agent')
    const home = join(root, 'home')
    const paths = { yanRoot, agentDir, home }

    assert.deepEqual(piSkillRoots(paths), [join(agentDir, 'skills'), join(home, '.agents', 'skills')])
    assert.equal(piSkillPattern(join(agentDir, 'skills', 'foo'), agentDir), 'skills/foo')
    assert.equal(piSkillPattern(join(agentDir, 'skills', 'nested', 'foo'), agentDir), 'skills/nested/foo')
    const outside = join(home, '.agents', 'skills', 'bar')
    assert.equal(piSkillPattern(outside, agentDir), toPosix(resolve(outside)))

    assert.deepEqual(managedSkillOf(join(yanRoot, 'skills', 'foo', 'SKILL.md'), paths), { scope: 'yan', dirName: 'foo' })
    assert.deepEqual(managedSkillOf(join(yanRoot, 'skills', 'foo', 'skill.md'), paths), { scope: 'yan', dirName: 'foo' })
    assert.deepEqual(managedSkillOf(join(agentDir, 'skills', 'foo', 'SKILL.md'), paths), { scope: 'pi', dirName: 'foo' })
    assert.deepEqual(managedSkillOf(join(home, '.agents', 'skills', 'foo', 'SKILL.md'), paths), { scope: 'pi', dirName: 'foo' })
    assert.equal(managedSkillOf(join(yanRoot, 'skills', 'foo', 'README.md'), paths), null)
    assert.equal(managedSkillOf(join(root, 'other', 'foo', 'SKILL.md'), paths), null)
    assert.equal(managedSkillOf(join(yanRoot, 'skills', 'nested', 'foo', 'SKILL.md'), paths), null)

    await writeSkill(join(yanRoot, 'skills', 'yan-a'), '---\nname: yan-a\ndescription: "双引号描述"\n---\n\n正文\n')
    await writeSkill(join(yanRoot, 'skills', 'yan-b'), '没有 frontmatter 的正文\n')
    await writeSkill(join(yanRoot, 'skills', 'yan-c'), '---\nname: yan-c\n')
    await writeSkill(join(yanRoot, 'skills', 'yan-d'), '---\ndescription:   only desc   \n---\n\n正文\n')
    await writeSkill(join(yanRoot, 'skills', '.hidden'), '# hidden\n')
    await writeFile(join(yanRoot, 'skills', '.disabled.json'), JSON.stringify(['yan-b']), 'utf8')

    const bom = String.fromCharCode(0xfeff)
    await writeSkill(
      join(agentDir, 'skills', 'pi-a'),
      `${bom}---\r\nname: pi-a\r\ndescription: '单引号描述'\r\n---\r\n\r\n正文\r\n`
    )
    await writeSkill(join(agentDir, 'skills', '.hidden'), '# hidden\n')
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ skills: ['-./skills/pi-a'] }), 'utf8')
    await writeSkill(join(home, '.agents', 'skills', 'pi-b'), '---\nname: pi-b\ndescription: plain desc\n---\n\n正文\n')

    const listed = await listManagedSkills(paths)
    assert.deepEqual(
      listed.map((entry) => ({ name: entry.name, description: entry.description, scope: entry.scope, enabled: entry.enabled })),
      [
        { name: 'yan-a', description: '双引号描述', scope: 'yan', enabled: true },
        { name: 'yan-b', description: '', scope: 'yan', enabled: false },
        { name: 'yan-c', description: '', scope: 'yan', enabled: true },
        { name: 'yan-d', description: 'only desc', scope: 'yan', enabled: true },
        { name: 'pi-a', description: '单引号描述', scope: 'pi', enabled: false },
        { name: 'pi-b', description: 'plain desc', scope: 'pi', enabled: true }
      ]
    )
    assert.equal(listed[0].location, join(yanRoot, 'skills', 'yan-a', 'SKILL.md'))
    assert.equal(listed[4].location, join(agentDir, 'skills', 'pi-a', 'SKILL.md'))
    assert.equal(listed[5].location, join(home, '.agents', 'skills', 'pi-b', 'SKILL.md'))

    await writeSkill(join(yanRoot, 'skills', 'good'), '# good\n')
    await writeSkill(join(agentDir, 'skills', 'piskill'), '# pi\n')
    assert.equal(managedSkillDir('yan', 'good', paths), join(yanRoot, 'skills', 'good'))
    assert.equal(managedSkillDir('pi', 'piskill', paths), join(agentDir, 'skills', 'piskill'))
    assert.equal(managedSkillDir('yan', 'missing', paths), null)
    assert.equal(managedSkillDir('yan', '..', paths), null)
    assert.equal(managedSkillDir('yan', '.hidden', paths), null)
    assert.equal(managedSkillDir('yan', 'has space', paths), null)
    assert.equal(managedSkillDir('yan', 'a/b', paths), null)
    assert.equal(managedSkillDir('yan', 'a'.repeat(65), paths), null)
    await mkdir(join(yanRoot, 'skills', 'empty-dir'), { recursive: true })
    assert.equal(managedSkillDir('yan', 'empty-dir', paths), null)

    await writeSkill(join(agentDir, 'skills', 'pi-toggle'), '# toggle\n')
    let result = await setManagedSkillEnabled('pi', 'pi-toggle', false, paths)
    assert.equal(result.ok, true)
    let settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))
    assert.deepEqual(settings.skills, ['-./skills/pi-a', '-skills/pi-toggle'])

    result = await setManagedSkillEnabled('pi', 'pi-toggle', false, paths)
    assert.equal(result.ok, true)
    settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))
    assert.deepEqual(settings.skills, ['-./skills/pi-a', '-skills/pi-toggle'])

    result = await setManagedSkillEnabled('pi', 'pi-toggle', true, paths)
    assert.equal(result.ok, true)
    settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))
    assert.deepEqual(settings.skills, ['-./skills/pi-a'])
    assert.equal((await listManagedSkills(paths)).find((entry) => entry.name === 'pi-toggle').enabled, true)

    result = await setManagedSkillEnabled('pi', 'ghost', false, paths)
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('ghost'))

    await writeSkill(join(yanRoot, 'skills', 'yan-toggle'), '# yan toggle\n')
    result = await setManagedSkillEnabled('yan', 'yan-toggle', false, paths)
    assert.equal(result.ok, true)
    let disabled = JSON.parse(await readFile(join(yanRoot, 'skills', '.disabled.json'), 'utf8'))
    assert.ok(disabled.includes('yan-b') && disabled.includes('yan-toggle'))
    assert.equal((await listManagedSkills(paths)).find((entry) => entry.name === 'yan-toggle').enabled, false)

    result = await setManagedSkillEnabled('yan', 'yan-toggle', true, paths)
    assert.equal(result.ok, true)
    disabled = JSON.parse(await readFile(join(yanRoot, 'skills', '.disabled.json'), 'utf8'))
    assert.equal(disabled.includes('yan-toggle'), false)

    const badAgent = join(root, 'bad-agent')
    await writeSkill(join(badAgent, 'skills', 'badskill'), '# bad\n')
    await writeFile(join(badAgent, 'settings.json'), 'not json', 'utf8')
    const badResult = await setManagedSkillEnabled('pi', 'badskill', false, { yanRoot, agentDir: badAgent, home })
    assert.equal(badResult.ok, false)
    assert.ok(badResult.error.includes('不是有效的 JSON'))
    assert.equal(await readFile(join(badAgent, 'settings.json'), 'utf8'), 'not json')

    const trashed = []
    const trash = async (target) => {
      trashed.push(target)
      await rm(target, { recursive: true, force: true })
    }
    await writeSkill(join(agentDir, 'skills', 'trash-me'), '# trash\n')
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ skills: ['-skills/trash-me'] }), 'utf8')
    result = await trashManagedSkill('pi', 'trash-me', trash, paths)
    assert.equal(result.ok, true)
    assert.deepEqual(trashed, [join(agentDir, 'skills', 'trash-me')])
    settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'))
    assert.equal(settings.skills, undefined)
    result = await trashManagedSkill('pi', 'ghost', trash, paths)
    assert.equal(result.ok, false)

    await writeSkill(join(yanRoot, 'skills', 'yan-trash'), '# yan trash\n')
    await writeFile(join(yanRoot, 'skills', '.disabled.json'), JSON.stringify(['yan-b', 'yan-trash']), 'utf8')
    result = await trashManagedSkill('yan', 'yan-trash', trash, paths)
    assert.equal(result.ok, true)
    disabled = JSON.parse(await readFile(join(yanRoot, 'skills', '.disabled.json'), 'utf8'))
    assert.equal(disabled.includes('yan-trash'), false)
    assert.equal(disabled.includes('yan-b'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run()
  console.log('skill-manager: 全部通过')
}
