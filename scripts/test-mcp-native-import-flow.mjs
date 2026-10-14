/**
 * 旧宿主 MCP → pi 原生导入设置页流程（`mcp-native-import-flow.ts`）的定向测试。
 *
 * 直接加载真实模块（esbuild 转译后在 VM 里执行），验证范围核对与分步结果投影：
 * prepare → 取消不 commit、同 scope 批准只 commit 一次、卸载/换 runner/切会话/换项目
 * 不 commit、错误与部分完成如实投影、进行中防重复。不是源码 regex 匹配。
 *
 * 不启动 Electron / 不碰真实配置、服务、模型或运行窗口。
 *
 * 用法： node scripts/test-mcp-native-import-flow.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { transform } from 'esbuild'

const source = await readFile('src/renderer/src/components/settings/mcp-native-import-flow.ts', 'utf8')
const { code } = await transform(source, { loader: 'ts', format: 'cjs', target: 'node18' })
const module = { exports: {} }
vm.runInNewContext(code, { module, exports: module.exports, require: () => { throw new Error('no imports expected') } })
const { createMcpImportFlow, sameMcpImportScope, projectMcpImportCommit, migratedTargetScope } = module.exports
assert.equal(typeof createMcpImportFlow, 'function', '必须导出 createMcpImportFlow')
assert.equal(typeof projectMcpImportCommit, 'function', '必须导出 projectMcpImportCommit')

let checks = 0
const check = (condition, message) => { assert.ok(condition, message); checks += 1 }

const preview = (over = {}) => ({
  token: 'tok-1',
  expiresAt: '2030-01-01T00:00:00.000Z',
  serverId: 'svc',
  nativeName: 'svc',
  scope: 'global',
  targetPath: 'C:/agent/mcp.json',
  content: '{ ... }',
  serverEntry: { command: 'npx', args: ['-y', 'srv'] },
  warnings: [],
  requiresReauth: false,
  ...over
})
const scope = (over = {}) => ({ mounted: true, activeRunnerId: 'r1', sessionId: 's1', projectKey: 'C:/proj', ...over })
const okResult = (over = {}) => ({
  ok: true,
  serverId: 'svc',
  nativeName: 'svc',
  targetPath: 'C:/agent/mcp.json',
  nativeWritten: true,
  deactivated: true,
  verified: true,
  verification: 'passed',
  steps: { nativeWrite: 'written', verify: 'passed', hostDisable: 'disabled' },
  notice: 'done',
  warnings: [],
  ...over
})

/* ── 范围相等判定（直接单测） ── */
check(sameMcpImportScope(scope(), scope()), '完全相同的范围视为同一范围')
check(!sameMcpImportScope(scope(), scope({ activeRunnerId: 'r2' })), '换 runner 不是同一范围')
check(!sameMcpImportScope(scope(), scope({ sessionId: 's2' })), '切会话不是同一范围')
check(!sameMcpImportScope(scope(), scope({ projectKey: 'C:/other' })), '换项目不是同一范围')
check(sameMcpImportScope(scope({ mounted: false }), scope()), 'mounted 不参与身份比较，只用于额外核对')

/* ── 取消：不 commit ── */
{
  let commits = 0
  const flow = createMcpImportFlow({
    prepare: async () => ({ ok: true, preview: preview() }),
    commit: async () => { commits += 1; return { ok: true, result: okResult() } },
    currentScope: () => scope(),
    requestConfirm: async () => false
  })
  const out = await flow.run('svc')
  check(out.phase === 'cancelled', '取消后 phase=cancelled')
  check(commits === 0, '取消不 commit')
  check(flow.busy === false, '结束后释放 busy')
}

/* ── 同 scope 批准：只 commit 一次，令牌来自 preview ── */
{
  let commits = 0
  const tokens = []
  const flow = createMcpImportFlow({
    prepare: async () => ({ ok: true, preview: preview() }),
    commit: async (token) => { commits += 1; tokens.push(token); return { ok: true, result: okResult() } },
    currentScope: () => scope(),
    requestConfirm: async () => true
  })
  const out = await flow.run('svc')
  check(out.phase === 'committed' && out.projection.ok === true, '批准后拿到成功的投影')
  check(commits === 1, '批准只 commit 一次')
  check(tokens[0] === 'tok-1', 'commit 用的是 prepare 给的令牌')
}

/* ── prepare 返回后换 runner / 切会话 / 换项目：不弹确认也不 commit ── */
for (const [field, value, label] of [
  ['activeRunnerId', 'r2', '换 runner'],
  ['sessionId', 's2', '切会话'],
  ['projectKey', 'C:/other', '换项目']
]) {
  const mutable = scope()
  let confirms = 0
  let commits = 0
  const flow = createMcpImportFlow({
    prepare: async () => { mutable[field] = value; return { ok: true, preview: preview() } },
    commit: async () => { commits += 1; return { ok: true, result: okResult() } },
    currentScope: () => ({ ...mutable }),
    requestConfirm: async () => { confirms += 1; return true }
  })
  const out = await flow.run('svc')
  check(out.phase === 'scope-changed', `${label}（prepare 之后）判为范围变化`)
  check(confirms === 0, `${label} 不再弹确认`)
  check(commits === 0, `${label} 不 commit`)
}

/* ── 确认期间换 runner / 切会话 / 换项目：不 commit ── */
for (const [field, value, label] of [
  ['activeRunnerId', 'r2', '换 runner'],
  ['sessionId', 's2', '切会话'],
  ['projectKey', 'C:/other', '换项目']
]) {
  const mutable = scope()
  let commits = 0
  const flow = createMcpImportFlow({
    prepare: async () => ({ ok: true, preview: preview() }),
    commit: async () => { commits += 1; return { ok: true, result: okResult() } },
    currentScope: () => ({ ...mutable }),
    requestConfirm: async () => { mutable[field] = value; return true }
  })
  const out = await flow.run('svc')
  check(out.phase === 'scope-changed', `${label}（确认期间）判为范围变化`)
  check(commits === 0, `${label}（确认期间）不 commit`)
}

/* ── 确认期间组件卸载：即使确认框结算为 true 也不 commit ── */
{
  let mounted = true
  let commits = 0
  const flow = createMcpImportFlow({
    prepare: async () => ({ ok: true, preview: preview() }),
    commit: async () => { commits += 1; return { ok: true, result: okResult() } },
    currentScope: () => scope({ mounted }),
    requestConfirm: async () => { mounted = false; return true }
  })
  const out = await flow.run('svc')
  check(out.phase === 'scope-changed', '卸载后判为范围变化')
  check(commits === 0, '卸载不 commit')
}

/* ── 已卸载时连 prepare 都不发 ── */
{
  let prepares = 0
  const flow = createMcpImportFlow({
    prepare: async () => { prepares += 1; return { ok: true, preview: preview() } },
    commit: async () => ({ ok: true, result: okResult() }),
    currentScope: () => scope({ mounted: false }),
    requestConfirm: async () => true
  })
  const out = await flow.run('svc')
  check(out.phase === 'scope-changed' && prepares === 0, '未挂载时不做 prepare')
}

/* ── 预览被拒 / 预览抛错：如实带出 code 与 error，不进入确认与提交 ── */
{
  let confirms = 0
  let commits = 0
  const flow = createMcpImportFlow({
    prepare: async () => ({ ok: false, code: 'server_unknown', error: '旧配置里没有这个服务' }),
    commit: async () => { commits += 1; return { ok: true, result: okResult() } },
    currentScope: () => scope(),
    requestConfirm: async () => { confirms += 1; return true }
  })
  const out = await flow.run('svc')
  check(out.phase === 'failed' && out.code === 'server_unknown' && /没有这个服务/.test(out.error), '预览被拒保留 code 与可读错误')
  check(confirms === 0 && commits === 0, '预览被拒不弹确认也不提交')
}
{
  const flow = createMcpImportFlow({
    prepare: async () => { throw new Error('IPC 断了') },
    commit: async () => ({ ok: true, result: okResult() }),
    currentScope: () => scope(),
    requestConfirm: async () => true
  })
  const out = await flow.run('svc')
  check(out.phase === 'failed' && out.code === 'ipc_error' && out.error === 'IPC 断了', '预览抛错归为 ipc_error 并保留原文')
}

/* ── 提交在写盘前被拒（无 result）：如实带出错误，旧条目未动 ── */
{
  const flow = createMcpImportFlow({
    prepare: async () => ({ ok: true, preview: preview() }),
    commit: async () => ({ ok: false, code: 'token_expired', error: '导入令牌已过期，请重新预览' }),
    currentScope: () => scope(),
    requestConfirm: async () => true
  })
  const out = await flow.run('svc')
  check(out.phase === 'failed' && out.code === 'token_expired' && /重新预览/.test(out.error), '提交被拒保留令牌错误')
}
{
  const flow = createMcpImportFlow({
    prepare: async () => ({ ok: true, preview: preview() }),
    commit: async () => { throw new Error('提交 IPC 抛错') },
    currentScope: () => scope(),
    requestConfirm: async () => true
  })
  const out = await flow.run('svc')
  check(out.phase === 'failed' && out.code === 'ipc_error' && out.error === '提交 IPC 抛错', '提交抛错归为 ipc_error')
}

/* ── 部分完成：原生已写、校验失败、旧条目仍启用，不能投影成「没写」 ── */
{
  const flow = createMcpImportFlow({
    prepare: async () => ({ ok: true, preview: preview() }),
    commit: async () => ({
      ok: true,
      result: okResult({
        ok: false,
        nativeWritten: true,
        deactivated: false,
        verified: false,
        verification: 'failed',
        steps: { nativeWrite: 'written', verify: 'failed', hostDisable: 'skipped' },
        notice: '原生配置已写入，但校验未通过；旧条目保持启用。',
        warnings: ['authRef 凭证不迁移']
      })
    }),
    currentScope: () => scope(),
    requestConfirm: async () => true
  })
  const out = await flow.run('svc')
  const p = out.projection
  check(out.phase === 'committed' && p.accepted === true, '提交被接受时仍投影分步结果')
  check(p.ok === false && p.nativeWritten === true && p.deactivated === false, '原生已写但未停用旧条目')
  check(p.verified === false && p.verification === 'failed', '校验失败如实保留')
  check(p.steps.nativeWrite === 'written' && p.steps.verify === 'failed' && p.steps.hostDisable === 'skipped', '三步状态各自保留')
  check(/旧条目保持启用/.test(p.notice) && p.warnings[0] === 'authRef 凭证不迁移', 'notice 与 warnings 原样保留')
}

/* ── 校验通过但检测到外部改动：未停用旧条目 ── */
{
  const flow = createMcpImportFlow({
    prepare: async () => ({ ok: true, preview: preview() }),
    commit: async () => ({
      ok: true,
      result: okResult({ ok: false, deactivated: false, steps: { nativeWrite: 'written', verify: 'passed', hostDisable: 'skipped-external-change' } })
    }),
    currentScope: () => scope(),
    requestConfirm: async () => true
  })
  const out = await flow.run('svc')
  check(out.projection.steps.hostDisable === 'skipped-external-change', '外部改动状态不被说成已停用')
  check(out.projection.deactivated === false, '未停用旧条目')
}

/* ── 缺字段的防御投影：缺步骤 / 缺 verification 时退回 skipped，不假装成功 ── */
{
  const projection = projectMcpImportCommit({ ok: true, serverId: 'svc', nativeName: 'svc', targetPath: 'x' })
  check(projection.steps.nativeWrite === 'skipped' && projection.steps.verify === 'skipped' && projection.steps.hostDisable === 'skipped', '缺步骤退回未执行')
  check(projection.nativeWritten === false && projection.deactivated === false && projection.verified === false, '缺字段不假装已写/已停用')
  check(projection.verification === 'unavailable', '缺 verification 退回 unavailable')
  check(Array.isArray(projection.warnings) && projection.warnings.length === 0, '缺 warnings 退回空数组')
}

/* ── 进行中防重复：第二次点击返回 busy，全程只 commit 一次 ── */
{
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let commits = 0
  const flow = createMcpImportFlow({
    prepare: async () => { await gate; return { ok: true, preview: preview() } },
    commit: async () => { commits += 1; return { ok: true, result: okResult() } },
    currentScope: () => scope(),
    requestConfirm: async () => true
  })
  const first = flow.run('svc')
  check(flow.busy === true, '进行中 busy=true')
  const second = await flow.run('svc')
  check(second.phase === 'busy', '进行中重复点击返回 busy')
  release()
  const out = await first
  check(out.phase === 'committed' && commits === 1, '重复点击不产生第二次 commit')
  check(flow.busy === false, '完成后释放 busy')
}

/* ── 已迁移范围推断：只按真实路径形状，不猜字段 ── */
check(migratedTargetScope('C:/proj/.pi/mcp.json') === 'project', '项目 .pi/mcp.json 推断为项目范围')
check(migratedTargetScope('C:\\proj\\.pi\\mcp.json') === 'project', 'Windows 反斜杠同样识别项目范围')
check(migratedTargetScope('C:/agent/mcp.json') === 'global', 'agentDir 下的 mcp.json 推断为全局')
check(migratedTargetScope('') === null, '空路径不硬猜范围')

for (const initiallyRunning of [true, false]) {
  let running = initiallyRunning, prepares = 0, commits = 0
  const flow = createMcpImportFlow({
    prepare: async () => { prepares += 1; return { ok: true, preview: preview() } },
    commit: async () => { commits += 1; return { ok: true, result: okResult() } },
    currentScope: () => scope(),
    isRunning: () => running,
    requestConfirm: async () => { running = true; return true }
  })
  const out = await flow.run('svc')
  check(out.phase === 'busy' && commits === 0, '开始或确认期间任务变忙均不commit')
  check(prepares === (initiallyRunning ? 0 : 1) && !flow.busy, '忙碌防护不预览运行任务且释放占用')
}
{
  let commits = 0
  const flow = createMcpImportFlow({
    prepare: async () => ({ ok: true, preview: preview() }),
    commit: async () => { commits += 1; return { ok: true, result: okResult() } },
    currentScope: () => scope(),
    requestConfirm: async () => { throw new Error('dialog failed') }
  })
  const out = await flow.run('svc')
  check(out.phase === 'failed' && out.code === 'confirmation_error' && commits === 0, '确认异常如实失败而非悬挂')
  check(!flow.busy, '确认异常后允许重新预览')
}
console.log(`MCP 原生导入前端流程测试通过：${checks} 项`)
