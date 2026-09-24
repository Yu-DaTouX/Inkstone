/**
 * 接入事务（`src/shared/acquisition.ts` + `src/main/capabilities/acquisition-service.ts`，实施-04 S6a）。
 *
 * 这一片能验的是两件事：**判断**（状态机、上限、失败分类、重试复用同一事务）
 * 与**真文件**（受管 staging 里的文件与 manifest 是否一致、失败有没有只清本次、
 * 恢复复核是不是真的重算 hash 而不是读日志）。
 * S6b-2 的 npm 制品准备使用本地 registry / tarball fixture：只验证固定版本、SHA-512、
 * 归档限制与受管解包，不访问互联网、不运行第三方脚本、也不改项目 pi 配置。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'

export async function runAcquisitionTests(ok, modules) {
  const { shared, service, npmArtifact, npmAcquisition, packageAuthorizationShared, packageAuthorizationService } = modules
  const at = '2026-09-20T10:00:00.000Z'

  /* ------------------------------------------------------- 1. 状态机（§10） */

  {
    ok(shared.canTransitionAcquisition('prepared', 'acquiring'), '状态机：prepared → acquiring 合法')
    ok(shared.canTransitionAcquisition('acquiring', 'verifying'), '状态机：装完必须先验证再激活')
    ok(!shared.canTransitionAcquisition('acquiring', 'activated'), '状态机：不允许跳过 verifying 直接激活')
    ok(!shared.canTransitionAcquisition('discovered', 'acquiring'), '状态机：不能跳过 inspected / prepared')
    ok(!shared.canTransitionAcquisition('resumed', 'failed'), '状态机：resumed 是终态')
    ok(
      shared.canTransitionAcquisition('pending-boundary', 'acquiring'),
      '状态机：pending-boundary 不是终态（等的是调度，不是用户）'
    )
    ok(shared.canTransitionAcquisition('verifying', 'pending-boundary'), '状态机：staging 校验完成后可等安全安装边界')
    ok(shared.canTransitionAcquisition('needs-auth', 'prepared'), '状态机：认证补齐后可以回到主路径')
    ok(!shared.isTerminalAcquisitionState('pending-boundary'), '状态机：pending-boundary 不算终态')
    ok(shared.isTerminalAcquisitionState('cancelled'), '状态机：cancelled 是终态')
  }

  /* ------------------------------------------------ 2. 事务与重试（§10 / §10.2） */

  {
    const make = () =>
      shared.newAcquisitionTransaction({
        operationId: 'op-1',
        planId: 'plan-1',
        planRevision: 1,
        candidateId: 'npm:demo@1.0.0',
        digest: 'digest-a',
        projectId: 'proj-1',
        at
      })
    ok(make().state === 'prepared', '事务：从 prepared 起步（发现链不算安装尝试）')
    ok(make().attempts === 0, '事务：初始尝试次数为 0')

    let acrossBoundary = shared.advanceAcquisition(make(), 'acquiring', { at })
    acrossBoundary = shared.advanceAcquisition(acrossBoundary, 'verifying', { at })
    acrossBoundary = shared.advanceAcquisition(acrossBoundary, 'pending-boundary', { at })
    acrossBoundary = shared.advanceAcquisition(acrossBoundary, 'acquiring', { at })
    ok(acrossBoundary.attempts === 1, '尝试计数：pending-boundary 后恢复安装仍属于同一轮，不多扣重试额度')

    let tx = make()
    tx = shared.advanceAcquisition(tx, 'acquiring', { at, detail: 'x' })
    ok(tx.attempts === 1, '事务：进入 acquiring 才算一次安装尝试')
    tx = shared.advanceAcquisition(tx, 'failed', { at, failure: { code: 'network', detail: 'boom' } })
    ok(shared.canRetryAcquisition(tx), '重试：失败且未用满次数时可以再试')
    tx = shared.retryAcquisition(tx, at)
    ok(tx.state === 'prepared' && tx.attempts === 1, '重试：回到 prepared，尝试次数保留')
    tx = shared.advanceAcquisition(tx, 'acquiring', { at })
    ok(tx.attempts === 2, '重试：第二次进入 acquiring 计到 2')
    tx = shared.advanceAcquisition(tx, 'failed', { at, failure: { code: 'network', detail: 'again' } })
    ok(!shared.canRetryAcquisition(tx), '重试：每个事务只允许一次正常重试（上限 2 次）')
    let threw = false
    try {
      shared.retryAcquisition(tx, at)
    } catch {
      threw = true
    }
    ok(threw, '重试：用满次数后再重试必须报错，不静默放行')

    /* 重试是新一轮尝试：上一轮绑定的激活目标（runner / 会话 / 目标修订 / sourceHead）已过期，必须清掉。 */
    let boundTx = make()
    boundTx.piPackageTarget = {
      runnerId: 'runner-a',
      runnerGeneration: 3,
      cwd: 'C:\\project',
      sessionFile: 'C:\\project\\session.jsonl',
      projectId: 'proj-1',
      goalId: 'goal-1',
      goalRevision: 4,
      sourceHead: 'a'.repeat(40),
      continueId: 'op-bound',
      packageName: '@fixture/safe-skill',
      packageVersion: '1.2.3'
    }
    boundTx = shared.advanceAcquisition(boundTx, 'acquiring', { at })
    boundTx = shared.advanceAcquisition(boundTx, 'failed', { at, failure: { code: 'verification', detail: 'boom' } })
    const retriedBound = shared.retryAcquisition(boundTx, at)
    ok(retriedBound.state === 'prepared', '重试：绑定的 pi 包事务回到 prepared')
    ok(
      retriedBound.piPackageTarget === undefined && retriedBound.skillFilesTarget === undefined,
      '重试：清除上一轮的激活目标绑定（否则重新绑定会被 target-conflict 拒绝）'
    )

    let illegal = false
    try {
      shared.advanceAcquisition(make(), 'resumed', { at })
    } catch {
      illegal = true
    }
    ok(illegal, '事务：非法迁移抛错（否则日志会自相矛盾）')

    const receipt = {
      operationId: 'op-1',
      planId: 'plan-1',
      planRevision: 1,
      candidateId: 'npm:demo@1.0.0',
      digest: 'digest-a',
      scope: 'project-managed',
      projectId: 'proj-1',
      installedPaths: ['demo/SKILL.md'],
      verification: 'files-present',
      activatedAt: at
    }
    ok(
      shared.receiptMatches(receipt, { planId: 'plan-1', digest: 'digest-a' }),
      'receipt：计划与指纹都对得上才算匹配'
    )
    ok(!shared.receiptMatches(receipt, { planId: 'plan-1', digest: 'digest-b' }), 'receipt：指纹变了就不匹配')
    ok(!shared.receiptMatches(receipt, { planId: 'plan-9', digest: 'digest-a' }), 'receipt：换计划就不匹配')
  }

  /* -------------------------------------------------- 3. 归档校验（§10 第 2 条） */

  {
    const v = (entries, limits) => shared.validateArtifactEntries(entries, limits)
    ok(v([{ path: 'demo/SKILL.md', bytes: 10 }]) === null, '校验：正常相对路径通过')
    ok(shared.normalizeArtifactPath('demo\\SKILL.md') === 'demo/SKILL.md', '校验：反斜杠归一成斜杠')
    ok(v([{ path: '../escape.md', bytes: 1 }])?.code === 'path-traversal', '校验：../ 被拒')
    ok(
      v([{ path: '..\\..\\evil.md', bytes: 1 }])?.code === 'path-traversal',
      '校验：反斜杠形式的路径穿越同样被拒（只判 / 会漏）'
    )
    ok(v([{ path: '/etc/passwd', bytes: 1 }])?.code === 'absolute-path', '校验：POSIX 绝对路径被拒')
    ok(v([{ path: 'C:\\Windows\\evil.dll', bytes: 1 }])?.code === 'absolute-path', '校验：盘符绝对路径被拒')
    ok(v([{ path: 'ok.md', bytes: 1 }, { path: 'link', bytes: 1, symlink: true }])?.code === 'symlink-not-allowed', '校验：符号链接被拒')
    ok(v([{ path: 'a.md', bytes: 1 }, { path: 'a.md', bytes: 1 }])?.code === 'duplicate-path', '校验：重复路径被拒')
    ok(v([])?.code === 'empty', '校验：空归档被拒')
    ok(v([{ path: 'a'.repeat(300) + '.md', bytes: 1 }])?.code === 'path-too-long', '校验：超长路径被拒')
    ok(
      v([{ path: 'a.md', bytes: 1 }], { maxFiles: 1, maxBytes: 10, maxPathLength: 50 }) === null,
      '校验：上限可配置（策略），单文件在上限内通过'
    )
    ok(
      v([{ path: 'a.md', bytes: 5 }, { path: 'b.md', bytes: 5 }], { maxFiles: 10, maxBytes: 8, maxPathLength: 50 })
        ?.code === 'too-large',
      '校验：累计字节超上限被拒（解压膨胀）'
    )
    ok(
      v([{ path: 'a.md', bytes: 1 }, { path: 'b.md', bytes: 1 }], { maxFiles: 1, maxBytes: 100, maxPathLength: 50 })
        ?.code === 'too-many-files',
      '校验：文件数超上限被拒'
    )
  }

  /* ------------------------------------------------------ 4. 失败分类（§13） */

  {
    const c = (text) => shared.classifyAcquisitionFailure(new Error(text))
    ok(c('fetch failed') === 'network', '失败分类：网络')
    ok(c('EACCES: permission denied') === 'permission', '失败分类：权限')
    ok(c('sha256 mismatch') === 'integrity', '失败分类：完整性')
    ok(c('spawn python ENOENT') === 'unsupported-runtime', '失败分类：运行时缺失')
    ok(c('握手失败，端点不可达') === 'verification', '失败分类：验证')
    ok(c('some weird thing happened') === 'unknown', '失败分类：认不出来就如实说 unknown（不许猜成网络问题）')
  }

  /* ------------------------------------------- 5. 真文件：受管 staging 全路径 */

  const root = await mkdtemp(join(tmpdir(), 'yan-acq-'))
  try {
    const svc = new service.AcquisitionService({ root })
    const begin = (digest = 'digest-1', planId = 'plan-1') =>
      svc.begin({ planId, candidateId: 'npm:demo@1.0.0', digest, projectId: 'proj-1', at })

    const tx = await begin()
    ok(tx.state === 'prepared', '真文件：begin 建出 prepared 事务')
    const again = await begin()
    ok(again.operationId === tx.operationId, '真文件：同一计划 + 指纹 → 同一 operationId（幂等）')
    let mismatch = false
    try {
      await begin('digest-2')
    } catch {
      mismatch = true
    }
    ok(mismatch, '真文件：同计划换了内容指纹 → 拒绝复用（计划已失效）')

    const manifest = await svc.stage({
      operationId: tx.operationId,
      at,
      files: [
        { path: 'demo/SKILL.md', content: '# demo\n' },
        { path: 'demo/notes.txt', content: 'hello' }
      ]
    })
    ok(manifest.files.length === 2, '真文件：两个文件都写进了 staging')
    ok(
      manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)),
      '真文件：manifest 里每个文件都有 sha256'
    )
    const staged = join(service.stagingDirOf(root, tx.operationId), 'payload', 'demo', 'SKILL.md')
    ok(existsSync(staged), '真文件：payload 真的落在受管 staging 里')
    ok((await readFile(staged, 'utf8')) === '# demo\n', '真文件：落盘内容与输入一致')
    let after = await svc.get(tx.operationId)
    ok(after.state === 'verifying' && after.attempts === 1, '真文件：落盘后进入 verifying，尝试计到 1')
    ok((await svc.verifyStaged(tx.operationId)).ok, '真文件：verifyStaged 重算 hash 一致')

    /* 仅核对 manifest 列出的文件不够：额外文件也会被后续 smoke / installer 消费。 */
    const unexpected = join(service.stagingDirOf(root, tx.operationId), 'payload', 'demo', 'unexpected.js')
    await writeFile(unexpected, 'globalThis.unreviewed = true\n', 'utf8')
    const extraFile = await svc.verifyStaged(tx.operationId)
    ok(!extraFile.ok && extraFile.problems.some((problem) => problem.includes('unexpected.js')),
      '真文件：未列入 manifest 的额外 payload 文件会被拒绝', extraFile.problems.join('；'))
    await rm(unexpected)
    ok((await svc.verifyStaged(tx.operationId)).ok, '真文件：移除额外文件后 staging 恢复通过复核')

    /* 篡改文件后再复核：必须发现不一致（这条是「不看日志看资源」的核心证据）。 */
    await writeFile(staged, '# demo tampered\n', 'utf8')
    const tampered = await svc.verifyStaged(tx.operationId)
    ok(!tampered.ok && tampered.problems.length > 0, '真文件：文件被改过，verifyStaged 报不一致')
    ok(tampered.problems.join(' ').includes('SKILL.md'), '真文件：报的是具体哪个文件不一致', tampered.problems.join('；'))
    let activateBlocked = false
    try {
      await svc.activate({
        operationId: tx.operationId,
        at,
        receipt: {
          planId: 'plan-1',
          planRevision: 1,
          candidateId: 'npm:demo@1.0.0',
          digest: 'digest-1',
          scope: 'project-managed',
          projectId: 'proj-1',
          installedPaths: ['demo/SKILL.md'],
          verification: 'files-present'
        }
      })
    } catch {
      activateBlocked = true
    }
    ok(activateBlocked, '真文件：复核不过就不能激活（激活前必过 verify）')
    after = await svc.get(tx.operationId)
    ok(after.state === 'failed', '真文件：激活被拦后事务记为 failed')

    /* 恢复复核：日志写过 activated 也不算数，文件不对就必须说不对。 */
    const resumeBad = await svc.resumeCheck({ operationId: tx.operationId, expected: { planId: 'plan-1', digest: 'digest-1' } })
    ok(!resumeBad.ok && resumeBad.reasons.length > 0, '真文件：resumeCheck 在资源损坏时不放行', resumeBad.reasons.join('；'))

    /* 正常路径：重来一次干净的 stage → activate → resumeCheck 通过。 */
    const tx2 = await svc.begin({ planId: 'plan-2', candidateId: 'npm:demo@1.0.0', digest: 'digest-1', projectId: 'proj-1', at })
    await svc.stage({ operationId: tx2.operationId, at, files: [{ path: 'demo/SKILL.md', content: '# demo\n' }] })
    /* 服务层必须提供状态机提示的重试入口，并且仅清本 operation 的旧 staging。 */
    const retried = await svc.retry(tx.operationId, at)
    ok(retried.state === 'prepared' && retried.attempts === 1, '真文件：retry 复用原事务并保留已消耗尝试数')
    ok(!retried.receipt && !retried.failure && !retried.stagingDir, '真文件：retry 清除上次失败的 receipt / failure / staging 指针')
    ok(!existsSync(service.stagingDirOf(root, tx.operationId)), '真文件：retry 清理本 operation 的 staging')
    ok(existsSync(service.stagingDirOf(root, tx2.operationId)), '真文件：retry 不碰其它 operation 的 staging')
    let retryLimit = false
    try {
      await svc.retry(tx.operationId, at)
    } catch (error) {
      retryLimit = error?.code === 'retry-not-allowed'
    }
    ok(retryLimit, '真文件：非 failed 状态不能重复发起 retry')
    const activated = await svc.activate({
      operationId: tx2.operationId,
      at,
      receipt: {
        planId: 'plan-2',
        planRevision: 1,
        candidateId: 'npm:demo@1.0.0',
        digest: 'digest-1',
        scope: 'project-managed',
        projectId: 'proj-1',
        installedPaths: ['demo/SKILL.md'],
        verification: 'files-present'
      }
    })
    ok(activated.state === 'activated' && !!activated.receipt, '真文件：验证通过 → 登记 receipt 并激活')
    const resumeOk = await svc.resumeCheck({ operationId: tx2.operationId, expected: { planId: 'plan-2', digest: 'digest-1' } })
    ok(resumeOk.ok, '真文件：receipt + 文件 hash 都对 → 恢复复核通过', resumeOk.reasons.join('；'))
    const wrongPlan = await svc.resumeCheck({ operationId: tx2.operationId, expected: { planId: 'plan-9', digest: 'digest-1' } })
    ok(!wrongPlan.ok, '真文件：换计划后恢复复核不通过（源已变化）')

    /* 被拒的归档：事务失败、**且本次 staging 目录不存在**。 */
    const tx3 = await svc.begin({ planId: 'plan-3', candidateId: 'npm:demo@1.0.0', digest: 'digest-3', projectId: 'proj-1', at })
    let rejected = null
    try {
      await svc.stage({ operationId: tx3.operationId, at, files: [{ path: '../../evil.md', content: 'x' }] })
    } catch (error) {
      rejected = error
    }
    ok(rejected?.code === 'path-traversal', '真文件：路径穿越在落盘**之前**被拒（不写任何文件）')
    ok(
      !existsSync(service.stagingDirOf(root, tx3.operationId)),
      '真文件：被拒后本次 staging 目录不存在（失败不留半份）'
    )
    ok((await svc.get(tx3.operationId)).state === 'failed', '真文件：被拒的事务如实记为 failed')

    /* rollback 只删本次：别的 operationId 目录必须原样都在。 */
    const kept = service.stagingDirOf(root, tx2.operationId)
    await svc.rollback(tx3.operationId)
    ok(existsSync(kept), '真文件：rollback 只删本次 staging，不碰别的受管目录')

    const logText = await readFile(service.acquisitionLogPath(root), 'utf8')
    ok(!existsSync(`${service.acquisitionLogPath(root)}.tmp`), '真文件：事务日志原子写（没有 .tmp 残留）')
    const parsed = JSON.parse(logText)
    ok(Object.keys(parsed.transactions).length === 3, '真文件：三条事务都落了盘', Object.keys(parsed.transactions).join(','))
    ok(
      parsed.transactions[tx.operationId].history.length >= 3,
      '真文件：事务历史按步记录（可从日志看出走过哪些状态）'
    )

    /* 等边界（§10.1）：确实要装但本轮不能装 → pending-boundary，而不是假装 activated。 */
    const tx4 = await svc.begin({ planId: 'plan-4', candidateId: 'npm:demo@1.0.0', digest: 'digest-4', projectId: 'proj-1', at })
    const bounded = await svc.markBoundary(tx4.operationId, '等调度', at)
    ok(bounded.state === 'pending-boundary', '真文件：等边界时停在 pending-boundary（不假装激活）')
    ok(bounded.receipt === undefined, '真文件：等边界没有 receipt（没装完就不登记）')
    const activationTarget = {
      runnerId: 'runner-a',
      runnerGeneration: 3,
      cwd: join(root, 'project'),
      sessionFile: join(root, 'project', 'session.jsonl'),
      projectId: 'proj-1',
      goalId: 'goal-1',
      goalRevision: 4,
      sourceHead: 'a'.repeat(40),
      continueId: tx4.operationId,
      packageName: '@fixture/safe-skill',
      packageVersion: '1.2.3'
    }
    const bound = await svc.bindPiPackageTarget(tx4.operationId, activationTarget)
    ok(bound.piPackageTarget?.sessionFile === activationTarget.sessionFile, '真文件：pending pi 包事务持久绑定原项目会话')
    const recoveredTarget = await new service.AcquisitionService({ root }).get(tx4.operationId)
    ok(recoveredTarget?.piPackageTarget?.runnerId === 'runner-a', '真文件：新 service 实例可恢复精确 runner 目标')
    ok(recoveredTarget?.piPackageTarget?.goalRevision === 4, '真文件：原目标 revision 持久恢复')
    ok(recoveredTarget?.piPackageTarget?.sourceHead === 'a'.repeat(40), '真文件：原项目 sourceHead 持久恢复')
    let targetConflict = false
    try {
      await svc.bindPiPackageTarget(tx4.operationId, { ...activationTarget, runnerId: 'runner-b' })
    } catch (error) {
      targetConflict = error?.code === 'target-conflict'
    }
    ok(targetConflict, '真文件：事务不能静默改绑到另一 runner')

    /* 损坏的事务真源必须 fail closed，不能被下一次写入当空日志覆盖。 */
    const logPath = service.acquisitionLogPath(root)
    await writeFile(logPath, '{broken', 'utf8')
    let corruptLogRejected = false
    try {
      await svc.begin({ planId: 'plan-after-corruption', candidateId: 'npm:demo@1.0.0', digest: 'd', projectId: 'proj-1', at })
    } catch (error) {
      corruptLogRejected = error?.code === 'log-corrupt'
    }
    ok(corruptLogRejected, '事务日志：损坏 JSON 时 fail closed，拒绝继续写')
    ok((await readFile(logPath, 'utf8')) === '{broken', '事务日志：损坏现场字节原样保留，不按空日志覆盖')

    /* 越界的 operationId：不允许用形状去拼路径。 */
    let badId = false
    try {
      service.stagingDirOf(root, '../escape')
    } catch {
      badId = true
    }
    ok(badId, '真文件：operationId 形状不合法时直接报错（不拼出受管目录之外的路径）')
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  await runNpmArtifactTests(ok, npmArtifact, npmAcquisition, service)
  await runPackageAuthorizationTests(ok, packageAuthorizationShared, packageAuthorizationService)
}

async function runPackageAuthorizationTests(ok, shared, serviceModule) {
  const root = await mkdtemp(join(tmpdir(), 'yan-package-auth-'))
  try {
    const grantStore = new serviceModule.PackageAuthorizationService(root)
    const input = { candidateId: 'npm:fixture@1.2.3', digest: 'a'.repeat(16), projectId: 'project-a' }
    const grant = await grantStore.grant({ ...input, allowLifecycleScripts: false, at: '2026-09-20T10:00:00.000Z' })
    ok(grant.via === 'settings-ui' && !grant.allowLifecycleScripts, '包授权：通过宿主 UI 记录精确候选且默认不允许 lifecycle scripts')
    ok(!!(await new serviceModule.PackageAuthorizationService(root).find(input)), '包授权：重新创建 store 后授权仍持久存在')
    ok(!(await grantStore.find({ ...input, projectId: 'project-b' })), '包授权：不能跨项目复用')
    ok(!(await grantStore.find({ ...input, digest: 'b'.repeat(16) })), '包授权：候选内容指纹变化后旧授权失效')
    ok(shared.packageExecutionGrantCovers(grant, input), '包授权：契约按候选 + digest + project 三元组精确匹配')
    ok(!shared.validPackageExecutionGrant({ ...grant, via: 'model-cli' }), '包授权：模型 CLI 不能伪造 host UI 授权来源')

    await grantStore.grant({ ...input, allowLifecycleScripts: true, at: '2026-09-20T10:01:00.000Z' })
    const updated = await grantStore.find(input)
    ok(updated?.allowLifecycleScripts === true, '包授权：生命周期脚本许可是独立显式字段，可被 UI 更新')
    ok(await grantStore.revoke(input), '包授权：撤销返回真实变化')
    ok(!(await grantStore.find(input)), '包授权：撤销后立即不再命中')
    ok(!(await grantStore.revoke(input)), '包授权：重复撤销如实返回无变化')

    const storePath = join(root, 'capabilities', 'package-authorizations.json')
    await writeFile(storePath, '{broken', 'utf8')
    let corruptRejected = false
    try {
      await grantStore.grant({ ...input, allowLifecycleScripts: false })
    } catch {
      corruptRejected = true
    }
    ok(corruptRejected, '包授权：坏文件时拒绝把授权默默降级为空后覆盖')
    ok((await readFile(storePath, 'utf8')) === '{broken', '包授权：损坏文件字节原样保留，便于恢复审查')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function runNpmArtifactTests(ok, npmArtifact, npmAcquisition, acquisitionServiceModule) {
  const root = await mkdtemp(join(tmpdir(), 'yan-npm-artifact-'))
  const packRoot = join(root, 'fixture')
  const sourcePackage = join(packRoot, 'package')
  const archivePath = join(root, 'fixture.tgz')
  const name = '@fixture/safe-skill'
  const version = '1.2.3'
  const packageJson = { name, version, description: 'isolated test fixture' }
  const expectedReadme = '# local fixture\n'
  try {
    await mkdir(sourcePackage, { recursive: true })
    await writeFile(join(sourcePackage, 'package.json'), JSON.stringify(packageJson))
    await writeFile(join(sourcePackage, 'README.md'), expectedReadme)
    await tar.c({ cwd: packRoot, file: archivePath, gzip: true }, ['package'])
    const archive = await readFile(archivePath)
    const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`
    const metadataUrl = 'https://registry.npmjs.org/%40fixture%2Fsafe-skill/1.2.3'
    const tarballUrl = 'https://registry.npmjs.org/@fixture/safe-skill/-/safe-skill-1.2.3.tgz'

    const response = (url, body) => ({
      ok: true,
      status: 200,
      url,
      headers: { get: () => null },
      json: async () => body,
      arrayBuffer: async () => {
        const bytes = body === null ? archive : Buffer.from(JSON.stringify(body))
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      }
    })
    let tarballFetches = 0
    const fakeFetch = async (url) => {
      if (url === metadataUrl) {
        return response(url, { name, version, dist: { integrity, tarball: tarballUrl } })
      }
      if (url === tarballUrl) {
        tarballFetches++
        return response(url, null)
      }
      throw new Error(`unexpected fixture request: ${url}`)
    }

    let metadataFetches = 0
    const manifest = await npmArtifact.fetchNpmPackageMetadata({
      name,
      version,
      fetchImpl: async (url, options) => {
        metadataFetches++
        ok(options.redirect === 'manual', 'npm prepare：exact-version manifest 不跟随 redirect')
        return fakeFetch(url)
      }
    })
    ok(manifest.integrity === integrity && manifest.name === name && manifest.version === version, 'npm prepare：只取官方 metadata 即固定身份与 tarball SRI')
    ok(manifest.tarballUrl === tarballUrl && metadataFetches === 1, 'npm prepare：只发一条 metadata 请求，不下载或执行包内容')

    const artifact = await npmArtifact.fetchNpmArtifact({
      root,
      operationId: 'fixed-op-1',
      name,
      version,
      expectedIntegrity: integrity,
      fetchImpl: fakeFetch
    })
    ok(artifact.integrity === integrity, 'npm 制品：使用 exact-version registry 给出的 SHA-512 SRI', artifact.integrity)
    ok(artifact.packageJson.name === name && artifact.packageJson.version === version, 'npm 制品：包内身份与精确候选一致')
    ok(artifact.files.length === 2 && artifact.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)), 'npm 制品：逐文件重算 SHA-256 清单', JSON.stringify(artifact.files))
    ok((await readFile(join(artifact.packageDir, 'README.md'), 'utf8')) === expectedReadme, 'npm 制品：通过校验后才解包到 operationId 专属目录')
    ok(existsSync(artifact.tarballPath), 'npm 制品：保留固定归档供后续安装阶段复核')

    const acquisitionRoot = await mkdtemp(join(tmpdir(), 'yan-npm-acquire-'))
    try {
      const txStore = new acquisitionServiceModule.AcquisitionService({ root: acquisitionRoot })
      const tx = await txStore.begin({
        planId: 'plan-fixture',
        candidateId: `npm:${name}@${version}`,
        digest: 'digest-fixture',
        projectId: 'project-fixture',
        at: '2026-09-20T10:00:00.000Z'
      })
      const staged = await npmAcquisition.stageNpmAcquisition({
        root: acquisitionRoot,
        operationId: tx.operationId,
        candidateId: tx.candidateId,
        digest: tx.digest,
        projectId: tx.projectId,
        name,
        version,
        integrity,
        fetchImpl: fakeFetch
      })
      const stagedTx = await txStore.get(tx.operationId)
      ok(stagedTx?.state === 'verifying' && staged.manifest.files.length === 2, 'npm acquire：固定候选下载后落受管 staging 并停在 verifying')
      ok((await readFile(join(staged.packageSourceDir, 'README.md'), 'utf8')) === expectedReadme, 'npm acquire：pi 包源只位于当前 operation 的 payload/package')
      ok((await txStore.verifyStaged(tx.operationId)).ok, 'npm acquire：staging 的 manifest hash 可重新核验')
      let mismatchRejected = false
      try {
        await npmAcquisition.stageNpmAcquisition({
          root: acquisitionRoot,
          operationId: tx.operationId,
          candidateId: tx.candidateId,
          digest: 'different-digest',
          projectId: tx.projectId,
          name,
          version,
          integrity,
          fetchImpl: fakeFetch
        })
      } catch (error) {
        mismatchRejected = error?.code === 'transaction-mismatch'
      }
      ok(mismatchRejected, 'npm acquire：事务指纹变化时拒绝复用或再次下载')
    } finally {
      await rm(acquisitionRoot, { recursive: true, force: true })
    }

    const archiveSha256 = createHash('sha256').update(archive).digest('hex')
    const sha256Artifact = await npmArtifact.fetchNpmArtifact({
      root,
      operationId: 'registry-sha256-op',
      name,
      version,
      expectedSha256: archiveSha256,
      fetchImpl: fakeFetch
    })
    ok(sha256Artifact.integrity === integrity, 'npm 制品：MCP Registry 的 fileSha256 可与 registry SHA-512 双重核验')

    let versionRejected = false
    let versionFetches = 0
    try {
      await npmArtifact.fetchNpmArtifact({
        root,
        operationId: 'range-op',
        name,
        version: '^1.2.3',
        fetchImpl: async () => { versionFetches++; throw new Error('must not fetch') }
      })
    } catch (error) {
      versionRejected = error?.code === 'version-not-pinned'
    }
    ok(versionRejected && versionFetches === 0, 'npm 制品：拒绝版本范围 / tag，且拒绝前不联网')

    let integrityRejected = false
    try {
      await npmArtifact.fetchNpmArtifact({
        root,
        operationId: 'integrity-op',
        name,
        version,
        expectedIntegrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
        fetchImpl: fakeFetch
      })
    } catch (error) {
      integrityRejected = error?.code === 'integrity-changed'
    }
    ok(integrityRejected, 'npm 制品：prepare 固定值变化时拒绝并使旧计划失效')
    ok(!existsSync(npmArtifact.npmArtifactDirOf(root, 'integrity-op')), 'npm 制品：完整性变化失败只清本次下载目录')

    let redirectRejected = false
    try {
      await npmArtifact.fetchNpmArtifact({
        root,
        operationId: 'redirect-op',
        name,
        version,
        fetchImpl: async (url) => response('https://attacker.example/redirected', null)
      })
    } catch (error) {
      redirectRejected = error?.code === 'redirect-origin'
    }
    ok(redirectRejected, 'npm 制品：registry metadata 重定向到非官方主机时拒绝')
    ok(!existsSync(npmArtifact.npmArtifactDirOf(root, 'redirect-op')), 'npm 制品：重定向拒绝后清理本次 staging')

    ok(
      npmArtifact.validateNpmTarEntry({ path: 'package/../../outside', type: 'File', size: 1 }) !== null,
      'npm 制品：拒绝归档路径穿越'
    )
    ok(
      npmArtifact.validateNpmTarEntry({ path: 'package/link', type: 'SymbolicLink', size: 0 }) !== null,
      'npm 制品：拒绝符号链接（不依赖解包器安全兜底）'
    )
    ok(
      npmArtifact.validateNpmTarEntry({ path: 'package/link', type: 'Link', size: 0 }) !== null,
      'npm 制品：拒绝硬链接'
    )
    ok(
      npmArtifact.validateNpmTarEntry({ path: 'package/dir/', type: 'Directory', size: 0 }) === null,
      'npm 制品：允许普通 package/ 目录条目'
    )
    ok(
      npmArtifact.validateNpmTarEntry({ path: 'package/CON.txt', type: 'File', size: 1 }) !== null,
      'npm 制品：拒绝 Windows 设备保留文件名'
    )
    ok(
      npmArtifact.validateNpmTarEntry({ path: 'package/file.txt:stream', type: 'File', size: 1 }) !== null,
      'npm 制品：拒绝 NTFS alternate data stream 路径'
    )

    let hashRejected = false
    try {
      await npmArtifact.fetchNpmArtifact({
        root,
        operationId: 'hash-op',
        name,
        version,
        fetchImpl: async (url) => {
          if (url === metadataUrl) return response(url, { name, version, dist: { integrity, tarball: tarballUrl } })
          if (url === tarballUrl) return {
            ...response(url, null),
            arrayBuffer: async () => {
              const bytes = Buffer.from('wrong archive')
              return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
            }
          }
          throw new Error(`unexpected fixture request: ${url}`)
        }
      })
    } catch (error) {
      hashRejected = error?.code === 'integrity-mismatch'
    }
    ok(hashRejected, 'npm 制品：tarball 字节与 registry SHA-512 不符时拒绝解包')
    ok(!existsSync(npmArtifact.npmArtifactDirOf(root, 'hash-op')), 'npm 制品：hash 错误清理本次 staging')

    let registryShaRejected = false
    try {
      await npmArtifact.fetchNpmArtifact({
        root,
        operationId: 'registry-sha-mismatch-op',
        name,
        version,
        expectedSha256: '0'.repeat(64),
        fetchImpl: fakeFetch
      })
    } catch (error) {
      registryShaRejected = error?.code === 'integrity-mismatch'
    }
    ok(registryShaRejected, 'npm 制品：MCP Registry 的 fileSha256 不匹配时拒绝')
    ok(!existsSync(npmArtifact.npmArtifactDirOf(root, 'registry-sha-mismatch-op')), 'npm 制品：SHA-256 不匹配清本次目录')

    let redirectNotFollowed = false
    let redirectFetches = 0
    try {
      await npmArtifact.fetchNpmArtifact({
        root,
        operationId: 'redirect-manual-op',
        name,
        version,
        fetchImpl: async (url, options) => {
          redirectFetches++
          redirectNotFollowed = options.redirect === 'manual'
          return { ...response(url, null), ok: false, status: 302 }
        }
      })
    } catch (error) {
      redirectNotFollowed &&= error?.code === 'registry-http'
    }
    ok(redirectNotFollowed && redirectFetches === 1, 'npm 制品：不跟随 redirect 去请求第二个主机')

    /* 同一 operationId 重放时重验 pinned SRI，并从可信 tarball 修复解包目录。 */
    const replayTarballFetches = tarballFetches
    await writeFile(join(artifact.packageDir, 'README.md'), '# local tampered\n')
    let replayMetadataFetches = 0
    const replayed = await npmArtifact.fetchNpmArtifact({
      root,
      operationId: 'fixed-op-1',
      name,
      version,
      expectedIntegrity: integrity,
      fetchImpl: async (url, options) => {
        if (url === metadataUrl) replayMetadataFetches++
        return fakeFetch(url, options)
      }
    })
    ok(replayed.integrity === integrity && replayMetadataFetches === 1, 'npm 制品：同一 operationId 可安全重试，且重新确认 registry 固定值')
    ok(tarballFetches === replayTarballFetches, 'npm 制品：有效的 pinned tarball 缓存避免重新下载')
    ok((await readFile(join(replayed.packageDir, 'README.md'), 'utf8')) === expectedReadme, 'npm 制品：重试以通过 SHA-512 验证的 tarball 重建解包内容')

    /* 缓存字节损坏时 fail closed，并保留现场供检查，不重新信任或覆盖。 */
    await writeFile(replayed.tarballPath, 'tampered cache')
    let cacheTamperRejected = false
    try {
      await npmArtifact.fetchNpmArtifact({
        root,
        operationId: 'fixed-op-1',
        name,
        version,
        expectedIntegrity: integrity,
        fetchImpl: fakeFetch
      })
    } catch (error) {
      cacheTamperRejected = error?.code === 'integrity-mismatch'
    }
    ok(cacheTamperRejected && existsSync(replayed.tarballPath), 'npm 制品：缓存篡改时拒绝重用且保留原目录供检查')

    const foreignOperationDir = npmArtifact.npmArtifactDirOf(root, 'foreign-op')
    await mkdir(join(foreignOperationDir, 'package'), { recursive: true })
    await writeFile(join(foreignOperationDir, 'package', 'keep.txt'), 'user data')
    let foreignDirRejected = false
    try {
      await npmArtifact.fetchNpmArtifact({
        root,
        operationId: 'foreign-op',
        name,
        version,
        expectedIntegrity: integrity,
        fetchImpl: async () => { throw new Error('foreign directory must be rejected before network access') }
      })
    } catch (error) {
      foreignDirRejected = error?.code === 'operation-directory-conflict'
    }
    ok(foreignDirRejected, 'npm 制品：无可信归档的既有 package 目录 fail closed')
    ok((await readFile(join(foreignOperationDir, 'package', 'keep.txt'), 'utf8')) === 'user data', 'npm 制品：目录冲突不覆盖既有文件')

    if (process.platform === 'win32') {
      const redirectedRoot = join(root, 'redirected-root')
      const redirectedTarget = join(root, 'redirected-target')
      await mkdir(join(redirectedRoot, 'capabilities'), { recursive: true })
      await mkdir(redirectedTarget)
      await symlink(redirectedTarget, join(redirectedRoot, 'capabilities', 'downloads'), 'junction')
      let downloadsRootRejected = false
      try {
        await npmArtifact.fetchNpmArtifact({
          root: redirectedRoot,
          operationId: 'redirected-root-op',
          name,
          version,
          expectedIntegrity: integrity,
          fetchImpl: async () => { throw new Error('redirected downloads root must be rejected before network access') }
        })
      } catch (error) {
        downloadsRootRejected = error?.code === 'downloads-root-invalid'
      }
      ok(downloadsRootRejected && (await readdir(redirectedTarget)).length === 0, 'npm 制品：downloads 根 junction 拒绝且不向目标目录写入')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
