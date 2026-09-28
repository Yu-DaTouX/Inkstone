/**
 * 学习数据导出：从四个原始 JSON 生成可读 Markdown 与完整副本。
 * 重点是「读法宽松、坏数据不拖垮整份导出」与「原始文件不动」。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export async function runLearningExportTests(ok, shared, main, fs) {
  const { buildLearningExport } = shared
  const raw = {
    courses: {
      version: 1,
      courses: [
        {
          id: 'co_1',
          title: '英语精读',
          goal: '读懂 Unit 3',
          units: [{ id: 'u1', title: '第一讲', sources: [{ sourceId: 'lib_1', version: 2 }] }],
          concepts: [{ id: 'c1', name: '比喻' }]
        },
        { title: '没有 id 的课程' }
      ]
    },
    exercises: {
      version: 1,
      exercises: [{ id: 'ex1', courseId: 'co_1', unitId: 'u1', kind: 'choice', prompt: '哪一个是比喻？', answer: { optionId: 'a' } }],
      attempts: [
        { id: 'at1', exerciseId: 'ex1', courseId: 'co_1', raw: 'a', correct: true, hintLevelSeen: 'direction', at: 1 },
        { id: 'at2', exerciseId: 'gone', courseId: 'co_x', raw: 'b', correct: null, at: 2 }
      ]
    },
    learningMemory: {
      version: 1,
      notes: [{ id: 'n1', courseId: 'co_1', title: '比喻笔记', body: 'outside room 是比喻' }, 'bad'],
      progress: [{ conceptId: 'c1', courseId: 'co_1', level: 'with-hint', review: true, evidence: [{}] }],
      reviews: []
    }
  }

  const files = buildLearningExport(raw, 1700000000000)
  const byName = new Map(files.map((f) => [f.name, f.content]))
  ok(byName.has('README.md') && byName.has('learning-data.json'), '导出含索引与完整原始副本')
  const course = byName.get('course-co_1.md') ?? ''
  ok(/# 英语精读/.test(course) && /读懂 Unit 3/.test(course), '课程文件写出标题与目标')
  ok(/1\. 第一讲（资料：lib_1 v2）/.test(course), '路线带资料引用与版本')
  ok(/比喻：看提示后完成，需要复习/.test(course), '概念观察写成可读文字')
  ok(/### 比喻笔记/.test(course) && /outside room 是比喻/.test(course), '笔记原文保留')
  ok(/a —— 对（看过提示：direction）/.test(course), '作答记录写出原始答案、判分与看过的提示')
  const orphan = byName.get('unassigned.md') ?? ''
  ok(/找不到题目的作答/.test(orphan) && /题目 gone/.test(orphan), '课程与题目都找不到的作答归到未归属')
  ok(JSON.parse(byName.get('learning-data.json')).courses.courses.length === 2, '完整副本保留原始数据（含坏条目）')
  ok(buildLearningExport({}, 0).length === 2, '没有数据时只有索引与空副本')

  const root = await fs.mkdtemp(join(tmpdir(), 'yan-learning-export-'))
  try {
    ok((await main.exportLearningData(root, 1)) === null, '没有任何学习文件时不创建导出目录')
    ok(!existsSync(join(root, 'learning-export')), '确实没有导出目录')
    const coursesFile = join(root, 'courses.json')
    writeFileSync(coursesFile, JSON.stringify(raw.courses))
    writeFileSync(join(root, 'exercises.json'), '{ 坏 JSON')
    const res = await main.exportLearningData(root, 2)
    ok(!!res && res.files.includes('course-co_1.md'), '有课程文件时导出课程 Markdown')
    ok(readFileSync(coursesFile, 'utf8') === JSON.stringify(raw.courses), '原始文件不被修改')
    const again = await main.exportLearningData(root, 3)
    ok(!!again && again.files.length === res.files.length, '重复导出整份覆盖，不留旧文件')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
