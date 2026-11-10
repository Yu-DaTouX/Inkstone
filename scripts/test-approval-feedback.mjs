import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-approval-feedback-'))
  try {
    const approval = await compile('src/shared/approval.ts', join(dir, 'approval.mjs'))
    const consent = await compile('src/shared/tool-consent.ts', join(dir, 'tool-consent.mjs'))
    const move = await compile('src/main/session-move.ts', join(dir, 'session-move.mjs'))

    const calendar = { capability: 'calendar', action: 'update event', resource: 'work', device: 'd1', scene: 'local' }
    assert.equal(consent.consentVerdict(calendar).danger, null, 'declared operations outside danger categories carry no category')
    assert.ok(consent.consentVerdict(calendar).reason.length > 0)
    assert.equal('mode' in consent.consentVerdict(calendar), false, 'no verdict can auto-allow from past answers')
    assert.equal(consent.recordConsent, undefined, 'answers are no longer recorded for later auto-allow')
    const mail = { ...calendar, capability: 'mail', action: 'send' }
    assert.equal(consent.consentVerdict(mail).danger, '对外发送或发布', 'danger categories are labelled')

    assert.equal(approval.normalizeApprovalFeedback('  路径写错了  '), '路径写错了')
    assert.equal(approval.normalizeApprovalFeedback('   '), undefined)
    assert.equal(approval.normalizeApprovalFeedback(42), undefined)
    assert.equal(approval.normalizeApprovalFeedback('x'.repeat(700)).length, approval.APPROVAL_FEEDBACK_MAX)

    assert.equal(approval.denyFeedbackNote(undefined), '')
    assert.equal(approval.denyFeedbackNote('   '), '')
    assert.equal(
      approval.denyFeedbackNote('请不要删除 build 目录'),
      '用户拒绝了这次操作，并给出理由：请不要删除 build 目录。请按这个理由调整做法后再试'
    )

    assert.equal(approval.withDenyFeedback('用户拒绝移动，继续在当前文件夹工作。', undefined), '用户拒绝移动，继续在当前文件夹工作。')
    assert.equal(approval.withDenyFeedback('用户拒绝移动，继续在当前文件夹工作。', '  '), '用户拒绝移动，继续在当前文件夹工作。')
    assert.equal(
      approval.withDenyFeedback('用户拒绝移动，继续在当前文件夹工作。', '先看日志'),
      '用户拒绝移动，继续在当前文件夹工作。 用户拒绝了这次操作，并给出理由：先看日志。请按这个理由调整做法后再试'
    )

    assert.deepEqual(consent.consentFeedbackSummary('allow', '不该出现'), {})
    assert.deepEqual(consent.consentFeedbackSummary('deny', undefined), {})
    assert.deepEqual(consent.consentFeedbackSummary('deny', '   '), {})
    assert.deepEqual(consent.consentFeedbackSummary('deny', ' 换个模型 '), {
      feedback: '换个模型',
      message: '用户拒绝了这次操作，并给出理由：换个模型。请按这个理由调整做法后再试'
    })

    const deniedNote = approval.denyFeedbackNote('理由')
    assert.equal(deniedNote.includes('请按这个理由调整做法后再试'), true)
    assert.equal(deniedNote.endsWith('。请按这个理由调整做法后再试'), true)

    assert.equal(typeof move.movedSessionContinuationPrompt, 'function')

    console.log('approval feedback ok')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await run()
