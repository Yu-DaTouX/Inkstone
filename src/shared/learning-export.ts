/**
 * 学习数据导出：把课程、学习位置、练习与作答、笔记、概念观察和复习项
 * 整理成可以直接阅读的 Markdown。
 *
 * 读法刻意宽松：输入是四个落盘文件的**原始 JSON**，不依赖各 store 的
 * 校验与类型 —— 学习功能收缩成技能之后，旧数据仍要能读出来。缺字段就跳过
 * 那一项，不因为一条坏数据放弃整份导出。
 *
 * 它不碰 electron / 文件系统，主进程与单测共用同一份规则。
 */

export interface LearningRawData {
  courses?: unknown
  studySessions?: unknown
  exercises?: unknown
  learningMemory?: unknown
}

export interface LearningExportFile {
  /** 相对导出目录的文件名 */
  name: string
  content: string
}

type Obj = Record<string, unknown>

function obj(value: unknown): Obj | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : undefined
}

function arr(value: unknown): Obj[] {
  return Array.isArray(value) ? value.map(obj).filter((v): v is Obj => !!v) : []
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function time(value: unknown): string {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ''
  return new Date(n).toISOString().replace('T', ' ').slice(0, 16)
}

/** 多行文本放进引用块，保持原样可读。 */
function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

function answerText(answer: unknown): string {
  if (answer === undefined || answer === null) return ''
  if (typeof answer === 'string') return answer
  try {
    return JSON.stringify(answer)
  } catch {
    return ''
  }
}

const LEVEL_LABELS: Record<string, string> = {
  unseen: '还没有观察',
  'with-hint': '看提示后完成',
  independent: '独立完成',
  transfer: '能迁移到新情境'
}

function sourceLine(ref: unknown): string {
  const r = obj(ref)
  if (!r) return ''
  const id = str(r.sourceId)
  if (!id) return ''
  const version = Number.isFinite(Number(r.version)) ? ` v${Number(r.version)}` : ''
  return `${id}${version}`
}

export const UNASSIGNED_COURSE_ID = '__unassigned__'

/**
 * 按课程整理成若干 Markdown 文件，另加一份索引 `README.md`。
 * 不属于任何现存课程的笔记、练习等归到「未归属课程」。
 */
export function buildLearningExport(raw: LearningRawData, exportedAt: number): LearningExportFile[] {
  const courses = arr(obj(raw.courses)?.courses)
  const sessions = arr(obj(raw.studySessions)?.sessions)
  const exerciseDoc = obj(raw.exercises)
  const exercises = arr(exerciseDoc?.exercises)
  const attempts = arr(exerciseDoc?.attempts)
  const memory = obj(raw.learningMemory)
  const notes = arr(memory?.notes)
  const progress = arr(memory?.progress)
  const reviews = arr(memory?.reviews)

  const knownIds = new Set(courses.map((c) => str(c.id)).filter(Boolean))
  const courseOf = (item: Obj): string => {
    const id = str(item.courseId)
    return id && knownIds.has(id) ? id : UNASSIGNED_COURSE_ID
  }
  const byCourse = <T extends Obj>(list: T[], id: string): T[] => list.filter((item) => courseOf(item) === id)

  const groups: { id: string; course?: Obj }[] = courses
    .filter((c) => str(c.id))
    .map((course) => ({ id: str(course.id), course }))
  const hasOrphans = [sessions, exercises, attempts, notes, progress, reviews].some((list) =>
    list.some((item) => courseOf(item) === UNASSIGNED_COURSE_ID)
  )
  if (hasOrphans) groups.push({ id: UNASSIGNED_COURSE_ID })

  const files: LearningExportFile[] = []
  const index: string[] = [
    '# 学习记录导出',
    '',
    `导出时间：${time(exportedAt)}（UTC）。这是只读副本，每次启动砚时重新生成；原始数据仍在数据目录的 courses.json、study-sessions.json、exercises.json、learning-memory.json。`,
    '',
    '完整原始数据见同目录的 `learning-data.json`。',
    ''
  ]
  if (groups.length === 0) index.push('（没有学习记录。）')

  for (const group of groups) {
    const course = group.course
    const title = course ? str(course.title) || '未命名课程' : '未归属课程'
    const fileName = group.id === UNASSIGNED_COURSE_ID ? 'unassigned.md' : `course-${group.id.replace(/[^A-Za-z0-9_-]/g, '_')}.md`
    const lines: string[] = [`# ${title}`, '']

    const units = arr(course?.units)
    const unitTitle = new Map(units.map((u) => [str(u.id), str(u.title)]))
    const concepts = arr(course?.concepts)
    const conceptName = new Map(concepts.map((c) => [str(c.id), str(c.name)]))

    if (course) {
      const goal = str(course.goal)
      if (goal) lines.push(`- 目标：${goal}`)
      const status = str(course.status)
      if (status) lines.push(`- 状态：${status}`)
      const created = time(course.createdAt)
      if (created) lines.push(`- 创建：${created}`)
      lines.push('')
      if (units.length) {
        lines.push('## 路线', '')
        units.forEach((unit, i) => {
          const target = str(unit.target)
          const sources = arr(unit.sources).map(sourceLine).filter(Boolean)
          lines.push(`${i + 1}. ${str(unit.title) || '未命名单元'}${target ? `：${target}` : ''}${sources.length ? `（资料：${sources.join('、')}）` : ''}`)
        })
        lines.push('')
      }
    }

    const courseSessions = byCourse(sessions, group.id)
    if (courseSessions.length) {
      lines.push('## 学到哪里', '')
      for (const s of courseSessions) {
        const unit = unitTitle.get(str(s.unitId)) || str(s.unitId)
        const pending = obj(s.pending)
        lines.push(`- ${unit || '（单元未知）'}：阶段 ${str(s.phase) || '未知'}${s.paused === true ? '，已暂停' : ''}（更新于 ${time(s.updatedAt)}）`)
        if (pending && str(pending.question)) lines.push(`  - 等待作答的问题：${str(pending.question)}`)
        const last = obj(s.lastAnswer)
        if (last && str(last.text)) lines.push(`  - 最近一次回答：${str(last.text)}`)
        if (str(s.nextStep)) lines.push(`  - 下一步：${str(s.nextStep)}`)
      }
      lines.push('')
    }

    const courseProgress = byCourse(progress, group.id)
    if (courseProgress.length) {
      lines.push('## 概念观察', '')
      for (const p of courseProgress) {
        const name = conceptName.get(str(p.conceptId)) || str(p.conceptId)
        const level = LEVEL_LABELS[str(p.level)] ?? str(p.level)
        const evidence = arr(p.evidence).length
        const self = obj(p.selfAssessment)
        lines.push(
          `- ${name}：${level}${p.review === true ? '，需要复习' : ''}（依据 ${evidence} 次作答）${self ? `；自评：${str(self.kind)}${str(self.text) ? ` ${str(self.text)}` : ''}` : ''}`
        )
      }
      lines.push('')
    }

    const courseNotes = byCourse(notes, group.id)
    if (courseNotes.length) {
      lines.push('## 笔记', '')
      for (const note of courseNotes) {
        const heading = str(note.title) || (str(note.kind) === 'summary' ? '小结' : '笔记')
        const unit = unitTitle.get(str(note.unitId))
        lines.push(`### ${heading}`, '')
        lines.push(`${unit ? `单元：${unit} · ` : ''}更新于 ${time(note.updatedAt)}`, '')
        const body = str(note.body)
        if (body) lines.push(body, '')
      }
    }

    const courseExercises = byCourse(exercises, group.id)
    const exerciseIds = new Set(courseExercises.map((e) => str(e.id)))
    const courseAttempts = attempts.filter((a) => exerciseIds.has(str(a.exerciseId)) || courseOf(a) === group.id)
    if (courseExercises.length || courseAttempts.length) {
      lines.push('## 练习与作答', '')
      for (const ex of courseExercises) {
        const unit = unitTitle.get(str(ex.unitId))
        lines.push(`### ${str(ex.kind) || '练习'}${unit ? ` · ${unit}` : ''}`, '')
        const prompt = str(ex.prompt)
        if (prompt) lines.push(quote(prompt), '')
        const options = arr(ex.options)
        if (options.length) {
          for (const opt of options) lines.push(`- ${str(opt.id)}. ${str(opt.text)}`)
          lines.push('')
        }
        const answer = answerText(ex.answer)
        if (answer && answer !== '{}') lines.push(`参考答案：${answer}`, '')
        const solution = str(ex.solution)
        if (solution) lines.push('解释：', '', quote(solution), '')
        const mine = courseAttempts.filter((a) => str(a.exerciseId) === str(ex.id))
        if (mine.length) {
          lines.push('作答记录：', '')
          for (const a of mine) {
            const verdict = a.correct === true ? '对' : a.correct === false ? '错' : '未判分'
            const help = [
              str(a.hintLevelSeen) && str(a.hintLevelSeen) !== 'none' ? `看过提示：${str(a.hintLevelSeen)}` : '',
              a.lookedAtSolution === true ? '看过解释' : ''
            ]
              .filter(Boolean)
              .join('，')
            lines.push(`- ${time(a.at)}：${str(a.raw) || '（空）'} —— ${verdict}${help ? `（${help}）` : ''}`)
            const correction = obj(a.correction)
            if (correction && str(correction.text)) lines.push(`  - 更正：${str(correction.text)}`)
          }
          lines.push('')
        }
      }
      const loose = courseAttempts.filter((a) => !exerciseIds.has(str(a.exerciseId)))
      if (loose.length) {
        lines.push('### 找不到题目的作答', '')
        for (const a of loose) lines.push(`- ${time(a.at)}：${str(a.raw) || '（空）'}（题目 ${str(a.exerciseId) || '未知'}）`)
        lines.push('')
      }
    }

    const courseReviews = byCourse(reviews, group.id)
    if (courseReviews.length) {
      lines.push('## 复习项', '')
      for (const r of courseReviews) {
        lines.push(`- ${str(r.prompt) || '（无内容）'}（到期 ${time(r.dueAt)}，原因 ${str(r.reason) || '未知'}）`)
      }
      lines.push('')
    }

    files.push({ name: fileName, content: lines.join('\n').trimEnd() + '\n' })
    index.push(`- [${title}](${fileName})`)
  }

  files.unshift({ name: 'README.md', content: index.join('\n').trimEnd() + '\n' })
  files.push({
    name: 'learning-data.json',
    content: JSON.stringify(
      {
        version: 1,
        exportedAt,
        courses: raw.courses ?? null,
        studySessions: raw.studySessions ?? null,
        exercises: raw.exercises ?? null,
        learningMemory: raw.learningMemory ?? null
      },
      null,
      2
    )
  })
  return files
}
