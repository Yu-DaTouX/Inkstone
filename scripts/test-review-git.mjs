import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const worktree = await readFile('src/main/git-worktree.ts', 'utf8')
const actions = await readFile('src/main/git-actions.ts', 'utf8')
const links = await readFile('src/main/worktree-links.ts', 'utf8')
const checkpoints = await readFile('src/main/checkpoints.ts', 'utf8')

assert.match(worktree, /status', '--porcelain', '--untracked-files=all', '--ignored=matching'/)
assert.match(worktree, /if \(!status\.ok\)[\s\S]*?拒绝删除/)
assert.match(actions, /branch\.startsWith\('\+'\)/)
assert.match(actions, /refs\/heads\/\$\{branch\}:refs\/heads\/\$\{branch\}/)
assert.match(links, /code !== 'ENOENT'\) throw error/)
assert.match(links, /读取工作树关联表失败，未覆盖原数据/)
assert.match(checkpoints, /takeSnapshot\(cwd, sessionKey, text, 'turn', \(\) => expired\)/)
assert.match(checkpoints, /if \(!tree \|\| expired\(\)\) return null/)
assert.match(checkpoints, /await serialized\(lockKey/)
console.log('review-git assertions passed')
