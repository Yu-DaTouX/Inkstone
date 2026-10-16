import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-review-data-'))
const previous = process.env.YAN_DATA_DIR
process.env.YAN_DATA_DIR = join(root, 'data')
let checks = 0
const ok = (condition, label) => { assert.ok(condition, label); checks++ }
const reject = async (action, label) => { await assert.rejects(action, undefined, label); checks++ }
try {
  const load = async (path, name) => {
    const outfile = join(root, `${name}.mjs`)
    await build({ entryPoints: [path], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', plugins: [{ name: 'electron-fixture', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const app = { getPath: () => process.env.YAN_DATA_DIR, getLocale: () => "en-US" }', loader: 'js' }))
    } }] })
    return import(pathToFileURL(outfile).href)
  }
  await mkdir(process.env.YAN_DATA_DIR, { recursive: true })
  const layout = await load('src/main/session-layout.ts', 'layout')
  await writeFile(layout.SESSION_LAYOUT_FILE, '{broken')
  await reject(() => layout.getSessionLayout(), '会话布局损坏拒绝读取')
  await reject(() => layout.rememberSession({ sessionId: 'fixture', cwd: root }), '会话布局损坏拒绝写回')
  ok(await readFile(layout.SESSION_LAYOUT_FILE, 'utf8') === '{broken', '会话布局原文保留')

  const sources = await load('src/main/sources.ts', 'sources')
  for (const invalid of ['', '.', '..']) { assert.throws(() => sources.sourcesDir(invalid)); checks++ }
  const normalize = await load('src/main/normalize.ts', 'normalize')
  for (const text of ['<div>user text</div>', '<?xml version="1.0"?><root>data</root>']) {
    ok(normalize.normalizeMessage({ role: 'user', content: text }, 1).text === text, '用户 HTML/XML 原文不被剥除')
  }

  const parser = await load('src/main/office/pdf-text.ts', 'parser')
  const stream = (text) => Buffer.concat([Buffer.from('<< /Filter /FlateDecode >>\nstream\n'), deflateSync(Buffer.from(`BT (${text}) Tj ET`)), Buffer.from('\nendstream\n')])
  const result = parser.parsePdfBuffer(Buffer.concat([Buffer.from('%PDF-1.4\n'), stream('First stream contains a sufficient amount of readable fixture text.'), stream('Second stream contains additional readable fixture content to extract.')]))
  ok(result.text?.includes('First stream') && result.text?.includes('Second stream'), 'PDF 两个压缩流均能解析')

  const memory = await load('src/main/project-memory-store.ts', 'memory')
  const memoryDir = join(root, 'memory-root', 'project-fixture'); await mkdir(join(memoryDir, memory.MANIFEST_FILE_NAME), { recursive: true })
  await writeFile(join(memoryDir, memory.MANIFEST_BACKUP_FILE_NAME), JSON.stringify({ version: 1, entries: [] }))
  const manifest = await memory.loadManifest('project-fixture', { root: join(root, 'memory-root') })
  ok(manifest.status === 'unreadable', '主 manifest 不可读时不能用备份重建覆盖')

  const tasks = await load('src/main/task-plan-store.ts', 'tasks')
  const taskDir = join(root, 'plans'); await mkdir(taskDir)
  const log = tasks.taskPlanLogPath('fixture', taskDir); await writeFile(log, '{"partial":')
  const applied = await tasks.applyTaskPlanOperation({ sessionId: 'fixture', round: 1, request: { action: 'add', operationId: 'fixture-op', items: [{ text: 'after partial' }] }, opts: { dir: taskDir } })
  ok(applied.ok, `半行任务日志之后仍可追加提交：${JSON.stringify(applied)}`)
  ok((await readFile(log, 'utf8')).startsWith('{"partial":\n'), '坏半行保留并与后续记录分隔')
  console.log(`数据安全定向回归通过：${checks} 项（隔离目录、布局、来源、PDF、manifest、任务日志）`)
} finally {
  if (previous === undefined) delete process.env.YAN_DATA_DIR; else process.env.YAN_DATA_DIR = previous
  await rm(root, { recursive: true, force: true })
}
