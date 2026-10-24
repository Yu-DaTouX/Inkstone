import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

await mkdir('.tmp/prompt-directories', { recursive: true })
const root = await mkdtemp(resolve('.tmp/prompt-directories/run-'))
const keys = ['YAN_DATA_DIR', 'YAN_PI_DIR', 'YAN_SESSIONS_DIR']
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
for (const [index, key] of keys.entries()) process.env[key] = join(root, ['data', 'pi', 'sessions'][index])

try {
  const outfile = join(root, 'fixture.mjs')
  await build({
    stdin: {
      contents: `export { registerCapabilitiesIpc } from ${JSON.stringify(resolve('src/main/ipc/capabilities-ipc.ts'))}; export { shell } from 'electron'`,
      resolveDir: process.cwd(),
      sourcefile: 'prompt-directories-fixture.ts'
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    plugins: [{
      name: 'electron-fixture',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          loader: 'js',
          contents: [
            'export const shell = { opened: [], error: "", failure: null, async openPath(path) { this.opened.push(path); if (this.failure) throw this.failure; return this.error }, showItemInFolder() {}, async trashItem() {} }',
            'export const app = { getPath: () => process.env.YAN_DATA_DIR, getLocale: () => "zh-CN", isPackaged: false, getVersion: () => "0.0.0" }',
            'export const dialog = { showMessageBox: async () => ({ response: 1 }) }',
            'export const ipcMain = { handle() {} }',
            'export const BrowserWindow = class {}',
            'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(String(value)), decryptString: value => Buffer.from(value).toString() }',
            'export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }'
          ].join('\n')
        }))
      }
    }]
  })
  const { registerCapabilitiesIpc, shell } = await import(pathToFileURL(outfile).href)
  const handlers = new Map()
  let runner
  let agent
  registerCapabilitiesIpc({ handle: (name, handler) => handlers.set(name, handler) }, {
    currentAgent: () => agent,
    registry: () => ({ activeRunner: () => runner }),
    thinExtensionPaths: () => [],
    settings: async () => ({ projects: [] }),
    isProjectTrusted: async () => false
  })
  const directories = handlers.get('yan:capabilities:promptDirectories')
  const open = handlers.get('yan:capabilities:openPromptDirectory')
  const create = handlers.get('yan:capabilities:createPromptTemplate')
  const user = join(process.env.YAN_PI_DIR, 'prompts')
  assert.deepEqual(directories(), { user }, '无当前会话时仍提供用户模板目录')
  assert.equal(existsSync(user), false, '读取目录位置不会创建目录')

  for (const value of [undefined, null, 42, {}, '', 'prompts', join(root, 'outside'), join(user, '..')]) {
    assert.equal((await open(value)).ok, false, '只能打开主进程列出的模板目录')
  }
  assert.deepEqual(shell.opened, [], '非法参数不调用系统打开')
  for (const input of [undefined, null, [], {}, { name: 42, content: 'text' }, { name: 'valid', content: 42 }]) {
    assert.equal((await create(input)).ok, false, '新建模板参数必须有效')
  }
  for (const name of ['../escape', 'a/b', 'a\\b', '/translate', 'name.md', 'a b', '_name', '-name', 'CON', 'nul', 'COM1', 'lpt9', 'a'.repeat(65)]) {
    assert.equal((await create({ name, content: 'fixture' })).ok, false, '拒绝路径穿越、系统保留名称和非法命令名')
  }
  for (const content of ['', '   ', 'a'.repeat(64_001), 'text\0text']) {
    assert.equal((await create({ name: 'valid', content })).ok, false, '拒绝空白、超长或含空字符的正文')
  }
  assert.equal((await create({ name: 'reload', content: 'fixture' })).ok, false, '拒绝覆盖内置命令')
  assert.equal(existsSync(user), false, '非法创建请求不会创建模板目录')
  assert.equal(existsSync(join(root, 'outside')), false, '非法路径不会被创建')

  assert.deepEqual(await open(user), { ok: true })
  assert.equal(existsSync(user), true, '用户点击时创建缺失的目录')
  assert.deepEqual(shell.opened, [user])
  const template = join(user, 'translate.md')
  await writeFile(template, 'fixture template')
  assert.deepEqual(await open(user), { ok: true })
  assert.equal(await readFile(template, 'utf8'), 'fixture template', '重复打开不覆盖已有模板')

  runner = { cwd: join(root, 'project-a') }
  const project = join(runner.cwd, '.pi', 'prompts')
  assert.deepEqual(directories(), { user, project }, '项目目录由当前运行实例推导')
  assert.equal(existsSync(project), false)
  assert.deepEqual(await open(project), { ok: true })
  assert.equal(existsSync(project), true)
  assert.equal(shell.opened.at(-1), project)

  runner = { cwd: join(root, 'project-b') }
  const count = shell.opened.length
  assert.equal((await open(project)).ok, false, '会话切换后拒绝旧项目目录')
  assert.equal(shell.opened.length, count)
  assert.equal(existsSync(join(runner.cwd, '.pi')), false, '拒绝旧请求时不创建新项目目录')
  assert.deepEqual(await open(directories().project), { ok: true })

  runner = undefined
  assert.deepEqual(directories(), { user })
  assert.equal((await open(project)).ok, false, '没有当前运行实例时不接受项目目录')
  shell.error = 'fixture shell error'
  assert.deepEqual(await open(user), { ok: false, error: 'fixture shell error' }, '系统打开失败不报告成功')
  shell.error = ''
  shell.failure = new Error('fixture exception')
  assert.deepEqual(await open(user), { ok: false, error: 'fixture exception' })
  shell.failure = null

  const blocked = join(root, 'not-a-directory')
  await writeFile(blocked, 'fixture')
  runner = { cwd: blocked }
  const beforeFailure = shell.opened.length
  assert.equal((await open(directories().project)).ok, false, '创建目录失败会返回错误')
  assert.equal(shell.opened.length, beforeFailure, '创建失败时不调用系统打开')

  runner = { cwd: 'relative-project' }
  assert.equal((await open(directories().project)).ok, false, '拒绝相对路径')
  if (process.platform === 'win32') {
    runner = { cwd: '\\\\fixture-server\\share' }
    assert.equal((await open(directories().project)).ok, false, '拒绝网络路径')
  }
  const created = await create({ name: ' simple ', content: ' 翻译成英文，只输出译文。 ' })
  assert.equal(created.ok, true)
  assert.equal(created.path, join(user, 'simple.md'), '只写入用户模板目录')
  assert.equal(await readFile(created.path, 'utf8'), '---\ndescription: "翻译成英文，只输出译文。"\n---\n\n翻译成英文，只输出译文。\n\n$@\n', '自动生成原生模板并追加命令参数')
  assert.equal((await create({ name: 'translate', content: 'replacement' })).ok, false)
  assert.equal(await readFile(template, 'utf8'), 'fixture template', '创建同名模板不会覆盖原文件')

  for (const [index, content] of ['$@', '$ARGUMENTS', '$1', '${@:2}', '${@:2:3}', '${1:-fallback}', '${ARGUMENTS:-fallback}'].entries()) {
    const result = await create({ name: `args-${index}`, content: `Existing ${content}` })
    assert.equal(result.ok, true)
    assert.equal((await readFile(result.path, 'utf8')).split('---\n\n')[1], `Existing ${content}\n`, '已有原生参数占位符时不重复追加')
  }
  const markdown = '---\n正文开头的分隔线不是元数据\n---\n含 "引号" 与冒号：内容'
  const markdownResult = await create({ name: 'markdown', content: markdown })
  assert.equal(markdownResult.ok, true)
  assert.equal((await readFile(markdownResult.path, 'utf8')).split('---\n\n')[1], `${markdown}\n\n$@\n`, '正文不会被误当作 frontmatter')

  const concurrent = await Promise.all([create({ name: 'concurrent', content: 'first' }), create({ name: 'concurrent', content: 'second' })])
  assert.equal(concurrent.filter(result => result.ok).length, 1, '并发同名创建也只允许一次成功')
  await mkdir(join(user, 'directory-target.md'))
  assert.equal((await create({ name: 'directory-target', content: 'fixture' })).ok, false, '不覆盖已有目录')

  agent = { listCommands: async () => [{ name: 'EXISTING', source: 'extension' }] }
  assert.equal((await create({ name: 'existing', content: 'fixture' })).ok, false, '检查当前扩展命令重名，忽略大小写')
  agent = { listCommands: async () => { throw new Error('fixture command list failure') } }
  const failed = await create({ name: 'unlisted', content: 'fixture' })
  assert.equal(failed.ok, false)
  assert.equal(existsSync(join(user, 'unlisted.md')), false, '读取命令失败时不写入无法确认的模板')

  console.log('test-prompt-directories: ok')
} finally {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
  await rm(root, { recursive: true, force: true })
}
