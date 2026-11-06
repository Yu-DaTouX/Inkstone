import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'model-text-'))
const entry = join(dir, 'entry.ts')
const root = process.cwd().split('\\').join('/')
await writeFile(entry, `
export * from '${root}/src/shared/ui-lang'
export { buildSubagentNotice } from '${root}/src/shared/subagent-notice'
export { asModelText } from '${root}/src/main/model-text'
`)
const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
const file = join(dir, 'bundle.mjs')
await writeFile(file, result.outputFiles[0].text)
const lib = await import(pathToFileURL(file).href)

lib.setUiLang('en-US')
const reason = lib.pick('worktree 已合并、放弃或归档清理，原工作树不在了', 'The worktree was merged, discarded or cleaned up')
assert.match(reason, /^The worktree/)
const notice = lib.buildSubagentNotice({
  id: 'sa-1', task: 't', status: 'done', isolation: 'worktree', review: 'archived',
  resumable: { ok: false, reason }
})
assert.match(notice, /不可续派：worktree 已合并/, '子代理通知里的不可续派原因按中文发给模型')
assert.doesNotMatch(notice, /merged, discarded/)

const inside = await lib.asModelText(async () => {
  await new Promise((resolve) => setTimeout(resolve, 2))
  return lib.pick('中文', 'English text')
})
assert.equal(inside, '中文')
assert.equal(lib.pick('中文', 'English text'), 'English text')
console.log('model-text ok')
