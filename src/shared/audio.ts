/**
 * 语音与内容形式（audio）的**契约层 + 纯逻辑**（实施-25 P20）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 解决什么
 * ══════════════════════════════════════════════════════════════════
 * 「先转写与朗读」（P20）：把一段录音变成可读的文本、把一段文本读出来。
 *
 * ── 三条边界（比功能更重要）──
 *  ① **不自建语音识别 / 朗读**。砚里没有 ASR、也没有 TTS —— 那要模型与音频服务，
 *     本片只做「该走哪条路、结果怎么归位」：识别与合成走外部能力（P17 的
 *     能力缺口路径：`capabilities search → prepare → acquire`）。
 *  ② **音频属于同一课程**。转写出来的文本是**同一门课**的新来源
 *     （`owner: {kind:'course', id}`），**不新建课程、也不建第二份学习记录** ——
 *     否则「学一份录音」会变成两门课、两套进度。
 *  ③ **不猜音频内容**。宿主拿不到音频就不编一句「大意是……」；
 *     没接入能力时如实说「现在做不了，可以这样接」。
 *
 * 它不碰 electron / pi / 文件系统，主进程与单测共用同一份规则。
 */

export const AUDIO_TASKS = ['transcribe', 'read-aloud'] as const
export type AudioTask = (typeof AUDIO_TASKS)[number]

export const AUDIO_TASK_LABELS: Record<AudioTask, string> = {
  transcribe: '把录音转成文字',
  'read-aloud': '把文字读出来'
}

/** 转写文本的上限（与资料库的文本来源同一量级）。 */
export const MAX_TRANSCRIPT_CHARS = 200_000

export interface AudioPlanInput {
  /** 归属课程（转写要落到它名下；朗读可以没有）。 */
  courseId?: string
  /** 音频来源（已在资料库里的那一份）。 */
  sourceId?: string
  version?: number
}

export interface AudioPlan {
  task: AudioTask
  /** 这件事要做什么。 */
  what: string
  /** 依赖哪种外部能力（给 P17 的缺口路径用）。 */
  capabilityNeed: string
  /** 结果怎么归位。 */
  where: string
  /** 宿主不做的那部分（说清楚，免得用户以为砚能直接识别）。 */
  boundary: string
  /** 可直接发给模型 / 填进输入框的一段说明。 */
  text: string
}

/** 固定文案：宿主不自建识别与朗读。 */
export const AUDIO_BOUNDARY_NOTE =
  '砚不自带语音识别与朗读：转写与合成要接外部能力（技能包或 MCP 服务），宿主只负责把结果归到同一门课里。'

/** 固定文案：音频与转写属于同一课程。 */
export const AUDIO_SAME_COURSE_NOTE =
  '音频与它的转写都属于同一门课：转写会登记成这门课的新来源，不会新建课程，也不会多出一份学习记录。'

export function audioBoundaryText(): string {
  return AUDIO_BOUNDARY_NOTE
}

export function audioSameCourseNote(): string {
  return AUDIO_SAME_COURSE_NOTE
}

/**
 * 一份「该怎么做」的计划。
 *
 * 刻意只给路径与归位规则，**不代替执行** —— 与 P14 / P16 / P17 同一套思路。
 */
export function audioPlan(task: AudioTask, input: AudioPlanInput = {}): AudioPlan {
  const target = input.courseId ? `课程 ${input.courseId}` : '（没有指定课程：先选一门课）'
  if (task === 'transcribe') {
    return {
      task,
      what: '把一段录音转成文字',
      capabilityNeed: '音频转写能力（转写 / speech-to-text）',
      where: `转写文本登记为**同一课程**的新来源（${target}），不新建课程`,
      boundary: AUDIO_BOUNDARY_NOTE,
      text: [
        '这件事要先把录音转成文字，再把它归到同一门课里：',
        '1. 先找有没有现成的转写能力：yan capabilities search --query-text "把录音转成文字"',
        '2. 有候选就先准备再接入：yan capabilities prepare --candidate <候选ID> → yan capabilities acquire --candidate <候选ID>（装东西会动你本机，要不要装由你定）',
        '3. 本地没有就联网找一次：yan capabilities discover --query-text "把录音转成文字"',
        '4. 拿到转写文本之后，把它登记到同一门课（用「登记到这门课」按钮，或 yan audio transcript）',
        '',
        AUDIO_SAME_COURSE_NOTE,
        AUDIO_BOUNDARY_NOTE
      ].join('\n')
    }
  }
  return {
    task,
    what: '把一段文字读出来（朗读）',
    capabilityNeed: '语音合成能力（TTS / 朗读）',
    where: '只产生一段音频给听：朗读结果不入库、不改变课程与学习记录',
    boundary: AUDIO_BOUNDARY_NOTE,
    text: [
      '这件事要把文字读出来：',
      '1. 先找有没有现成的朗读能力：yan capabilities search --query-text "把文字读出来"',
      '2. 有候选就先准备再接入：yan capabilities prepare --candidate <候选ID> → yan capabilities acquire --candidate <候选ID>（要不要装由你定）',
      '3. 本地没有就联网找一次：yan capabilities discover --query-text "朗读 / TTS"',
      '',
      '朗读只产生音频，不会改动课程与学习记录。',
      AUDIO_BOUNDARY_NOTE
    ].join('\n')
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 转写文本的登记（同一课程）
 * ══════════════════════════════════════════════════════════════════ */

export type TranscriptError = 'empty' | 'too-long' | 'missing-course' | 'missing-source'

export function validateTranscript(
  text: unknown
): { ok: true; text: string } | { ok: false; code: TranscriptError; reason: string } {
  const value = typeof text === 'string' ? text.trim() : ''
  if (!value) return { ok: false, code: 'empty', reason: '转写文本是空的' }
  if ([...value].length > MAX_TRANSCRIPT_CHARS) {
    return { ok: false, code: 'too-long', reason: `转写文本超过 ${MAX_TRANSCRIPT_CHARS} 字符` }
  }
  return { ok: true, text: value }
}

export interface TranscriptImport {
  kind: 'text'
  ref: string
  identity: string
  title: string
  content: string
  owner: { kind: 'course'; id: string }
}

/**
 * 转写文本 → **同一课程**的资料库来源输入。
 *
 * `identity` 用 `transcript:<sourceId>@<version>`：同一段音频再转一次会落到
 * **同一份来源的新版本**（而不是冒出一份「新资料」）—— 与 P06b-4 用成果 id
 * 当身份同一条理由。
 */
export function transcriptImportInput(input: {
  courseId: string
  sourceId: string
  version: number
  title?: string
  text: string
}): { ok: true; value: TranscriptImport } | { ok: false; code: TranscriptError; reason: string } {
  const courseId = String(input.courseId ?? '').trim()
  if (!courseId) return { ok: false, code: 'missing-course', reason: '要先知道这段录音属于哪门课' }
  const sourceId = String(input.sourceId ?? '').trim()
  if (!sourceId) return { ok: false, code: 'missing-source', reason: '缺少音频来源 id' }
  const checked = validateTranscript(input.text)
  if (!checked.ok) return checked
  const version = Number.isInteger(input.version) && input.version >= 1 ? input.version : 1
  const identity = `transcript:${sourceId}@${version}`
  const title = input.title?.trim() || `转写：${sourceId}`
  return {
    ok: true,
    value: {
      kind: 'text',
      ref: identity,
      identity,
      title,
      content: checked.text,
      /* 归属**同一课程**：这是「不建第二份学习记录」的落点 */
      owner: { kind: 'course', id: courseId }
    }
  }
}

/**
 * 登记之后课程该怎么走（给界面与模型看的一句话）。
 *
 * 刻意**不说**「已加入路线」：新增来源不等于自动加单元 ——
 * 那是课程自己的动作，别在这里替它承诺。
 */
export function transcriptRegisteredText(sourceId: string, version: number): string {
  return `转写已登记为同一门课的新来源（${sourceId} v${version}）。课程与学习进度没有变；要不要把它加成一个单元由你自己定。`
}
