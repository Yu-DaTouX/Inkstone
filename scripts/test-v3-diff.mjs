import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const source = fileURLToPath(new URL('../src/renderer/src/features/diff/pure.ts', import.meta.url))
const result = await build({
  entryPoints: [source],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const mod = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

const { alignHunk, byteLength, DIFF_LIMITS, foldLines, formatBytes, isBinaryPatch, patchExceedsLimit, parsePatch, tokenizeLine, unquotePath, wordDiff } = mod

const workdir = mkdtempSync(join(tmpdir(), 'yan-v3-diff-'))
const patchPath = join(workdir, 'synthetic.patch')
const patchText = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,4 @@ context section',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  ' export default a',
  ''
].join('\n')
writeFileSync(patchPath, patchText, 'utf8')
const readBack = readFileSync(patchPath, 'utf8')
rmSync(workdir, { recursive: true, force: true })

{
  const parsed = parsePatch(readBack)
  assert.equal(parsed.files.length, 1, '一个文件')
  const file = parsed.files[0]
  assert.equal(file.path, 'src/app.ts', '路径剥掉 b/ 前缀')
  assert.equal(file.oldPath, 'src/app.ts', '旧路径剥掉 a/ 前缀')
  assert.equal(file.additions, 2, '新增计数来自实际 + 行')
  assert.equal(file.deletions, 1, '删除计数来自实际 - 行')
  assert.equal(file.hunks.length, 1)
  const hunk = file.hunks[0]
  assert.equal(hunk.oldStart, 1)
  assert.equal(hunk.oldCount, 3)
  assert.equal(hunk.newStart, 1)
  assert.equal(hunk.newCount, 4)
  assert.equal(hunk.section, 'context section', '保留 hunk 尾部的区段说明')
  assert.deepEqual(
    hunk.lines.map((l) => [l.kind, l.oldLine, l.newLine]),
    [
      ['context', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['context', 3, 4]
    ],
    '行号按 hunk 头 + 位置推导；新增行没有旧行号'
  )
  assert.equal(hunk.lines[0].text, 'const a = 1', '正文去掉前缀空格')
  assert.equal(hunk.lines[1].raw, '-const b = 2', 'raw 保留完整前缀')
}

{
  const multi = [
    'diff --git a/old/name.ts b/new/name.ts',
    'similarity index 90%',
    'rename from old/name.ts',
    'rename to new/name.ts',
    '--- a/old/name.ts',
    '+++ b/new/name.ts',
    '@@ -1 +1 @@',
    '-export const x = 1',
    '+export const x = 2',
    'diff --git a/added.txt b/added.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/added.txt',
    '@@ -0,0 +1,2 @@',
    '+hello',
    '+world',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/img.png b/img.png',
    'index 3333333..4444444 100644',
    'Binary files a/img.png and b/img.png differ'
  ].join('\n')
  const parsed = parsePatch(multi)
  assert.equal(parsed.files.length, 4, '四个文件块')
  const [renamed, added, deleted, binary] = parsed.files
  assert.equal(renamed.renamed, true)
  assert.equal(renamed.path, 'new/name.ts')
  assert.equal(renamed.oldPath, 'old/name.ts')
  assert.equal(added.newFile, true)
  assert.equal(added.path, 'added.txt', '新文件取 +++ 路径')
  assert.equal(added.additions, 2)
  assert.equal(deleted.deletedFile, true)
  assert.equal(deleted.path, 'gone.txt', '删除文件回退到旧路径')
  assert.equal(deleted.deletions, 1)
  assert.equal(binary.binary, true, '二进制标记')
  assert.equal(binary.hunks.length, 0, '二进制没有可渲染行')
  assert.equal(binary.path, 'img.png', '二进制也要有文件名')
}

{
  assert.equal(unquotePath('"\\344\\270\\255.txt"'), '中.txt', '八进制转义还原 UTF-8 中文')
  const quoted = ['diff --git "a/\\346\\226\\207.txt" "b/\\346\\226\\207.txt"', '--- "a/\\346\\226\\207.txt"', '+++ "b/\\346\\226\\207.txt"', '@@ -1 +1 @@', '-a', '+b'].join('\n')
  assert.equal(parsePatch(quoted).files[0].path, '文.txt')

  const crlf = 'diff --git a/x b/x\r\n--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n'
  const parsedCrlf = parsePatch(crlf)
  assert.equal(parsedCrlf.files[0].hunks[0].lines[1].text, 'b', 'CRLF 归一后正文不带 \\r')

  const implicit = ['--- a/x', '+++ b/x', '-old', '+new'].join('\n')
  const parsedImplicit = parsePatch(implicit)
  assert.equal(parsedImplicit.files[0].hunks.length, 1, '没有 @@ 也建隐式 hunk')
  assert.equal(parsedImplicit.files[0].hunks[0].lines[0].oldLine, null, '隐式 hunk 不捏造行号')
}

{
  const tricky = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', '--- became minus minus', '+++ plus plus'].join('\n')
  const hunk = parsePatch(tricky).files[0].hunks[0]
  assert.equal(hunk.lines[0].kind, 'del', 'hunk 内 --- 视为删除行')
  assert.equal(hunk.lines[0].text, '-- became minus minus')
  assert.equal(hunk.lines[1].kind, 'add', 'hunk 内 +++ 视为新增行')
}

{
  const patch = ['--- a/x', '+++ b/x', '@@ -1,5 +1,5 @@', ' ctx', ' ctx', ' ctx'].join('\n')
  const file = parsePatch(patch).files[0]
  assert.equal(file.additions, 0, '没有 + 行就是 0，不拿 hunk 计数冒充')
  assert.equal(file.deletions, 0)
}

{
  const patch = ['--- a/x', '+++ b/x', '@@ -1,4 +1,5 @@', ' keep', '-a1', '-a2', '+b1', '+b2', '+b3', ' tail'].join('\n')
  const hunk = parsePatch(patch).files[0].hunks[0]
  const rows = alignHunk(hunk.lines)
  assert.deepEqual(
    rows.map((r) => `${r.kind}:${r.left?.text ?? '_'}|${r.right?.text ?? '_'}`),
    ['context:keep|keep', 'replace:a1|b1', 'replace:a2|b2', 'add:_|b3', 'context:tail|tail'],
    '连续删除 / 新增按位置配对，多余的一侧补空'
  )
}

{
  const same = wordDiff('const a = 1', 'const a = 1')
  assert.equal(same.changed, false, '完全一致不标红')
  assert.deepEqual(same.left.map((s) => s.text).join(''), 'const a = 1', '拼接回原文')

  const d = wordDiff('const answer = 42', 'const answer = 43')
  assert.equal(d.changed, true)
  const leftChanged = d.left.filter((s) => s.changed).map((s) => s.text).join('')
  const rightChanged = d.right.filter((s) => s.changed).map((s) => s.text).join('')
  assert.equal(leftChanged, '42', '左侧只高亮变化的数字词元')
  assert.equal(rightChanged, '43', '右侧同理')
  assert.deepEqual(d.left.map((s) => s.text).join(''), 'const answer = 42', '左段拼接无损')

  assert.deepEqual(tokenizeLine('a=1;'), ['a', '=', '1', ';'], 'ASCII 词元切分')
  const zh = wordDiff('你好世界', '你好地球')
  assert.equal(zh.changed, true)
  assert.ok(zh.left.some((s) => s.changed), 'CJK 逐字切分也能定位变化')

  const big = 'x'.repeat(DIFF_LIMITS.maxWordChars + 10)
  const fallback = wordDiff(big, `${big}z`)
  assert.equal(fallback.left.length, 1, '超长输入整行降级')
  assert.equal(fallback.left[0].changed, true)
}

{
  const lines = [
    ...Array.from({ length: 10 }, (_, i) => ({ kind: 'context', text: `ctx${i}`, raw: ` ctx${i}`, oldLine: i + 1, newLine: i + 1 })),
    { kind: 'add', text: 'new', raw: '+new', oldLine: null, newLine: 11 },
    ...Array.from({ length: 10 }, (_, i) => ({ kind: 'context', text: `tail${i}`, raw: ` tail${i}`, oldLine: i + 11, newLine: i + 12 }))
  ]
  const folded = foldLines(lines, 3)
  const gaps = folded.filter((r) => r.kind === 'gap')
  assert.equal(gaps.length, 2, '头尾各折一段')
  assert.equal(gaps[0].count, 7, '头段保留紧邻改动的 3 行')
  assert.equal(gaps[1].count, 7, '尾段同理')
  assert.equal(folded.filter((r) => r.kind === 'line').length, 3 + 1 + 3, '改动与上下文保留')

  const noChange = foldLines(lines.map((l) => ({ ...l, kind: 'context' })), 3)
  assert.equal(noChange.length, 1, '整段未改动折成一条')
  assert.equal(noChange[0].kind, 'gap')
  assert.equal(noChange[0].count, 21, '折叠行数等于总行数')
  assert.equal(noChange[0].lines.length, 21, '折叠行可原样放回')

  const expanded = foldLines(lines, 100)
  assert.equal(expanded.every((r) => r.kind === 'line'), true, 'keep 足够大时不折叠')

  assert.deepEqual(foldLines([], 3), [], '空输入')
}

{
  assert.equal(byteLength('中'), 3, 'UTF-8 字节数')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(isBinaryPatch('Binary files a/x and b/x differ'), true)
  assert.equal(isBinaryPatch('GIT binary patch\nliteral 12'), true)
  assert.equal(isBinaryPatch('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b'), false)
  assert.equal(patchExceedsLimit('x'.repeat(10), 5), true)
  assert.equal(patchExceedsLimit('x'.repeat(10), 100), false)
  assert.equal(DIFF_LIMITS.maxBytes < DIFF_LIMITS.hardMaxBytes, true, '软上限要小于硬上限')
}

console.log('R4 diff 纯逻辑：解析 / 对齐 / 词差 / 折叠 / 降级 全部通过')
