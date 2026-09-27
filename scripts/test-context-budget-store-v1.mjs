import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runContextBudgetStoreV1Tests(ok, storeModule) {
  const root = await mkdtemp(join(tmpdir(), 'yan-context-budget-store-v1-'))
  try {
    const store = new storeModule.ContextBudgetStoreV1(root)
    ok(!(await store.isConfigured('session-new')), '未配置策略的旧会话可与 V1 会话区分')
    const newSessionPolicy = await store.ensureDefault('session-new')
    ok(
      (await store.isConfigured('session-new')) && newSessionPolicy.phases.main.selectedBudget === 200_000,
      '宿主确认新会话后才持久启用 auto / 200K 默认策略'
    )
    const initial = await store.read('session-1')
    const initialPhase = initial.phases.main
    ok(initialPhase.mode === 'auto' && initialPhase.selectedBudget === 200_000, '新会话从 auto / 200K 起步')

    const fixed = await store.update('session-1', initial.revision, (current) => ({
      ...current,
      phases: {
        ...current.phases,
        main: {
          ...current.phases.main,
          mode: 'fixed',
          selectedBudget: 500_000,
          selectionSource: 'user',
          selectionReason: 'user_fixed_budget'
        }
      }
    }))
    ok(fixed.phases.main.mode === 'fixed' && fixed.phases.main.selectedBudget === 500_000, 'CAS 更新成功后持久化用户固定档')

    let staleCode = ''
    try {
      await store.update('session-1', initial.revision, (current) => current)
    } catch (error) {
      staleCode = error?.code ?? ''
    }
    ok(staleCode === 'stale_revision', '旧 revision 被拒绝，不能覆盖新策略')

    const nextPhase = await store.update('session-1', fixed.revision, (current) => ({
      ...current,
      activePhaseId: 'phase-next',
      phases: {
        ...current.phases,
        'phase-next': { ...current.phases.main, phaseId: 'phase-next', selectionReason: 'phase transition' }
      }
    }))
    const reloaded = await store.read('session-1')
    ok(
      nextPhase.activePhaseId === 'phase-next' && reloaded.phases['phase-next']?.mode === 'fixed' &&
        reloaded.phases['phase-next']?.selectedBudget === 500_000,
      '阶段切换后重载仍保留用户固定档位'
    )

    const path = join(root, 'session-1', 'policy.json')
    await writeFile(path, 'malformed-policy', 'utf8')
    let corruptCode = ''
    try {
      await store.read('session-1')
    } catch (error) {
      corruptCode = error?.code ?? ''
    }
    ok(corruptCode === 'corrupt' && (await readFile(path, 'utf8')) === 'malformed-policy', '损坏策略明确报错并原样保留，不静默重置')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
