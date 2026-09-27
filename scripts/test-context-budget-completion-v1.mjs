import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runContextBudgetCompletionV1Tests(ok, completion, observer) {
  const root = await mkdtemp(join(tmpdir(), 'yan-context-budget-completion-v1-'))
  const previousDataDir = process.env.YAN_DATA_DIR
  process.env.YAN_DATA_DIR = root
  const sessionId = 'session-completion-v1'
  const sessionDir = join(root, 'context-budget-v1', sessionId)
  await mkdir(sessionDir, { recursive: true })
  const policyPath = join(sessionDir, 'policy.json')
  const policy = {
    version: 1,
    sessionId,
    activePhaseId: 'main',
    revision: 'completion-test-revision',
    updatedAt: 1,
    phases: {
      main: {
        phaseId: 'main', mode: 'auto', selectedBudget: 200_000, autoMaxBudget: 700_000,
        materials: []
      }
    }
  }
  const writes = []
  const pi = {
    appendEntry(type, value) { writes.push({ type, value }) }
  }
  const ctx = { sessionManager: { getSessionId: () => sessionId } }
  const model = {
    provider: 'test-provider', api: 'openai-completions', id: 'test-model',
    baseUrl: 'http://127.0.0.1:1234/v1', contextWindow: 1_000_000, maxTokens: 64_000
  }
  const completions = []
  const registry = {
    async complete(_model, payload, options) {
      completions.push({ payload, options })
      return { stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] }
    }
  }

  try {
    await writeFile(policyPath, JSON.stringify(policy), 'utf8')
    await completion.completeWithContextBudgetV1({
      pi, ctx, requestKind: 'state', registry, model,
      payload: { systemPrompt: 'State summary', messages: [{ role: 'user', content: [{ type: 'text', text: 'small input' }] }] },
      options: { maxTokens: 2_000 }
    })
    ok(completions.length === 1, 'V1 状态生成在硬容量内仍沿用 pi registry.complete')

    const compactPi = { handlers: {}, on(event, handler) { this.handlers[event] = handler }, appendEntry(type, value) { writes.push({ type, value }) } }
    observer.default(compactPi)
    const blockedCompact = compactPi.handlers.session_before_compact({ reason: 'overflow' }, ctx)
    ok(blockedCompact?.cancel === true, 'V1 会话取消未经预算维护器接管的 pi 原生压缩')
    ok(writes.some((entry) => entry.value?.code === 'context_maintenance_required'), '原生压缩取消记录可诊断原因且不含会话正文')
    const beforeHardBlock = completions.length
    let blockedCode = ''
    try {
      await completion.completeWithContextBudgetV1({
        pi, ctx, requestKind: 'deep', registry, model: { ...model, contextWindow: 80_000 },
        payload: { systemPrompt: 'Deep summary', messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(320_000) }] }] },
        options: { maxTokens: 8_000 }
      })
    } catch (error) {
      blockedCode = error?.code ?? ''
    }
    ok(blockedCode === 'context_capacity_blocked' && completions.length === beforeHardBlock, '深度辅助调用超过硬容量时在 registry.complete 前被拦')

    let identityCode = ''
    try {
      await completion.completeWithContextBudgetV1({ pi, ctx: {}, requestKind: 'state', registry, model, payload: {}, options: { maxTokens: 1000 } })
    } catch (error) {
      identityCode = error?.code ?? ''
    }
    ok(identityCode === 'context_budget_unavailable' && completions.length === beforeHardBlock, '辅助调用无法核实会话身份时不旁路预算检查')

    let missingOutputCode = ''
    try {
      await completion.completeWithContextBudgetV1({
        pi, ctx, requestKind: 'handoff', registry, model,
        payload: { messages: [{ role: 'user', content: [{ type: 'text', text: 'no known output reserve' }] }] },
        options: {}
      })
    } catch (error) {
      missingOutputCode = error?.code ?? ''
    }
    ok(missingOutputCode === 'context_budget_unavailable' && completions.length === beforeHardBlock, '辅助调用缺少实际 R 时 fail closed')

    const legacyCtx = { sessionManager: { getSessionId: () => 'legacy-session' } }
    const beforeLegacy = completions.length
    await completion.completeWithContextBudgetV1({
      pi, ctx: legacyCtx, requestKind: 'state', registry, model: {},
      payload: {}, options: {}
    })
    ok(completions.length === beforeLegacy + 1, '没有 V1 策略文件的旧会话保留 legacy 辅助生成路径')

    await writeFile(policyPath, '{broken policy', 'utf8')
    let corruptCode = ''
    try {
      await completion.completeWithContextBudgetV1({ pi, ctx, requestKind: 'summary', registry, model, payload: {}, options: { maxTokens: 1000 } })
    } catch (error) {
      corruptCode = error?.code ?? ''
    }
    ok(corruptCode === 'context_budget_unavailable' && (await readFile(policyPath, 'utf8')) === '{broken policy', 'V1 策略损坏时阻止内部生成并保留原文件')

    const legacyCompact = compactPi.handlers.session_before_compact({ reason: 'manual' }, legacyCtx)
    ok(legacyCompact === undefined, 'legacy 会话仍沿用原生压缩行为')
    ok(compactPi.handlers.session_before_compact({ reason: 'manual' }, {})?.cancel === true, '原生压缩身份缺失时 fail closed')
  } finally {
    if (previousDataDir === undefined) delete process.env.YAN_DATA_DIR
    else process.env.YAN_DATA_DIR = previousDataDir
    await rm(root, { recursive: true, force: true })
  }
}
