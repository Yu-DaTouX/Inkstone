#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const posix = (p) => p.replace(/\\/g, '/')

async function load(dir) {
  const entry = join(dir, 'entry.ts')
  const session = posix(join(ROOT, 'src/renderer/src/features/session'))
  const shared = posix(join(ROOT, 'src/shared'))
  await writeFile(entry, [
    `export * from '${session}/tool-title.ts'`,
    `export * from '${session}/tool-summary.ts'`,
    `export * from '${session}/tool-run-model.ts'`,
    `export * from '${session}/turn-process.ts'`,
    `export * from '${shared}/danger-block.ts'`,
    `export { sessionText } from '${session}/text.ts'`
  ].join('\n'))
  const outfile = join(dir, 'bundle.mjs')
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', jsx: 'automatic' })
  return import(pathToFileURL(outfile).href)
}

let seq = 0
const call = (name, args = {}, status = 'ok', extra = {}) => ({ id: `call-${++seq}`, name, args, status, ...extra })

let pass = 0
let fail = 0
function ok(cond, label, detail) {
  if (cond) {
    pass += 1
    process.stdout.write(`  ✓ ${label}\n`)
  } else {
    fail += 1
    process.stdout.write(`  ✗ ${label}  ← 实际: ${detail === undefined ? '' : JSON.stringify(detail)}\n`)
  }
}
function group(name) {
  process.stdout.write(`\n▌${name}\n`)
}

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-tool-title-'))
  try {
    const m = await load(dir)
    const zh = (key, vars) => m.sessionText('zh-CN', key, vars)
    const en = (key, vars) => m.sessionText('en-US', key, vars)

    group('六类常用工具的单步标题：完成 / 进行中 / 失败三种时态，中英各一份')
    {
      const cases = [
        ['read', 'stepRead', 'stepReadRunning', 'stepReadFailed'],
        ['bash', 'stepRan', 'stepRunning', 'stepRunFailed'],
        ['edit', 'stepEdited', 'stepEditing', 'stepEditFailed'],
        ['write', 'stepCreated', 'stepCreating', 'stepWriteFailed'],
        ['grep', 'stepSearched', 'stepSearching', 'stepSearchFailed'],
        ['ls', 'stepListed', 'stepListing', 'stepListFailed'],
        ['web_search', 'stepWebSearched', 'stepWebSearching', 'stepWebSearchFailed']
      ]
      for (const [name, done, running, failed] of cases) {
        const base = call(name, { path: 'src/a.ts', pattern: 'x', query: 'y', command: 'ls', url: 'https://example.com' })
        ok(m.toolStepTitle(base, zh).label === zh(done), `${name} 完成时用完成后动词`, m.toolStepTitle(base, zh).label)
        ok(m.toolStepTitle({ ...base, status: 'running' }, zh).label === zh(running), `${name} 进行中用进行时动词`, m.toolStepTitle({ ...base, status: 'running' }, zh).label)
        ok(m.toolStepTitle({ ...base, status: 'error' }, zh).label === zh(failed), `${name} 失败用失败时动词`, m.toolStepTitle({ ...base, status: 'error' }, zh).label)
        ok(m.toolStepTitle(base, en).label === en(done), `${name} 英文完成时动词`, m.toolStepTitle(base, en).label)
        ok(m.toolStepTitle({ ...base, status: 'running' }, en).label === en(running), `${name} 英文进行时动词`, m.toolStepTitle({ ...base, status: 'running' }, en).label)
      }
      const described = m.toolStepTitle(call('bash', { command: 'sed -n 1,20p a.ts', description: '查看构建日志' }), zh)
      ok(described.label === '查看构建日志' && described.meta === '' && described.code === false, '命令带说明时标题只显示说明，不显示原始命令', described)
      const blank = m.toolStepTitle(call('bash', { command: 'ls', description: '  ' }), zh)
      ok(blank.meta === 'ls' && blank.code === true, '说明为空时回退到命令', blank)
      ok(m.stepDescription(call('bash', { command: 'ls', description: 'x'.repeat(300) })).length === 120, '说明过长时截断')
      const todo = m.toolStepTitle(call('todos', { action: 'set', items: [{}, {}, {}] }), zh)
      ok(todo.label === '更新待办' && todo.meta === '3 项', '待办工具显示「更新待办 · N 项」，不露参数名', todo)
      ok(m.toolStepTitle(call('todos', { action: 'clear' }), en).label === 'Updated to-dos' && m.toolStepTitle(call('todos', { action: 'clear' }), en).meta === '', '没有条目时只显示动作')
      ok(en('stepRead') === 'Read' && en('stepReadRunning') === 'Reading' && en('stepReadFailed') === 'Failed to read', '英文动词照参考的时态写法', [en('stepRead'), en('stepReadRunning'), en('stepReadFailed')])
      ok(en('stepRan') === 'Ran' && en('stepEdited') === 'Edited' && en('stepListed') === 'Listed', '命令/编辑/列目录的完成时', [en('stepRan'), en('stepEdited'), en('stepListed')])
    }

    group('已取消不当作失败：沿用完成时动词')
    {
      const cancelled = call('bash', { command: 'sleep 9' }, 'error', { cancelled: true })
      ok(m.stepState(cancelled) === 'done', '已取消归为完成态', m.stepState(cancelled))
      ok(m.toolStepTitle(cancelled, en).label === 'Ran', '取消的命令不写失败', m.toolStepTitle(cancelled, en).label)
    }

    group('标题旁的元信息：文件名只留基名，命令是脱敏后的完整命令')
    {
      const read = m.toolStepTitle(call('read', { file_path: 'src/renderer/a.ts' }), zh)
      ok(read.label === '读取' && read.meta === 'a.ts' && read.code === false, 'read 的元信息是基名', read)
      const edit = m.toolStepTitle(call('edit', { path: 'D:\\\\repo\\\\src\\\\b.ts' }), zh)
      ok(edit.meta === 'b.ts', 'edit 的元信息是基名（兼容反斜杠路径）', edit.meta)
      const grep = m.toolStepTitle(call('grep', { pattern: 'toolStepTitle' }), zh)
      ok(grep.meta === 'toolStepTitle', 'grep 的元信息是模式', grep.meta)
      const ls = m.toolStepTitle(call('ls', { path: 'src/renderer/' }), zh)
      ok(ls.meta === 'src/renderer', 'ls 的元信息是目录（去掉尾斜杠）', ls.meta)
      const web = m.toolStepTitle(call('web_fetch', { url: 'https://example.com/a' }), zh)
      ok(web.label === '联网搜索' && web.meta === 'https://example.com/a', 'web 的元信息是地址', web)
      const bash = m.toolStepTitle(call('bash', { command: 'npm run test -- --token abc123' }), zh)
      ok(bash.code === true && bash.meta.includes('npm run test') && !bash.meta.includes('abc123'), '命令以代码样式显示且凭据已脱敏', bash)
      const mcp = m.toolStepTitle(call('mcp__srv__list_issues', { path: 'x/y.ts' }), zh)
      ok(mcp.label === 'mcp__srv__list_issues', '未覆盖类别的工具退回原始工具名', mcp.label)
      const mcpRead = m.toolStepTitle(call('mcp__srv__read_file', { path: 'x/y.ts' }), zh)
      ok(mcpRead.label === '读取' && mcpRead.meta === 'y.ts', 'MCP 读取类工具按读取显示', mcpRead)
    }

    group('bash 摘要只脱敏、不裁剪：命令本身照常保留')
    {
      const command = 'git log --oneline -5 && npm test -- --watch=false'
      ok(m.summarize(call('bash', { command })) === command, '无凭据命令原样返回', m.summarize(call('bash', { command })))
      const long = `echo ${'a'.repeat(9000)}`
      ok(m.summarize(call('bash', { command: long })) === long, '超长命令不截断', m.summarize(call('bash', { command: long })).length)
      ok(m.summarize(call('read', { path: 'src/a.ts' })) === 'a.ts', '非命令工具仍只取基名', m.summarize(call('read', { path: 'src/a.ts' })))
    }

    group('凭据脱敏：token / key / password / Authorization 等取值都替换为 ***')
    {
      const redact = m.redactCommandSecrets
      ok(redact('deploy --token abcdef123456') === 'deploy --token ***', '--token 的取值被替换', redact('deploy --token abcdef123456'))
      ok(redact('deploy --api-key=sk-live-123') === 'deploy --api-key=***', '--api-key=value 的取值被替换', redact('deploy --api-key=sk-live-123'))
      ok(redact('cli --password "hunter 2"') === 'cli --password ***', '--password 后的引号值被替换', redact('cli --password "hunter 2"'))
      ok(redact('curl -H "Authorization: Bearer abc.def" https://x.dev') === 'curl -H "Authorization: Bearer ***" https://x.dev', 'Authorization: Bearer 的令牌被替换', redact('curl -H "Authorization: Bearer abc.def" https://x.dev'))
      ok(redact('curl -H "X-Api-Key: k-123" https://x.dev') === 'curl -H "X-Api-Key: ***" https://x.dev', 'X-Api-Key 请求头被替换', redact('curl -H "X-Api-Key: k-123" https://x.dev'))
      ok(redact('curl https://user:s3cret@example.com/x') === 'curl https://user:***@example.com/x', 'URL 里的密码被替换', redact('curl https://user:s3cret@example.com/x'))
      ok(redact('curl "https://api.dev/v1?access_token=tok123&page=2"') === 'curl "https://api.dev/v1?access_token=***&page=2"', '查询串里的令牌被替换，其它参数保留', redact('curl "https://api.dev/v1?access_token=tok123&page=2"'))
      ok(redact('OPENAI_API_KEY=sk-1 npm run build') === 'OPENAI_API_KEY=*** npm run build', '环境变量里的 API key 被替换', redact('OPENAI_API_KEY=sk-1 npm run build'))
      ok(redact('GITHUB_TOKEN=ghp_x git push') === 'GITHUB_TOKEN=*** git push', 'TOKEN 环境变量被替换', redact('GITHUB_TOKEN=ghp_x git push'))
      ok(redact('psql postgres://app:pw@db:5432/app') === 'psql postgres://app:***@db:5432/app', '数据库连接串里的密码被替换', redact('psql postgres://app:pw@db:5432/app'))
      ok(redact('npm test -- --watch') === 'npm test -- --watch', '普通命令不受影响', redact('npm test -- --watch'))
      ok(redact('code --keyboard-layout us') === 'code --keyboard-layout us', '名字里带 key 但不是凭据的参数不受影响', redact('code --keyboard-layout us'))
      ok(redact('MONKEY=1 make') === 'MONKEY=1 make', '同名变量不含凭据词尾时不脱敏', redact('MONKEY=1 make'))
      ok(redact('') === '', '空命令原样返回', redact(''))
    }

    group('组摘要分段带失败标记（含部分失败），分段文字不带失败数，失败数只在扁平字符串里保留')
    {
      const tools = [
        call('read', { path: 'a.ts' }),
        call('bash', { command: 'false' }, 'error'),
        call('bash', { command: 'true' }, 'error')
      ]
      const summary = m.summarizeToolRun(tools)
      const parts = m.toolRunParts(summary, zh)
      ok(parts.some((part) => part.text.includes('读取 1 个文件')), '摘要含读取段', parts)
      ok(
        parts.some((part) => part.text.includes('运行 2 条命令') && !part.text.includes('个失败') && part.failed === true),
        '整类失败的命令段标红，但分段文字不带失败数',
        parts
      )
      const plainJoined = parts.map((part) => part.text).join('')
      const flatWithoutCounts = m.formatToolRun(summary, zh).replace(/（\d+ 个失败）/g, '')
      ok(flatWithoutCounts === plainJoined, '去掉失败数后，字符串摘要与分段拼回一致', { flatWithoutCounts, plainJoined })
      ok(m.formatToolRun(summary, zh).includes('（2 个失败）'), '扁平字符串摘要仍带失败数')
      const mixed = m.summarizeToolRun([
        call('read', { path: 'a.ts' }),
        call('read', { path: 'b.ts' }, 'error'),
        call('bash', { command: 'ls' })
      ])
      const mixedParts = m.toolRunParts(mixed, zh)
      ok(
        mixedParts.some((part) => part.text.includes('读取 2 个文件') && !part.text.includes('个失败') && part.failed === true),
        '部分失败的分段也标红，但文字不带失败数',
        mixedParts
      )
    }

    group('高危操作被拒绝：标题换成「已拒绝」，不算失败，展开仍保留原因原文')
    {
      const deniedText = '高危操作未获用户确认：递归删除大范围目录：/。用户拒绝了这次操作。请换一种更安全的做法，或向用户说明为什么必须这样做。'
      const feedbackText = '高危操作未获用户确认：递归删除大范围目录：/。用户拒绝了这次操作，并给出理由：改用回收站。请按这个理由调整做法后再试。请换一种更安全的做法，或向用户说明为什么必须这样做。'
      const noAnswerText = '高危操作未获用户确认：关机或重启。没有得到用户确认。请换一种更安全的做法，或向用户说明为什么必须这样做。'
      const hostText = '高危操作未获用户确认：关机或重启。没能取得用户确认（fetch failed）。请换一种更安全的做法，或向用户说明为什么必须这样做。'
      for (const text of [deniedText, feedbackText, noAnswerText]) {
        const denied = call('bash', { command: 'rm -rf /' }, 'error', { output: text })
        ok(m.stepState(denied) === 'denied', '拒绝与无答复都归为已拒绝态', m.stepState(denied))
        ok(m.toolStepTitle(denied, zh).label === '已拒绝运行', '中文标题按类别写已拒绝运行', m.toolStepTitle(denied, zh).label)
        ok(m.toolStepTitle(denied, en).label === 'Denied', '英文标题用 Denied', m.toolStepTitle(denied, en).label)
        ok(m.toolStepTitle(denied, zh).meta === 'rm -rf /', '展开标题仍带命令原文', m.toolStepTitle(denied, zh).meta)
      }
      ok(m.stepState(call('read', { path: 'a.ts' }, 'error', { output: deniedText })) === 'denied', '读取类被拦截也是已拒绝', m.stepState(call('read', { path: 'a.ts' }, 'error', { output: deniedText })))
      ok(m.stepVerbKey(call('edit', { path: 'a.ts' }, 'error', { output: deniedText }), zh) === '已拒绝编辑', '编辑类用已拒绝编辑', m.stepVerbKey(call('edit', { path: 'a.ts' }, 'error', { output: deniedText }), zh))
      const structured = call('bash', { command: 'rm -rf /' }, 'error', { denied: true })
      ok(m.stepState(structured) === 'denied', '主进程带 denied 标记时直接判已拒绝', m.stepState(structured))
      ok(m.stepState(call('bash', { command: 'true' }, 'error', { output: hostText })) === 'failed', '宿主故障仍按失败处理', m.stepState(call('bash', { command: 'true' }, 'error', { output: hostText })))
      ok(m.stepState(call('bash', { command: 'true' }, 'error', { output: deniedText, cancelled: true })) === 'done', '已取消优先归为完成态', m.stepState(call('bash', { command: 'true' }, 'error', { output: deniedText, cancelled: true })))
      ok(m.isDeniedCall(structured) === true && m.isDeniedCall(call('bash', { command: 'true' }, 'error', { output: hostText })) === false, 'isDeniedCall 只认拒绝与无答复', [m.isDeniedCall(structured), m.isDeniedCall(call('bash', { command: 'true' }, 'error', { output: hostText }))])
      const mixed = m.summarizeToolRun([
        call('read', { path: 'a.ts' }),
        call('bash', { command: 'rm -rf /' }, 'error', { output: deniedText })
      ])
      ok(mixed.failed === 0, '组摘要失败数不计已拒绝', mixed.failed)
      ok(!m.formatToolRun(mixed, zh).includes('失败'), '组摘要不写失败', m.formatToolRun(mixed, zh))
      ok(mixed.state === 'denied', '组状态以最后一个成员为准，已拒绝有独立状态', mixed.state)
    }

    process.stdout.write(`\n结果：${pass} 通过，${fail} 失败\n`)
    if (fail > 0) process.exitCode = 1
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

run().catch((err) => {
  process.stderr.write(`\n[未捕获] ${err && err.stack ? err.stack : err}\n`)
  process.exit(1)
})
