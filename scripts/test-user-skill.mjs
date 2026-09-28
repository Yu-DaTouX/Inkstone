/**
 * 用户技能：名称校验、SKILL.md 生成、旧办事模板转换与一次性导出。
 *
 * 导出与保存都在临时目录里跑（传 root），不碰真实数据目录。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export async function runUserSkillTests(ok, shared, main, fs) {
  const { validateUserSkill, userSkillMarkdown, legacyPlaybookToSkill, legacyPlaybookSkillName } = shared

  /* ---- 名称与内容校验 ---- */
  {
    ok(validateUserSkill({ name: 'weekly-report', description: '周报', body: '# 周报' }).ok, '合法的技能名与内容通过')
    ok(validateUserSkill({ name: 'Weekly', description: 'x', body: 'x' }).code === 'bad-name', '大写字母的名字被拒')
    ok(validateUserSkill({ name: '周报', description: 'x', body: 'x' }).code === 'bad-name', '非 ASCII 名字被拒（与目录名一致）')
    ok(validateUserSkill({ name: 'a--b', description: 'x', body: 'x' }).code === 'bad-name', '连续连字符被拒')
    ok(validateUserSkill({ name: 'ok', description: '  ', body: 'x' }).code === 'missing-description', '缺 description 被拒')
    ok(validateUserSkill({ name: 'ok', description: 'x', body: '' }).code === 'missing-body', '缺正文被拒')
    const multi = validateUserSkill({ name: 'ok', description: '第一行\n第二行', body: 'x' })
    ok(multi.ok && multi.value.description === '第一行 第二行', 'description 折成一行')
  }

  /* ---- SKILL.md 生成 ---- */
  {
    const md = userSkillMarkdown({ name: 'demo', description: '含冒号: 与 "引号"', body: '# 标题' })
    ok(md.startsWith('---\nname: demo\n'), 'frontmatter 以 name 开头')
    ok(md.includes('description: "含冒号: 与 \\"引号\\""'), 'description 以 JSON 字符串写入，冒号与引号不破坏 frontmatter')
    ok(md.trimEnd().endsWith('# 标题'), '正文在 frontmatter 之后')
  }

  /* ---- 旧办事模板转换 ---- */
  {
    ok(legacyPlaybookSkillName('pb_1A2b') === 'playbook-pb-1a2b', '旧 id 转成合法技能名')
    ok(legacyPlaybookSkillName('模板') === 'playbook-untitled', '无法转写的 id 落到 untitled')
    const skill = legacyPlaybookToSkill({
      id: 'pb_x1',
      title: '整理下载目录',
      goal: '按类型归档',
      io: { inputs: ['下载目录'], outputs: ['变更清单'] },
      steps: [
        { title: '列出文件', effect: 'read' },
        { title: '移动文件', effect: 'write', scope: ['~/Downloads'] },
        { title: '发邮件通知', effect: 'external' }
      ]
    })
    ok(!!skill && skill.name === 'playbook-pb-x1', '转换结果带技能名')
    ok(/整理下载目录/.test(skill.description) && /按类型归档/.test(skill.description), 'description 含标题与目标')
    ok(/2\. 移动文件（会改东西；范围：~\/Downloads）/.test(skill.body), '写步骤保留范围')
    ok(/3\. 发邮件通知（会对外发出；范围未写明，执行前先问用户）/.test(skill.body), '缺范围的步骤保留下来并要求先问用户')
    ok(/执行前把具体范围/.test(skill.body), '有写 / 外发步骤时写出确认约定')
    ok(validateUserSkill(skill).ok, '转换结果能通过同一套校验')
    ok(legacyPlaybookToSkill({ id: 'x' }) === undefined, '没有标题的旧条目跳过')
  }

  /* ---- 导出与保存（临时目录） ---- */
  const root = await fs.mkdtemp(join(tmpdir(), 'yan-user-skill-'))
  try {
    ok((await main.userSkillPaths(root)).length === 0, '没有 skills 目录时返回空列表')
    const none = await main.migrateLegacyPlaybooks(root)
    ok(none.exported.length === 0, '没有 playbooks.json 时什么也不做')

    writeFileSync(
      join(root, 'playbooks.json'),
      JSON.stringify({
        version: 1,
        playbooks: [
          { id: 'pb_a', title: '模板 A', goal: '', steps: [{ title: '读', effect: 'read' }] },
          { id: 'pb_b', title: '模板 B', goal: '', steps: [] },
          { title: '坏条目' }
        ]
      })
    )
    const first = await main.migrateLegacyPlaybooks(root)
    ok(first.exported.length === 2 && first.skipped === 1, '两条导出、坏条目跳过', JSON.stringify(first))
    const fileA = join(root, 'skills', 'playbook-pb-a', 'SKILL.md')
    ok(existsSync(fileA) && /模板 A/.test(readFileSync(fileA, 'utf8')), '导出文件写到 skills/<名称>/SKILL.md')
    ok(existsSync(join(root, 'playbooks.json')), '原 playbooks.json 保留')
    ok((await main.userSkillPaths(root)).length === 2, 'userSkillPaths 列出导出的技能')

    rmSync(join(root, 'skills', 'playbook-pb-a'), { recursive: true, force: true })
    const second = await main.migrateLegacyPlaybooks(root)
    ok(second.exported.length === 0 && !existsSync(fileA), '用户删掉导出的技能后不会被再次生成')

    const saved = await main.saveUserSkill({ name: 'my-flow', description: '我的做法', body: '# 做法' }, { root, reservedNames: ['office'] })
    ok(saved.ok && existsSync(join(root, 'skills', 'my-flow', 'SKILL.md')), '保存用户技能')
    const dup = await main.saveUserSkill({ name: 'my-flow', description: '我的做法', body: '# 改' }, { root })
    ok(!dup.ok && dup.code === 'exists', '已存在时不带 replace 被拒')
    const replaced = await main.saveUserSkill({ name: 'my-flow', description: '我的做法', body: '# 改', replace: true }, { root })
    ok(replaced.ok && replaced.replaced === true, '带 replace 可以覆盖')
    const reserved = await main.saveUserSkill({ name: 'office', description: 'x', body: 'x' }, { root, reservedNames: ['office'] })
    ok(!reserved.ok && reserved.code === 'reserved-name', '与随包技能重名被拒')

    mkdirSync(join(root, 'skills', '.hidden'), { recursive: true })
    writeFileSync(join(root, 'skills', '.hidden', 'SKILL.md'), 'x')
    ok(!(await main.userSkillPaths(root)).some((p) => p.includes('.hidden')), '点开头的目录不当作技能')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
