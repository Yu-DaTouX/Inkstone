import { runSuite } from './lib/test-suite.mjs'

const NETWORK = /^(?:[\\/]{2}(?![?.][\\/][a-zA-Z]:[\\/])|[\\/]\?\?[\\/])/

function fsSpy() {
  return {
    name: 'fs-spy',
    setup(build) {
      build.onResolve({ filter: /^(?:node:)?fs(?:\/promises)?$/ }, (args) =>
        args.namespace === 'fs-spy' ? { path: args.path, external: true } : { path: args.path.replace(/^node:/, ''), namespace: 'fs-spy' }
      )
      build.onLoad({ filter: /.*/, namespace: 'fs-spy' }, async (args) => {
        const real = await import(`node:${args.path}`)
        const names = Object.keys(real).filter((name) => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name))
        const lines = [
          `import * as real from 'node:${args.path}'`,
          `const touched = (globalThis.__networkTouched ??= [])`,
          `const network = ${NETWORK}`,
          `const wrap = (name, fn) => typeof fn !== 'function' ? fn : Object.assign(function (...args) {`,
          `  const mocked = typeof args[0] === 'string' ? globalThis.__fsMock?.get(name + ':' + args[0]) : undefined`,
          `  if (mocked !== undefined) return name.endsWith('Sync') ? mocked : Promise.resolve(mocked)`,
          `  for (const arg of args.slice(0, 2)) if (typeof arg === 'string' && network.test(arg)) {`,
          `    touched.push(name + ':' + arg)`,
          `    const error = Object.assign(new Error('ENOENT: blocked by test'), { code: 'ENOENT' })`,
          `    if (typeof args[args.length - 1] === 'function') return args[args.length - 1](error)`,
          `    if (name.endsWith('Sync') || name === 'existsSync') { if (name === 'existsSync') return false; throw error }`,
          `    return Promise.reject(error)`,
          `  }`,
          `  return fn.apply(this, args)`,
          `}, fn)`,
          ...names.map((name) => `export const ${name} = wrap(${JSON.stringify(name)}, real[${JSON.stringify(name)}])`),
          `export default real.default ?? real`
        ]
        return { contents: lines.join('\n'), loader: 'js', resolveDir: process.cwd() }
      })
    }
  }
}

const UNC_INPUTS = [
  '\\\\attacker.invalid\\share\\a.txt',
  '//attacker.invalid/share/a.txt',
  '\\\\?\\UNC\\attacker.invalid\\share\\a.txt',
  '\\\\.\\UNC\\attacker.invalid\\share\\a.txt',
  '\\??\\UNC\\attacker.invalid\\share\\a.txt',
  '/??/UNC/attacker.invalid/share/a.txt',
  '/\\attacker.invalid\\share\\a.txt'
]

await runSuite(import.meta.url, async (ok, compile) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const touched = () => (globalThis.__networkTouched ??= [])
  const clean = (label) => {
    const hits = touched().splice(0)
    ok(hits.length === 0, label, hits.join(', '))
  }
  const plugins = [fsSpy()]

  const refs = await compile('src/main/file-refs.ts', { plugins })
  const editor = await compile('src/main/file-editor.ts', { plugins })
  const store = await compile('src/main/html-artifact-preview-store.ts', { plugins })
  const dir = await mkdtemp(join(tmpdir(), 'yan-network-path-'))
  try {
    const local = join(dir, 'a.txt')
    await writeFile(local, 'hello\n')
    for (const input of UNC_INPUTS) {
      const stat = await refs.statPreview(input, dir)
      ok(!stat.ok, `statPreview 拒绝 ${input}`)
      clean(`statPreview 不访问网络路径 ${input}`)
      const preview = await refs.readPreview(input, dir)
      ok(!preview.ok && preview.issue === 'invalid', `readPreview 显示为不可预览 ${input}`, JSON.stringify(preview))
      clean(`readPreview 不访问网络路径 ${input}`)
      const bytes = await refs.readPreviewBytes(input, dir)
      ok(!bytes.ok, `readPreviewBytes 拒绝 ${input}`)
      clean(`readPreviewBytes 不访问网络路径 ${input}`)
      const edit = await editor.readEditableFile(dir, input)
      ok(!edit.ok && edit.error === 'denied', `编辑器读取拒绝 ${input}`, edit.error)
      clean(`编辑器读取不访问网络路径 ${input}`)
      const write = await editor.writeEditableFile(dir, input, 'x', null)
      ok(write.status === 'denied', `编辑器写入拒绝 ${input}`, write.status)
      clean(`编辑器写入不访问网络路径 ${input}`)
    }
    const html = new store.HtmlArtifactPreviewStore(dir)
    for (const input of ['\\\\attacker.invalid\\share\\a.html', '//attacker.invalid/share/a.html', '\\??\\UNC\\attacker.invalid\\share\\a.html']) {
      const prepared = await html.prepare(input)
      ok(!prepared.ok, `HTML 产物预览拒绝 ${input}`)
      clean(`HTML 产物预览不访问网络路径 ${input}`)
      await html.prepareForWorkspace(input, dir)
      clean(`工作区 HTML 预览不访问网络路径 ${input}`)
    }
    const fine = await refs.statPreview(local, dir)
    ok(fine.ok, '本地绝对路径照常预览')
    const relative = await refs.readPreview('a.txt', dir)
    ok(relative.ok && relative.text === 'hello\n', '项目内相对路径照常预览')

    for (const prefix of ['\\\\?\\', '\\\\.\\', '//?/']) {
      const long = prefix + local
      const longStat = await refs.statPreview(long, dir)
      ok(longStat.ok, `本地长路径照常预览 ${long}`, JSON.stringify(longStat))
      const longEdit = await editor.readEditableFile(dir, long)
      ok(longEdit.ok && longEdit.text === 'hello\n', `本地长路径照常编辑 ${long}`, JSON.stringify(longEdit).slice(0, 200))
      clean(`本地长路径不被当成网络路径 ${long}`)
    }

    const nas = '\\\\nas.invalid\\share\\proj'
    const mapped = 'Z:\\proj'
    const nasFile = `${nas}\\a.txt`
    const nasHtml = `${nas}\\page.html`
    const htmlBytes = Buffer.from('<p>hi</p>')
    const fakeFile = (size) => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size, mtimeMs: 1 })
    const fakeDir = { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, size: 0, mtimeMs: 1 }
    const handle = {
      stat: async () => fakeFile(htmlBytes.length),
      read: async (buffer, offset, length, position) => {
        const bytesRead = Math.max(0, Math.min(length, htmlBytes.length - position))
        htmlBytes.copy(buffer, offset, position, position + bytesRead)
        return { bytesRead, buffer }
      },
      close: async () => undefined
    }
    globalThis.__fsMock = new Map([
      [`realpath:${mapped}`, nas],
      [`stat:${nas}`, fakeDir],
      [`realpath:${nasFile}`, nasFile],
      [`stat:${nasFile}`, fakeFile(6)],
      [`lstat:${nasFile}`, fakeFile(6)],
      [`readFile:${nasFile}`, Buffer.from('hello\n')],
      [`realpath:${nasHtml}`, nasHtml],
      [`open:${nasHtml}`, handle]
    ])
    try {
      const mappedStat = await refs.statPreview(nasFile, mapped)
      ok(mappedStat.ok && mappedStat.abs === nasFile, '映射盘项目：realpath 得到的 UNC 路径仍可预览（新鲜度检查）', JSON.stringify(mappedStat))
      const mappedEdit = await editor.readEditableFile(mapped, nasFile)
      ok(mappedEdit.ok && mappedEdit.text === 'hello\n', '映射盘项目：编辑器可读 UNC 形式的项目文件', JSON.stringify(mappedEdit).slice(0, 200))
      const mappedHtml = await html.prepareForWorkspace(nasHtml, mapped)
      ok(mappedHtml.ok, '映射盘项目：HTML 预览可用 UNC 形式的项目文件', JSON.stringify(mappedHtml))
      clean('映射盘项目内的访问只落在项目共享上')
      for (const outside of ['\\\\nas.invalid\\share\\other\\a.txt', '\\\\attacker.invalid\\share\\proj\\a.txt']) {
        const denied = await refs.statPreview(outside, mapped)
        ok(!denied.ok, `映射盘项目外的网络路径仍拒绝 ${outside}`)
        clean(`映射盘项目外的网络路径不访问 ${outside}`)
      }
      const localRoot = await refs.statPreview(nasFile, dir)
      ok(!localRoot.ok, '本地项目下同一个 UNC 路径仍拒绝')
    } finally {
      globalThis.__fsMock = undefined
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  const gate = await compile('src/main/file-path-gate.ts')
  ok(gate.foreignNetworkPath('\\\\attacker\\s\\a.txt', 'C:\\proj'), '本地项目里出现的 UNC 路径算外部网络路径')
  ok(gate.foreignNetworkPath('\\\\attacker\\s\\a.txt'), '没有项目根时 UNC 路径算外部网络路径')
  ok(!gate.foreignNetworkPath('\\\\nas\\proj\\src\\a.ts', '\\\\nas\\proj'), '项目本身在网络共享上时，项目内的文件照常访问')
  ok(!gate.foreignNetworkPath('//nas/proj/src/a.ts', '\\\\nas\\proj'), '斜杠写法的项目内网络路径照常访问')
  ok(gate.foreignNetworkPath('\\\\nas\\other\\a.ts', '\\\\nas\\proj'), '同一主机上项目外的共享仍拒绝')
  ok(gate.foreignNetworkPath('\\\\evil\\proj\\a.ts', '\\\\nas\\proj'), '其他主机仍拒绝')
  ok(gate.foreignNetworkPath('\\??\\UNC\\nas\\proj\\a.ts', '\\\\nas\\proj'), 'NT 前缀写法一律拒绝')
  ok(!gate.foreignNetworkPath('C:\\proj\\a.ts', 'C:\\proj') && !gate.foreignNetworkPath('src/a.ts', 'C:\\proj'), '本地路径不受影响')

  const { isNetworkPath } = await compile('src/shared/network-path.ts', { platform: 'neutral' })
  const networkSamples = [...UNC_INPUTS, 'file://attacker/share/a.png', 'file:////attacker/share/a.png', 'file:///%5C%5Cattacker/share/a.png', 'FILE://attacker/s', 'file://localhost//attacker/s', '  \\\\attacker\\s']
  for (const value of networkSamples) {
    ok(isNetworkPath(value), `识别网络路径 ${value}`)
  }
  const deviceSamples = ['\\\\?\\UNC\\nas\\s\\a', '\\\\.\\pipe\\x', '\\\\?\\Volume{1b3b1146-0000-0000-0000-100000000000}\\a', '\\\\.\\C:\\..\\UNC\\attacker\\s', '\\\\?\\C:\\x\\..\\..\\UNC\\attacker\\s', '//./c:/../UNC/attacker/s', 'file:////?/UNC/attacker/s', '\\\\.\\C:\\.. \\UNC\\attacker\\s', '\\\\.\\C:\\.. .\\UNC\\attacker\\s', '\\\\.\\C:\\ ..\\x', '\\\\?\\C:\\a\\...\\b', '\\\\.\\C:\\a\\. \\b', '\\\\.\\C:\\a\\..  ']
  for (const value of deviceSamples) {
    ok(isNetworkPath(value), `设备路径与带 .. 的长路径仍拦 ${value}`)
  }
  const longLocalSamples = ['\\\\?\\C:\\Users\\a\\target\\debug\\x.rs', '\\\\.\\D:\\a.txt', '//?/C:/a.txt', '\\\\?\\c:', 'file:////?/C:/a.txt']
  for (const value of longLocalSamples) {
    ok(!isNetworkPath(value), `本地长路径不拦 ${value}`)
  }
  const localSamples = ['C:\\a\\b.txt', 'C:/a/b.txt', '/home/a/b.txt', 'src/a.ts', 'file:///C:/a/b.txt', 'file://localhost/C:/a.txt', 'file:///home/a.txt', 'https://example.com/a']
  for (const value of localSamples) {
    ok(!isNetworkPath(value), `不误伤本地路径 ${value}`)
  }
  const { isNetworkPath: inspectIsNetworkPath } = await import('../resources/pi-extensions/readonly-tools.js')
  const allSamples = [...networkSamples, ...deviceSamples, ...longLocalSamples, ...localSamples, '\\??\\C:\\a.txt', '%5C%5Cattacker%5Cs', '', '   ', 'file:', 'file://', 'file://?/C:/a', 'C:', '\\\\', '//']
  const mismatched = allSamples.filter((value) => inspectIsNetworkPath(value) !== isNetworkPath(value))
  ok(mismatched.length === 0, `git_inspect 里复制的 isNetworkPath 与共享实现在 ${allSamples.length} 个样例上结果一致`, JSON.stringify(mismatched))
  ok(inspectIsNetworkPath(42) === isNetworkPath(42) && inspectIsNetworkPath(undefined) === isNetworkPath(undefined), '非字符串输入结果一致')

  const { classifyLink } = await compile('src/shared/links.ts', { platform: 'neutral' })
  for (const href of ['\\\\attacker\\share\\x.txt', '//attacker/share/x.txt', 'file:////attacker/share/x.txt', 'file://attacker/share/x.png', 'file:///%5C%5Cattacker/share/x.png', '%5C%5Cattacker%5Cshare%5Cx.txt', '/??/UNC/attacker/share/x.txt', '/??/UNC/attacker/share/x.txt#L3', '/\\attacker\\share\\x.txt']) {
    ok(classifyLink(href).kind === 'invalid', `消息里的网络路径链接不可预览 ${href}`, JSON.stringify(classifyLink(href)))
  }
  ok(classifyLink('file:///C:/a/b.ts').kind === 'file' && classifyLink('C:\\a\\b.ts').kind === 'file' && classifyLink('src/a.ts').kind === 'file', '本地文件链接不受影响')

  const { parseVisualBlock } = await compile('src/shared/visual-blocks.ts', { platform: 'neutral' })
  for (const image of ['/\\attacker\\share\\a.png', '/??/UNC/attacker/share/a.png']) {
    const parsed = parseVisualBlock('yan-cards', JSON.stringify({ items: [{ title: 'x', image }] }))
    ok(!parsed.ok, `可视化卡片拒绝网络图片路径 ${image}`, JSON.stringify(parsed).slice(0, 200))
  }
  const fineCard = parseVisualBlock('yan-cards', JSON.stringify({ items: [{ title: 'x', image: 'C:\\pics\\a.png' }] }))
  ok(fineCard.ok, '可视化卡片的本地图片照常显示', JSON.stringify(fineCard).slice(0, 200))
})
