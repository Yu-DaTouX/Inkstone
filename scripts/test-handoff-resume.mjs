/**
 * 交接续接消息与消费证据（实施-05 S5b-3b）。
 *
 * 这一层只有两件事，但两件都必须准：
 *   · 正文里那个标记是**唯一**能让「发过了」在磁盘上可判的东西 ——
 *     标记写法与检测规则必须同源，否则重启后每次都重发一遍；
 *   · 没有包时**不静默造一份空包**（§8「失败降级，不静默裁掉」）——
 *     正文如实说明，模型会自己重新确认。
 *
 * 用法：npm run test:unit
 */
export async function runHandoffResumeTests(ok, resume, handoffShared) {
  console.log('\n--- 实施-05 S5b-3b 交接续接消息（正文 / 消费证据） ---')

  const pkg = handoffShared.sanitizeHandoffPackage(
    {
      goal: '把导入做快',
      deliverable: '一个可用的导入',
      constraints: ['不许改数据库结构'],
      acceptance: ['点一下能下载'],
      done: ['批量接口已合并'],
      remaining: ['还没有进度条'],
      nextActions: ['加进度'],
      blockers: [],
      files: ['src/import.ts'],
      notes: ['长任务还在跑']
    },
    { sourceSession: 'C:/s/a.jsonl', sourceHead: 'm-9', mode: 'autonomous', model: 'x', now: 5 }
  )
  ok(!!pkg, '夹具：交接包可构造')

  /* --------------------------------------------------- 标记 */

  ok(resume.resumeMarker('rs-1') === '[yan-handoff-resume:rs-1]', '标记是带前缀的独占一行形态')
  ok(resume.resumeMarker('  rs-2  ') === '[yan-handoff-resume:rs-2]', '标记两端空白被清掉')
  ok(!resume.containsResumeEvidence('随便一段文字', 'rs-1'), '没有标记 → 没有证据')
  ok(resume.containsResumeEvidence(`前\n${resume.resumeMarker('rs-1')}\n后`, 'rs-1'), '标记出现 → 是证据')
  ok(!resume.containsResumeEvidence(`前\n${resume.resumeMarker('rs-2')}\n后`, 'rs-1'), '别的 id 不算证据')
  ok(!resume.containsResumeEvidence('', 'rs-1') && !resume.containsResumeEvidence(null, 'rs-1'), '空内容 / 非字符串 → 没证据')
  ok(!resume.containsResumeEvidence('[yan-handoff-resume:]', ''), '空 id 永远不算证据（否则任何文件都“有证据”）')

  /* --------------------------------------------------- 正文 */

  const text = resume.buildResumeText(pkg, 'rs-9')
  ok(text.includes(resume.resumeMarker('rs-9')), '正文里带上了标记行')
  ok(resume.containsResumeEvidence(text, 'rs-9'), '自己的正文自己认（正文 / 检测同源）')
  for (const part of ['把导入做快', '一个可用的导入', '不许改数据库结构', '点一下能下载', '批量接口已合并', '还没有进度条', '加进度', 'src/import.ts', '长任务还在跑']) {
    ok(text.includes(part), `正文带上了内容栏：${part}`)
  }
  ok(!/sourceSession|generatedAt|generator/.test(text), '正文不带宿主元数据（对模型没意义、只占 token）')
  ok(/yan goal report/.test(text), '正文要求接手后重新登记这一段的进展（交接包里的进度不算新证据）')
  ok(!/从 rev0 开始/.test(text), 'F4：不再告诉模型「目标全新从 rev0 开始」（宿主已经把目标带过来了）')
  ok(text.length < 4000, `正文有界（${text.length} 字符）—— 交接不把历史灌进来`)

  const noPkg = resume.buildResumeText(null, 'rs-10')
  ok(noPkg.includes(resume.resumeMarker('rs-10')), '没有包也带标记（否则这次交接永远确认不了）')
  ok(/没有留下交接包/.test(noPkg), '没有包时如实说明，不静默造一份空包')

  /* --------------------------------------------------- 消息侧判据 */

  const users = [
    { role: 'assistant', text: `我复述一下 ${resume.resumeMarker('rs-11')}` },
    { role: 'user', text: '别的话' }
  ]
  ok(!resume.hasResumeEvidence(users, 'rs-11'), '助手复述不算证据（只有 user / custom 消息才真的发出去了）')
  users.push({ role: 'user', content: text.replace('rs-9', 'rs-11') })
  ok(resume.hasResumeEvidence(users, 'rs-11'), 'user 消息带标记 → 有证据（content 形态也认）')

  /* 实施-14 F4：交接 resume 以后的形态是 custom 控制消息（旧 user 只读识别） */
  const customs = [{ role: 'custom', text: `控制消息 ${resume.resumeMarker('rs-12')}` }]
  ok(resume.hasResumeEvidence(customs, 'rs-12') === true, 'F4：custom 控制消息带标记 → 也算证据')
  ok(
    resume.hasResumeEvidence([{ role: 'tool', text: resume.resumeMarker('rs-13') }], 'rs-13') === false,
    'F4：工具结果复述不算证据'
  )

  ok(resume.resumePreview('  一行\n  很长   的话  ', 6) === '一行 很长 …', '预览压平空白并截断')
  ok(resume.resumePreview('短') === '短', '预览短文本原样返回')
}
