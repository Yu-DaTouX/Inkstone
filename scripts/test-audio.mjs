/**
 * 语音与内容形式（实施-25 P20）—— 计划 / 转写登记 / 边界文案。
 *
 * 四条最值得钉住的：
 *   · **不自建识别与朗读**：计划里给的是外部能力路径，不是「砚来识别」；
 *   · **音频属于同一课程**：转写登记成同一门课的新来源，`owner` 指课程；
 *   · **同一段音频再转一次落到同一份来源的新版本**（`identity` 带 sourceId@version）；
 *   · **不承诺加了单元**：登记只说「来源多了」，课程与进度不变。
 */

export function runAudioTests(ok, mod) {
  const {
    AUDIO_TASKS,
    AUDIO_TASK_LABELS,
    AUDIO_BOUNDARY_NOTE,
    AUDIO_SAME_COURSE_NOTE,
    audioPlan,
    audioBoundaryText,
    audioSameCourseNote,
    validateTranscript,
    transcriptImportInput,
    transcriptRegisteredText,
    MAX_TRANSCRIPT_CHARS
  } = mod

  /* ---- 计划 ---- */
  {
    const transcribe = audioPlan('transcribe', { courseId: 'co1', sourceId: 'lib_a', version: 2 })
    ok(transcribe.task === 'transcribe' && transcribe.what.includes('录音'), '转写计划说明做什么')
    ok(/capabilities search/.test(transcribe.text) && /capabilities prepare/.test(transcribe.text) && /capabilities acquire/.test(transcribe.text), '给的是外部能力的接入路径')
    ok(/capabilities discover/.test(transcribe.text), '本地没有时给出去联网找')
    ok(!/我来转写|自动识别这段|砚会识别/.test(transcribe.text), '没有「砚自己识别」这种承诺', transcribe.text.slice(0, 40))
    ok(transcribe.text.includes(AUDIO_SAME_COURSE_NOTE), '计划里带上「同一课程」那句')
    ok(transcribe.where.includes('co1'), '归位说明里带上课程 id')
    ok(/不新建课程/.test(transcribe.where), '明确不新建课程')

    const nothing = audioPlan('transcribe')
    ok(/没有指定课程/.test(nothing.where), '没给课程时如实说「先选一门课」')

    const read = audioPlan('read-aloud', { courseId: 'co1' })
    ok(read.task === 'read-aloud' && /TTS|朗读/.test(read.capabilityNeed), '朗读计划指向 TTS 能力')
    ok(/不入库/.test(read.where), '朗读结果不入库')
    ok(/不会改动课程与学习记录/.test(read.text), '朗读不改变课程与学习记录')

    ok(AUDIO_TASKS.length === 2 && Object.keys(AUDIO_TASK_LABELS).length === 2, '两个任务都有标签')
    ok(/不自带语音识别与朗读/.test(audioBoundaryText()), '边界文案写明不自带识别与朗读')
    ok(/同一门课/.test(audioSameCourseNote()), '同一课程文案只有一个出口')
  }

  /* ---- 转写文本校验 ---- */
  {
    ok(validateTranscript('  你好  ').text === '你好', '转写文本去首尾空白')
    const empty = validateTranscript('   ')
    ok(!empty.ok && empty.code === 'empty', '空转写：拒掉')
    ok(!validateTranscript(undefined).ok, '不是字符串：拒掉')
    const long = validateTranscript('x'.repeat(MAX_TRANSCRIPT_CHARS + 1))
    ok(!long.ok && long.code === 'too-long', '超长转写：如实报错', long.reason)
    ok(validateTranscript('x'.repeat(MAX_TRANSCRIPT_CHARS)).ok, '刚好到上限：可以')
  }

  /* ---- 登记输入（同一课程） ---- */
  {
    const input = transcriptImportInput({ courseId: 'co1', sourceId: 'lib_a', version: 3, text: '这是转写。' })
    ok(input.ok, '合法输入能过')
    ok(input.value.kind === 'text', '登记成文本来源')
    ok(input.value.owner.kind === 'course' && input.value.owner.id === 'co1', '归属**同一课程**（不建新课程）')
    ok(input.value.identity === 'transcript:lib_a@3', '身份带音频来源与版本（同一段再转落到同一份的新版本）', input.value.identity)
    ok(input.value.ref === input.value.identity, 'ref 与 identity 一致（便于按 identity 查版本）')
    ok(/转写/.test(input.value.title), '默认标题能看出是转写')

    const custom = transcriptImportInput({ courseId: 'co1', sourceId: 'lib_a', version: 1, title: '第三讲的录音', text: 'x' })
    ok(custom.value.title === '第三讲的录音', '可以自定义标题')

    const badVersion = transcriptImportInput({ courseId: 'co1', sourceId: 'lib_a', version: 0, text: 'x' })
    ok(badVersion.ok && badVersion.value.identity === 'transcript:lib_a@1', '版本非法时回退到 1（不编一个版本号）')

    const noCourse = transcriptImportInput({ courseId: '', sourceId: 'lib_a', version: 1, text: 'x' })
    ok(!noCourse.ok && noCourse.code === 'missing-course', '没课程：拒掉（不知道归到哪）')
    const noSource = transcriptImportInput({ courseId: 'co1', sourceId: '', version: 1, text: 'x' })
    ok(!noSource.ok && noSource.code === 'missing-source', '没音频来源：拒掉')
    const emptyText = transcriptImportInput({ courseId: 'co1', sourceId: 'lib_a', version: 1, text: ' ' })
    ok(!emptyText.ok && emptyText.code === 'empty', '空文本：拒掉（不登记一份空来源）')
  }

  /* ---- 登记之后的说明 ---- */
  {
    const text = transcriptRegisteredText('lib_t1', 2)
    ok(/同一门课/.test(text), '说明登记到同一门课')
    ok(/课程与学习进度没有变/.test(text), '说明课程与进度没变')
    ok(/要不要把它加成一个单元由你自己定/.test(text), '**不承诺**已加单元（那是课程自己的动作）')
    ok(!/已加入路线|自动加入/.test(text), '没有「已加入路线」这种承诺', text)
    ok(AUDIO_BOUNDARY_NOTE.includes('技能包') && AUDIO_BOUNDARY_NOTE.includes('MCP'), '边界文案说清走哪类外部能力')
  }
}
