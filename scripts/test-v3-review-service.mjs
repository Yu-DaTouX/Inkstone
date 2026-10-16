import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return outfile
}

let step = 0
function ok(label) {
  step += 1
  console.log(`  ok ${step}. ${label}`)
}

function fakeIpc() {
  const handlers = new Map()
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    rawHandle: (channel, fn) => handlers.set(channel, fn),
    has: (channel) => handlers.has(channel),
    invoke: (channel, ...args) => {
      const fn = handlers.get(channel)
      if (!fn) throw new Error(`没有注册 ${channel}`)
      return fn(...args)
    }
  }
}

const outDir = await mkdtemp(join(tmpdir(), 'yan-review-svc-'))
const dataRoot = await mkdtemp(join(tmpdir(), 'yan-review-svc-data-'))
const repoDir = await mkdtemp(join(tmpdir(), 'yan-review-svc-repo-'))
const OID_BASE = 'a'.repeat(40)
const OID_HEAD = 'b'.repeat(40)

try {
  const serviceMod = await import(pathToFileURL(await compile(join(process.cwd(), 'src', 'main', 'review', 'service.ts'), join(outDir, 'service.mjs'))).href)
  const reviewShared = await import(pathToFileURL(await compile(join(process.cwd(), 'src', 'shared', 'review.ts'), join(outDir, 'review-shared.mjs'))).href)
  const ipcMod = await import(pathToFileURL(await compile(join(process.cwd(), 'src', 'main', 'ipc', 'review-ipc.ts'), join(outDir, 'review-ipc.mjs'))).href)
  const { ReviewService } = serviceMod
  const { ReviewAnnotationStore } = await import(pathToFileURL(await compile(join(process.cwd(), 'src', 'main', 'review', 'annotations.ts'), join(outDir, 'annotations.mjs'))).href)
  const { ReviewAgentCoordinator } = await import(pathToFileURL(await compile(join(process.cwd(), 'src', 'main', 'review', 'agent.ts'), join(outDir, 'agent.mjs'))).href)

  const authorize = async (cwd) => {
    const value = String(cwd ?? '')
    if (value.includes('denied')) return { ok: false, error: '目录未授权' }
    return { ok: true, cwd: value || repoDir }
  }

  const workingFiles = [
    { x: 'M', y: '.', path: 'src/a.ts', untracked: false, ignored: false, unmerged: false, staged: true, unstaged: false },
    { x: '?', y: '?', path: 'src/new.ts', untracked: true, ignored: false, unmerged: false, staged: false, unstaged: true }
  ]
  const readWorkingChanges = async (cwd) => {
    if (cwd !== repoDir) {
      return { ok: false, error: '未知目录', root: null, scope: '.', branch: null, detached: false, unborn: false, head: null, files: [], truncated: false }
    }
    return {
      ok: true,
      root: repoDir,
      scope: '.',
      branch: 'main',
      detached: false,
      unborn: false,
      head: 'head1',
      files: workingFiles,
      truncated: false
    }
  }

  const readWorkingDiff = async (cwd, path) => ({
    ok: true,
    path,
    patch: `diff --git a/${path} b/${path}\n+${path} changed\n`,
    truncated: false,
    binary: false,
    staged: false,
    unstaged: true,
    untracked: false,
    bytes: 32
  })

  function branchExec() {
    const calls = []
    return {
      calls,
      run: async (cwd, args) => {
        calls.push({ cwd, args })
        if (args.includes('--abbrev-ref')) return { ok: true, stdout: 'feat/x\n', stderr: '' }
        if (args.includes('--verify')) {
          const ref = String(args[args.length - 1] ?? '')
          return { ok: true, stdout: `${ref.startsWith('main') ? OID_BASE : OID_HEAD}\n`, stderr: '' }
        }
        if (args.includes('--name-status')) return { ok: true, stdout: 'M\0src/a.ts\0A\0src/b.ts\0', stderr: '' }
        if (args.includes('--numstat')) return { ok: true, stdout: '3\t1\tsrc/a.ts\0-\t-\tsrc/b.ts\0', stderr: '' }
        return { ok: true, stdout: '', stderr: '' }
      }
    }
  }

  const annotations = new ReviewAnnotationStore({ root: dataRoot })

  {
    const service = new ReviewService({ authorize, annotations, changes: { readWorkingChanges } })
    const changeSet = await service.changeSet({ source: 'uncommitted', cwd: repoDir })
    assert.equal(changeSet.ok, true)
    assert.equal(changeSet.files.length, 2)
    assert.equal(changeSet.files.find((f) => f.path === 'src/a.ts').status, 'modified')
    assert.equal(changeSet.files.find((f) => f.path === 'src/new.ts').status, 'untracked')
    assert.equal(changeSet.files[0].annotations, 0)
    const add = await service.addAnnotation({
      changeSetId: changeSet.id,
      scopeKey: changeSet.scopeKey,
      path: 'src/a.ts',
      lineStart: 12,
      body: '这里要兼容旧 token'
    })
    assert.equal(add.ok, true)
    const merged = await service.changeSet({ source: 'uncommitted', cwd: repoDir })
    assert.equal(merged.files.find((f) => f.path === 'src/a.ts').annotations, 1)
    ok('未提交变更集读取正确，批注计数合并到文件条目')
  }

  {
    const exec = branchExec()
    const service = new ReviewService({ authorize, annotations, changes: { exec, resolveRepo: async () => ({ root: repoDir }) } })
    const changeSet = await service.changeSet({ source: 'branch', cwd: repoDir, base: 'main' })
    assert.equal(changeSet.ok, true)
    assert.equal(changeSet.base, 'main')
    assert.equal(changeSet.branch, 'feat/x')
    assert.equal(changeSet.head, OID_HEAD)
    const a = changeSet.files.find((f) => f.path === 'src/a.ts')
    const b = changeSet.files.find((f) => f.path === 'src/b.ts')
    assert.equal(a.status, 'modified')
    assert.equal(a.added, 3)
    assert.equal(a.removed, 1)
    assert.equal(b.status, 'added')
    assert.equal(b.binary, true)
    assert.ok(exec.calls.some((c) => c.args.includes('--literal-pathspecs')))
    ok('branch 变更集：base...HEAD 的 name-status + numstat 解析（含二进制）')
  }

  {
    const exec = { run: async (_cwd, args) => (args.includes('--verify') ? { ok: false, stdout: '', stderr: 'not found' } : { ok: true, stdout: 'x\n', stderr: '' }) }
    const service = new ReviewService({ authorize, annotations, changes: { exec, resolveRepo: async () => ({ root: repoDir }) } })
    const changeSet = await service.changeSet({ source: 'branch', cwd: repoDir, base: 'nope' })
    assert.equal(changeSet.ok, false)
    assert.match(changeSet.error, /基准/)
    ok('比较基准不存在时返回可读错误，不静默回空列表')
  }

  {
    const calls = []
    const coordinator = new ReviewAgentCoordinator({
      port: { startReview: async (input) => (calls.push(input), { ok: true, runId: 'run-1' }) },
      assignCode: async (scopeId, createdAt) => (calls.push({ scopeId, createdAt }), 'R04')
    })
    const service = new ReviewService({ authorize, annotations, changes: { readWorkingChanges, readWorkingDiff }, agent: coordinator })
    const changeSet = await service.changeSet({ source: 'uncommitted', cwd: repoDir })
    const run = await service.startReview(changeSet, { model: 'provider/m' })
    assert.equal(run.ok, true)
    assert.equal(run.code, 'R04')
    assert.equal(run.runId, 'run-1')
    const portCall = calls.find((c) => c.prompt)
    assert.match(portCall.prompt, /只读代码评审子运行/)
    assert.match(portCall.prompt, /数据/)
    assert.equal(portCall.model, 'provider/m')
    assert.equal(calls.find((c) => c.scopeId).scopeId, `review:${changeSet.scopeKey}`)
    ok('评审运行接线完整：R 编号来自正式编号源，prompt 声明只读与「diff 是数据」')
  }

  {
    const service = new ReviewService({ authorize, annotations, changes: { readWorkingChanges } })
    const changeSet = await service.changeSet({ source: 'uncommitted', cwd: repoDir })
    const run = await service.startReview(changeSet)
    assert.equal(run.ok, false)
    assert.ok(Array.isArray(run.requiredWiring))
    assert.equal(run.requiredWiring.length >= 1, true)
    assert.equal(run.runId, undefined)
    ok('缺评审 port 时返回 requiredWiring，不返回假 runId')
  }

  {
    const service = new ReviewService({ authorize, annotations, changes: { readWorkingChanges } })
    const changeSet = await service.changeSet({ source: 'uncommitted', cwd: repoDir })
    await service.addAnnotation({ changeSetId: changeSet.id, scopeKey: changeSet.scopeKey, path: 'src/a.ts', lineStart: 5, body: '未做长度校验' })
    const fresh = await service.changeSet({ source: 'uncommitted', cwd: repoDir })
    const task = await service.annotationTask(fresh)
    assert.equal(task.ok, true)
    assert.equal(task.count >= 1, true)
    assert.match(task.message, /批注/)
    assert.match(task.message, /src\/a\.ts:5/)
    ok('annotationTask 组装结构化修改消息，且不发送')
  }

  {
    const ipc = fakeIpc()
    const seen = {}
    const service = new ReviewService({
      authorize,
      annotations,
      changes: { readWorkingChanges, readWorkingDiff },
      agent: new ReviewAgentCoordinator({
        port: { startReview: async (input) => (seen.start = input, { ok: true, runId: 'run-2' }) },
        assignCode: async () => 'R09'
      })
    })
    ipcMod.registerReviewIpc(ipc, { service })
    for (const channel of [
      'yan:review:changes',
      'yan:review:diff',
      'yan:review:annotations',
      'yan:review:annotationAdd',
      'yan:review:annotationUpdate',
      'yan:review:annotationRemove',
      'yan:review:annotationClear',
      'yan:review:annotationTask',
      'yan:review:start',
      'yan:review:ghStatus',
      'yan:review:commit',
      'yan:review:push',
      'yan:review:pr'
    ]) {
      assert.equal(ipc.has(channel), true, `缺少 ${channel}`)
    }
    const changes = await ipc.invoke('yan:review:changes', { source: 'uncommitted', cwd: repoDir })
    assert.equal(changes.ok, true)
    const start = await ipc.invoke('yan:review:start', {
      query: { source: 'uncommitted', cwd: repoDir },
      model: 'provider/m'
    })
    assert.equal(start.ok, true)
    assert.equal(start.code, 'R09')
    assert.equal(seen.start.model, 'provider/m')
    const forged = await ipc.invoke('yan:review:start', { changeSet: { ok: true, id: 'x', cwd: '/etc' } })
    assert.equal(forged.ok, false)
    ok('IPC 全部通道注册；start 以 query 重读变更集，忽略伪造对象')
  }

  {
    const ipc = fakeIpc()
    const service = new ReviewService({ authorize, annotations, changes: { readWorkingChanges } })
    ipcMod.registerReviewIpc(ipc, { service })
    const changeSet = await ipc.invoke('yan:review:changes', { source: 'uncommitted', cwd: repoDir })
    const added = await ipc.invoke('yan:review:annotationAdd', {
      changeSetId: changeSet.id,
      scopeKey: changeSet.scopeKey,
      path: 'src/a.ts',
      lineStart: 3,
      body: 'IPC 写入的批注'
    })
    assert.equal(added.ok, true)
    const list = await ipc.invoke('yan:review:annotations', changeSet.id, changeSet.scopeKey)
    assert.equal(list.annotations.some((a) => a.body === 'IPC 写入的批注'), true)
    const removed = await ipc.invoke('yan:review:annotationRemove', { changeSetId: changeSet.id, scopeKey: changeSet.scopeKey, id: added.annotation.id })
    assert.equal(removed.ok, true)
    ok('IPC 批注新增 / 读回 / 删除')
  }

  {
    const service = new ReviewService({ authorize, annotations, changes: { readWorkingChanges } })
    const outcome = await service.push({ cwd: repoDir, remote: 'origin', branch: 'feat', setUpstream: false })
    assert.equal(outcome.ok, false)
    assert.match(outcome.message, /未接线/)
    ok('Git 写适配未接线时明确报错，不假装推送成功')
  }

  {
    const service = new ReviewService({ authorize, annotations, changes: { readWorkingChanges } })
    const changeSet = await service.changeSet({ source: 'session', cwd: repoDir, sessionId: 's1' })
    assert.equal(changeSet.ok, false)
    assert.equal(changeSet.source, 'session')
    assert.equal(changeSet.unavailable, 'session-verifier-missing')
    assert.equal(changeSet.files.length, 0)
    ok('session 来源缺验证注入口：fail-closed，不静默当未提交')
  }

  {
    const sessionDeps = {
      findBaseline: async () => ({ id: 'cp1', sha: OID_BASE, at: 1, preview: '开始' }),
      readTree: async () => ({ ok: true, nameStatus: 'M\0src/a.ts\0', numstat: '5\t2\tsrc/a.ts\0', patch: 'patch-A', patchTruncated: false })
    }
    const service = new ReviewService({
      authorize,
      annotations,
      changes: {
        resolveRepo: async () => ({ root: repoDir }),
        verifySession: async ({ sessionId, cwd }) =>
          sessionId === 's1' && cwd === repoDir
            ? { ok: true, ownership: { sessionId, sessionKey: 'sk-1', cwd: repoDir } }
            : { ok: false, error: '会话不属于这个目录' },
        session: sessionDeps
      }
    })
    const changeSet = await service.changeSet({ source: 'session', cwd: repoDir, sessionId: 's1' })
    assert.equal(changeSet.ok, true)
    assert.equal(changeSet.source, 'session')
    assert.deepEqual(changeSet.sessionBaseline, { checkpointId: 'cp1', sha: OID_BASE, at: 1 })
    assert.equal(changeSet.revisionKind, 'content')
    assert.equal(changeSet.files[0].path, 'src/a.ts')
    assert.equal(changeSet.files[0].added, 5)
    const wrong = await service.changeSet({ source: 'session', cwd: repoDir, sessionId: 's2' })
    assert.equal(wrong.ok, false)
    assert.equal(wrong.unavailable, 'session-verification-failed')
    ok('session 来源用已验证基线的差异；错会话被拒')
  }

  {
    let patch = '+aaa\n-bbb\n'
    const readWorkingDiff = async (cwd, path) => ({
      ok: true, path, patch, truncated: false, binary: false, staged: false, unstaged: true, untracked: false, bytes: patch.length
    })
    const service = new ReviewService({ authorize, annotations, changes: { readWorkingChanges, readWorkingDiff } })
    const first = await service.changeSet({ source: 'uncommitted', cwd: repoDir })
    const same = await service.changeSet({ source: 'uncommitted', cwd: repoDir })
    assert.equal(first.revision, same.revision)
    patch = '+ccc\n-ddd\n'
    const changed = await service.changeSet({ source: 'uncommitted', cwd: repoDir })
    assert.notEqual(changed.revision, first.revision)
    assert.equal(changed.files.find((f) => f.path === 'src/a.ts').added, 1)
    assert.equal(changed.files.find((f) => f.path === 'src/a.ts').removed, 1)
    ok('working revision 随同文件内容变化；同增删数不同内容也变')
  }

  {
    let patch = '+one\n'
    const readWorkingDiff = async (cwd, path) => ({
      ok: true, path, patch, truncated: false, binary: false, staged: false, unstaged: true, untracked: false, bytes: patch.length
    })
    const service = new ReviewService({ authorize, annotations, changes: { readWorkingChanges, readWorkingDiff } })
    const first = await service.changeSet({ source: 'uncommitted', cwd: repoDir })
    const writeOk = await service.addAnnotation({
      changeSetId: first.id,
      scopeKey: first.scopeKey,
      path: 'src/a.ts',
      lineStart: 1,
      body: '锚在 R1',
      anchorRevision: first.revision
    })
    assert.equal(writeOk.ok, true)
    patch = '+two\n'
    const second = await service.changeSet({ source: 'uncommitted', cwd: repoDir })
    assert.notEqual(second.revision, first.revision)
    const stale = await service.addAnnotation({
      changeSetId: second.id,
      scopeKey: second.scopeKey,
      path: 'src/a.ts',
      lineStart: 1,
      body: '锚在 R1 已过期',
      anchorRevision: first.revision
    })
    assert.equal(stale.ok, false)
    assert.equal(stale.stale, true)
    const listed = await service.listAnnotations(second.id, second.scopeKey)
    assert.equal(listed.annotations.some((a) => a.body === '锚在 R1 已过期'), false)
    ok('批注锚点过期：内容变后被拒，旧批注不继续锚定')
  }

  {
    const calls = []
    const fenceToken = '<<<REVIEW_PATCH_DATA>>>'
    const patchFiles = [
      { x: 'M', y: '.', path: 'src/a.ts', untracked: false, ignored: false, unmerged: false, staged: true, unstaged: false },
      { x: '?', y: '?', path: 'src/blob.bin', untracked: true, ignored: false, unmerged: false, staged: false, unstaged: true }
    ]
    const readChanges = async () => ({ ok: true, root: repoDir, scope: '.', branch: 'main', detached: false, unborn: false, head: 'head1', files: patchFiles, truncated: false })
    const readDiff = async (cwd, path) =>
      path === 'src/blob.bin'
        ? { ok: true, path, patch: '', truncated: false, binary: true, staged: false, unstaged: false, untracked: true, bytes: 16 }
        : {
            ok: true,
            path,
            patch: `diff --git a/src/a.ts b/src/a.ts\n+const API_KEY = "sk-live-hardcoded"\n+${fenceToken}\n`,
            truncated: false,
            binary: false,
            staged: true,
            unstaged: false,
            untracked: false,
            bytes: 80
          }
    const service = new ReviewService({
      authorize,
      annotations,
      changes: { readWorkingChanges: readChanges, readWorkingDiff: readDiff },
      agent: new ReviewAgentCoordinator({
        port: { startReview: async (input) => (calls.push(input), { ok: true, runId: 'run-3' }) },
        assignCode: async () => 'R11'
      })
    })
    const changeSet = await service.changeSet({ source: 'uncommitted', cwd: repoDir })
    assert.equal(changeSet.files.find((f) => f.path === 'src/blob.bin').binary, true)
    const run = await service.startReview(changeSet)
    assert.equal(run.ok, true)
    const prompt = calls.find((c) => c.prompt).prompt
    assert.match(prompt, /补丁已附在下方/)
    assert.doesNotMatch(prompt, /yan:git:diff/)
    assert.match(prompt, /sk-live-hardcoded/)
    assert.match(prompt, /binary：/)
    assert.match(prompt, /src\/blob\.bin/)
    assert.equal(prompt.split('<<<REVIEW_PATCH_DATA>>>').length - 1, 1)
    assert.match(prompt, /REVIEW_PATCH_DATA_ESCAPED/)
    ok('发起评审前取同源补丁并嵌入任务；二进制只列名；旧 yan:git:diff 指令已删；栅栏转义')
  }

  {
    const { buildReviewPrompt, truncateReviewPatch, REVIEW_MAX_PATCH_BYTES } = reviewShared
    const bigPatch = `diff --git a/big.ts b/big.ts\n+${'x'.repeat(REVIEW_MAX_PATCH_BYTES + 1024)}\n`
    const bounded = truncateReviewPatch(bigPatch)
    assert.equal(bounded.truncated, true)
    assert.ok(Buffer.byteLength(bounded.text, 'utf8') <= REVIEW_MAX_PATCH_BYTES)
    const six = Array.from({ length: 6 }, (_, i) => ({
      path: `src/f${i}.ts`,
      patch: `+${'y'.repeat(REVIEW_MAX_PATCH_BYTES)}`,
      truncated: false,
      binary: false
    }))
    const prompt = buildReviewPrompt({
      code: 'R99',
      changeSet: { source: 'uncommitted', repoRoot: '/r', scope: '.', branch: null, base: null, files: [] },
      patches: [
        { path: 'src/a.ts', patch: `+${'z'.repeat(REVIEW_MAX_PATCH_BYTES)}`, truncated: false, binary: false },
        { path: 'src/blob.bin', patch: '', truncated: false, binary: true },
        { path: 'src/broken.ts', patch: '', truncated: false, binary: false, error: '权限不足' },
        ...six
      ]
    })
    assert.match(prompt, /truncated：/)
    assert.match(prompt, /本次补丁总量已达上限/)
    assert.match(prompt, /binary：/)
    assert.match(prompt, /未取得补丁：权限不足/)
    ok('buildReviewPrompt：单文件截断 / 总量上限 / binary 与未取得补丁标注')
  }

  console.log('\n评审 service / IPC：全部通过')
} finally {
  await rm(outDir, { recursive: true, force: true })
  await rm(dataRoot, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
}
