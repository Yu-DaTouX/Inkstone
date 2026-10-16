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

const OID_BASE = 'a'.repeat(40)
const OID_HEAD = 'b'.repeat(40)
const OID_HEAD2 = 'c'.repeat(40)

const outDir = await mkdtemp(join(tmpdir(), 'yan-review-prov-'))
const repoDir = await mkdtemp(join(tmpdir(), 'yan-review-prov-repo-'))

try {
  const changesMod = await import(
    pathToFileURL(await compile(join(process.cwd(), 'src', 'main', 'review', 'changes.ts'), join(outDir, 'changes.mjs'))).href
  )
  const { readReviewChangeSet, readReviewFileDiff } = changesMod

  const authorize = async (cwd) => {
    const value = String(cwd ?? '')
    if (value.includes('denied')) return { ok: false, error: '目录未授权' }
    return { ok: true, cwd: value || repoDir }
  }

  const workingFiles = [{ x: 'M', y: '.', path: 'src/a.ts', untracked: false, ignored: false, unmerged: false, staged: false, unstaged: true }]
  const readWorkingChanges = async (cwd) =>
    cwd === repoDir
      ? { ok: true, root: repoDir, scope: '.', branch: 'main', detached: false, unborn: false, head: 'head1', files: workingFiles, truncated: false }
      : { ok: false, error: '未知目录', root: null, scope: '.', branch: null, detached: false, unborn: false, head: null, files: [], truncated: false }

  const makeDiff = (patch, overrides = {}) => ({
    ok: true,
    path: 'src/a.ts',
    patch,
    truncated: false,
    binary: false,
    staged: false,
    unstaged: true,
    untracked: false,
    bytes: patch.length,
    ...overrides
  })

  const verifyOk = async ({ sessionId, cwd }) => ({ ok: true, ownership: { sessionId, sessionKey: 'sk-1', cwd: repoDir } })

  {
    let patch = '+same\n'
    const readWorkingDiff = async (cwd, path) => makeDiff(patch)
    const deps = { readWorkingChanges, readWorkingDiff }
    const a = await readReviewChangeSet({ source: 'uncommitted', cwd: repoDir }, authorize, deps)
    const b = await readReviewChangeSet({ source: 'uncommitted', cwd: repoDir }, authorize, deps)
    assert.equal(a.ok, true)
    assert.equal(a.revisionKind, 'content')
    assert.equal(a.revision, b.revision)
    patch = '+same but different content\n'
    const c = await readReviewChangeSet({ source: 'uncommitted', cwd: repoDir }, authorize, deps)
    assert.notEqual(c.revision, a.revision)
    ok('working revision 随同文件内容变化（HEAD / 文件名 / 状态不变）')
  }

  {
    let patch = '+one\n-gone\n'
    const readWorkingDiff = async (cwd, path) => makeDiff(patch)
    const deps = { readWorkingChanges, readWorkingDiff }
    const first = await readReviewChangeSet({ source: 'uncommitted', cwd: repoDir }, authorize, deps)
    assert.equal(first.files[0].added, 1)
    assert.equal(first.files[0].removed, 1)
    patch = '+two\n-lost\n'
    const second = await readReviewChangeSet({ source: 'uncommitted', cwd: repoDir }, authorize, deps)
    assert.equal(second.files[0].added, 1)
    assert.equal(second.files[0].removed, 1)
    assert.notEqual(second.revision, first.revision)
    ok('同增删数不同内容 → revision 不同')
  }

  {
    let headOid = OID_HEAD
    const exec = {
      calls: [],
      run: async (cwd, args) => {
        exec.calls.push(args)
        if (args.includes('--abbrev-ref')) return { ok: true, stdout: 'feat/x\n', stderr: '' }
        if (args.includes('--name-status')) return { ok: true, stdout: 'M\0src/a.ts\0', stderr: '' }
        if (args.includes('--numstat')) return { ok: true, stdout: '1\t1\tsrc/a.ts\0', stderr: '' }
        if (args.includes('--verify')) {
          const ref = String(args[args.length - 1] ?? '')
          return { ok: true, stdout: `${ref.startsWith('main') ? OID_BASE : headOid}\n`, stderr: '' }
        }
        return { ok: true, stdout: '', stderr: '' }
      }
    }
    const deps = { exec, resolveRepo: async () => ({ root: repoDir }) }
    const first = await readReviewChangeSet({ source: 'branch', cwd: repoDir, base: 'main' }, authorize, deps)
    assert.equal(first.ok, true)
    assert.equal(first.base, 'main')
    assert.equal(first.branch, 'feat/x')
    assert.equal(first.head, OID_HEAD)
    assert.ok(exec.calls.some((args) => args.includes(`${OID_BASE}...${OID_HEAD}`)))
    headOid = OID_HEAD2
    const moved = await readReviewChangeSet({ source: 'branch', cwd: repoDir, base: 'main' }, authorize, deps)
    assert.equal(moved.head, OID_HEAD2)
    assert.notEqual(moved.revision, first.revision)
    ok('branch 两端绑定提交 OID；ref 移动 → head / revision 改变')
  }

  {
    const exec = {
      calls: [],
      run: async (cwd, args) => {
        exec.calls.push(args)
        if (args.includes('--verify')) {
          const ref = String(args[args.length - 1] ?? '')
          return { ok: true, stdout: `${ref.startsWith('main') ? OID_BASE : OID_HEAD}\n`, stderr: '' }
        }
        if (args.includes('--patch')) return { ok: true, stdout: 'diff --git a/src/a.ts b/src/a.ts\n', stderr: '' }
        return { ok: true, stdout: '', stderr: '' }
      }
    }
    const diff = await readReviewFileDiff(repoDir, 'src/a.ts', 'branch', { base: 'main' }, authorize, { exec, resolveRepo: async () => ({ root: repoDir }) })
    assert.equal(diff.ok, true)
    assert.ok(exec.calls.some((args) => args.includes(`${OID_BASE}...${OID_HEAD}`)))
    ok('branch 单文件正文与变更集同一 OID 版本')
  }

  {
    const missing = await readReviewChangeSet({ source: 'session', cwd: repoDir, sessionId: 's1' }, authorize, {})
    assert.equal(missing.ok, false)
    assert.equal(missing.source, 'session')
    assert.equal(missing.unavailable, 'session-verifier-missing')

    const wrongSession = await readReviewChangeSet(
      { source: 'session', cwd: repoDir, sessionId: 's2' },
      authorize,
      { verifySession: async () => ({ ok: false, error: '会话不属于这个目录' }) }
    )
    assert.equal(wrongSession.ok, false)
    assert.equal(wrongSession.unavailable, 'session-verification-failed')

    const wrongCwd = await readReviewChangeSet(
      { source: 'session', cwd: repoDir, sessionId: 's1' },
      authorize,
      { verifySession: async () => ({ ok: true, ownership: { sessionId: 's1', sessionKey: 'sk', cwd: 'denied-dir' } }) }
    )
    assert.equal(wrongCwd.ok, false)
    assert.equal(wrongCwd.unavailable, 'session-verification-failed')

    const noSessionId = await readReviewChangeSet({ source: 'session', cwd: repoDir }, authorize, { verifySession: verifyOk })
    assert.equal(noSessionId.ok, false)
    assert.equal(noSessionId.unavailable, 'session-verification-failed')
    ok('session 缺验证 / 验证失败 / 错 cwd / 缺 id：fail-closed')
  }

  {
    let readTreeCalled = false
    const deps = {
      verifySession: verifyOk,
      resolveRepo: async () => ({ root: repoDir }),
      session: {
        findBaseline: async () => null,
        readTree: async () => {
          readTreeCalled = true
          throw new Error('无基线时不应读取')
        }
      }
    }
    const result = await readReviewChangeSet({ source: 'session', cwd: repoDir, sessionId: 's1' }, authorize, deps)
    assert.equal(result.ok, false)
    assert.equal(result.source, 'session')
    assert.equal(result.unavailable, 'session-baseline-missing')
    assert.equal(result.files.length, 0)
    assert.equal(result.revision, '')
    assert.equal(readTreeCalled, false)
    ok('无会话基线：明确 unavailable，不伪装成未提交改动')
  }

  {
    let patch = 'patch-A'
    const seenTreeShas = []
    const seenFileShas = []
    const session = {
      findBaseline: async () => ({ id: 'cp1', sha: OID_BASE, at: 10, preview: '开始' }),
      readTree: async (cwd, sha) => {
        seenTreeShas.push(sha)
        return { ok: true, nameStatus: 'M\0src/a.ts\0A\0bin.dat\0', numstat: '3\t1\tsrc/a.ts\0-\t-\tbin.dat\0', patch, patchTruncated: false }
      },
      readFile: async (cwd, sha, rel) => {
        seenFileShas.push(sha)
        return { ok: true, path: rel, patch, truncated: false, binary: false, bytes: patch.length }
      }
    }
    const deps = { verifySession: verifyOk, resolveRepo: async () => ({ root: repoDir }), session }
    const first = await readReviewChangeSet({ source: 'session', cwd: repoDir, sessionId: 's1' }, authorize, deps)
    assert.equal(first.ok, true)
    assert.deepEqual(first.sessionBaseline, { checkpointId: 'cp1', sha: OID_BASE, at: 10 })
    assert.equal(first.files.find((f) => f.path === 'bin.dat').binary, true)
    assert.equal(first.files.find((f) => f.path === 'src/a.ts').added, 3)
    patch = 'patch-B'
    const second = await readReviewChangeSet({ source: 'session', cwd: repoDir, sessionId: 's1' }, authorize, deps)
    assert.notEqual(second.revision, first.revision)
    const fileDiff = await readReviewFileDiff(repoDir, 'src/a.ts', 'session', { sessionId: 's1' }, authorize, deps)
    assert.equal(fileDiff.ok, true)
    assert.ok(seenTreeShas.every((sha) => sha === OID_BASE))
    assert.ok(seenFileShas.every((sha) => sha === OID_BASE))
    ok('session 基线清单 / 补丁 / 单文件正文同 sha；内容变化 revision 变')
  }

  {
    let baselineSha = OID_BASE
    const deps = {
      verifySession: verifyOk,
      resolveRepo: async () => ({ root: repoDir }),
      session: {
        findBaseline: async () => ({ id: 'cp1', sha: baselineSha, at: 10, preview: '' }),
        readFile: async (cwd, sha, rel) => ({ ok: true, path: rel, patch: `patch@${sha}`, truncated: false, binary: false, bytes: 4 })
      }
    }
    const first = await readReviewFileDiff(repoDir, 'src/a.ts', 'session', { sessionId: 's1' }, authorize, deps)
    baselineSha = OID_HEAD
    const late = await readReviewFileDiff(repoDir, 'src/a.ts', 'session', { sessionId: 's1' }, authorize, deps)
    assert.match(first.patch, new RegExp(OID_BASE))
    assert.match(late.patch, new RegExp(OID_HEAD))
    assert.notEqual(first.patch, late.patch)
    ok('迟到的 session 补丁读取解析当前基线，不缓存旧 sha')
  }

  {
    const diff = await readReviewFileDiff(repoDir, 'src/a.ts', 'session', {}, authorize, { verifySession: verifyOk })
    assert.equal(diff.ok, false)
    assert.match(diff.error, /会话标识/)
    ok('session 补丁请求缺 sessionId：拒绝，不读主仓')
  }

  {
    const truncated = await readReviewChangeSet(
      { source: 'session', cwd: repoDir, sessionId: 's1' },
      authorize,
      {
        verifySession: verifyOk,
        session: {
          findBaseline: async () => ({ id: 'cp', sha: OID_BASE, at: 1, preview: '' }),
          readTree: async () => ({ ok: true, nameStatus: 'M\0src/a.ts\0', numstat: '1\t1\tsrc/a.ts\0', patch: 'x', patchTruncated: true })
        }
      }
    )
    assert.equal(truncated.revisionPartial, true)

    const many = Array.from({ length: 2001 }, (_, i) => `M\0d/f${i}.ts\0`).join('')
    const overflow = await readReviewChangeSet(
      { source: 'session', cwd: repoDir, sessionId: 's1' },
      authorize,
      {
        verifySession: verifyOk,
        session: {
          findBaseline: async () => ({ id: 'cp', sha: OID_BASE, at: 1, preview: '' }),
          readTree: async () => ({ ok: true, nameStatus: many, numstat: '1\t1\td/f0.ts\0', patch: 'x', patchTruncated: false })
        }
      }
    )
    assert.equal(overflow.truncated, true)
    assert.equal(overflow.files.length, 2001)
    ok('补丁截断 / 文件数超限：标记 revisionPartial / truncated，不假装完整')
  }

  console.log('\n评审变更集真实来源与内容 revision：全部通过')
} finally {
  await rm(outDir, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
}
