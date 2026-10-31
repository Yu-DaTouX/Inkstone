import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { storeHelpers } from './app.mjs'
import { deflateSync } from 'node:zlib'

const SIZES = [
  { key: 'short', title: '卡片·少字' },
  { key: 'normal', title: '卡片·正常' },
  { key: 'long', title: '卡片·多字' }
]

const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} } }

function crc32(buffer) {
  let crc = ~0
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (~crc) >>> 0
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, tail])
}

function gradientPng(width, height, seed) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = (x * 255 / width + seed * 60) % 256
      raw[row + 2 + x * 3] = (y * 255 / height + seed * 30) % 256
      raw[row + 3 + x * 3] = 160 - seed * 20
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}

const LONG_PATH = 'src/features/reconciliation/pipeline/stages/normalize-currency-amounts-with-banker-rounding-and-fallback.ts'
const LONG_URL = 'https://example.com/docs/reference/ledger/reconciliation/rounding-rules/banker-rounding-and-currency-minor-units?utm_source=inkstone&utm_medium=card-gallery&utm_campaign=very-long-link'

function lines(count, make) {
  return Array.from({ length: count }, (_, i) => make(i + 1)).join('\n')
}

class Builder {
  constructor(cwd, startAt) {
    this.cwd = cwd
    this.rows = []
    this.parentId = null
    this.clock = startAt
    this.seq = 0
    this.marks = []
  }
  tick(ms = 20000) { this.clock += ms; return this.clock }
  push(row) {
    const id = randomBytes(4).toString('hex')
    this.rows.push({ ...row, id, parentId: this.parentId, timestamp: new Date(this.clock).toISOString() })
    this.parentId = id
    return id
  }
  mark(name) { this.marks.push({ name, messageIndex: this.seq }) }
  user(text, images = []) {
    this.tick()
    const content = [{ type: 'text', text }, ...images.map(data => ({ type: 'image', data, mimeType: 'image/png' }))]
    this.push({ type: 'message', message: { role: 'user', content, timestamp: this.clock } })
    return `m${this.seq++}`
  }
  assistant(content, stopReason = 'stop', errorMessage) {
    this.tick()
    const usage = { input: 12640, output: 842, cacheRead: 4096, cacheWrite: 0, totalTokens: 17578, cost: { input: 0.003, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0051 } }
    this.push({ type: 'message', message: { role: 'assistant', api: 'openai-responses', provider: 'fake', model: 'fake-model', content, stopReason, ...(errorMessage ? { errorMessage } : {}), usage, timestamp: this.clock } })
    return `m${this.seq++}`
  }
  result(toolCallId, toolName, text, extra = {}) {
    this.tick(3000)
    this.push({ type: 'message', message: { role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text }], isError: false, timestamp: this.clock, ...extra } })
  }
  bashExecution(command, output, exitCode) {
    this.tick()
    this.push({ type: 'message', message: { role: 'bashExecution', command, content: output, exitCode, cancelled: false, timestamp: this.clock } })
    this.seq++
  }
  custom(text, customType) {
    this.tick()
    this.push({ type: 'custom_message', customType, content: text, display: true })
    this.seq++
  }
  branchSummary(summary) {
    this.tick()
    this.push({ type: 'branch_summary', summary, fromId: this.parentId })
    this.seq++
  }
}

const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args })
const thinking = thought => ({ type: 'thinking', thinking: thought })
const text = value => ({ type: 'text', text: value })

function content(size) {
  const pick = (short, normal, long) => size === 'short' ? short : size === 'normal' ? normal : long
  const paragraph = '对账模块在汇总退款与分期付款时先把金额转成浮点数再相加，累计误差会在月末汇总里暴露出来；这次需要把计算统一改成以最小货币单位为单位的整数，同时保持历史报表的四舍五入口径不变。'
  const userTexts = {
    plain: pick('看下这个报错。', '帮我检查对账模块里金额舍入的问题，先复现再修复，修完跑一遍测试，别动无关文件。', `${paragraph}\n\n请先复现问题并写出能稳定复现的最小用例，再修复。\n\n涉及文件包括 ${LONG_PATH} 以及相邻的测试目录；参考说明见 ${LONG_URL}\n\n修完之后跑完整测试，并把改动总结成一份可以直接贴进 PR 描述的清单。注意：\n1. 不要改历史报表的舍入口径\n2. 保留现有的日志格式\n3. 不要引入新的依赖\n4. 任何需要人工确认的取舍先问我，不要自己定\n\n\`\`\`js\nconst total = items.reduce((sum, item) => sum + item.amount, 0)\n\`\`\``),
    files: pick('看这个文件。', '请对照这个文件和这张截图，看看数据对不对。', `请对照下面的文件和三张截图，逐项核对金额、币种和月份边界，并说明哪些记录需要人工复核。${paragraph}`),
    err: pick('再试一次。', '好的，请继续上一步。', `${paragraph}\n\n继续上一步，把剩下的部分也处理完，然后告诉我结果。`)
  }
  const reply = {
    short: '已修复，测试通过。',
    normal: '## 修复结果\n\n金额改为以分为单位的整数计算，避免了浮点误差。\n\n- 汇总函数 `sumAmounts` 现在只做整数加法\n- 新增两个边界用例：空批次与退款\n- 全部 **42** 个测试通过\n\n后续如果需要，可以把同样的做法用到导出模块。',
    long: `## 修复结果\n\n${paragraph}\n\n### 改动\n\n${lines(10, i => `- 第 ${i} 项：核对账本第 ${i} 行，金额与汇总一致；相关实现位于 \`${LONG_PATH}\`，测试覆盖对应分支与币种边界。`)}\n\n### 对照\n\n| 场景 | 修复前 | 修复后 | 备注 |\n| --- | --- | --- | --- |\n| 空批次 | 返回 NaN | 返回 0 | 与历史口径一致 |\n| 退款 | 提前舍入 | 精确到分 | 需要人工抽样复核 |\n| 分期付款 | 累计误差 0.03 | 无误差 | 月末汇总已验证 |\n\n\`\`\`js\nexport function sumAmounts(items) {\n  return items.reduce((sum, item) => sum + Math.round(item.amount * 100), 0) / 100 // 保持历史口径：先转成分，再统一除以一百输出\n}\n\`\`\`\n\n参考资料：${LONG_URL}\n\n${paragraph}`
  }
  const thought = pick('先看一下报错。', '先复现问题，再看汇总函数是不是在累加前就做了舍入。\n如果是，就改成整数分的累加。', lines(14, i => `考虑 ${i}：对照账本第 ${i} 批的汇总，浮点累加顺序会影响末位，需要确认是否在累加前就已经舍入，以及历史报表的口径是否依赖这个行为。`))
  const bashCommand = pick('npm test', 'npm test -- --reporter=dot && node scripts/check-ledger.js --month 2026-09', `cd ${LONG_PATH.split('/').slice(0, -1).join('/')} && npm test -- --reporter=spec --runInBand --testPathPattern="reconciliation|rounding|currency" 2>&1 | tee /tmp/ledger-test-output.log && node scripts/check-ledger.js --month 2026-09 --region all --format json --include-refunds --include-installments --out ./build/reports/ledger-2026-09-full-report.json`)
  const bashOutput = pick('3 passed', lines(12, i => `PASS  tests/ledger-${i}.test.js (0.${i}s)`) + '\n\nTests: 12 passed, 12 total', lines(80, i => `PASS  tests/reconciliation/pipeline/stage-${i}.test.js  (${i * 7} ms)  - covers rounding, currency minor units and month boundary handling for batch ${i}`) + '\n\nTests: 80 passed, 80 total')
  const description = pick('运行测试', '运行测试并核对对账脚本输出', '运行整个对账相关测试集并把输出同时写入日志文件，随后用检查脚本生成九月份的全量报告，确认退款和分期付款都包含在内')
  return { pick, userTexts, reply, thought, bashCommand, bashOutput, description }
}

function diffOf(path, status, added, removed, size) {
  const body = []
  for (let i = 0; i < removed; i++) body.push(`-  const total${i} = items.reduce((sum, item) => sum + item.amount, 0)`)
  for (let i = 0; i < added; i++) body.push(`+  const total${i} = items.reduce((sum, item) => sum + Math.round(item.amount * 100), 0) / 100`)
  const patch = `@@ -1,${removed + 2} +1,${added + 2} @@\n function sum(items) {\n${body.join('\n')}\n   return total0\n`
  const side = exists => ({ exists, size: exists ? 640 + size : 0 })
  return { path, before: side(status !== 'created'), after: side(status !== 'deleted'), added, removed, patch, status }
}

function piDiff(added, removed) {
  const out = []
  for (let i = 0; i < removed; i++) out.push(`-${String(i + 2).padStart(3)} const total${i} = items.reduce((sum, item) => sum + item.amount, 0)`)
  for (let i = 0; i < added; i++) out.push(`+${String(i + 2).padStart(3)} const total${i} = items.reduce((sum, item) => sum + Math.round(item.amount * 100), 0) / 100`)
  return out.join('\n')
}

function buildSession(size, ctx) {
  const c = content(size)
  const { pick } = c
  const b = new Builder(ctx.project, Date.now() - 6 * 3600000)
  const images = [gradientPng(160, 100, 0), gradientPng(160, 100, 1), gradientPng(160, 100, 2)].slice(0, pick(1, 1, 3)).map(data => data.toString('base64'))
  const approvals = []
  const artifacts = []
  const long = size === 'long'

  b.user(pick('先看看项目。', '先看看这个项目是做什么的。', `先看看这个项目是做什么的，${ctx.paragraph} 参考 ${LONG_URL}`))
  b.assistant([text(pick('这是一个对账项目。', '这是一个本地对账小项目，包含解析、汇总与报表三个部分。', `这是一个本地对账项目，包含解析、汇总与报表三个部分。${ctx.paragraph} 完整说明见 ${LONG_URL}，实现入口位于 ${LONG_PATH}。`))])
  b.mark('分支来源（首条助手回合顶部）')

  b.mark('用户消息·纯文本')
  b.user(c.userTexts.plain)
  b.mark('助手回复·纯文本与 Markdown')
  b.assistant([text(c.reply[size])])

  b.mark('用户消息·图片与文件引用')
  const refs = ctx.files.slice(0, pick(1, 2, 3)).map(file => `- ${file}`).join('\n')
  b.user(`${c.userTexts.files}\n\n（附件文件，可直接读取）\n${refs}`, images)

  b.mark('思考与工具步骤（bash 成功、读取、搜索、列目录）')
  b.assistant([thinking(c.thought), call('c-bash', 'bash', { command: c.bashCommand, description: c.description }), call('c-read', 'read', { path: pick('a.js', 'src/ledger/reconcile.js', LONG_PATH), offset: 1, limit: pick(20, 80, 400) }), call('c-grep', 'grep', { pattern: pick('sum', 'reduce\\(', 'Math\\.round|toFixed|parseFloat|Number\\(.*amount'), path: pick('.', 'src', 'src/features/reconciliation/pipeline') }), call('c-ls', 'ls', { path: pick('.', 'src/ledger', 'src/features/reconciliation/pipeline/stages') })], 'toolUse')
  b.result('c-bash', 'bash', c.bashOutput)
  b.result('c-read', 'read', lines(pick(3, 12, 60), i => `${i}  export const line${i} = compute(${i}, 'segment-${i}')${long ? ' // long trailing comment to show how read output wraps or truncates inside the expanded step card' : ''}`))
  b.result('c-grep', 'grep', lines(pick(1, 5, 30), i => `${pick('a.js', 'src/ledger/reconcile.js', LONG_PATH)}:${i * 3}: const total = items.reduce((sum, item) => sum + item.amount, 0)`))
  b.result('c-ls', 'ls', lines(pick(2, 8, 40), i => `${long ? 'normalize-currency-amounts-with-banker-rounding-' : 'file-'}${i}.js`))
  b.assistant([text(pick('看完了。', '看完了，问题在汇总函数里。', `看完了，问题在汇总函数里。${ctx.paragraph}`))])

  b.mark('工具失败：bash 非零退出、读取不存在的文件、被拒绝的高危操作')
  b.user(pick('再跑一次。', '再跑一次完整测试，顺便读一下配置。', '再跑一次完整测试，顺便读一下配置，并清理掉旧的注册表项。'))
  const failOutput = pick('1 failed', lines(10, i => `FAIL  tests/ledger-${i}.test.js\n  Expected: 100.10\n  Received: 100.09999999999999`) + '\nnpm ERR! Test failed.  See above for more details.', lines(60, i => `FAIL  tests/reconciliation/stage-${i}.test.js\n  AssertionError: expected 100.10 to equal 100.09999999999999 at ${LONG_PATH}:${i}:12`) + '\nnpm ERR! Test failed.  See above for more details.')
  b.assistant([call('c-fail-bash', 'bash', { command: pick('npm test', 'npm test -- --bail', 'npm test -- --bail --testPathPattern="reconciliation|rounding|currency" --maxWorkers=2 --coverage --coverageReporters=text-summary'), description: pick('运行测试', '运行完整测试', '运行完整测试并输出覆盖率摘要，遇到第一个失败就停止') }), call('c-fail-read', 'read', { path: pick('x.json', 'config/missing.json', `config/${LONG_PATH.replace(/\//g, '-')}.missing.json`) }), call('c-denied', 'bash', { command: 'reg delete "HKCU\\Software\\InkstoneCardGallery" /f', description: pick('清理注册表', '删除旧的注册表项', '删除旧的注册表项以重置本地缓存状态，这是一个会被拦截的高危操作示例') }), call('c-approved', 'bash', { command: 'git push origin main', description: pick('推送', '推送到远端', '把当前分支推送到远端仓库，需要用户确认的操作示例') })], 'toolUse')
  b.result('c-fail-bash', 'bash', failOutput, { isError: true })
  b.result('c-fail-read', 'read', `ENOENT: no such file or directory, open '${pick('x.json', 'config/missing.json', LONG_PATH)}'`, { isError: true })
  b.result('c-denied', 'bash', `高危操作未获用户确认：用户拒绝了这次操作${long ? '。' + ctx.paragraph : ''}`, { isError: true })
  b.result('c-approved', 'bash', pick('ok', 'To origin\n   a1b2c3d..e4f5a6b  main -> main', lines(20, i => `remote: resolving deltas ${i * 5}%`)))
  const askedAt = b.clock - 20000
  approvals.push(
    { id: randomUUID(), toolCallId: 'c-denied', kind: 'danger', tool: 'bash', title: pick('删除注册表项', '删除旧的注册表项', '删除当前用户注册表 HKCU\\Software\\InkstoneCardGallery 下的全部旧缓存状态项并强制跳过确认'), choice: 'deny', feedback: pick('不行。', '这个键不要删，先确认用途。', '这个键不要删。先去确认它是不是还被别的程序使用，确认之后把用途写进说明里再来问我，不要直接强制删除，也不要用 /f 参数跳过确认，谢谢。'), askedAt, at: askedAt + 4000 },
    { id: randomUUID(), toolCallId: 'c-approved', kind: 'permission', tool: 'bash', title: pick('推送', 'git push origin main', '把当前分支 main 推送到 origin 远端仓库并附带全部新建标签，包含两个本地提交'), choice: pick('once', 'session', 'remember'), askedAt, at: askedAt + 3000 }
  )
  b.assistant([text(pick('测试失败了，另外两步见上。', '测试仍有一个失败；注册表操作被拒绝了，推送已完成。', `测试仍有失败项；注册表操作被拒绝了，推送已完成。${ctx.paragraph}`))])

  b.mark('改动卡：edit / write / 删除（TurnChanges）与成果（artifacts）')
  b.user(pick('改一下。', '请修复金额舍入，并新增一个测试和说明文档。', `请修复金额舍入，并新增测试、说明文档和一份可以直接发给财务的报告。${ctx.paragraph}`))
  const editPath = pick('a.js', 'cards/ledger.js', `cards/${LONG_PATH}`)
  const editCalls = [
    call('c-edit', 'edit', { path: editPath, edits: [{ oldText: 'sum + item.amount', newText: 'sum + Math.round(item.amount * 100)' }] }),
    call('c-write', 'write', { path: pick('cards/b.js', 'cards/ledger.test.js', 'cards/features/reconciliation/pipeline/stages/normalize-currency-amounts-with-banker-rounding.test.ts'), content: 'test("rounds", () => {})\n' })
  ]
  if (size !== 'short') editCalls.push(call('c-edit2', 'edit', { path: 'cards/format.js', edits: [{ oldText: 'toFixed(2)', newText: 'toFixed(2).padStart(10)' }] }))
  if (long) editCalls.push(call('c-edit3', 'edit', { path: 'cards/report.js', edits: [{ oldText: 'a', newText: 'b' }] }), call('c-delete', 'bash', { command: 'rm cards/legacy-rounding.js', description: '删除旧文件' }))
  b.assistant(editCalls, 'toolUse')
  b.result('c-edit', 'edit', `Successfully replaced 1 block(s) in ${editPath}.`, { details: { diff: piDiff(pick(1, 2, 6), pick(1, 1, 4)), firstChangedLine: 2, fileDiff: diffOf(editPath, 'modified', pick(1, 2, 6), pick(1, 1, 4), 0) } })
  b.result('c-write', 'write', `Successfully wrote 24 bytes to ${editCalls[1].arguments.path}`, { details: { fileDiff: diffOf(editCalls[1].arguments.path, 'created', pick(3, 14, 120), 0, 1) } })
  if (size !== 'short') b.result('c-edit2', 'edit', 'Successfully replaced 1 block(s) in cards/format.js.', { details: { diff: piDiff(2, 2), firstChangedLine: 3, fileDiff: diffOf('cards/format.js', 'modified', 2, 2, 2) } })
  if (long) {
    b.result('c-edit3', 'edit', 'Successfully replaced 1 block(s) in cards/report.js.', { details: { diff: piDiff(30, 12), firstChangedLine: 3, fileDiff: diffOf('cards/report.js', 'modified', 30, 12, 3) } })
    b.result('c-delete', 'bash', '', { details: { fileDiff: diffOf('cards/legacy-rounding.js', 'deleted', 0, 48, 4) } })
  }
  const finalId = b.assistant([text(pick('改好了，成果见下。', '改好了：修复、测试和说明文档都已就绪，成果见下。', `改好了：修复、测试、说明文档和给财务的报告都已就绪，成果见下。${ctx.paragraph}`))])
  artifacts.push({ messageId: finalId, filename: pick('report.md', 'reconciliation-report.md', 'quarterly-reconciliation-report-with-a-very-long-descriptive-name-final-version-3.md'), mime: 'md', body: `# 对账报告\n\n${lines(pick(3, 12, 80), i => `- 批次 ${i}：金额一致，需要人工复核的记录 ${i % 3} 条`)}\n`, description: pick(undefined, '九月份对账结果', '九月份对账结果汇总：覆盖所有区域、退款与分期付款，附带需要人工复核的记录清单和每个批次的差异说明') })
  if (size !== 'short') {
    artifacts.push({ messageId: finalId, filename: pick('a.svg', 'trend.svg', 'monthly-reconciliation-difference-trend-by-region.svg'), mime: 'svg', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120"><rect width="240" height="120" fill="#264653"/><polyline fill="none" stroke="#e9c46a" stroke-width="4" points="10,100 60,70 110,80 160,40 220,20"/></svg>' })
    artifacts.push({ messageId: finalId, filename: 'preview.png', mime: 'png', body: gradientPng(240, 140, 1) })
  }
  if (long) {
    artifacts.push({ messageId: finalId, filename: 'ledger-export-2026-09.csv', mime: 'csv', body: lines(40, i => `${i},2026-09-${String((i % 28) + 1).padStart(2, '0')},${(i * 13.37).toFixed(2)},CNY`) })
    artifacts.push({ messageId: finalId, filename: 'bundle.zip', mime: 'zip', body: Buffer.from('PK-not-a-real-zip') })
    artifacts.push({ messageId: finalId, filename: 'removed-after-export.pdf', mime: 'pdf', body: null, description: '原始文件已被移走，用来显示不可用状态' })
  }

  b.mark('web-search：搜索来源卡与网页读取')
  b.user(pick('查一下资料。', '查找金额舍入的官方资料与开源实现。', `查找金额舍入的官方资料与开源实现，重点看银行家舍入与最小货币单位的做法。${ctx.paragraph}`))
  const sources = [
    { title: 'Readability：提取网页正文的开源实现', url: 'https://github.com/mozilla/readability', snippet: '正文解析与结构提取', published: '2026-10-29', readState: 'discovered' },
    { title: 'MDN：Number.prototype.toFixed', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/toFixed', snippet: '数值格式化与舍入', published: '2026-10-28', readState: 'read' },
    { title: 'React：构建交互界面的官方文档', url: 'https://react.dev/learn', snippet: '界面与状态管理', readState: 'discovered', cached: true },
    { title: 'Wikipedia：Rounding', url: 'https://en.wikipedia.org/wiki/Rounding', snippet: '舍入规则概览', readState: 'discovered' },
    { title: 'IEEE 754：浮点数算术标准的官方说明与历史背景以及在金融系统中的常见陷阱', url: LONG_URL, snippet: lines(3, () => '很长的摘要文字用来观察来源卡片在多字时的换行与截断表现。').replace(/\n/g, ''), readState: 'discovered' },
    { title: '没有图标的网站仍可正常使用', url: 'https://missing-icon.invalid/article', snippet: '图标失败降级', readState: 'discovered' },
    { title: 'Python decimal 模块文档', url: 'https://docs.python.org/3/library/decimal.html', snippet: '十进制定点与浮点运算', readState: 'discovered' }
  ].slice(0, pick(1, 3, 7))
  const query = pick('金额舍入', '金额舍入 官方资料与开源实现', '金额舍入 银行家舍入 最小货币单位 官方资料 开源实现 浮点误差 财务系统常见陷阱')
  b.assistant([call('c-search', 'web_search', { query }), call('c-fetch', 'web_fetch', { url: sources[0].url })], 'toolUse')
  b.result('c-search', 'web_search', sources.map(s => `${s.title}\n${s.url}`).join('\n\n'), { details: { search: { action: 'query', query, items: sources } } })
  b.result('c-fetch', 'web_fetch', '正文节选……', { details: { search: { action: 'fetch', url: sources[0].url, title: sources[0].title, readState: 'partial', cached: true, fetchedAt: '2026-10-29T00:00:00Z', truncated: true } } })
  b.assistant([text(pick('资料已找到。', `先从官方文档与原始实现核对。[Readability](${sources[0].url}) 支持提取正文。`, `先从官方文档与原始实现核对。[Readability](${sources[0].url}) 支持提取正文，长页面可以继续定位和读取。${ctx.paragraph}`))])

  b.mark('计划/待办（todo_write 步骤）')
  b.user(pick('列个计划。', '列一个修复计划。', '列一个详细的修复计划，把每一步的验收标准也写上。'))
  const todos = [
    ['复现问题', 'completed'], ['定位累加位置', 'completed'], ['改成整数分', 'in_progress'], ['补边界用例', 'pending'], ['更新说明文档', 'pending'],
    ['跑完整测试', 'pending'], ['整理 PR 描述', 'pending'], ['同步到导出模块', 'pending'], ['人工抽样复核', 'pending'], ['发布前检查', 'pending'], ['通知财务', 'pending'], ['归档证据', 'pending']
  ].slice(0, pick(2, 5, 12)).map(([content, status]) => ({ content: long ? `${content}：${ctx.paragraph}` : content, status, activeForm: content }))
  b.assistant([call('c-todo', 'todo_write', { todos }), call('c-todo-fail', 'todo_write', { todos: todos.slice(0, 2) })], 'toolUse')
  b.result('c-todo', 'todo_write', 'Todos updated')
  b.result('c-todo-fail', 'todo_write', pick('无效', '待办列表无效：只能有一项处于进行中。', `待办列表无效：只能有一项处于进行中，并且每一项都必须包含非空的内容与状态字段。${ctx.paragraph}`), { isError: true })
  b.assistant([text(pick('计划已列出。', '计划已列出，从第三项开始。', `计划已列出，从第三项开始。${ctx.paragraph}`))])

  b.mark('问答历史（已回答、多问题、已跳过）')
  b.user(pick('选个方案。', '帮我选一个修复方案。', '帮我选一个修复方案，并且把你的取舍理由讲清楚，还有两个相关问题也一起问我。'))
  const question = pick('用哪种做法？', '修复用整数分还是十进制库？', `${ctx.paragraph} 修复时用整数分表示金额，还是引入十进制库？两种做法对历史报表口径、依赖体积和后续维护成本的影响不同，请选一个。`)
  const options = size === 'long'
    ? [{ label: '整数分', description: '只用整数分做加减，显示时再除以一百；不引入依赖，历史口径保持不变，但乘除法需要自己处理舍入。' }, { label: '十进制库', description: '引入成熟的十进制库，所有运算直接用十进制类型；写法最自然，但增加依赖体积，也要迁移现有数据结构。' }, { label: '保持现状', description: '暂不修复，只在报表上标注误差范围；改动最小，但问题依然存在。' }, { label: '两者并存', description: '核心路径用整数分，导出路径用十进制库；复杂度最高。' }, { label: '以后再说', description: '先搁置，等下个迭代再决定。' }]
    : size === 'normal' ? [{ label: '整数分', description: '不引入依赖' }, { label: '十进制库', description: '写法更自然' }, { label: '保持现状', description: '' }] : ['是', '否']
  b.assistant([call('c-q1', 'question', { question, options }), call('c-q2', 'AskUserQuestion', { questions: [{ question: pick('先改哪一个模块？', '先改汇总模块还是导出模块？', `先改汇总模块还是导出模块？${ctx.paragraph}`), header: pick('模块', '范围', '修复顺序与范围'), multiSelect: false, options: [{ label: '汇总模块', description: pick('', '核心路径', '核心路径，影响所有报表，需要最先修复并回归全部月份的数据') }, { label: '导出模块', description: pick('', '次要路径', '次要路径，只影响导出的文件格式') }] }] }), call('c-q3', 'question', { question: pick('要不要继续？', '要不要顺便清理旧文件？', '要不要顺便清理旧文件、过期的缓存目录和不再使用的示例数据？这一步不可逆，请确认。'), options: ['清理', '不清理'] })], 'toolUse')
  b.result('c-q1', 'question', `Answer: ${size === 'long' ? '整数分' : size === 'normal' ? '整数分' : '是'}`, { details: { question, options, answer: size === 'short' ? '是' : '整数分' } })
  b.result('c-q2', 'AskUserQuestion', `User has answered your questions: "${pick('先改哪一个模块？', '先改汇总模块还是导出模块？', `先改汇总模块还是导出模块？${ctx.paragraph}`)}"="汇总模块". You can now continue with the user's answers in mind.`)
  b.result('c-q3', 'question', 'User skipped the question', { isError: true, cancelled: true, details: { cancelled: true } })
  b.assistant([text(pick('按你的选择来。', '好的，按你的选择来：整数分，先改汇总模块。', `好的，按你的选择来：整数分，先改汇总模块。${ctx.paragraph}`))])

  b.mark('用户在终端里直接执行的命令（bashExecution）')
  b.bashExecution(pick('git status', 'git log --oneline -n 5', `git log --oneline --graph --decorate --all -n 40 -- ${LONG_PATH}`), pick('clean', lines(5, i => `a1b2c3${i} 修复第 ${i} 处舍入`), lines(40, i => `* a1b2c${i} (HEAD -> main) 修复第 ${i} 处舍入并补充边界用例以覆盖历史报表的口径差异`)), 0)
  b.bashExecution(pick('false', 'npm run missing-script', 'node -e "throw new Error(\'失败示例\')"'), pick('', 'npm ERR! Missing script: "missing-script"', lines(25, i => `    at Module._compile (node:internal/modules/cjs/loader:${i}:14)`)), 1)

  b.mark('说明性卡片：分支摘要 note 与自定义 note')
  b.branchSummary(pick('从旧分支带来的摘要。', '这个分支从“修复舍入”分支分出，已经完成整数分改造，还没有补测试。', `这个分支从“修复舍入”分支分出，已经完成整数分改造，还没有补测试。${ctx.paragraph}\n\n${lines(6, i => `- 要点 ${i}：${ctx.paragraph}`)}`))
  b.custom(pick('扩展提示。', '扩展提示：检测到 3 个未提交文件。', `扩展提示：检测到未提交文件。\n\n${lines(8, i => `- ${LONG_PATH}.${i}`)}`), 'git-hint')

  const errors = [
    ['usage-quota', pick('Usage limit reached', 'You have used all your plan limits for this 5 hour window. Resets at 3:20 PM (Asia/Shanghai).', `You have used all your plan limits for this 5 hour window. Resets at 3:20 PM (Asia/Shanghai). ${lines(6, () => 'Please upgrade your plan or wait for the window to reset before sending more requests.').replace(/\n/g, ' ')}`)],
    ['rate-quota', pick('429 Too many requests', '429 Too many requests: rate limit exceeded, retry after 20 seconds.', `429 Too many requests: rate limit exceeded for organization, limit 60 requests per minute. ${lines(5, () => 'Concurrent requests above the limit are rejected until the window slides forward.').replace(/\n/g, ' ')}`)],
    ['retryable', pick('502 bad gateway', '502 Bad Gateway: upstream connection reset', `terminated: socket hang up while streaming the response; upstream connection reset by peer after 38 seconds. ${lines(5, () => 'The request may be retried safely.').replace(/\n/g, ' ')}`)],
    ['auth', pick('401 unauthorized', '401 Unauthorized: invalid api key', `401 Unauthorized: invalid api key supplied for provider. ${lines(5, () => 'Check the credential in settings and make sure the key has access to the selected model.').replace(/\n/g, ' ')}`)],
    ['context', pick('context length exceeded', 'This model\'s maximum context length is 200000 tokens; the prompt is too long.', `This model's maximum context length is 200000 tokens; the prompt is too long (requested 231442 tokens). ${lines(5, () => 'Reduce the amount of text in your messages or compact the conversation.').replace(/\n/g, ' ')}`)],
    ['refused', pick('content policy', 'Your request was flagged by the content policy filter.', `Your request was flagged by the content policy filter and blocked. ${lines(5, () => 'Please revise the request and avoid prohibited content before trying again.').replace(/\n/g, ' ')}`)],
    ['request', pick('model not found', 'The model `fake-model-v9` does not exist or you do not have access to it.', `invalid_request_error: The model fake-model-v9 does not exist or you do not have access to it. ${lines(5, () => 'Choose another model in the picker and try again.').replace(/\n/g, ' ')}`)],
    ['aborted', pick('aborted by user', 'Request was aborted by user', 'Request was aborted by user while the model was still generating the final answer; no partial result was saved.')]
  ]
  const errorStart = b.seq
  for (const [name, message] of errors) {
    b.mark(`ErrorCard·${name}`)
    b.user(c.userTexts.err)
    b.assistant([], 'error', message)
  }
  b.mark('DecisionBlock：回复以问句结尾（已回答）')
  b.user(pick('做完了吗？', '改完了吗？', '改完了吗？请把结果和遗留问题都讲清楚。'))
  b.assistant([text(`${pick('已完成。', '已完成修复，测试全部通过。', `已完成修复，测试全部通过。${ctx.paragraph}`)}\n\n${pick('要继续吗？', '要我顺手把另一个模块的同类问题也一起修掉吗？', `要我顺手把导出模块、报表模块和数据导入模块里的同类问题也一起修掉吗？这样会多改十几个文件，但可以一次解决所有浮点累加的隐患，我会分成独立提交方便你审查。`)}`)])
  b.user(pick('好。', '好的，请继续。', '好的，请继续，但是分成独立提交，并且在每个提交里附上对应的测试，最后统一给我一份汇总。'))
  b.mark('WrapUpCard：收尾卡（最后一轮）')
  b.user(pick('收个尾。', '请做个收尾总结。', '请做个收尾总结，并告诉我下一步。'))
  b.assistant([text(pick('收尾如下。', '已完成，见下方卡片。', `已完成，见下方卡片。${ctx.paragraph}`)), call('c-wrap', 'wrap_up', {
    recap: pick('已完成。', '修复已完成，测试全部通过，尚未提交。', `修复已完成，测试全部通过，尚未提交。${ctx.paragraph} 另外还有两处遗留问题需要人工确认：历史报表口径与导出模块的舍入。`),
    ask: pick('提交吗？', '要现在提交这些改动吗？', '要现在提交这些改动，并同步创建一个 PR 供财务同事审阅吗？提交前我会先核对暂存清单，确保只包含本次任务相关的文件。'),
    actions: [{ label: pick('提交', '提交改动', '提交并创建 PR 供审阅'), message: '提交' }, { label: pick('不了', '先不提交', '暂时不提交，我想先再看一遍'), message: '先不提交' }]
  })], 'toolUse')
  b.result('c-wrap', 'wrap_up', 'ok')
  return { b, approvals, artifacts, errorStart }
}

export function prepareCards(box) {
  const project = box.project
  const files = []
  for (const [name, body] of [['notes.md', '# notes\n\ncard gallery fixture\n'], ['data.csv', 'id,amount\n1,10.10\n2,20.20\n'], ['long-file-name-for-attachment-chip-wrapping-test-document-final-v3.txt', 'x\n']]) {
    const path = join(project, 'cards', name)
    mkdirSync(join(project, 'cards'), { recursive: true })
    writeFileSync(path, body)
    files.push(path)
  }
  const paragraph = '对账模块在汇总退款与分期付款时先把金额转成浮点数再相加，累计误差会在月末汇总里暴露出来；这次需要把计算统一改成以最小货币单位为单位的整数，同时保持历史报表的四舍五入口径不变。'
  const ctx = { project, files, paragraph }
  const approvalLog = { version: 1, sessions: {} }
  const titles = readJson(join(box.dataDir, 'manual-titles.json'))
  const sessions = []
  const coverage = []
  for (const size of SIZES) {
    const { b, approvals, artifacts } = buildSession(size.key, ctx)
    const id = randomUUID()
    const forkAt = b.rows.find(row => row.message?.role === 'assistant').timestamp
    const header = { type: 'session', version: 3, id, timestamp: new Date(Date.parse(forkAt) + 1000).toISOString(), cwd: project, parentSession: join(box.sessionsDir, 'parent-session-placeholder.jsonl') }
    const startedAt = new Date(Date.parse(b.rows[0].timestamp)).toISOString()
    const meta = [{ type: 'model_change', provider: 'fake', modelId: 'fake-model', id: randomBytes(4).toString('hex'), parentId: null, timestamp: startedAt }]
    const info = { type: 'session_info', name: size.title, id: randomBytes(4).toString('hex'), parentId: null, timestamp: startedAt }
    const rows = [header, info, ...meta, ...b.rows]
    b.rows[0].parentId = meta[0].id
    const bucket = `--${project.replace(/[:\\/]/g, '-')}--`
    const file = join(box.sessionsDir, bucket, `${startedAt.replace(/[:.]/g, '-')}_${id}.jsonl`)
    mkdirSync(join(box.sessionsDir, bucket), { recursive: true })
    writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    approvalLog.sessions[id] = approvals.map(entry => ({ ...entry }))
    const artifactDir = join(box.dataDir, 'artifacts', `s-${id}`)
    mkdirSync(artifactDir, { recursive: true })
    const manifest = artifacts.map(item => {
      const artifactId = `art-${randomUUID()}`
      const bytes = item.body === null ? 1024 : Buffer.byteLength(item.body)
      const path = join(artifactDir, `${artifactId}-${item.filename}`)
      if (item.body !== null) writeFileSync(path, item.body)
      const mediaType = { md: 'text/markdown', svg: 'image/svg+xml', png: 'image/png', csv: 'text/csv', zip: 'application/zip', pdf: 'application/pdf' }[item.mime]
      const kind = item.mime === 'svg' ? 'svg' : item.mime === 'png' ? 'image' : item.mime === 'pdf' ? 'document' : item.mime === 'zip' ? 'binary' : 'code'
      return { messageId: item.messageId, artifact: { id: artifactId, sourceId: artifactId, version: 1, sha256: createHash('sha256').update(item.body ?? 'missing').digest('hex'), filename: item.filename, path, mediaType, kind, bytes, createdAt: Date.now(), previewable: kind !== 'binary', ...(item.description ? { description: item.description } : {}) } }
    })
    writeFileSync(join(artifactDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    titles[id] = size.title
    sessions.push({ id, file, title: size.title, size: size.key })
    coverage.push({ title: size.title, sessionId: id, file, sections: b.marks })
  }
  writeFileSync(join(box.dataDir, 'approval-log.json'), JSON.stringify(approvalLog, null, 2))
  writeFileSync(join(box.dataDir, 'manual-titles.json'), JSON.stringify(titles, null, 2))
  const desktopPath = join(box.dataDir, 'desktop.json')
  writeFileSync(desktopPath, JSON.stringify({ ...readJson(desktopPath), cwd: project, recentCwds: [project], remoteAccess: { enabled: false }, lastMainModel: 'fake/fake-model' }, null, 2))
  const coverageFile = join(box.runDir, 'cards-coverage.json')
  writeFileSync(coverageFile, JSON.stringify(coverage, null, 2))
  for (const item of sessions) {
    item.overlay = overlayFor(item.size, approvalLog.sessions[item.id])
  }
  box.cards = { sessions, coverageFile }
  return box.cards
}

function overlayFor(size, approvals) {
  const pick = (short, normal, long) => size === 'short' ? short : size === 'normal' ? normal : long
  const paragraph = '对账模块在汇总退款与分期付款时先把金额转成浮点数再相加，累计误差会在月末汇总里暴露出来。'
  return {
    approvals,
    compactAfter: '计划已列出',
    compaction: pick({ status: 'completed' }, { status: 'completed', beforeTokens: 182400, afterTokens: 21300, afterMeasured: true }, { status: 'failed', beforeTokens: 391200, error: `压缩失败：摘要模型返回了空结果，已保留原上下文。${paragraph}${paragraph}${paragraph}` }),
    quotaMinutes: pick(0, 45, 445),
    browserReason: pick('需要登录。', '这个页面需要你先登录账号，登录完成后点“我已完成”，我再继续读取页面内容。', `这个页面需要你先完成登录和短信验证，验证码会发到你的手机上。${paragraph}完成之后回到这里点“我已完成”，我再继续读取页面内容，并把读取到的表格整理成对账清单。`)
  }
}

export async function initializeCards(cdp, box) {
  const { until } = storeHelpers(cdp)
  if (!await until('s.sessions.length >= 3', 30000)) throw new Error('卡片会话未被实例加载')
  const data = Object.fromEntries(box.cards.sessions.map(item => [item.id, item.overlay]))
  await cdp.evaluate(`(()=>{
    const data = ${JSON.stringify(data)}
    const store = window.__yanStore
    let busy = false
    const apply = () => {
      if (busy) return
      const s = store.getState()
      const sid = s.session?.sessionId
      const d = data[sid]
      if (!d) return
      const patch = {}
      if (s.approvalLogSession !== sid) { patch.approvalLog = d.approvals; patch.approvalLogSession = sid }
      if (!s.session.lastCompaction) {
        const m = s.messages.find(x => x.role === 'assistant' && (x.text || '').startsWith(d.compactAfter))
        if (m?.timestamp) patch.session = { ...s.session, lastCompaction: { ...d.compaction, startedAt: m.timestamp + 500, endedAt: m.timestamp + 4500 } }
      }
      if (s.quotaResume?.sessionId !== sid) patch.quotaResume = { sessionId: sid, provider: 'fake', armedAt: Date.now(), resetAt: d.quotaMinutes ? Date.now() + d.quotaMinutes * 60000 : undefined }
      if (!Object.keys(patch).length) return
      busy = true
      try { store.setState(patch) } finally { busy = false }
    }
    window.__cardsHandoff = (on = true) => {
      const s = store.getState()
      const sid = s.session?.sessionId
      const d = data[sid]
      if (!d) return false
      store.setState({ browserStates: { ...s.browserStates, [sid]: { ...s.browserState, userControl: on, userControlRequest: on ? { reason: d.browserReason, sessionId: sid, at: Date.now() } : undefined } } })
      return true
    }
    store.subscribe(apply)
    apply()
  })()`)
  const target = box.cards.sessions.find(item => item.size === 'normal')
  await cdp.evaluate(`(async()=>{
    const s = window.__yanStore.getState()
    s.patchSettings({ theme: 'dark', lang: 'zh-CN' })
    await s.switchSession(${JSON.stringify(target.file)})
  })()`)
}
