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

    const now = Date.UTC(2026, 9, 21)
    const calendar = { capability: 'calendar', action: 'update event', resource: 'work', device: 'd1', scene: 'local' }
    const allowed = { key: consent.consentKeyOf(calendar), parts: calendar, records: Array.from({ length: 6 }, (_, i) => ({ decision: 'allow', at: now - i * 3_600_000 })) }
    assert.equal(consent.consentVerdict(undefined, calendar, now).mode, 'ask')
    assert.equal(consent.consentVerdict(allowed, calendar, now).mode, 'auto', 'declared non-category operations auto-allow after repeated consent')
    const mail = { ...calendar, capability: 'mail', action: 'send' }
    const mailAllowed = { ...allowed, key: consent.consentKeyOf(mail), parts: mail }
    assert.equal(consent.consentVerdict(mailAllowed, mail, now).mode, 'ask', 'danger categories always ask')
    assert.equal(consent.consentVerdict({ ...allowed, override: 'always-ask' }, calendar, now).mode, 'ask')

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
